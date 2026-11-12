import { Readable } from "node:stream";
import type { VoiceSpeakHandler } from "../../voice-types.js";
import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { VoiceSession, type VoiceSessionHost } from "./voice-session.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  StreamingTranscriptionSession,
} from "../../speech/speech-provider.js";
import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../speech/turn-detection-provider.js";

const VOICE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

class FakeVoiceTurnDetectionSession extends EventEmitter implements TurnDetectionSession {
  public readonly requiredSampleRate = 16000;

  async connect(): Promise<void> {}

  appendPcm16(_chunk: Buffer): void {}

  flush(): void {}
  reset(): void {}
  close(): void {}
}

class FakeVoiceSttSession extends EventEmitter implements StreamingTranscriptionSession {
  public readonly requiredSampleRate = 16000;
  public commitCount = 0;

  async connect(): Promise<void> {}

  appendPcm16(_pcm16le: Buffer): void {}

  commit(): void {
    this.commitCount += 1;
  }

  clear(): void {}
  close(): void {}

  emitCommitted(event: StreamingTranscriptionCommittedEvent): void {
    this.emit("committed", event);
  }

  emitTranscript(event: StreamingTranscriptionEvent): void {
    this.emit("transcript", event);
  }
}

interface FakeVoiceHost extends VoiceSessionHost {
  readonly emitted: SessionOutboundMessage[];
  readonly spokenInput: Array<{ agentId: string; text: string }>;
}

function createFakeHost(): FakeVoiceHost {
  const emitted: SessionOutboundMessage[] = [];
  const spokenInput: Array<{ agentId: string; text: string }> = [];
  return {
    emitted,
    spokenInput,
    emit: (msg) => {
      emitted.push(msg);
    },
    loadAgent: async (agentId) =>
      ({ id: agentId, config: { systemPrompt: undefined } }) as unknown as ManagedAgent,
    reloadAgentSession: async (agentId) => ({ id: agentId }) as unknown as ManagedAgent,
    recordNativeTranscript: vi.fn().mockResolvedValue(undefined),
    sendSpokenInput: async (agentId, text) => {
      spokenInput.push({ agentId, text });
    },
    interruptAgentIfRunning: async () => {},
    hasActiveAgentRun: () => false,
  };
}

function createVoiceSession(tts: TextToSpeechProvider | null = null) {
  let speakHandler: VoiceSpeakHandler | undefined;
  const detector = new FakeVoiceTurnDetectionSession();
  const sttSession = new FakeVoiceSttSession();
  const stt: SpeechToTextProvider = {
    id: "local",
    createSession: vi.fn(() => sttSession),
  };
  const turnDetection: TurnDetectionProvider = {
    id: "local",
    createSession: vi.fn(() => detector),
  };
  const host = createFakeHost();
  const voiceSession = new VoiceSession({
    host,
    logger: pino({ level: "silent" }),
    sessionId: "voice-session-test",
    sttLanguage: "en",
    tts,
    voiceBridge: {
      registerVoiceSpeakHandler: (_id, handler) => {
        speakHandler = handler;
      },
    },
    stt,
    voice: { turnDetection },
  });
  return {
    voiceSession,
    detector,
    sttSession,
    host,
    speak: (args: Parameters<VoiceSpeakHandler>[0]) => {
      if (!speakHandler) throw new Error("Voice speak handler not registered");
      return speakHandler(args);
    },
  };
}

function isAudioOutput(message: SessionOutboundMessage): boolean {
  return message.type === "audio_output";
}

async function waitForAudioOutput(host: FakeVoiceHost): Promise<void> {
  await vi.waitFor(() => expect(host.emitted.filter(isAudioOutput)).toHaveLength(1));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("VoiceSession streaming transcription", () => {
  test("interrupts playback and the agent on speech detection without partial transcripts", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const { voiceSession, detector, host, speak } = createVoiceSession(tts);
    const interrupted: string[] = [];
    async function recordInterruption(agentId: string) {
      interrupted.push(agentId);
    }
    host.interruptAgentIfRunning = recordInterruption;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({ text: "A spoken response." });
    try {
      await waitForAudioOutput(host);
      detector.emit("speech_started");
      await settle();
      expect(host.emitted).toContainEqual({
        type: "voice_input_state",
        payload: { isSpeaking: true },
      });
      expect(interrupted).toEqual([VOICE_AGENT_ID]);
      await playback;
    } finally {
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test("session abort stops later audio even when the speak tool supplies its own signal", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const { voiceSession, host, speak } = createVoiceSession(tts);
    const external = new AbortController();
    let abortRequested = false;
    const emit = host.emit;
    function acknowledgeLaterAudio(message: SessionOutboundMessage) {
      emit(message);
      if (message.type === "audio_output" && abortRequested)
        voiceSession.handleAudioPlayed(message.payload.id);
    }
    host.emit = acknowledgeLaterAudio;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({
      text: "First sentence. Second sentence. Third sentence.",
      signal: external.signal,
    });
    try {
      await waitForAudioOutput(host);
      abortRequested = true;
      await voiceSession.handleAbort();
      await playback;
      expect(host.emitted.filter(isAudioOutput)).toHaveLength(1);
      expect(external.signal.aborted).toBe(false);
    } finally {
      external.abort();
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test("surfaces a refused voice-mode agent interruption", async () => {
    const { voiceSession, host } = createVoiceSession();
    host.interruptAgentIfRunning = vi.fn(async () => {
      throw new Error("active run cancellation was not acknowledged");
    });

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

    await expect(voiceSession.handleAbort()).rejects.toThrow(
      "active run cancellation was not acknowledged",
    );
    expect(host.interruptAgentIfRunning).toHaveBeenCalledWith(VOICE_AGENT_ID);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "activity_log",
        payload: expect.objectContaining({
          type: "error",
          content: "Voice interruption failed: active run cancellation was not acknowledged",
          metadata: { voiceAbortFailed: true },
        }),
      }),
    );

    await voiceSession.cleanup();
  });

  test("delivers the streaming final transcript to the agent exactly once", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "ship the streaming final",
      isFinal: true,
      language: "en",
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await settle();

    expect(sttSession.commitCount).toBe(1);
    expect(host.spokenInput).toEqual([
      { agentId: VOICE_AGENT_ID, text: "ship the streaming final" },
    ]);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "ship the streaming final",
          language: "en",
          avgLogprob: -0.1,
        }),
      }),
    );

    await voiceSession.cleanup();
  });

  test("emits an empty transcript on finalization timeout without submitting to the agent", async () => {
    vi.useFakeTimers();
    try {
      const { voiceSession, detector, sttSession, host } = createVoiceSession();

      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();
      sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });

      await vi.advanceTimersByTimeAsync(10_000);
      await settle();

      expect(host.spokenInput).toEqual([]);
      expect(host.emitted).toContainEqual(
        expect.objectContaining({
          type: "transcription_result",
          payload: expect.objectContaining({ text: "" }),
        }),
      );

      await voiceSession.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  test("filters a low-confidence streaming final without submitting to the agent", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "background noise",
      isFinal: true,
      avgLogprob: -2.5,
      isLowConfidence: true,
    });
    await settle();

    expect(host.spokenInput).toEqual([]);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "",
          avgLogprob: -2.5,
          isLowConfidence: true,
        }),
      }),
    );

    await voiceSession.cleanup();
  });
});

describe("native voice offer", () => {
  test("returns the SDP answer and stops the native connection when voice is disabled", async () => {
    const { host, voiceSession } = createVoiceSession();
    const agent = await host.loadAgent(VOICE_AGENT_ID);
    const stop = vi.fn().mockResolvedValue(undefined);
    const startNativeVoice = vi.fn().mockResolvedValue({ answerSdp: "answer", stop });
    host.loadAgent = vi
      .fn()
      .mockResolvedValue(Object.assign(agent, { session: { startNativeVoice } }));
    await voiceSession.handleNativeVoiceOffer({
      type: "voice.native.start.request",
      requestId: "offer",
      agentId: VOICE_AGENT_ID,
      offerSdp: "offer-sdp",
    });
    expect(startNativeVoice).toHaveBeenCalledWith("offer-sdp", expect.any(Function), undefined);
    expect(host.emitted).toContainEqual({
      type: "voice.native.start.response",
      payload: {
        requestId: "offer",
        agentId: VOICE_AGENT_ID,
        accepted: true,
        answerSdp: "answer",
        error: null,
      },
    });
    await voiceSession.handleSetVoiceMode(false, undefined, "stop");
    expect(stop).toHaveBeenCalledOnce();
    expect(host.spokenInput).toEqual([]);
  });

  test("returns a visible failure when native startup fails", async () => {
    const { host, voiceSession } = createVoiceSession();
    const agent = await host.loadAgent(VOICE_AGENT_ID);
    const startNativeVoice = vi.fn().mockRejectedValue(new Error("Signaling failed"));
    host.loadAgent = vi
      .fn()
      .mockResolvedValue(Object.assign(agent, { session: { startNativeVoice } }));
    await voiceSession.handleNativeVoiceOffer({
      type: "voice.native.start.request",
      requestId: "offer",
      agentId: VOICE_AGENT_ID,
      offerSdp: "offer-sdp",
    });
    expect(host.emitted).toContainEqual({
      type: "voice.native.start.response",
      payload: {
        requestId: "offer",
        agentId: VOICE_AGENT_ID,
        accepted: false,
        answerSdp: null,
        error: "Signaling failed",
      },
    });
    expect(host.spokenInput).toEqual([]);
  });
  test("rejects duplicate offers while starting and stops a connection obtained after cancellation", async () => {
    const { host, voiceSession } = createVoiceSession();
    const agent = await host.loadAgent(VOICE_AGENT_ID);
    const stop = vi.fn().mockResolvedValue(undefined);
    let resolveConnection!: (value: { answerSdp: string; stop(): Promise<void> }) => void;
    const pending = new Promise<{ answerSdp: string; stop(): Promise<void> }>((resolve) => {
      resolveConnection = resolve;
    });
    const startNativeVoice = vi.fn().mockReturnValue(pending);
    host.loadAgent = vi
      .fn()
      .mockResolvedValue(Object.assign(agent, { session: { startNativeVoice } }));
    const first = voiceSession.handleNativeVoiceOffer({
      type: "voice.native.start.request",
      requestId: "first",
      agentId: VOICE_AGENT_ID,
      offerSdp: "offer",
    });
    await vi.waitFor(() => expect(startNativeVoice).toHaveBeenCalledOnce());
    await voiceSession.handleNativeVoiceOffer({
      type: "voice.native.start.request",
      requestId: "second",
      agentId: VOICE_AGENT_ID,
      offerSdp: "other",
    });
    expect(startNativeVoice).toHaveBeenCalledOnce();
    expect(host.emitted).toContainEqual({
      type: "voice.native.start.response",
      payload: {
        requestId: "second",
        agentId: VOICE_AGENT_ID,
        accepted: false,
        answerSdp: null,
        error: "Native voice is already active or starting",
      },
    });
    voiceSession.cancel();
    resolveConnection({ answerSdp: "late", stop });
    await first;
    expect(stop).toHaveBeenCalledOnce();
    await voiceSession.cleanup();
  });
});

test("native final transcripts are recorded in order before stop acknowledges without resending", async () => {
  const { host, voiceSession } = createVoiceSession();
  const agent = await host.loadAgent(VOICE_AGENT_ID);
  let emit!: (event: import("../../agent/native-voice.js").NativeVoiceEvent) => void;
  let finishStop!: () => void;
  const stop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishStop = resolve;
      }),
  );
  host.loadAgent = vi.fn().mockResolvedValue(
    Object.assign(agent, {
      session: {
        startNativeVoice: async (_offer: string, callback: typeof emit) => {
          emit = callback;
          return { answerSdp: "answer", stop };
        },
      },
    }),
  );
  let save!: () => void;
  const recorded: string[] = [];
  host.recordNativeTranscript = vi.fn(async (agentId, role, text) => {
    expect(agentId).toBe(VOICE_AGENT_ID);
    recorded.push(`${role}:${text}`);
    if (recorded.length === 1)
      await new Promise<void>((resolve) => {
        save = resolve;
      });
  });
  await voiceSession.handleNativeVoiceOffer({
    type: "voice.native.start.request",
    requestId: "offer",
    agentId: VOICE_AGENT_ID,
    offerSdp: "offer",
  });
  emit({ type: "transcript", role: "user", text: "same words" });
  const stopping = voiceSession.handleSetVoiceMode(false, undefined, "stop-final");
  emit({ type: "transcript", role: "user", text: "same words" });
  emit({ type: "transcript", role: "assistant", text: "reply" });
  await vi.waitFor(() => expect(recorded).toEqual(["user:same words"]));
  finishStop();
  await Promise.resolve();
  expect(
    host.emitted.some(
      (e) => e.type === "set_voice_mode_response" && e.payload.requestId === "stop-final",
    ),
  ).toBe(false);
  save();
  await stopping;
  expect(recorded).toEqual(["user:same words", "user:same words", "assistant:reply"]);
  const ids = vi.mocked(host.recordNativeTranscript).mock.calls.map((call) => call[3]);
  expect(new Set(ids).size).toBe(3);
  expect(host.spokenInput).toEqual([]);
  await voiceSession.handleSetVoiceMode(false, undefined, "again");
  expect(stop).toHaveBeenCalledOnce();
  await voiceSession.cleanup();
});

test("native received transcripts finish saving to the original agent after source closes", async () => {
  const { host, voiceSession } = createVoiceSession();
  const agent = await host.loadAgent(VOICE_AGENT_ID);
  let emit!: (event: import("../../agent/native-voice.js").NativeVoiceEvent) => void;
  host.loadAgent = vi.fn().mockResolvedValue(
    Object.assign(agent, {
      session: {
        startNativeVoice: async (_offer: string, callback: typeof emit) => {
          emit = callback;
          return { answerSdp: "answer", stop: async () => {} };
        },
      },
    }),
  );
  let saved!: () => void;
  host.recordNativeTranscript = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
  );
  await voiceSession.handleNativeVoiceOffer({
    type: "voice.native.start.request",
    requestId: "offer",
    agentId: VOICE_AGENT_ID,
    offerSdp: "offer",
  });
  emit({ type: "transcript", role: "user", text: "retained" });
  await vi.waitFor(() => expect(host.recordNativeTranscript).toHaveBeenCalledOnce());
  voiceSession.cancel();
  const cleanup = voiceSession.cleanup();
  emit({ type: "transcript", role: "user", text: "after cancel ignored" });
  expect(voiceSession.hasDemand).toBe(true);
  saved();
  await cleanup;
  expect(host.recordNativeTranscript).toHaveBeenCalledExactlyOnceWith(
    VOICE_AGENT_ID,
    "user",
    "retained",
    expect.any(String),
  );
  expect(host.spokenInput).toEqual([]);
  expect(voiceSession.hasDemand).toBe(false);
});

test("native voice stop reports transcript storage failure instead of confirming a saved stop", async () => {
  const { host, voiceSession } = createVoiceSession();
  const agent = await host.loadAgent(VOICE_AGENT_ID);
  let emit!: (event: import("../../agent/native-voice.js").NativeVoiceEvent) => void;
  host.loadAgent = vi.fn().mockResolvedValue(
    Object.assign(agent, {
      session: {
        startNativeVoice: async (_offer: string, callback: typeof emit) => {
          emit = callback;
          return { answerSdp: "answer", stop: async () => {} };
        },
      },
    }),
  );
  host.recordNativeTranscript = vi.fn().mockRejectedValue(new Error("disk write failed"));
  await voiceSession.handleNativeVoiceOffer({
    type: "voice.native.start.request",
    requestId: "offer",
    agentId: VOICE_AGENT_ID,
    offerSdp: "offer",
  });
  emit({ type: "transcript", role: "user", text: "retain" });
  await voiceSession.handleSetVoiceMode(false, undefined, "failed-save");
  expect(host.emitted).toContainEqual(
    expect.objectContaining({
      type: "set_voice_mode_response",
      payload: expect.objectContaining({
        requestId: "failed-save",
        accepted: false,
        error: "disk write failed",
      }),
    }),
  );
  expect(host.spokenInput).toEqual([]);
  expect(voiceSession.hasDemand).toBe(false);
  expect(voiceSession.isActiveForAgent(VOICE_AGENT_ID)).toBe(false);
  host.recordNativeTranscript = vi.fn().mockResolvedValue(undefined);
  await voiceSession.handleNativeVoiceOffer({
    type: "voice.native.start.request",
    requestId: "retry-offer",
    agentId: VOICE_AGENT_ID,
    offerSdp: "offer",
  });
  emit({ type: "transcript", role: "user", text: "new session succeeds" });
  await voiceSession.handleSetVoiceMode(false, undefined, "retry-stop");
  expect(host.emitted).toContainEqual(
    expect.objectContaining({
      type: "set_voice_mode_response",
      payload: expect.objectContaining({ requestId: "retry-stop", accepted: true, error: null }),
    }),
  );
  await expect(voiceSession.cleanup()).resolves.toBeUndefined();
});

test("returns an explicit unsupported native choice failure to the calling client", async () => {
  const { host, voiceSession } = createVoiceSession();
  const agent = await host.loadAgent(VOICE_AGENT_ID);
  const startNativeVoice = vi
    .fn()
    .mockRejectedValue(new Error("Codex realtime V3 voice is unavailable: coral"));
  host.loadAgent = vi.fn(async () => ({
    ...agent,
    session: { ...agent.session!, startNativeVoice },
  }));
  await voiceSession.handleNativeVoiceOffer({
    type: "voice.native.start.request",
    requestId: "unsupported",
    agentId: VOICE_AGENT_ID,
    offerSdp: "offer",
    voice: "coral",
  });
  expect(startNativeVoice).toHaveBeenCalledWith("offer", expect.any(Function), "coral");
  expect(host.emitted).toContainEqual({
    type: "voice.native.start.response",
    payload: {
      requestId: "unsupported",
      agentId: VOICE_AGENT_ID,
      accepted: false,
      answerSdp: null,
      error: "Codex realtime V3 voice is unavailable: coral",
    },
  });
});
