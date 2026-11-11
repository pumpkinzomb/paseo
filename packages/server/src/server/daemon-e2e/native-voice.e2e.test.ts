import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { AgentSession } from "../agent/agent-sdk-types.js";
import type { NativeVoiceEvent } from "../agent/native-voice.js";

test("native voice negotiates through the real client/daemon and belongs to its source", async () => {
  const root = await mkdtemp(path.resolve("../../.lab/native-voice-contract-"));
  const onStartTurn = vi.fn();
  const clients = createTestAgentClients({ onStartTurn });
  const codex = clients.codex;
  if (!codex) throw new Error("Codex test client missing");
  let emit: (event: NativeVoiceEvent) => void = () => undefined;
  const stop = vi.fn().mockImplementation(async () => {
    emit({ type: "transcript", role: "user", text: "마지막 문장도 보존" });
  });
  const startNativeVoice = vi.fn().mockImplementation(async (_offer, onEvent) => {
    emit = onEvent;
    return { answerSdp: "answer-sdp", stop };
  });
  function withVoice(session: AgentSession): AgentSession {
    return Object.assign(session, { startNativeVoice });
  }
  const create = codex.createSession.bind(codex);
  const resume = codex.resumeSession.bind(codex);
  vi.spyOn(codex, "createSession").mockImplementation(async (...args) =>
    withVoice(await create(...args)),
  );
  vi.spyOn(codex, "resumeSession").mockImplementation(async (...args) =>
    withVoice(await resume(...args)),
  );
  const staticDir = path.join(root, "static");
  await mkdir(staticDir);
  const options = { paseoHomeRoot: root, staticDir, agentClients: clients, cleanup: false };
  let ctx = await createDaemonTestContext(options);
  const other = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
  try {
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd: root,
      modeId: "always-ask",
    });
    const answer = await ctx.client.startNativeVoice(agent.id, "offer-sdp");
    expect(answer).toBe("answer-sdp");
    expect(startNativeVoice).toHaveBeenCalledWith("offer-sdp", expect.any(Function));
    emit({ type: "transcript", role: "user", text: "같은 말" });
    emit({ type: "transcript", role: "assistant", text: "음성 응답" });
    emit({ type: "transcript", role: "user", text: "같은 말" });
    await other.connect();
    await other.fetchAgents({ subscribe: {} });
    await other.setVoiceMode(false);
    expect(stop).not.toHaveBeenCalled();
    await ctx.client.setVoiceMode(false);
    expect(stop).toHaveBeenCalledOnce();
    const expected = [
      { type: "user_message", text: "같은 말" },
      { type: "assistant_message", text: "음성 응답" },
      { type: "user_message", text: "같은 말" },
      { type: "user_message", text: "마지막 문장도 보존" },
    ];
    const timeline = await other.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(
      timeline.entries.map(({ item }) => ({
        type: item.type,
        text: "text" in item ? item.text : undefined,
      })),
    ).toEqual(expected);
    expect(onStartTurn).not.toHaveBeenCalled();
    await other.close();
    await ctx.cleanup();
    ctx = await createDaemonTestContext(options);
    const restored = await ctx.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(
      restored.entries.map(({ item }) => ({
        type: item.type,
        text: "text" in item ? item.text : undefined,
      })),
    ).toEqual(expected);
    expect(onStartTurn).not.toHaveBeenCalled();
  } finally {
    await other.close();
    await ctx.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("native voice refuses unsupported agents through the real client response", async () => {
  const root = await mkdtemp(path.resolve("../../.lab/native-voice-refusal-"));
  const ctx = await createDaemonTestContext({ paseoHomeRoot: root });
  try {
    const agent = await ctx.client.createAgent({
      provider: "claude",
      cwd: root,
      modeId: "default",
    });
    await expect(ctx.client.startNativeVoice(agent.id, "offer-sdp")).rejects.toThrow(
      "does not support native voice",
    );
  } finally {
    await ctx.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
