const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("Invalid local source revision");
module.exports = {
  extends: path.join(__dirname, "electron-builder.yml"),
  appId: "sh.paseo.local",
  // Keep bundle executable names compatible with the existing helper/CLI packaging.
  productName: "Paseo",
  executableName: "Paseo",
  electronDist: path.join(path.dirname(require.resolve("electron/package.json")), "dist"),
  directories: { output: path.join(root, ".lab", "packaged") },
  publish: null,
  extraMetadata: {
    paseoDistribution: {
      schemaVersion: 1,
      channel: "local",
      updatePolicy: "local-only",
      sourceRevision,
    },
  },
  mac: {
    identity: "-",
    notarize: false,
    hardenedRuntime: true,
    target: [{ target: "dir", arch: [process.arch] }],
  },
};
