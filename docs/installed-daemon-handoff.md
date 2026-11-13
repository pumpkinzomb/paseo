# Inactive exact installed-daemon handoff

`installed-daemon-handoff.ts` is NOT connected to main/IPC or enabled in production.
It grants no general daemon lifecycle capability. The existing registered-daemon
connection-only stop/restart guard is unchanged.

The host must supply a verified exact candidate token, old/new revisions and exact
original UID/home/server ID/PID/start/listen/version. Only the new revision or
explicit original recovery revision can re-enter. A private fixed
`~/.paseo-installed/daemon-update-v1/hold.json` is exclusive-created and fsynced
before injected official stop. Re-entry checks the same hold and original
registration. The new instance must retain home/server ID/listen/UID and match
expected version. A durable exact receipt precedes injected registration CAS.
A matching receipt permits idempotent refresh only while that precise instance
is still present; another instance is never silently adopted.

The module uses no process-control implementation, script path, database copy,
userData mutation or provider call. Official stop/start, a cross-process exclusive
update fence and atomic registration CAS are injected contracts, NOT supplied
production adapters. Active-job admission/writer quiescence proof remains missing;
`verifyAdmission` must deny new work and establish real settlement, not trust UI
idle or a renderer boolean. Candidate authenticity/approval must be revalidated by
trusted main. Existing current registration parsing remains authoritative.

Records are immutable and never automatically reclaimed. Partial/torn records
fail closed. A crash after starting but before writing receipt requires explicit
recovery because ownership cannot be inferred from a new PID. A conflict or failed
start never overwrites registration. Completed handoff archival/next update,
versioned recovery authorization and production fence/CAS implementations remain
unwired. The API must not be advertised as production-ready.

Tests use synthetic temporary homes and injected lifecycle functions only.

## Private registration CAS adapter

`refreshInstalledRegistration` supplies the previously missing filesystem CAS
adapter, still not wired to production. It uses the official validator and the
same fixed `provision.lock` mkdir lock as `provision-installed-daemon.mjs`.
Exact durable hold/receipt, original record fields, raw preimage and inode are
checked before atomic rename. Replacement file and parent directory are fsynced.
The immutable private `registration-preimage.json` is retained; no auto-rollback
can overwrite a later registration. Failures/interruption retain the lock for
explicit recovery. Success removes only its own lock. A subsequent completed
receipt is handled by the handoff re-entry path, not by repeating raw CAS.

This excludes cooperative provisioning/CAS writers, not a malicious same-user
process that ignores the lock or swaps paths during filesystem checks. Receipt
verification proves binding to durable evidence, not that the daemon is still
alive; the trusted lifecycle adapter must revalidate that while holding its update
fence. Production admission, lifecycle and main authorization remain separate.

The Node CAS fixture first compiles only this module and its imported helpers to
ignored `.lab/registration-cas` with the existing donor TypeScript binary. It
exercises private tempfile homes, conflicts, immutable preimage, cooperative
concurrency, interrupted lock and symlink rejection; no live registration is read.

## Inactive host composition: daemon-only sequence

`runInstalledHandoffHost` now composes the exact handoff, real private store and
real registration CAS under a fixed private whole-run `handoff.lock`. It admits
only host-owned capability/revision and supplied official admission/lifecycle
functions. The stop adapter receives a durable-hold verifier to bind to
`commitToShutdown` with a daemon ticket. Any uncertain failure retains the host
lock; no PID-based stale reclamation is provided. Successful idempotent receipt
re-entry performs no additional daemon stop.

The integrated fixture uses the REAL UpdateAdmissionFence/quiescence module and
REAL temporary store/CAS, but FAKE exact stop/start functions. It proves new work
is denied in that fixture, not complete production ingress coverage. No CLI or
running daemon is contacted.

IMPORTANT: this composition is currently a contiguous daemon-only stop→start
sequence. It does NOT yet place Squirrel app replacement between those phases.
Production app+daemon update requires separate prepareStop and post-relaunch
resumeAfterReplacement contracts, durable exact lock ownership across relaunch,
and real official CLI/admission adapters. Do not connect the contiguous helper
to the production update button or treat it as completed app-update integration.

## Split replacement boundary

`installed-handoff-split.ts` now separates old-app `prepareInstalledReplacement`
from new-app `resumeInstalledReplacement`. Prepare requires exact old revision,
closes/probes admission through trusted daemon control, persists hold before stop,
then verifies absence and durably records `stopped.json`. It releases its lock only
on this confirmed boundary. Squirrel replacement belongs between the calls.
Resume requires the same capability and stopped receipt plus a separately verified
signed next (or explicitly authorized original recovery) revision. It never stops
an unexpected daemon. It starts the same home/server through the trusted lifecycle
adapter, writes receipt, then invokes the actual registration CAS adapter.

The split regression fixture uses real temporary files, admission quiescence and
registration CAS, but mocked lifecycle functions. The module is not connected to
IPC or actual packaged startup. `verifyApproval` must verify the running signature
and exact revision; the string `runningRevision` alone is not signature proof.
An uncertain failure (including after start and before receipt) retains its lock.
It does not blindly retry/fallback. The original recovery build path is tested
only from an already verified stopped boundary, not after unknown partial startup.
Existing installed binaries cannot honor these new boundaries until a coordinated
bootstrap release is deployed. No general daemon lifecycle permission is granted.

## Official bundled lifecycle adapter (not enabled)

`createOfficialDaemonLifecycle` now calls the existing real daemon-control APIs,
bundled runner resolver and bundled CLI status/stop paths. It is packaged-only,
has no arbitrary command/path parameter, and requires trusted main capability
verification, exact running-bundle revision/version verification, and committed
admission authorization. General registered-daemon connection-only guards remain
unchanged. Stop captures the original PID/start and uses official keep-terminals
RPC with force=false; start refuses an existing process and verifies the newly
spawned home/server/listen/UID/PID/start/version. Uncertain outcomes are not force
cleaned or silently adopted.

Still required: a trusted daemon admission transport that binds the exact update
ticket to this adapter's stop callback; actual signed bundle revision verification
and split Squirrel host wiring. The adapter is not registered on IPC. Its four
mocked unit tests cover denial and identity boundaries, not signed execution. The
separate official CLI tempfile test remains the only real process lifecycle
exercise so far; it does not prove this bundled Electron adapter's signed E2E.

## Main/startup coordinator

`createInstalledUpdateCoordinator()` returns null for an unpackaged app or absent
fixed `~/.paseo-installed/approved-update.json`; otherwise it returns `driver` and
`resumeIfPending()`. The private approved record has schemaVersion=1, approved=true,
teamId, bundleId=`sh.paseo.local`, candidateDigest (SHA-256 of the approved ZIP),
zipSha512, and exact capability. No path is accepted from renderer IPC. The only
archive is `candidates/<capability.token>/candidate.zip` under that private root.
The code checks approved archive hashes before offering/applying and verifies the
running .app with codesign Apple anchor/Team/bundle requirement and its sealed
package sourceRevision plus app version.

The real private update-control descriptor must match original UID/PID/start and
serverId and advertise daemonCommit. The coordinator publishes server approval,
requests a daemon-mode ticket, writes hold, commits through the existing mailbox,
and waits for that exact daemon to exit. It does NOT issue a second stop. It then
requests native Squirrel installation. Startup resume runs the signed revision
check and exact stopped-record split resume/CAS before ordinary registration
initialization. Incomplete holds and new revisions without stopped receipts fail
closed. Old startup without a pending hold is a no-op.

Four unit tests mock native signature/lifecycle edges and use private temp records;
they are not signed E2E. Actual admission testing currently reports built-in plugin
renderer-safety coverage unknown for document-preview/external-connections, even
with pluginsEnabled=false. This must be resolved truthfully, not bypassed. Signing,
production approval generation and production activation are not performed here.
