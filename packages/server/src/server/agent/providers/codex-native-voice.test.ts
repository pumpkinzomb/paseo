import { describe, expect, it, vi } from "vitest";
import { CodexNativeVoice, listCodexV3Voices } from "./codex-native-voice.js";

function setup() {
  const voice = new CodexNativeVoice();
  const client = { request: vi.fn().mockResolvedValue({}) };
  const emit = vi.fn();
  return { voice, client, emit };
}

describe("Codex native voice", () => {
  it("waits for the matching SDP answer after the RPC acknowledgement", async () => {
    const { voice, client, emit } = setup();
    const start = voice.start(client, "thread", "offer", emit);
    let completed = false;
    void start.then(() => {
      completed = true;
      return undefined;
    });
    await Promise.resolve();
    voice.handle("thread/realtime/sdp", { threadId: "other", sdp: "wrong" });
    await Promise.resolve();
    expect(completed).toBe(false);
    voice.handle("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
    const connection = await start;
    expect(connection.answerSdp).toBe("answer");
    expect(client.request).toHaveBeenCalledWith(
      "thread/realtime/start",
      expect.objectContaining({
        transport: { type: "webrtc", sdp: "offer" },
        outputModality: "audio",
      }),
      30000,
    );
    await connection.stop();
    await connection.stop();
    expect(
      client.request.mock.calls.filter(([method]) => method === "thread/realtime/stop"),
    ).toHaveLength(1);
    expect(voice.isActive).toBe(false);
  });

  it("rejects an asynchronous backend error instead of reporting startup success", async () => {
    const { voice, client, emit } = setup();
    const start = voice.start(client, "thread", "offer", emit);
    const rejected = expect(start).rejects.toThrow("backend unavailable");
    voice.handle("thread/realtime/error", { threadId: "thread", message: "backend unavailable" });
    await rejected;
    expect(emit).not.toHaveBeenCalled();
    expect(voice.isActive).toBe(false);
  });

  it("forwards completed transcripts and remote closure only to the owner", async () => {
    const { voice, client, emit } = setup();
    const start = voice.start(client, "thread", "offer", emit);
    voice.handle("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
    await start;
    await expect(voice.start(client, "other", "offer", emit)).rejects.toThrow("already");
    voice.handle("thread/realtime/transcript/done", {
      threadId: "other",
      role: "user",
      text: "wrong",
    });
    voice.handle("thread/realtime/transcript/done", {
      threadId: "thread",
      role: "user",
      text: "hello",
    });
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: "transcript",
      role: "user",
      text: "hello",
    });
    voice.handle("thread/realtime/closed", { threadId: "thread", reason: "expired" });
    expect(emit).toHaveBeenLastCalledWith({ type: "closed", reason: "expired" });
    expect(voice.isActive).toBe(false);
  });

  it("cancels startup when its owning agent closes", async () => {
    const { voice, client, emit } = setup();
    const start = voice.start(client, "thread", "offer", emit);
    const rejected = expect(start).rejects.toThrow("session closed");
    await voice.close();
    await rejected;
    expect(voice.isActive).toBe(false);
  });
  it("notifies the owner and releases voice when its provider process exits", async () => {
    const { voice, client, emit } = setup();
    const start = voice.start(client, "thread", "offer", emit);
    voice.handle("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
    await start;
    voice.fail(new Error("Provider process exited"));
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      message: "Provider process exited",
    });
    expect(voice.isActive).toBe(false);
    await voice.close();
    expect(
      client.request.mock.calls.filter(([method]) => method === "thread/realtime/stop"),
    ).toHaveLength(0);
  });
});

it("keeps final transcripts during stop and shares concurrent stop acknowledgement", async () => {
  const { voice, client, emit } = setup();
  const start = voice.start(client, "thread", "offer", emit);
  voice.handle("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
  const connection = await start;
  let finish!: () => void;
  client.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({});
      }),
  );
  const stopping = connection.stop();
  const again = connection.stop();
  expect(again).toBe(stopping);
  expect(voice.isActive).toBe(true);
  voice.handle("thread/realtime/transcript/done", {
    threadId: "thread",
    role: "user",
    text: "last words",
  });
  expect(emit).toHaveBeenCalledExactlyOnceWith({
    type: "transcript",
    role: "user",
    text: "last words",
  });
  finish();
  await stopping;
  voice.handle("thread/realtime/transcript/done", {
    threadId: "thread",
    role: "user",
    text: "too late",
  });
  expect(emit).toHaveBeenCalledOnce();
  expect(voice.isActive).toBe(false);
});

it("checks V3 availability and forwards an explicit choice without substituting a default", async () => {
  const { voice, client, emit } = setup();
  client.request.mockResolvedValue({ voices: { v3: ["coral"] } });
  const start = voice.start(client, "thread", "offer", emit, "coral");
  await vi.waitFor(() =>
    expect(client.request).toHaveBeenCalledWith(
      "thread/realtime/start",
      expect.objectContaining({ voice: "coral" }),
      30000,
    ),
  );
  voice.handle("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
  await (await start).stop();
  client.request.mockClear();
  await expect(voice.start(client, "thread", "offer", emit, "ash")).rejects.toThrow(
    "unavailable: ash",
  );
  expect(client.request).not.toHaveBeenCalledWith(
    "thread/realtime/start",
    expect.anything(),
    expect.anything(),
  );
});

describe("Codex V3 catalog", () => {
  it("reads only V3 and never starts a thread or voice connection", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({
        voices: {
          v2: ["sage", "marin"],
          v3: ["cove", "haetsal", "cove"],
        },
      }),
    };
    await expect(listCodexV3Voices(client)).resolves.toEqual(["cove", "haetsal"]);
    expect(client.request.mock.calls).toEqual([["thread/realtime/listVoices", {}, 5000]]);
  });
  it("does not substitute V2 when V3 is missing", async () => {
    const client = { request: vi.fn().mockResolvedValue({ voices: { v2: ["sage"] } }) };
    await expect(listCodexV3Voices(client)).rejects.toThrow();
  });
  it("propagates discovery failure so a retry can request a fresh catalog", async () => {
    const client = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ voices: { v3: ["cove"] } }),
    };
    await expect(listCodexV3Voices(client)).rejects.toThrow("offline");
    await expect(listCodexV3Voices(client)).resolves.toEqual(["cove"]);
  });
});
