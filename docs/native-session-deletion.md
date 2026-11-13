# Explicit original-session deletion

Individual conversation-group Delete uses the nativeSessionDeletion capability
and an explicit deleteNativeSessions request after confirmation. Old clients and
hosts retain their local-record-only contract. Project removal and bulk completed
session removal are not silently escalated to original history deletion.

The confirmation includes Codex/Claude originals, model segments and child
transcripts, and asks the owner to close native sessions in other apps first.
Paseo checks its own running work and shared references; it cannot prove universal
external-app idleness or provide an OS-level lock against other native apps.

Codex uses official thread/delete, never archive as a substitute. Claude uses SDK
deleteSession, removing its transcript and subagent transcript directory. Claude
config roots differing from the SDK process config fail closed; no process-wide
environment mutation is performed. Unsupported providers are rejected.

Each exact native target has durable pending/deleted receipts in its retained
Paseo record metadata. Every native acknowledgement precedes Paseo record removal.
Errors retain the records. Pending outcomes require operator reconciliation and
are never blindly replayed. Acknowledged targets are skipped on local cleanup
retries. This is durable progress, not an atomic cross-provider rollback.

Shared source files, worktrees, attachments, auth and provider-wide databases are
preserved. Workspace metadata retains its existing tombstone/archive behavior.
Dedicated folder reclamation is a separate lifecycle. No claim is made to erase
backups, remote copies or every on-disk byte.

Tests use temporary fixture homes and mock app servers. The real SDK integration
test deletes only fixture transcript/subagent files. No user conversation is
deleted as a test or deployment side effect.
