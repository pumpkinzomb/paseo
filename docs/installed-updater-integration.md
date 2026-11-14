# Installed updater integration

This integration starts from main 81670544d, which contains remote main 1de1ebaed. It selects the installed updater runtime validated at c1455479b without merging that experimental branch history.

Included: signed local-only packaging, version/header UI, private approved update IPC, native Squirrel replacement, exact registered daemon ownership, split durable shutdown/start handoff and registration CAS, truthful admission/quiescence and normal shutdown drainage.

Excluded: migration planners/apply/recovery commands, migration activation-mode writer lease, native replacement/rebuild helper, disposable app entrypoints and smoke harnesses. The passive fixed pending-marker startup refusal remains; this code does not create or resolve migration markers.

No approved private update manifest means no actionable update button. General registered daemon controls remain connection-only. The daemon must be explicitly started with PASEO_INSTALLED_UPDATE_CONTROL=1 for coordinated update admission.

This source integration does not migrate historical projects, change live homes, publish a build or restart the operating app. Existing signed c145 verification is evidence for its runtime; this reduced source selection still requires its own targeted validation.

## Shutdown and restart ownership

Shutdown seals new admission before closing message delivery. Delivery close must
still drain messages it already owns, await in-flight acknowledgments and remain
idempotent without reopening that fence. A cleanup failure is not evidence that
an update was applied.

`paseo daemon restart --home <registered-home>` asks the existing supervisor to
replace its worker and confirms the replacement identity/readiness. It does not
replace the installed app or update its daemon binary. Do not substitute a shell
sequence of daemon stop, bundle copy and daemon start inside the agent being
stopped: that caller is not a durable owner of the transition.

For an installed app and daemon update, use the approved-candidate desktop
coordinator and its persisted split handoff. The development runtime controller
is not an installed-app fallback. If no approved candidate is available, report
that state rather than issuing shutdown and claiming an automatic restart.

## Rejected update requests and retry

The renderer shows only public failure categories, never native paths, runtime
IDs, or raw exceptions. Admission rejection before any stop invocation may return
to idle only after releasing this attempt's exact lock and independently
revalidating the signed approval, archive and unchanged original daemon identity.
The IPC layer then permits replay of that exact offer token; the UI reads fresh
status and restores the action only when the trusted host explicitly permits it.

Once stop is attempted, or hold/stopped/native-commit evidence exists, failures
remain non-retryable and consumed. Unknown status/read errors do not restore the
button. Recovery-required failures remain visible and require operator review;
a timestamp is never authority to remove a handoff lock.
