const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

function readSettings(env) {
  const teamId = env.PASEO_SIGNING_TEAM_ID;
  const identity = env.PASEO_SIGNING_IDENTITY;
  if (!/^[A-Z0-9]{10}$/.test(teamId || "")) throw new Error("Expected explicit signing Team ID");
  if (
    typeof identity !== "string" ||
    !identity.startsWith("Developer ID Application: ") ||
    !identity.endsWith(` (${teamId})`) ||
    /[\r\n]/.test(identity)
  )
    throw new Error(
      "Expected matching Developer ID Application identity, not ad-hoc or development identity",
    );
  return { teamId, identity };
}
function verifyIdentityListing(settings, listing) {
  const lines = listing.split("\n").filter((line) => /^\s*\d+\) [A-Fa-f0-9]{40} "/.test(line));
  if (!lines.some((line) => line.endsWith(`"${settings.identity}"`)))
    throw new Error("Matching valid Developer ID signing identity/private key is unavailable");
}
function verifySignature(settings, listing, { requireRuntime = false } = {}) {
  if (
    !listing.split("\n").includes(`TeamIdentifier=${settings.teamId}`) ||
    !listing.split("\n").includes(`Authority=${settings.identity}`)
  )
    throw new Error("Signed code does not match the pinned Developer ID identity and Team ID");
  if (requireRuntime && !/flags=0x[0-9a-f]+\([^\n]*runtime/.test(listing))
    throw new Error("Hardened runtime is required");
}
function preflight(env = process.env, run = execFileSync) {
  const settings = readSettings(env);
  if (env.PASEO_DESKTOP_SMOKE === "1")
    throw new Error("Visible smoke launch is not part of signing preparation");
  const listing = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  verifyIdentityListing(settings, listing);
  return settings;
}
function notarizationPlan({ profile, archive, app }) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(profile || ""))
    throw new Error("Expected a Keychain profile name, not credentials");
  if (
    !path.isAbsolute(archive) ||
    !archive.endsWith(".zip") ||
    !path.isAbsolute(app) ||
    !app.endsWith(".app")
  )
    throw new Error("Expected absolute zip and app paths");
  return [
    ["xcrun", "notarytool", "submit", archive, "--keychain-profile", profile, "--wait"],
    ["xcrun", "stapler", "staple", app],
    ["xcrun", "stapler", "validate", app],
    ["spctl", "--assess", "--type", "execute", "--verbose=4", app],
  ];
}
function signatureCommand(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error("Signed bundle verification failed");
  return (result.stdout || "") + (result.stderr || "");
}
function verifyBundle(appPath, settings, run = signatureCommand) {
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "pipe",
  });
  // Inspect every Mach-O, including nested helpers and native modules. --deep is
  // verification only; electron-builder signs nested code inside-out normally.
  const magic = new Set([
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ]);
  let inspected = 0;
  let mainVerified = false;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const fd = fs.openSync(target, "r");
      const bytes = Buffer.alloc(4);
      try {
        fs.readSync(fd, bytes, 0, 4, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (!magic.has(bytes.toString("hex"))) continue;
      inspected++;
      const result = run("/usr/bin/codesign", ["-d", "--verbose=4", target], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const isMain = target === path.join(appPath, "Contents/MacOS/Paseo");
      verifySignature(settings, result, { requireRuntime: isMain });
      if (isMain) mainVerified = true;
    }
  }
  if (!fs.existsSync(path.join(appPath, "Contents/MacOS/Paseo")))
    throw new Error("Missing main executable");
  walk(appPath);
  if (!inspected || !mainVerified) throw new Error("No verified main Mach-O payload found");
}
module.exports = {
  readSettings,
  verifyIdentityListing,
  verifySignature,
  preflight,
  notarizationPlan,
  verifyBundle,
};
