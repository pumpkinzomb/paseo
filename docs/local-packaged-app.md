# Local installed application (work in progress)

`packages/desktop/electron-builder.local.cjs` builds a local macOS directory bundle.
It reuses the worktree's verified Electron distribution, uses `sh.paseo.local`,
ad-hoc signs with hardened runtime, and does not notarize or publish. This does
not disable macOS security checks or claim Developer ID/notarization. The existing
Paseo bundle/executable name is retained because helper/CLI paths depend on it.

The package embeds `paseoDistribution` with `local-only` updater policy and source
revision. Upstream updater entry points reject this distribution before initializing
any network updater. Missing/invalid package reads fail closed; existing upstream
packages without the marker retain their own upstream policy.

Build only in a configured independent lab, from committed source:

1. `node scripts/isolated-lab.mjs check`
2. `node scripts/isolated-lab.mjs build`
3. `npm run build:app-deps`
4. In `packages/app`: `PASEO_WEB_PLATFORM=electron npm exec -- expo export --platform web`
5. `npm run build:main --workspace=@getpaseo/desktop`
6. `npm exec --workspace=@getpaseo/desktop -- electron-builder --config electron-builder.local.cjs --dir --mac --publish never`

Output is `.lab/packaged`, not Applications or the active runtime. Do not install
or overwrite the running app merely to test the bundle. Packaged startup loads
`paseo://app` from static `Resources/app-dist` and the bundled daemon runner; it
must not require Metro or the source checkout.

For verification, use a newly created isolated HOME, PASEO_HOME, userData and free
loopback daemon port. Do not copy provider credentials, sessions, browser profiles
or user configuration. Disable relay/MCP injection in that test-only daemon config.
Keep the normal application sandbox and signing checks. Close only the test app
normally and confirm its daemon exits. Live migration remains a separate step.

Still pending: versioned bundle manifests, trusted local candidate acceptance,
installed-app replacement/rollback and UI update action. The dev-runtime controller
contract is not an installed `.app` updater. No user-facing update action is enabled.

## Current verification result

The first arm64 local package was created and passed `codesign --verify --deep
--strict`, but **did not launch**. macOS library validation rejected the ad-hoc
main executable/framework combination (both have no Team Identifier). No daemon
or UI reached readiness. No library-validation exception, hardened-runtime change,
Gatekeeper bypass or operating-system security change was applied. The failed
reproducible bundle was removed; small logs remain in the lab. No currently valid
code-signing identity was available on the build host. A normal same-Team-ID Apple
development signing path must be established and checked before another real
application launch or any deployment. Paid distribution is not assumed necessary;
Personal Team development signing and public notarized distribution are different.

## Inert installed-update core

`src/local-update/candidate.ts` requires a pinned base, local distribution, matching
bundle/platform/architecture, real Team ID, same app/daemon version, exact observed
payload digest, an independent signed-code observation, a no-dev-server smoke
receipt, and a uniquely identified explicit approval. An approval alone is not a
signature or a smoke result. These observations are supplied only by a trusted
future host verifier; renderer data cannot create them.

`transaction.ts` is disabled by default and has **no production driver**. Its
injected interface requires an exclusive process lock, durable journal, fixed
managed directories, atomic compare-and-swap activation, an ingress fence and
normal shutdown. The transaction rechecks the candidate after shutdown, verifies
both UI and daemon readiness, and rolls back on failure. Lost activation
acknowledgements are reconciled by observing the current digest. Unknown ownership
or failed rollback remains `recovery_required`, never a blind retry or forced kill.

`ipc.ts` exposes only status and an opaque 64-hex offer token, requires a trusted
sender-frame validator, strips candidate actions unless `productionReady` is
explicitly true, prevents duplicate/replayed requests and redacts driver failures.
It is **not registered in main or exposed in preload**. The UI likewise defaults
to `productionReady=false` and does not render an apply button. `adapter.ts` connects
the interfaces only for tests/future trusted integration.

Tests use temporary fake bundle directories and an atomic pointer file. They do
not launch, replace or sign any actual `.app`. They verify eligibility, tampering,
active work, candidate mutation, duplicate requests, startup failure, uncertain
swap acknowledgement, interrupted recovery and IPC integration. Passing these
fixtures is not evidence that installed-app cutover or production state continuity
works. Real signed-app launch, real durable driver, interruption/rollback and
end-to-end UI/daemon migration remain required before enabling the button.

## Personal Developer ID preparation

Paseo is a personal project, separate from the NekoChat organization. Do not
hardcode either team or a person's certificate name. The additional
`electron-builder.developer-id.cjs` configuration requires local
`PASEO_SIGNING_TEAM_ID` and the exact `PASEO_SIGNING_IDENTITY` certificate name.
These identify a certificate; neither is a password or private key.

Before building, the configuration checks `security find-identity -v -p codesigning`
for a valid matching **Developer ID Application** identity. Missing credentials,
ad-hoc signing, Apple Development identities, and mismatched teams fail closed.
Electron-builder retains its normal nested-code signing order. After signing,
verification checks the complete sealed bundle and every Mach-O's Developer ID
and Team ID, and requires hardened runtime on the main executable. Existing
entitlements are unchanged; library validation is not disabled. This configuration
also rejects automatically launching the app as a signing side effect.

Build prerequisites after the owner prepares the personal team:

1. Use the personal Apple Developer account, not an organization's team. Obtain
   a Developer ID Application certificate using Apple's supported Xcode/account
   procedure. Its private key must remain on the Mac; a downloaded certificate
   without its matching private key is insufficient.
2. Verify that Keychain Access shows the certificate with its private key and
   that `security find-identity -v -p codesigning` lists it as valid. Set the two
   non-secret identifiers locally only after comparing the actual team.
3. Follow the build steps above, replacing the builder configuration with
   `electron-builder.developer-id.cjs`. Output stays in `.lab/developer-id`.
   No signature, publication, account change or real build was performed while
   preparing this configuration.
4. Notarization remains a separate authorized submission, not a build side
   effect. Let the owner create a `notarytool store-credentials` Keychain profile
   interactively. Never put an app-specific password, private key, API key or
   recovery material in source, shell history, logs or chat. Use only the profile
   name in subsequent commands.
5. Prepare a zip of the signed app, submit it using `notarytool` with that
   Keychain profile, require an **Accepted** result, inspect warnings, staple the
   app, validate the staple, and assess with Gatekeeper before a separately
   approved isolated launch. A rejected submission must stop this sequence.

`notarizationPlan` returns argument arrays for review and does not execute them.
The profile is a reference to locally stored credentials, not those credentials.
Both local configurations retain `publish: null` and the `local-only` update
policy. Public release hosting and automatic downloading are not enabled.
Fixture tests do not establish that a real signed or notarized app launches.

Sources: [Apple Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates),
[notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
and [Keychain credential profiles](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool).

## Durable executor handoff

`mailbox.ts` adds a disabled-by-default handoff between the app and a separately
owned updater. The app queues an exact verified offer token and immediately
reports applying; it does not wait inside a process that must exit for an update.
The executor-side adapter reuses the transaction's candidate verification,
normal shutdown, UI/daemon readiness and rollback contracts.

The host supplies one canonical, owner-private control directory. Records are
bounded, owner-private, single-link files opened without following symlinks.
Writes use fsync plus atomic rename; an exclusive directory lock prevents two
executors from consuming the same job. Receipts prevent token replay after an
app restart. A changed/withdrawn candidate is rejected again by the executor.
There are no renderer-selected paths, shell commands, credentials or download URLs.

A crashed/uncertain transaction leaves a running record. Recovery is a separate
executor operation; stale locks are never removed by a timeout. An operator must
first establish executor ownership before resolving an abandoned lock. This is a
fail-closed boundary, not yet an unattended recovery service. Tests use temporary
files and fresh mailbox instances to verify persistence, duplicate requests,
approval changes, rollback receipts, IPC queueing and malformed/aliased storage.

No real helper process/service is installed or launched, no production bundle
verifier/activation driver is supplied, and main/preload/UI remain disconnected.
A signed persistent executor, fenced work ingress, real fixed-root activation and
signed UI/daemon smoke tests are still required before production readiness can
be enabled. Mailbox fixture success is not installed-app update validation.
