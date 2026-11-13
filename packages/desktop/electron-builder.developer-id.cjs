const path = require("node:path");
const base = require("./electron-builder.local.cjs");
const policy = require("../../scripts/signing/developer-id-policy.cjs");
const settings = policy.readSettings(process.env);
module.exports = {
  ...base,
  directories: { output: path.resolve(__dirname, "../../.lab/developer-id") },
  forceCodeSigning: true,
  beforePack: (context) => {
    if (context.electronPlatformName !== "darwin")
      throw new Error("Developer ID configuration is macOS only");
    policy.preflight();
  },
  afterSign: async (context) => {
    if (context.electronPlatformName !== "darwin")
      throw new Error("Developer ID configuration is macOS only");
    policy.verifyBundle(path.join(context.appOutDir, "Paseo.app"), settings);
    await require("./scripts/after-sign.js").default(context);
  },
  // Submission is a separate owner-authorized action, never a build side effect.
  publish: null,
  mac: {
    ...base.mac, // electron-builder selects the certificate class itself and rejects the prefix.
    identity: settings.identity.slice("Developer ID Application: ".length),
    hardenedRuntime: true,
    notarize: false,
  },
};
