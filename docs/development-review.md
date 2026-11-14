# Conversation-linked development review

Files shows one expandable tree for the viewed conversation. Its output directory,
connected source roots, delegated tasks and captured reviews are groups in the
same list. Expand folders inline; select a group, folder or file to make Changes
follow that work. Selecting conversation outputs returns Changes to that directory;
a non-Git conversation never borrows a task's diff.

Delegated managed-worktree creation records associations to registered source
workspaces under the existing creation admission fence. The host verifies the
source directory and managed main-repository placement against the task's canonical
Git repository. Source roots are not selected by renderer paths or arbitrary
workspace browsing. Existing approved links retain their pinned repository identity;
a replacement repository does not silently overwrite it.

Legacy groups can be derived from registered parent chains and verified managed
main-repository placement. List/read discovery does not write registry data, so it
remains safe while update admission is sealed. An unrelated sibling is excluded
even when it shares a repository. Untrusted sources and symlink aliases cannot
establish an association. Reads require `workspace.read`; creation, explicit
reviewed association and capture keep their existing mutation permissions. No
association changes an agent's cwd or grants file writes, execution or another
host's authority.

## Review evidence

New managed worktrees pin their starting commit in Git administration metadata.
The guarded SDK/lead workflow captures already committed content before the task
directory is removed; it does not create Git commits. It retains base/head commit
IDs, source workspace ID and repository identity in the workspace registry. Repeated captures retain
previous evidence; they do not rewrite an open file's pinned revision.

Legacy worktrees have a moving comparison ref rather than a pinned base. The
capture RPC/SDK accepts an explicitly reviewed full `baseSha` for those tasks;
it verifies that the commit exists and is an ancestor of the task head. It does
not guess a historical base from today's main. Missing evidence is reported rather
than invented. Ordinary Files/Changes has no capture action.

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

Associations and evidence are durable. Active tree work lasts for the app session
and is scoped by host and conversation. The primary Changes view follows that
active work rather than pinning the selection at the time it opened. File tabs
and explicitly focused/historical diff tabs retain their own immutable source
identity. Switching the tree cannot reinterpret them. Missing work stays unavailable
instead of falling back to another directory.

Conversation output browsing keeps the ordinary explorer's toolbar, sorting,
menus and file actions. Connected development roots use the same tree row pattern
and read-only source/diff renderers; they do not expose save or revert actions.

Visible active panels on a connected host refresh expanded live directories and
selected live content every five seconds. The related-group inventory refreshes
every ten seconds under the same activity gates. Collapsed development directories
unmount their demand; hidden, backgrounded and disconnected panels stop refresh.
Only related roots are inspected, with no host-wide repository candidate scan or
new daemon watcher. Individual reads validate the requested scope.

Text reads and total diff output are limited to 4 MiB, with at most 100 untracked
files per diff. Binary files retain their inventory/status alongside text diffs;
opening a binary file in the source viewer reports unsupported. Oversized reads
and aggregate diffs report an error rather than silently presenting a complete review. Historical directory
entries have no working-file size or modification time. Image/document previews,
editable development source tabs, and automatic final capture at task retirement
are not provided by this surface.

The optional `developmentReview` capability gates the new RPCs. Older hosts keep
ordinary conversation Files/Changes without a selector or development requests.
An already opened development tab on an older host shows update guidance; no
alternate path-based request is attempted.
