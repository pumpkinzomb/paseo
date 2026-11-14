# Conversation-linked development review

Files and Changes can select the conversation directory or a linked development
workspace on the same host. Link a registered source by its displayed name and
path. The daemon accepts workspace IDs, resolves the directory itself, and stores
the association outside plugin metadata. Linking requires `workspace.manage`;
reading requires `workspace.read`. Links never change an agent's cwd or grant
file writes, execution, or permission to another host.

Only managed descendants of the conversation can appear as task scopes. A task
must share the linked source's canonical Git common directory. An unrelated
sibling is not admitted because it happens to use the same repository. Sources
must be registered canonical repository roots; symlink aliases and untrusted
change-request sources cannot be linked. Ordinary host permissions still apply.

## Review evidence

New managed worktrees pin their starting commit in Git administration metadata.
Use **Pin committed review** while the task directory still exists to retain its
base/head commit IDs, source workspace ID and repository identity in the workspace
registry. Capture before removing the task directory. Repeated captures retain
previous evidence; they do not rewrite an open file's pinned revision.

Legacy worktrees have a moving comparison ref rather than a pinned base. The
capture RPC/SDK accepts an explicitly reviewed full `baseSha` for those tasks;
it verifies that the commit exists and is an ancestor of the task head. It does
not guess a historical base from today's main. The normal button reports the
missing evidence instead of inventing it.

**Committed** means the captured objects are available. **Integrated** additionally
means the captured head is an ancestor of the selected retained source's current
HEAD. Agent completion, an empty uncommitted diff, or a removed branch does not
prove integration. Commit diff and historical file reads use the retained source
and captured SHAs after task branch/directory removal. Missing objects, records,
or a replaced repository produce an unavailable result. Review does not create,
remove or rewrite Git refs, branches, source, authentication or session history.
Keep unintegrated commits reachable separately; this feature does not prevent Git
object pruning or preserve a deleted workspace record.

## Client scope and limits

Links and evidence are durable. The shared Files/Changes selection lasts for the
current app session and is keyed by host and conversation. Opened review files
persist their own host/conversation/source/evidence identity. Switching the
selector cannot reinterpret them. A missing scope fails explicitly; it never
falls back to the conversation directory. Review source files use the existing
read-only source renderer and structured diff renderer, with no save/revert actions.

Visible active review panels on a connected host refresh their selected live
scope every five seconds. Hidden, backgrounded or disconnected panels stop this
demand. The source inventory refreshes on opening/remount or explicit Refresh;
it does not recursively watch every linked repository. File reads validate only
the selected scope. There is no new daemon watcher or subscription to leak.

Text reads and total diff output are limited to 4 MiB, with at most 100 untracked
files per diff. Binary files retain their inventory/status alongside text diffs;
opening a binary file in the source viewer reports unsupported. Oversized reads
and aggregate diffs report an error rather than silently presenting a complete review. Historical directory
entries have no working-file size or modification time. Image/document previews,
editable development source tabs, and automatic final capture at task retirement
are not provided by this surface.

The optional `developmentReview` capability gates the new RPCs. Older hosts keep
ordinary conversation Files/Changes and show update guidance for development
review; no alternate path-based request is attempted.
