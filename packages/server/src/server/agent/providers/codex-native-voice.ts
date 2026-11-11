import { z } from "zod";
import type { NativeVoiceConnection, NativeVoiceEvent } from "../native-voice.js";
interface RpcClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}
interface Owner {
  client: RpcClient;
  threadId: string;
  emit: (event: NativeVoiceEvent) => void;
  resolve: (sdp: string) => void;
  reject: (error: Error) => void;
  closed: boolean;
  ready: boolean;
  stopping?: Promise<void>;
}
const Envelope = z.object({
  threadId: z.string(),
  message: z.string().optional(),
  reason: z.string().nullable().optional(),
});
const SdpEvent = z.object({ threadId: z.string(), sdp: z.string().min(1) });
const TranscriptEvent = z.object({ threadId: z.string(), role: z.string(), text: z.string() });

/** ChatGPT login supports WebRTC. The PCM WebSocket route requires separate API-key auth. */
export class CodexNativeVoice {
  private owner: Owner | null = null;
  get isActive(): boolean {
    return this.owner !== null;
  }

  async start(
    client: RpcClient,
    threadId: string,
    offerSdp: string,
    emit: (event: NativeVoiceEvent) => void,
  ): Promise<NativeVoiceConnection> {
    if (this.owner)
      throw new Error("This Codex conversation already has an active voice connection");
    let resolve!: (sdp: string) => void;
    let reject!: (error: Error) => void;
    const answer = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Notifications can reject before the start RPC acknowledgement arrives.
    void answer.catch(() => undefined);
    const owner: Owner = { client, threadId, emit, resolve, reject, closed: false, ready: false };
    this.owner = owner;
    const timer = setTimeout(() => reject(new Error("Codex voice signaling timed out")), 30000);
    try {
      await client.request(
        "thread/realtime/start",
        {
          threadId,
          version: "v3",
          transport: { type: "webrtc", sdp: offerSdp },
          outputModality: "audio",
        },
        30000,
      );
      const answerSdp = await answer;
      if (owner.closed) throw new Error("Codex voice closed during startup");
      owner.ready = true;
      return {
        answerSdp,
        stop: () => {
          if (owner.stopping) return owner.stopping;
          if (owner.closed) return Promise.resolve();
          // Keep accepting completed transcripts until the bounded stop RPC settles.
          owner.stopping = (async () => {
            try {
              await client.request("thread/realtime/stop", { threadId }, 5000);
            } finally {
              owner.closed = true;
              if (this.owner === owner) this.owner = null;
            }
          })();
          return owner.stopping;
        },
      };
    } catch (error) {
      if (this.owner === owner) this.owner = null;
      const needsStop = !owner.closed;
      owner.closed = true;
      if (needsStop)
        await client.request("thread/realtime/stop", { threadId }, 5000).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  handle(method: string, params: unknown): boolean {
    if (!method.startsWith("thread/realtime/")) return false;
    const owner = this.owner;
    const envelope = Envelope.safeParse(params);
    if (!owner || !envelope.success) return true;
    if (envelope.data.threadId !== owner.threadId || owner.closed) return true;
    if (method === "thread/realtime/sdp") {
      const parsed = SdpEvent.safeParse(params);
      if (parsed.success) owner.resolve(parsed.data.sdp);
    } else if (method === "thread/realtime/transcript/done") {
      const parsed = TranscriptEvent.safeParse(params);
      if (parsed.success && owner.ready)
        owner.emit({ type: "transcript", role: parsed.data.role, text: parsed.data.text });
    } else if (method === "thread/realtime/error" || method === "thread/realtime/closed") {
      owner.closed = true;
      this.owner = null;
      const message = envelope.data.message ?? "Codex voice connection closed";
      if (!owner.ready) owner.reject(new Error(message));
      else if (method.endsWith("/error")) owner.emit({ type: "error", message });
      else
        owner.emit({
          type: "closed",
          reason: envelope.data.reason ?? null,
        });
    }
    return true;
  }
  fail(error: Error): void {
    const owner = this.owner;
    if (owner)
      this.handle("thread/realtime/error", { threadId: owner.threadId, message: error.message });
  }

  async close(): Promise<void> {
    const owner = this.owner;
    if (!owner) return;
    this.owner = null;
    owner.closed = true;
    owner.reject(new Error("Codex session closed"));
    try {
      await owner.client.request("thread/realtime/stop", { threadId: owner.threadId }, 5000);
    } finally {
      if (owner.ready) owner.emit({ type: "closed", reason: "Codex session closed" });
    }
  }
}
