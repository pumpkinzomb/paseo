import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshGrokToken, requestNativeToken } from "./auth-refresh.js";

function fixture(reply: (request: { id: number; method: string }) => unknown) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: new Writable(),
    kill: vi.fn((_signal?: string) => true),
  });
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close"));
    return true;
  });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      queueMicrotask(() => {
        const response = reply(request);
        if (response) child.stdout.write(JSON.stringify(response) + "\n");
      });
      callback();
    },
  });
  spawn.mockReturnValue(child);
  return child;
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe("official Grok auth lookup", () => {
  it("only initializes and reads native auth, without a session or model prompt", async () => {
    const methods: string[] = [];
    const child = fixture((req) => {
      methods.push(req.method);
      return { id: req.id, result: req.id === 1 ? {} : { result: { token: "fixture" } } };
    });
    expect(await requestNativeToken()).toBe("fixture");
    expect(methods).toEqual(["initialize", "_x.ai/auth/getBearerToken"]);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn.mock.calls[0][1]).toEqual(["agent", "--no-leader", "stdio"]);
  });
  it("fails closed on unsupported method without surfacing response secrets", async () => {
    fixture((req) =>
      req.id === 1 ? { id: 1, result: {} } : { id: 2, error: { message: "secret fixture" } },
    );
    expect(await requestNativeToken()).toBeUndefined();
  });
  it("never accepts server initiated permission requests", async () => {
    fixture(() => ({ id: 44, method: "session/request_permission", params: {} }));
    expect(await requestNativeToken()).toBeUndefined();
  });
  it("times out and terminates a hung CLI", async () => {
    vi.useFakeTimers();
    const child = fixture(() => null);
    const pending = requestNativeToken();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeUndefined();
    expect(child.kill).toHaveBeenCalled();
  });
});

it("single-flights native refresh and enforces a cooldown", async () => {
  fixture((req) => ({ id: req.id, result: req.id === 1 ? {} : { result: { token: "fixture" } } }));
  const path = join(homedir(), ".grok", "auth.json");
  const first = refreshGrokToken(path);
  const second = refreshGrokToken(path);
  expect(first).toBe(second);
  expect(await first).toBe("fixture");
  expect(await refreshGrokToken(path)).toBeUndefined();
  expect(spawn).toHaveBeenCalledOnce();
});
it("never refreshes a foreign credential locator", async () => {
  expect(await refreshGrokToken("/different-account/auth.json")).toBeUndefined();
  expect(spawn).not.toHaveBeenCalled();
});
