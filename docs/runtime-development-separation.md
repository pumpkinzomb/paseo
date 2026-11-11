# Runtime and development separation

## Purpose

An agent improving Paseo must not rewrite the files used by its own running UI,
daemon, or dependency tree. A separate branch alone is insufficient if both
processes consume the same `dist`, `node_modules`, Metro source, ports, or state.

## Local layout

- Original checkout: retained as a preserved in-progress source set. It contains
  user browser changes and unfinished manager isolation work. Do not build it
  into the running app, discard it, or reset it to match the new lab.
- Development lab: a separate Git worktree from the reviewed main checkpoint.
  Dependencies are independent APFS copies (not a shared node_modules link).
  Builds affect this checkout only.
- Stable release: separately staged source and compiled artifacts, plus its own
  independent dependencies. Agents do not develop against this directory.
- Production state: kept at its existing path until a deliberate data migration.
  Release switches should change code, not copy auth or session data.

Local absolute paths are in ignored `.lab-config.json`, not in Git.

## Lab commands

Use Node 22.20.0, then:

```
node scripts/isolated-lab.mjs check
node scripts/isolated-lab.mjs build
node scripts/isolated-lab.mjs desktop
```

The lab uses daemon 6778 and Metro 8092, never 6767/6768/8082/8084. Its Paseo home
and Electron user data live under its own `.lab`. No live-data seeding is allowed.
An occupied port is an error, never an instruction to kill another process.
The helper does not isolate provider credentials or the OS filesystem. Agent
model isolation is a separate, still-unverified feature and is not enabled here.

## Release procedure

1. Finish changes in the lab. Run focused tests plus type/lint/build checks.
2. Stage a new versioned release; do not overwrite the active release in place.
3. Verify internal workspace links resolve within that release, not the lab or
   original checkout. Record code/artifact hashes and the exact test result.
4. Require no running/approval/background agent tasks before daemon cutover.
   Preserve an exact old-release pointer and backup current durable metadata.
5. Switch launcher only to the verified release, reusing the same live data.
6. Verify session IDs, current workspace, expected model and basic navigation.
   If startup fails, restore the previous release pointer; never delete data.
7. Keep previous release until rollback is no longer needed. A native provider
   migration or schema change may need a distinct rollback plan.

Both the UI and daemon must consume independent runtime copies; separating only
the recovery UI is insufficient. The opt-in supervised development updater below
automates relaunch, but never forces an active daemon or window to stop.

## Verification scope

`isolated-lab.test.mjs` uses temporary filesystem fixtures to exercise path,
port, dependency-link and inherited-environment rejection. It does not launch
real providers. A successful lab build proves output separation, not browser,
provider, authentication, migration or security equivalence.

## Self-development policy

`isolated-lab.mjs` now sets `PASEO_SELF_DEVELOPMENT_POLICY` to JSON with
`labRoot` and `protectedRoots`. The server validates real paths, including symlink
aliases and nonexistent descendants. AgentManager rejects new agent creation in
protected roots before deleting/creating state. This covers Paseo-managed parent
and child creation, not native provider subagents or arbitrary shell commands.
All provider launch configurations receive daemon guidance to perform Paseo
self-development and delegation in the lab. Existing native session cwd is never
silently moved. An existing record with no native session needs a fresh creation,
so a protected cwd will be rejected in that case too.

Other project paths remain allowed. The policy is opt-in; unrelated installations
without this environment setting are unchanged. The stable launcher must also set
the policy for its daemon; setting it only in the lab does not protect agents
running in the stable application. Autonomous promotion remains a separate
approved operation with complete work checks, backup and hash-verified rollback.
Local cutover scripts are one-shot operations, not general deployment commands.
The opt-in update supervisor below can promote validated renderer releases.
This development policy itself does not provide OS-level write/process restrictions.

Explicit user operations, including restart, are evaluated against their scope
and effects rather than refused by the autonomous-development default. Check
running work and saved state, then use the supported operational path. Explain
concrete interruptions and obtain only a missing decision or required approval.
A restart request does not authorize unrelated deployment, discarded work or
forced termination of unknown processes. Tool permissions and access denials
still apply. This guidance does not install a restart supervisor or make an
unfinished deployment path safe.

## Stable launcher

`scripts/launch-stable-runtime.mjs` is the maintained version of the installed
Desktop shortcut target. It reads local `workspaces/paseo-runtime-control/active.json`,
verifies release/UI hashes and allows a separately versioned `daemonRelease`.
`selfDevelopmentPolicy` contains the absolute lab path and protected roots, and
is passed to a cold-started daemon. Existing daemons are not silently restarted
by the launcher; policy changes require the approved promotion procedure above.
`--check` verifies files without starting processes. Do not commit active.json,
local data, auth, or machine-specific paths. The installed copy must be updated
only through the operator deployment path, not an agent development task.

## Supervised development updates

`scripts/dev-update.mjs` is an opt-in development-runtime launcher and updater.
It is separate from the packaged Electron updater and does not patch Metro source
in place. Installing it is a deliberate launcher change: existing launchers and
running apps are not adopted or modified by `init`.

The supported behavior is conservative:

- A validated release can be queued while the application is in use.
- If only renderer source/assets changed, the desktop automatically hands off
  after every app window and browser guest has already closed. It retains the
  daemon and verifies its identity across handoff. It never closes a window,
  reloads a browser form, or assumes an unsent draft was saved.
- Native, dependency, configuration or daemon changes wait for a normal app quit
  and confirmed daemon exit. The supervisor then starts the new release without
  another launch click. A surviving daemon, including `Keep running after quit`,
  blocks full replacement. Active agents, terminals and background work are not
  interrupted to make an update happen.
- The default remains update-on-exit. An additional renderer-only opt-in below
  can automatically restart safe open windows while retaining the same daemon.
  Full daemon/native/dependency replacement still requires normal quit.
  Local releases can be queued explicitly or by the independent discovery watcher.
  There is no model-callable deployment endpoint.

### Stage and validate

Commit changes in an independent development lab. Stage with:

```
node scripts/dev-update.mjs stage --source /absolute/lab \
  --releases /absolute/releases --id update-<commit> --state-preserving
```

The source commit is cloned without hardlinks into a new staging directory before
validation. Dependencies are installed from the lockfile there, and Electron's lazy binary download is completed and checked before sealing. Server/app/desktop
builds, repository typecheck/lint/format and focused updater tests run in that
snapshot. The command refuses a dirty source tree and never copies live state,
authentication, `.env` files or existing dependencies. A failed check leaves an
unselected staging directory for diagnosis. Successful staging emits the release
ID and manifest digest to pass to `init` or `queue`.

`--state-preserving` is an operator assertion made after reviewing the changes:
there must be no incompatible state migration. The updater cannot infer that from
tests and does not support data/schema rollback. The complete staged tree is
hashed, including dependencies, links and executable bits. npm-created hardlinks are detached into independent files before hashing.
Escaping symlinks and any remaining shared hardlinks are refused. Only Metro's `.expo`, generated `expo-env.d.ts` type stub, and dependency cache
directories are mutable. Versioned releases must not be edited after registration.

### First installation

Create a configuration JSON outside the source/release/state directories:

```
{
  "schemaVersion": 1,
  "releases": "/absolute/releases",
  "home": "/absolute/existing-paseo-home",
  "userData": "/absolute/existing-electron-profile",
  "serverId": "existing-server-id",
  "daemonPort": 6768,
  "metroPort": 8084,
  "selfDevelopmentPolicy": {
    "labRoot": "/absolute/lab",
    "protectedRoots": ["/absolute/releases", "/absolute/control"]
  }
}
```

`enableLocalInspection: true` preserves an already-authorized local debugging
workflow by assigning an ephemeral loopback DevTools port. It is off by default.
Do not enable it as a new security setting without the user's approval.

Use the same existing home/profile/server identity; do not copy sessions or auth.
Managed daemon launches intentionally ignore listen/CORS environment overrides.
The existing home's persisted `daemon.listen` must exactly match the configured
loopback port, and `daemon.cors.allowedOrigins` must permit the Metro localhost
origin. Startup validates these without modifying them. Any required security
setting change needs the user's approval through the supported settings flow.
Choose non-overlapping, canonical absolute paths. The control directory must be
owned by the user with mode 0700. `init` creates it with that mode if absent; it
never changes permissions on an existing directory.

```
node scripts/dev-update.mjs init --control /absolute/control \
  --config /absolute/config.json --release update-<commit> --digest <digest>
node /absolute/control/controller/dev-update.mjs start --control /absolute/control
```

For an explicitly reviewed first installation that must retain the existing
managed daemon, `init --retain-current-daemon` captures its actual identity from
the configured home. It is a one-use bootstrap grant bound to the selected digest,
not permission to adopt a future PID or a replacement daemon. Use it only after
reviewing UI/daemon compatibility and arranging for the old desktop to quit without
stopping that daemon. The new desktop receives a private generation-bound identity
handoff and restores normal quit ownership. Startup requires the desktop to acknowledge
the exact adopted identity before consuming bootstrap or reporting success. A retained daemon is never automatically
restarted for a version mismatch. Never assume empty/unavailable work inventory.

Without that explicit bootstrap option, before the **first start**, normally quit the previous app and stop its daemon
through the existing supported flow when the user is ready. The new supervisor
refuses an existing daemon or occupied Metro port, rather than guessing ownership
or killing it. Repoint the user's launcher separately after startup verification.
`start` launches a detached supervisor, so an updating agent can finish its turn
without owning the restart process. A launch PID is not a success confirmation.

### Safe automatic renderer restart

After installing a matching controller, desktop, renderer and daemon, opt in with
`"automaticUpdates": {"enabled": true, "mode": "renderer"}` in the private
supervisor configuration. Installing only an app release does not upgrade the
external controller or add a lease capability to an already-running older daemon.
The first adoption therefore needs one reviewed normal quit/start. The control
path and existing home/profile stay unchanged; do not copy credentials or state.

A compatible renderer-only queued release can then restart automatically, without
asking the user to close the window. Before normal UI quit, it requires all of:

- An authoritative short-lived lease from the same daemon generation. Active or
  unknown agent/provider work, pending deliveries, uploads and other mutations
  defer the update. The lease is renewed across restart; the daemon is not killed.
- A focused, restorable workspace with strictly persisted draft and selection
  checkpoints. Recent input, pending UI operations and unsaved/unknown form state
  defer it. A five-second native countdown supports cancellation, and final input
  sealing closes the gap between saving drafts and committing the restart.
- Fresh browser-frame evidence with no editing surface, capture, media, download
  or automation in progress. Static browser pages can restore; arbitrary forms,
  including search pages and unknown frames, are deliberately not treated as safe.
- Matching generation/digest/prepare-token receipts and the same retained daemon
  before and after replacement startup. Unsupported capability, uncertainty or
  timeout never becomes a force-stop fallback.

Cancellation suppresses that exact pending digest across supervisor restarts.
The release remains pending and can still apply after the user's normal quit.
Unsafe open-window updates remain pending and are retried with a cooldown, not
forced. Native, server, configuration and dependency changes use the normal-quit
path even when this option is on. `mode: "full"` is rejected.

This is a bounded safe renderer restart, not seamless active-job migration or
preservation of arbitrary browser forms. It does not claim full daemon hot swap.
A failed or uncertain relaunch follows the recovery procedure below and preserves
both the selection history and current user data.

### Opt-in update discovery

The separate watcher adds source detection and validation. It only queues a
release; the supervisor applies the configured normal-quit or safe-renderer policy.
The watcher itself does not close a window or stop a daemon.
Create private `control/update-discovery.json` after reviewing the source channel:

```json
{
  "enabled": true,
  "remoteUrl": "https://github.com/OWNER/paseo.git",
  "ref": "refs/heads/main",
  "sourceRepository": "/absolute/development-checkout",
  "cacheRoot": "/absolute/private-update-cache",
  "pollIntervalMs": 300000
}
```

The cache must be outside source, release, control and user-state directories.
Use a controller containing the discovery modules; installing a source change in
an app release does not replace an older independently installed controller.

```
node /absolute/controller/dev-update.mjs check-updates --control /absolute/control
node /absolute/controller/dev-update.mjs start-update-watch --control /absolute/control
```

`check-updates` performs one check. `start-update-watch` starts an independent
background process; verify `status` for its first result, not merely its launch
PID. It polls the pinned fork's main branch and only queues fast-forward releases
with a reviewed content-bound preservation declaration after validation. See
[the release declaration workflow](dev-update-discovery.md). Arbitrary main
commits, diverged history, missing declarations and failed validation stay unapplied.

Queued changes use the configured supervisor policy above. The watcher does
not install an OS login service, force an open app to exit, or implement full-daemon
hot replacement. Its lock is not automatically cleared after an uncertain exit.

### Queue and inspect

```
node /absolute/control/controller/dev-update.mjs queue --control /absolute/control \
  --release update-<new-commit> --digest <new-digest>
node /absolute/control/controller/dev-update.mjs status --control /absolute/control
```

One pending update is supported. Repeating the exact request is idempotent; a
new request cannot overwrite a pending or interrupted deployment. Status reports
waiting-for-windows, waiting-for-app-quit, waiting-for-daemon-stop, automatic-update
(with preparation, cancellation or blocker details), or a recovery error. The
command/status output is the operator feedback surface; the native automatic
restart countdown is not a general discovery/build progress UI. The daemon's normal auto-start setting must be enabled
for readiness to complete.

### Failure and recovery

The supervisor owns only its spawned Metro/Electron children. It never signals
a discovered daemon, force-kills a timeout, or rolls stored messages/drafts back.
Selection changes only after Electron's first document finishes loading,
bootstrap completes, and the daemon reports the configured identity/listen address.
This checks startup, not React rendering, provider behavior or the user's complete
workspace state.

A failed or uncertain launch retains the old committed selection and a durable
transition/lock. An alive candidate is left for inspection instead of being killed
for rollback. Never delete a lock based on its age or PID alone. Operator recovery
must first reconcile the recorded generation/processes, normally close surviving
owned windows and stop their daemon when safe, inspect the failure, then choose
the retained previous or candidate release. Restore only code selection, never old
user-data snapshots. There is no automatic force-clear or automatic data rollback.

The implementation has focused filesystem and real child-process coverage; the
desktop handoff is also exercised in the existing isolated Electron startup suite.
A successful test does not install this controller or prove a live cutover.
