# Session-owned generated outputs

Generated handoff patches, logs, screenshots, reports and document preview copies
have a lifecycle separate from source code and authoritative user documents.
`prepare_task_artifacts` obtains a marked output directory below the agent's
recorded project/workspace cwd:

```
.paseo-task-artifacts/<sha256(workspaceId)>/
  .paseo-owner.json
  ...generated output...
  .paseo-document-previews/...
```

The host supplies the workspace identity, never a renderer/tool-selected cleanup
path. Model segments in one workspace share an owner; separate workspaces remain
separate even when their cwd is identical. Preview tools select this directory
automatically. Their local source files are still resolved against the original
workspace, not the cache directory. The Files sidebar can browse the normal
nested directory, and existing file citations/preview viewers retain their paths.

Lead instructions require the preparation tool before writing disposable task
outputs. Arbitrary shell writes outside that directory are **not** automatically
adopted, attributed or deleted. This is lifecycle ownership, not a filesystem
sandbox. The tool does not grant permissions. Source changes still belong in
reviewed development worktrees and Git commits, not disposable output directories.

## Removal

Permanent deletion of a complete, confirmed session group (or project groups)
closes its idle runtimes and verifies exact membership before considering cleanup.
The manager preflights every owned tree before native deletion, then revalidates
and removes those trees before deleting Paseo records. A cleanup failure in the manager is
reported before local records are removed. Final group cleanup failure keeps the
workspace visible for review; partial results must be checked before retry. If native deletion already
succeeded, its existing durable receipts prevent repeating an uncertain deletion.

Archive, restoration and individual-agent deletion do not remove group output.
Native originals are removed only when separately approved by the existing
native-deletion contract. No source root, worktree, installed app, auth/settings
home, shared parent directory, other workspace output, attachment store or legacy
unmarked output is recursively removed by task cleanup. Missing old workspaces
are a no-op. Ownership mismatch, unmarked directories, symbolic links, hard-linked
files and nonregular entries fail closed for operator review.

Removing a temporary output file manually or running arbitrary concurrent native
writers is outside this ownership protocol. Do not put documents intended to
survive session deletion in this directory. Archive the session or save those
documents to their project instead.

## Legacy shared output

Old root-level `artifacts/` and `.paseo-document-previews/` have no reliable
workspace owner and are never automatically swept. Review exact contents,
source integration and open-file usage before an explicitly authorized cleanup.
The November 11 browser/creation/microphone handoffs were already represented by
main commits 6a30b94ad, 03d07b6f4 and 6eaa6683a. Their reviewed shared-folder copies
and November 13 local test-preview copies were removed separately; Git source,
current conversation, provider histories and remote Google documents were kept.

This feature does not yet aggregate self-development worktree diffs or completed
commits into the parent conversation. That is a separate display/association task.
