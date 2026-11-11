# Opt-in development renderer update leases

The daemon implements an optional local file mailbox when the supervised launcher
explicitly sets `PASEO_DEV_UPDATE_DAEMON_CONTROL` to an absolute private directory.
Existing launches do not enable it. There is no TCP, session RPC or model-tool
update endpoint. Legacy daemons without the descriptor are unsupported, not idle.

## Controller contract

The 0600 `descriptor.json` advertises version 1, `generation` (UUID), `serverId`,
`workerPid`, `ttlMs:15000`, normalized PID-lock `instance`, `daemonIdentity`, and
`capabilities:{rendererLease:true,daemonCommit:false}`. The directory and generation
subdirectories are 0700 and owned by the same OS user. Public directories, symlink
requests, oversized requests and mismatched IDs are rejected, never repaired.

Identity is `JSON.stringify({pid,startedAt,hostname,uid,bootId,workerPid,generation})`
in that property order; absent bootId is null. Every operation rechecks PID-lock
identity. The launcher must also compare the descriptor with its owned daemon.

Requests: `<control>/<generation>/requests/<uuid>.json`, atomically published 0600:

    {version:1,id,operation,binding?,ticket?}

Responses at the matching `responses/<uuid>.json`:

    {version:1,id,ok:true,result}
    {version:1,id,ok:false,error:{code:"update_blocked",message}}

`binding` is `{mode:"renderer",daemonIdentity,candidateDigest}` (lowercase SHA-256).
`prepare` returns a ticket adding `{token,expiresAt,epoch}`. `inspect` returns that
ticket plus `phase`; strip phase before using the strict ticket request schema.
`commit` revalidates safety and returns the ticket while keeping the daemon running
and admission fenced. `renew` returns an updated ticket with 15-second expiry,
bounded to 600 seconds from preparation. `abort` returns `{released:true}` and
reopens admission. The controller renews every 3 seconds, checks immediately before
native commit, and releases after verified replacement UI readiness. Invalidated,
expired or uncertain leases must never authorize a later cutover. Requests/results
remain as private audit files; no stale generation is automatically deleted.

## Safety boundary

The fence covers central session mutation dispatch (retryable error retains the
request ID), AgentManager lifecycle/foreground admission and provider prompts,
browser command execution, schedule tick/manual claims, queued message dispatch,
and finish subscription registration/start. Scheduled/durable delivery work is
retained and retried, not acknowledged or discarded on denial. Existing admitted
work blocks prepare immediately; it is not forcibly drained. Read/subscription and
health requests needed by replacement UI startup remain available. Nonretryable
one-way input (including terminal bytes) and urgent cancellation/permission replies
interrupt and release the renderer fence, invalidate the ticket epoch, and are
delivered normally. They are never silently discarded. This interruption rule is
renderer-only; a future irreversible daemon stop needs a separate terminal ingress
handoff boundary. Terminal resize (JSON and binary), terminal listing and output
subscriptions remain available during renderer restoration without invalidating the
lease; these do not create or terminate retained PTYs. Binary terminal input and
file-transfer frames are delivered unchanged while revoking the renderer lease.

Every runtime must have persisted continuity metadata, known provider stop safety,
and no pending work according to AgentManager cleanup eligibility. Provider veto,
unknown safety, permissions, lifecycle/event tails and changing runtime membership
block. Provider events invalidate the epoch without dropping their events. Expiry
and abort release the fence; a normal daemon shutdown explicitly revokes its lease.

Unknown/external plugin runtimes, active plugin events, connected-host routes, pending browser commands,
queued/dispatching messages, finish watches/tasks and schedule work are explicit
blockers. Retained session operations, including file uploads and voice/dictation,
also block until their completion or cancellation cleanup has settled, not merely
until the initial JSON request returns. This first version does not try to pause opaque plugins or routed hosts. Only the
explicit reviewed bundled provider/usage/worktree registrations launched through
`startBuiltinPlugin` may remain idle with the retained daemon. Matching an ID alone
is insufficient; registration changes, pending invocations, subscriptions and
provider connections veto. New plugin requests/events/catalog changes interrupt
the renderer lease before proceeding. No plugin is stopped by this exception.
The reviewed set is Antigravity, fx, Hoplite and Muse provider adapters; Claude,
Codex, Copilot, Cursor, Grok, Kimi, MiniMax, OpenCode Go and Z.ai usage sources;
and the worktree-include hook. Muse retains its accompanying usage registration.
Local catalog/list/provider-snapshot reads do not revoke the lease; usage fetches
and arbitrary plugin invocations are not reclassified as metadata reads.
The native side independently checkpoints drafts and guards browser/input activity.
This lease alone does not prove browser or renderer state preservation.

## Deliberately unsupported

Full automatic daemon replacement remains disabled. Although the generic primitive
can invoke a supplied `stop({keepTerminals:true})`, bootstrap never supplies a working
full-stop callback and rejects daemon-mode requests. Existing supervisor shutdown
has a forced timeout, which is not acceptable for autonomous terminal-preserving
replacement. A real no-force ownership/handoff path and isolated PTY adoption test
are required first. SIGTERM is not terminal preserving. `agents.resumeOnStartup`
is not a continuity guarantee.

Focused tests cover mailbox permissions/schema, token/identity/digest, expiry,
renewal, provider veto, epoch invalidation, concurrent admission, central Session
retry responses, browser execution, and durable schedule/message/finish deferral.
Actual Electron+daemon retained-update E2E is a separate required release check.
