# Managed worktree maintenance inspection

Managed setup registers the canonical worktree identity and a digest of its
preparation receipt in the supervisor's `managed-worktrees` registry. Existing
managed worktrees are registered on the next successful setup reuse; arbitrary
old checkouts are not discovered or adopted.

After normal supervisor startup or a successful update, the supervisor queues a
read-only inspection. A failed replacement does not inspect the failed release.
Inspection is independent of runtime status and failures do not stop the app.

The inspector checks Git worktree membership, root identity, protected paths,
symlink aliases, uncommitted changes, and whether HEAD is an ancestor of both
local main and the running release's source revision. Patch-equivalent squash
merges are conservatively skipped. Only the managed receipt and setup lock are
excluded from the untracked-file check; other unknown files prevent eligibility.

`managed-worktrees/last-result.json` reports each candidate or skip reason and
explicitly sets `inspectionOnly: true` and `automaticReclamation: false`.
`maintenance-error.json` records a registry/inspection failure separately from
runtime health. It is a historical error record, not the current app status.

**No files are reclaimed by this implementation.** Even an eligible candidate
reports `exclusive-maintenance-lease-unavailable`. A quiet session snapshot is
not an exclusive lease: sessions, terminals, scheduled tasks and builds must all
be prevented from starting against a worktree while reclamation is underway.
The current daemon does not provide that complete admission gate.

A later reclamation phase must add that gate, recheck all evidence under the
lease, preserve source and conversation history, restrict removal to registered
reproducible artifacts, and implement dependency restoration on resume. Neither
agent completion nor removing a completed task card authorizes filesystem
cleanup. This inspection does not enforce restrictions on arbitrary shell use.
