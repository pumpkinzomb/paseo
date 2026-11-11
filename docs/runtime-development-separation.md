# Runtime and development separation

## Purpose

An agent improving Paseo must not rewrite the files used by its own running UI,
daemon, or dependency tree. A separate branch alone is insufficient if both
processes consume the same `dist`, `node_modules`, Metro source, ports, or state.

## Local layout

- Original checkout: retained as a preserved in-progress source set. It contains
  user browser changes and unfinished manager isolation work. Do not build it
  into the running app, discard it, or reset it to match the new lab.
- Development lab: a separate Git worktree from the reviewed main checkpoint.
  Dependencies are independent APFS copies (not a shared node_modules link).
  Builds affect this checkout only.
- Stable release: separately staged source and compiled artifacts, plus its own
  independent dependencies. Agents do not develop against this directory.
- Production state: kept at its existing path until a deliberate data migration.
  Release switches should change code, not copy auth or session data.

Local absolute paths are in ignored `.lab-config.json`, not in Git.

## Lab commands

Use Node 22.20.0, then:

```
node scripts/isolated-lab.mjs check
node scripts/isolated-lab.mjs build
node scripts/isolated-lab.mjs desktop
```

The lab uses daemon 6778 and Metro 8092, never 6767/6768/8082/8084. Its Paseo home
and Electron user data live under its own `.lab`. No live-data seeding is allowed.
An occupied port is an error, never an instruction to kill another process.
The helper does not isolate provider credentials or the OS filesystem. Agent
model isolation is a separate, still-unverified feature and is not enabled here.

## Release procedure

1. Finish changes in the lab. Run focused tests plus type/lint/build checks.
2. Stage a new versioned release; do not overwrite the active release in place.
3. Verify internal workspace links resolve within that release, not the lab or
   original checkout. Record code/artifact hashes and the exact test result.
4. Require no running/approval/background agent tasks before daemon cutover.
   Preserve an exact old-release pointer and backup current durable metadata.
5. Switch launcher only to the verified release, reusing the same live data.
6. Verify session IDs, current workspace, expected model and basic navigation.
   If startup fails, restore the previous release pointer; never delete data.
7. Keep previous release until rollback is no longer needed. A native provider
   migration or schema change may need a distinct rollback plan.

No automatic promotion is implemented. Both the UI and daemon must consume
independent runtime copies; separating only the recovery UI is insufficient.

## Verification scope

`isolated-lab.test.mjs` uses temporary filesystem fixtures to exercise path,
port, dependency-link and inherited-environment rejection. It does not launch
real providers. A successful lab build proves output separation, not browser,
provider, authentication, migration or security equivalence.

## Self-development policy

`isolated-lab.mjs` now sets `PASEO_SELF_DEVELOPMENT_POLICY` to JSON with
`labRoot` and `protectedRoots`. The server validates real paths, including symlink
aliases and nonexistent descendants. AgentManager rejects new agent creation in
protected roots before deleting/creating state. This covers Paseo-managed parent
and child creation, not native provider subagents or arbitrary shell commands.
All provider launch configurations receive daemon guidance to perform Paseo
self-development and delegation in the lab. Existing native session cwd is never
silently moved. An existing record with no native session needs a fresh creation,
so a protected cwd will be rejected in that case too.

Other project paths remain allowed. The policy is opt-in; unrelated installations
without this environment setting are unchanged. The stable launcher must also set
the policy for its daemon; setting it only in the lab does not protect agents
running in the stable application. Autonomous promotion remains a separate
approved operation with complete work checks, backup and hash-verified rollback.
Local cutover scripts are one-shot operations, not general deployment commands.
No automatic promotion is implemented. This feature does not provide OS-level
write/process restrictions.

Explicit user operations, including restart, are evaluated against their scope
and effects rather than refused by the autonomous-development default. Check
running work and saved state, then use the supported operational path. Explain
concrete interruptions and obtain only a missing decision or required approval.
A restart request does not authorize unrelated deployment, discarded work or
forced termination of unknown processes. Tool permissions and access denials
still apply. This guidance does not install a restart supervisor or make an
unfinished deployment path safe.

## Stable launcher

`scripts/launch-stable-runtime.mjs` is the maintained version of the installed
Desktop shortcut target. It reads local `workspaces/paseo-runtime-control/active.json`,
verifies release/UI hashes and allows a separately versioned `daemonRelease`.
`selfDevelopmentPolicy` contains the absolute lab path and protected roots, and
is passed to a cold-started daemon. Existing daemons are not silently restarted
by the launcher; policy changes require the approved promotion procedure above.
`--check` verifies files without starting processes. Do not commit active.json,
local data, auth, or machine-specific paths. The installed copy must be updated
only through the operator deployment path, not an agent development task.

Current focused validation: 292 AgentManager/policy tests, 6 lab-launcher tests,
server typecheck and lint pass. Native-provider behavior and OS confinement are
not established by these tests. A minimal runtime policy patch can retain the
previous approved backend artifacts so unfinished browser/provider isolation
code is not accidentally included in the release.
