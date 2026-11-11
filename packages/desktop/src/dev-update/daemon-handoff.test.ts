import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDevUpdateDaemonHandoff, writeDevUpdateDaemonOwnership } from "./daemon-handoff.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "paseo-daemon-handoff-")),
  );
  directories.push(directory);
  fs.chmodSync(directory, 0o700);
  const instance = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    uid: process.getuid!(),
    hostname: os.hostname(),
    serverId: "server-1",
    listen: "127.0.0.1:6799",
    desktopManaged: true,
  };
  const input = {
    isPackaged: false,
    directory,
    generation: "generation-1",
    home: path.join(directory, "home"),
    instance,
  };
  const record = { schemaVersion: 1, generation: input.generation, home: input.home, instance };
  const filename = path.join(directory, "daemon-handoff.json");
  const write = (value: unknown = record) =>
    fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
  write();
  return { input, record, filename, write };
}

describe("retained daemon ownership capability", () => {
  it("publishes a private ownership receipt with the actual instance", () => {
    const f = fixture();
    f.write({ ...f.record, instance: { ...f.record.instance, listen: "remote:9999" } });
    writeDevUpdateDaemonOwnership(f.input);
    const receipt = path.join(f.input.directory, "daemon-owned.json");
    expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toEqual(f.record);
    expect(fs.statSync(receipt).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(f.input.directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses stale ownership and cleans temporary files when publication fails", () => {
    const f = fixture();
    expect(() => writeDevUpdateDaemonOwnership({ ...f.input, generation: "wrong" })).toThrow();
    const receipt = path.join(f.input.directory, "daemon-owned.json");
    expect(fs.existsSync(receipt)).toBe(false);
    fs.mkdirSync(receipt);
    expect(() => writeDevUpdateDaemonOwnership(f.input)).toThrow();
    expect(fs.statSync(receipt).isDirectory()).toBe(true);
    expect(fs.readdirSync(f.input.directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("returns the live instance, never the recorded endpoint", () => {
    const f = fixture();
    f.write({ ...f.record, instance: { ...f.record.instance, listen: "remote:9999" } });
    expect(readDevUpdateDaemonHandoff(f.input)).toBe(f.input.instance);
  });

  it.each(["pid", "startedAt", "uid", "hostname", "serverId", "desktopManaged"] as const)(
    "rejects mismatched %s",
    (key) => {
      const f = fixture();
      const replacements = {
        pid: 999999,
        uid: 999999,
        startedAt: "different",
        hostname: "different",
        serverId: "different",
        desktopManaged: false,
      };
      f.write({ ...f.record, instance: { ...f.record.instance, [key]: replacements[key] } });
      expect(readDevUpdateDaemonHandoff(f.input)).toBeNull();
    },
  );

  it.each([
    null,
    {},
    { schemaVersion: 2 },
    { generation: "old" },
    { home: "/other" },
    { instance: null },
  ])("rejects malformed or stale records %j", (patch) => {
    const f = fixture();
    const value = patch && Object.keys(patch).length ? { ...f.record, ...patch } : patch;
    f.write(value);
    expect(readDevUpdateDaemonHandoff(f.input)).toBeNull();
  });

  it("rejects malformed JSON, oversized files, missing files, and directories", () => {
    const f = fixture();
    for (const content of ["{broken", " ".repeat(4097)]) {
      fs.writeFileSync(f.filename, content);
      expect(readDevUpdateDaemonHandoff(f.input)).toBeNull();
    }
    fs.unlinkSync(f.filename);
    expect(readDevUpdateDaemonHandoff(f.input)).toBeNull();
    fs.mkdirSync(f.filename);
    expect(readDevUpdateDaemonHandoff(f.input)).toBeNull();
  });

  it("rejects public directories and symlink files or ancestors", () => {
    const f = fixture();
    fs.chmodSync(f.input.directory, 0o755);
    expect(readDevUpdateDaemonHandoff(f.input)).toBeNull();
    fs.chmodSync(f.input.directory, 0o700);
    fs.renameSync(f.filename, `${f.filename}.real`);
    fs.symlinkSync(`${f.filename}.real`, f.filename);
    expect(readDevUpdateDaemonHandoff(f.input)).toBeNull();
    fs.unlinkSync(f.filename);
    f.write();
    const parent = fixture().input.directory;
    fs.symlinkSync(f.input.directory, path.join(parent, "alias"));
    expect(
      readDevUpdateDaemonHandoff({ ...f.input, directory: path.join(parent, "alias") }),
    ).toBeNull();
    const nested = path.join(f.input.directory, "nested");
    fs.mkdirSync(nested, { mode: 0o700 });
    fs.copyFileSync(f.filename, path.join(nested, "daemon-handoff.json"));
    expect(
      readDevUpdateDaemonHandoff({ ...f.input, directory: path.join(parent, "alias", "nested") }),
    ).toBeNull();
  });

  it("requires supervised development and a live managed instance", () => {
    const f = fixture();
    for (const patch of [
      { isPackaged: true },
      { directory: undefined },
      { directory: "relative" },
      { generation: undefined },
      { instance: null },
      { instance: { ...f.input.instance, desktopManaged: false } },
    ])
      expect(readDevUpdateDaemonHandoff({ ...f.input, ...patch })).toBeNull();
  });
});
