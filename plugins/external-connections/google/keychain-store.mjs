import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export class GoogleKeychainError extends Error {
  constructor(code) {
    super(code);
    this.name = "GoogleKeychainError";
    this.code = code;
  }
}

/** helperPath must come from the trusted app package, never plugin/user settings. */
export function createGoogleKeychainStore({
  helperPath,
  spawnProcess = spawn,
  timeoutMs = 5000,
  verifyHelper = () => {},
}) {
  if (typeof helperPath !== "string" || !isAbsolute(helperPath))
    throw new GoogleKeychainError("INVALID_HELPER_PATH");
  function invoke(operation, account, value) {
    if (typeof account !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(account))
      throw new GoogleKeychainError("INVALID_ACCOUNT");
    if (
      operation === "write" &&
      (typeof value !== "string" || !value || Buffer.byteLength(value) > 16384)
    )
      throw new GoogleKeychainError("INVALID_VALUE");
    return new Promise((resolve, reject) => {
      let child;
      try {
        verifyHelper();
        child = spawnProcess(helperPath, [], {
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
          env: {
            PATH: "/usr/bin:/bin",
            HOME: process.env.HOME,
            USER: process.env.USER,
            TMPDIR: process.env.TMPDIR,
          },
        });
      } catch {
        reject(new GoogleKeychainError("KEYCHAIN_HELPER_UNAVAILABLE"));
        return;
      }
      let finished = false;
      let output = "";
      let size = 0;
      const timer = setTimeout(() => fail("KEYCHAIN_HELPER_TIMEOUT"), timeoutMs);
      function fail(code) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill();
        reject(new GoogleKeychainError(code));
      }
      child.on("error", () => fail("KEYCHAIN_HELPER_UNAVAILABLE"));
      child.stdin.on("error", () => fail("KEYCHAIN_HELPER_UNAVAILABLE"));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > 65536) {
          fail("KEYCHAIN_INVALID_RESPONSE");
          return;
        }
        output += chunk.toString("utf8");
      });
      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        let result;
        try {
          result = JSON.parse(output);
        } catch {
          reject(new GoogleKeychainError("KEYCHAIN_INVALID_RESPONSE"));
          return;
        }
        if (!result || typeof result !== "object") {
          reject(new GoogleKeychainError("KEYCHAIN_INVALID_RESPONSE"));
          return;
        }
        if (operation === "read" && result.status === "not_found" && code === 1) {
          resolve(null);
          return;
        }
        if (code !== 0 || result.status !== "ok") {
          reject(new GoogleKeychainError("KEYCHAIN_UNAVAILABLE"));
          return;
        }
        if (operation === "read") {
          if (
            typeof result.value !== "string" ||
            !result.value ||
            Buffer.byteLength(result.value) > 16384
          ) {
            reject(new GoogleKeychainError("KEYCHAIN_INVALID_RESPONSE"));
            return;
          }
          resolve(result.value);
        } else {
          resolve(undefined);
        }
      });
      child.stdin.end(JSON.stringify({ operation, account, value }));
    });
  }
  return {
    read: (account) => invoke("read", account),
    write: (account, value) => invoke("write", account, value),
    delete: (account) => invoke("delete", account),
  };
}
