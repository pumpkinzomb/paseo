# Development update discovery

`scripts/dev-update-discovery.mjs` supplies an opt-in polling controller. It never
pushes Git, changes the source working tree, switches the running release, or
terminates a process. The runtime supervisor owns application and restart policy.
A renderer candidate can be queued automatically only after exact compatibility
intent, isolated checks, and isolated launch validation. Full candidates require
an explicitly supplied full-stage adapter and remain subject to the supervisor's
separate daemon handoff gate.

## Integration contract

`createDiscovery({ config, control, readCurrent, validateLaunch, stageFull?,
fetch?, stageRenderer?, queue? })` returns `pollOnce()`, `start()`, and async
`stop()`. `pollOnce` is single-flight. `stop` prevents a completed in-flight stage
from subsequently queuing; it does not kill child processes or reopen an app.

Config fields:

- `enabled`: explicit opt-in.
- `remoteUrl`: pinned existing fork GitHub HTTPS URL, without credentials.
- `ref`: exactly `refs/heads/main`.
- `sourceRepository`: independent local repository containing the installed
  revision. Its objects seed the private bare cache read-only, allowing a remote
  behind the installed local release to be classified without a downgrade.
- `cacheRoot`: absolute canonical private directory, outside every protected
  source, release, control, daemon home, and Electron profile directory.
- `protectedPaths`: all those existing directories; callers must supply the full
  set. Validation rejects overlap in either direction and cache aliases.
- `releases`: the supervisor's canonical sealed-release directory.
- `pollIntervalMs`: default 5 minutes, clamped between 1 minute and 24 hours.
- `minFreeBytes`: reserve in addition to the size of a full independent base copy;
  default 8 GiB.

`readCurrent()` returns `{ id, digest, root, manifest, pending?, transition? }`.
It must read current state each time, not capture a startup snapshot. Queue ports
receive `(selection, { baseDigest, mode, candidateRevision })` and must atomically
verify that installed digest and pending/transition state still permit the queue.
The default queue adapter does this under the existing selection lock.

`validateLaunch({ root, candidate, current })` must start/check/stop **only an
isolated candidate profile**, using no live credentials or session copies. A
missing callback fails closed. It must finish cleanup before returning and must
throw on failure. Default renderer checks run app typecheck, changed-source lint
and formatting, and Vitest related tests with offline npm resolution. Tests here
inject lightweight validation ports; they do not claim a real Electron launch.

`stageFull` receives the same candidate/current/cache/release context. It must
verify and preserve the declaration, execute the existing full release checks,
and return `{ id, digest }`. The declaration is not permission to bypass any
runtime safety gate or execution approval.

## Publishing compatible source

Commit code in an independent checkout first. Then call
`prepareReleaseIntent({ repository, baseRevision, mode: "renderer" | "full" })`,
write its returned JSON to root `dev-update-release.json`, and commit that file.
The helper requires a clean checkout and does not write, commit, or push.
Publishing remains a separate authorized action.

The declaration binds schema version 1, exact installed `baseRevision`,
`stateCompatibility: "preserve"`, mode, and `contentDigest`. Digest is SHA-256 of
the deterministic Git recursive tree records (including names, modes, and blob
IDs), excluding only the root declaration itself. A later source change requires
a new declaration. Behind revisions are ignored; divergence, missing intent,
stale base/digest, or incompatible paths are rejected.

Renderer declarations may change regular files in `packages/app/src` and
`packages/app/assets`, plus documentation and the intent file. Symlink overlays,
dependency/native/config changes are rejected. Staging copies the current sealed
release independently and overlays only the eligible runtime files. Docs and
intent changes are recorded as provenance, not overlaid onto native release
bytes. Before sealing, the existing `isRendererOnly` check must prove every
non-renderer byte still matches the installed base.

## Durable recovery

`control/discovery.json` records checked revision/base, result, staged selection,
rejection reason, and retry time. A staged selection is persisted before queueing,
so interrupted queue operations reuse the verified artifact. Rejected staging
revisions are not rebuilt each poll; a corrected commit can be considered. An
operator can deliberately archive the discovery status to retry a repaired
validation environment. Network errors back off, capped at one hour. Lock files
are never automatically cleared. Failed staging directories are retained for
inspection, not deleted by discovery. There is no automatic cleanup of user
artifacts and no Git push operation in this module.

Focused regression command: `node --test scripts/dev-update-discovery.test.mjs`.
