import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { AgentSession } from "../agent/agent-sdk-types.js";

test("native voice negotiates through the real client/daemon and belongs to its source", async () => {
  const root = await mkdtemp(path.resolve("../../.lab/native-voice-contract-"));
  const clients = createTestAgentClients();
  const codex = clients.codex;
  if (!codex) throw new Error("Codex test client missing");
  const stop = vi.fn().mockResolvedValue(undefined);
  const startNativeVoice = vi.fn().mockResolvedValue({ answerSdp: "answer-sdp", stop });
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
  const ctx = await createDaemonTestContext({ paseoHomeRoot: root, agentClients: clients });
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
    await other.connect();
    await other.fetchAgents({ subscribe: {} });
    await other.setVoiceMode(false);
    expect(stop).not.toHaveBeenCalled();
    await ctx.client.setVoiceMode(false);
    expect(stop).toHaveBeenCalledOnce();
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
