# Explicit installed profile planning

`packages/desktop/src/profile/installed-profile.mjs` is a read-only, unconnected
bootstrap planning boundary. It does not create provisioning records, copy data,
start or stop a daemon, acquire Electron locks, or enable adoption.

Only a packaged `local-only` host may read the fixed
`<OS user home>/.paseo-installed/profile.json`. The parent directory must be
canonical, user-owned 0700; the no-follow opened file must be user-owned 0600,
single-link, bounded JSON. The record requires explicit approval, separate
canonical private userData/home directories and an exact loopback daemon
host/port/PID/instance/version. No fixed production port is assumed.

The host must supply trusted OS-local profile-owner and daemon inspections.
Manifest-supplied PIDs cannot prove absence of a profile owner. Unknown or active
owners are rejected. Daemon evidence must match current user, home, alive process,
instance identity, endpoint and application version. Renderer/browser inputs
must never supply these callbacks, home path, distribution or packaged state.

A successful result is only a plan: `activationReady` remains false and daemon
lifecycle is connect-only. The future bootstrap must acquire the actual exclusive
Electron userData lock before opening any database, then revalidate ownership and
daemon evidence under that lock. If another owner wins, exit without opening the
profile. Release all provisional resources on failure. Do not wire the plan to
start/stop commands or the development daemon handoff mechanism.

The future integration point is before the current main.ts userData selection
and before window/database creation. Its lifecycle must reuse the existing
non-owned-daemon behavior, not manufacture `ownedLaunch`. Development must never
read this manifest: `developmentProfilePaths` defines independent home/userData
for every canonical checkout digest, including main. This helper is not yet wired
to production or development bootstrap.

Provisioning UI/CLI, OS owner inspection, lock acquisition and real signed app
validation remain separate work. No production record has been created.

Missing provisioning returns `absent`, allowing bootstrap to retain its normal
unprovisioned behavior. Other errors must not silently fall back to opening a
possibly shared profile. This first boundary pins one daemon lifetime and exact
app version: a daemon restart (new PID/instance) or application version change
requires explicit reprovisioning. It does not yet solve profile continuity across
updates. A future compatibility contract must replace strict equality only with
independently validated daemon protocol/version evidence, never by ignoring it.

## Bootstrap coordinator (fixture-tested, not wired)

`installed-bootstrap.mjs` provides host-injected sequencing: preflight plan,
exclusive profile lease, revalidation, reversible pre-window profile selection,
connection to the existing daemon, then ownership assertion. Lock competition or
identity drift aborts before selection. Failure disconnects, restores selection
and releases the lease. Close is idempotent and disconnect-only; start/stop/restart
methods reject. No actual OS lock adapter or daemon transport is supplied.

Adapters must inspect other profile owners while recognizing their own exclusive
lease, and must not report `unowned` merely because a stale PID was recorded.
Selection must be atomic/reversible and occur before database/window creation.
The lock must cover the entire profile-use lifetime. Transport disconnect must
never stop the daemon. A changed version remains rejected until reprovisioned.

Actual integration still needs enforcement at main.ts userData selection
(currently around line 325), including rejection of conflicting packaged dev
profile environment overrides. Dev main checkout currently shares defaults; its
new independent resolver is not wired yet. `setupSingleInstanceLock` around line
928 permits `DISABLE_SINGLE_INSTANCE_LOCK`; installed adoption must never permit
that bypass. Guard daemon-manager startDaemon, stopDesktopDaemon,
stopCapturedDaemon and the corresponding IPC handlers, not just the coordinator's
public methods. These existing production paths are unchanged by this commit.

## Current minimal daemon-only bootstrap integration

The separate `registered-daemon.ts` path supersedes UI-profile adoption for actual
bootstrap integration: the installed app keeps its own Electron userData and
never copies or opens the development UI database. It reads only the fixed
`<OS home>/.paseo-installed/daemon.json` when package metadata is exactly local-only.
No provisioning record is written by this code. Missing registration preserves
existing defaults; invalid registration aborts startup before any window opens.

Registration pins private canonical daemon home, serverId, PID, startedAt,
loopback listen endpoint and exact app/daemon version. Actual local process
identity and CLI daemon-status evidence are checked at bootstrap and each status
or credential request. The existing daemon-status/start IPC returns the verified
endpoint and serverId (no hardcoded port). Renderer daemon-start-service already
constructs its connection from these fields. Credential handling remains on its
existing scoped IPC path; no credentials are added to public status metadata.

The actual daemon-manager now returns an existing registered connection from
start (never starts a new daemon), rejects stop/restart/stopCaptured operations,
and reports no owned desktop daemon for quit. It never creates ownedLaunch for
this connection. Registration refuses development home/userData overrides and
PASEO_DISABLE_SINGLE_INSTANCE_LOCK. Version or process lifetime mismatch remains
fail-closed and requires explicit reprovisioning.

This source wiring has not been built into or exercised in a signed Electron
app. Fixture and source-contract tests do not replace runtime IPC/renderer
validation. Full desktop TypeScript checking is pending dependencies/build
availability; the new registration module has an isolated strict typecheck.

Known remaining renderer integration: `DaemonStartService` still skips its
startup/upsert path when `manageBuiltInDaemon` is false. With its normal enabled
setting the registered start IPC is connect-only and returns the endpoint used
by upsert, but independent automatic connection with management disabled needs
an explicit follow-up path. No real renderer connection is claimed here.

## Explicit provisioning CLI

After this repository's CLI and server are built, use
`node scripts/provision-installed-daemon.mjs --home CANONICAL_HOME` for a read-only
plan. `--approve` performs the private atomic write; an existing registration also
requires `--replace`. No CLI path override is accepted. The executable derives
only this checkout's compiled daemon-control module and CLI, rejects aliased tool
paths, and checks local process evidence against CLI status twice before writing.
It does not print credentials or copy UI/session databases. A private provisioning
lock serializes writers; failures retain the old registration.

The CLI does not change daemon lifecycle ownership. A development-owned daemon
may still exit with its owning desktop when keep-running is disabled. Provisioning
alone cannot keep that process alive; its independent lifecycle must be decided
before production cutover. PID/startedAt/version changes require reprovisioning.
