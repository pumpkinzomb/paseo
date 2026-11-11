import { afterEach, describe, expect, it, vi } from "vitest";
const command = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: command }));
import { readCursorCliKeychainToken } from "./keychain.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  command.mockReset();
});

describe("Cursor CLI keychain access", () => {
  it("uses only the exact CLI service and account with a bounded command", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    command.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: " fixture-access-token\n" });
    });
    expect(await readCursorCliKeychainToken()).toBe("fixture-access-token");
    expect(command).toHaveBeenCalledWith(
      "/usr/bin/security",
      ["find-generic-password", "-a", "cursor-user", "-s", "cursor-access-token", "-w"],
      { timeout: 3000, maxBuffer: 65536, encoding: "utf8" },
      expect.any(Function),
    );
  });

  it("suppresses errors and captured output when missing, denied or timed out", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    command.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error("fixture-credential-in-error"));
    });
    expect(await readCursorCliKeychainToken()).toBeNull();
  });

  it("never runs security on non-macOS hosts", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(await readCursorCliKeychainToken()).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });
});
