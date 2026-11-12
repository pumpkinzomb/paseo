# Lead agent instruction profile

A lead agent is identified by the persisted `paseo.role=assistant` label. At create,
resume and reload, the manager derives a runtime-only `paseo-lead` instruction
profile. It is not a provider option and is not stored in native worker config.
Ordinary worker sessions keep their native defaults. Provider/model handoffs create
a new lead segment, preserving the logical conversation and reviewed handoff
context through the existing default-assistant service.

The default lead identifies as Sunny. The selected model is an execution backend,
not a different assistant identity. The common profile also carries the user's
Sunny relationship and voice: an affectionate younger-sister-like companion,
natural 오빠 address, warm concise practical answers, intent-first reasoning,
one best recommendation, minimal questions, and respect for existing work and
permission boundaries. This is owned by Paseo rather than loaded from native
Codex/Claude files. Existing leads receive missing persona text at resume/reload
without replacing their reviewed project context; ordinary workers are unchanged.
The identity button beside Devices opens the connected host's common persona.
The settings RPC returns the effective text; edits are saved as
`daemon.leadPersona`. An empty value restores the built-in persona. The new value
applies to the next lead creation, normal resume, or reload. Saving never stops an
active turn or rewrites its provider session; the UI must not claim an already
running session changed immediately. The host-owned persona prefix is versioned
and replaced, not repeatedly appended. Native worker profiles remain unchanged.
Daemon/self-development instructions remain in
the composed prompt; this profile does not bypass permissions or managed policy.

## Claude

The adapter uses the composed Paseo prompt as a custom system prompt instead of
appending to the Claude Code preset. `settingSources: []` disables automatic
user/project/local settings and CLAUDE.md loading. `strictMcpConfig: true` limits
MCP to explicitly supplied servers. `skills: []` disables native skill discovery.
These fields are set after provider options,
so ordinary option merging cannot accidentally restore native automatic loading.

Paseo's explicit provider options, configured agent definitions and runtime MCP
servers remain supported. HOME, CLAUDE_CONFIG_DIR, credentials and native session
storage are unchanged. This is configuration isolation, not an OS sandbox.

Native fixture initialization (without model requests) confirmed user/project
custom agents and skills disappear while an explicit MCP still connects. Do not
use Claude `--safe-mode`: the same fixture showed it removes explicit Paseo MCP
as well. Installed-plugin discovery was not validated by the fixture, so that
case remains a separate verification gap.

## Codex

The native app-server schema supports `baseInstructions` on thread start, resume
and fork. The lead profile can replace the provider's base identity using those
fields while retaining native authentication and history. The native server ignores
base instruction overrides on a thread that is already running. This adapter uses
a dedicated app-server connection per session; changes apply at a fresh start or
normal unloaded-thread resume, not as a promised hot identity change mid-turn.

New Codex lead sessions run in a fixed runtime below
`$PASEO_HOME/lead-runtime/codex`: `home`, `home/.codex`, and `workspace`.
If PASEO_HOME is inside a Git checkout, the helper selects a repository-external
sibling `.paseo-lead-runtimes/<home-identity>/codex` instead. This avoids moving
the live Paseo home while preventing native project configuration discovery.
HOME, CODEX_HOME, USERPROFILE and XDG directories point into this scope. Both
app-server process cwd and thread cwd use the independent workspace. The user's
project directory is retained as reference data for delegation, not loaded as the
coordinator's native project configuration. Runtime paths are reused across
sessions; dependencies and credentials are not copied.

The helper refuses runtime workspaces inside Git repositories (including resolved
symlink ancestors), and rejects HOME/CODEX_HOME/cwd symlinks escaping the managed
scope. A symlink for PASEO_HOME itself is supported. Native fixture probing
verified ancestor `.codex` developer/MCP configuration and `.agents` skills were
absent, while a skill inside the scratch cwd remained discoverable.
System/enterprise managed settings and permission enforcement are not disabled.
This is a configuration boundary, not filesystem access confinement: authorized
tools can still access project files.

Persisted `paseoLeadRuntime` metadata records the runtime scope and original project
path. Resume accepts only the same scope; it does not relocate history. Legacy
sessions without the marker retain their native home and expose
`legacy-unisolated` status. To adopt the new scope, create a new lead segment using
the existing reviewed-context handoff. Do not describe an old native segment as
fully isolated merely because it has a Sunny prompt.

A runtime-confirmed legacy Codex lead shows **Continue with Sunny settings** in
the composer. It uses the existing reviewed-context handoff, including when the
selected provider and model stay the same. Confirmation creates a new segment
in the same logical conversation and workspace, then opens it automatically.
The original segment remains readable. The destination carries a visible
isolation-transition label; reconnecting or opening a page does not silently
create segments or start model turns. Once isolated, same-provider model changes
remain in-place; cross-provider changes still use a reviewed handoff.

The separate scope requires official Codex login once. Run the official login
flow with exactly the live daemon's scope HOME/CODEX_HOME/cwd; logging into a test
`.lab` scope does not authenticate the live app. Never copy credentials from the
native home or use the internal-only `chatgptAuthTokens` RPC. The installed
app-server rejects `--ignore-user-config`; the exec-only flag is not an alternate
solution. Existing native worker authentication and histories remain untouched.

## Verification boundary

Focused adapter tests verify launch options and native-worker behavior; manager
coverage verifies role-based selection survives reload and is not persisted into
worker config. These are not a real logged-in provider roundtrip or a guarantee
that a running app has been updated. Restart/deployment is a separate step.
