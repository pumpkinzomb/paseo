# Managed worktree dependency reclamation

Managed setup registers the canonical worktree identity and its preparation
receipt in the supervisor's `managed-worktrees` registry. Existing prepared
worktrees register on their next successful setup reuse. Arbitrary old checkouts
are not adopted or deleted.

After normal startup or a successful update, the supervisor checks registered
candidates. A failed replacement does not use the failed release as evidence.
The inspector verifies Git worktree membership, root identity, protected paths,
symlink aliases, a clean checkout, and HEAD ancestry in both local main and the
running release. Squash-equivalent but non-ancestor branches are skipped. Only
the managed receipt and setup lock are excluded from the dirty check.

When the daemon advertises reclamation support, a registry ID and deployment
evidence are sent through its verified local control channel. The daemon loads
the trusted helper and independently verifies the current sealed release, the
retained dependency donor, tracked installation inputs and the exact dependency
tree. Changed or unregistered dependency files prevent reclamation.

The final daemon gate requires no live agent runtime, running turn or terminal;
a quiet-looking chat is not sufficient. Final validation and dependency-root
rename happen synchronously under the daemon's admission fence. A durable
recovery marker is written before the first rename; partial failures roll back,
or leave a blocked recovery state if rollback cannot finish. No build outputs
are reclaimed: only receipt-registered dependency roots are eligible.

Detached dependencies go to a private same-volume retired transaction folder.
Purge runs in a separate Node subprocess, not the app's event loop. It validates
the donor and detached tree again and unlinks only registered artifacts; it never
recursively deletes the source worktree. Normal startup/update maintenance also
retries committed `retired`/`purging` transactions. A private PID/token writer lock
prevents concurrent purges; dead-owner takeover is serialized. An ambiguous
owner or interrupted takeover lock is retained for operator inspection. `prepared`, rolled-back or
recovery-required transactions are not automatically purged. Uncertain mailbox
outcomes are reported without immediately retrying the detach request.

Source, Git data and conversation history stay in place. Before an agent or
terminal reuses a retired workspace, the admission hook runs the trusted setup
helper. It restores from the receipt's retained verified donor using independent
copy-on-write reuse, with no installer fallback. If the donor is missing, inputs
changed or recovery is required, the operation remains blocked with an error.
History-only inspection does not prepare dependencies.

`managed-worktrees/last-result.json` records candidates, results and skip reasons.
Without a reclaim callback it explicitly reports inspection-only mode. A detached
result with `purgePending` does not prove disk cleanup finished; the transaction's
`purged` state is the completion evidence. Reported `logicalBytes` are file sizes,
not measured free-space gains: APFS copy-on-write blocks may still be shared.

This is a managed-workflow boundary, not OS sandbox enforcement. Arbitrary external
shell processes can still access files outside daemon admission. Metadata and
path checks detect many changes but cannot make hostile simultaneous filesystem
mutation impossible. All destructive validation tests use temporary fixtures.

## Retiring runtime releases

Use the supervised controller's `prune-releases` command to inspect old runtime
copies. It defaults to a read-only JSON plan and keeps the two most recently
modified directories in addition to all referenced releases:

```
node scripts/dev-update.mjs prune-releases --control /absolute/control \
  --releases /absolute/releases --keep 2 --exclude candidate-id
```

Repeat `--exclude` or supply comma-separated IDs to preserve operator candidates.
Selection history, pending/transition releases, controller metadata, managed
worktree restore donors, release recovery markers, process command lines and
open cwd/executable paths preserve their referenced releases. Unreadable metadata
or unavailable process inspection fails closed. Leases, stage/update operations
and ambiguous operation locks block the plan. Files and symlinks are never deletion
targets. A completed release's `release.json` dependency donor is provenance;
independent CoW copies do not need that donor to run or roll back. Restore markers
and receipts still preserve donors needed to recover missing dependencies.
Logical byte estimates are not guaranteed APFS free-space gains.

For deletion, first stop the supervisor and discovery watcher through their normal
operator flow, ensure no staging/update task is running, then rerun with `--apply`.
The command does not stop processes. It holds the selection lock, reinspects usage
before every deletion, and writes atomic before/after receipts under
`control/release-pruning/<transaction>.json`. A failed/interrupted receipt can
contain a partially deleted directory; inspect it before retrying. No receipt or
lock is written by dry-run. Concurrent external filesystem/process mutation is
outside this workflow's isolation; run apply only during an operator maintenance
window. Do not use this command to remove source worktrees or live state.
