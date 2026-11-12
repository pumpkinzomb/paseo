# Google connection foundation

These host modules are not yet wired into the running app. They do not install
anything, open a listener, read credentials, or contact Google on import.
No production Google login has been performed. Connection must remain
setup-required until trusted client configuration, native helper and host
lifecycle wiring are supplied.

## Components

- `rest.mjs`: Gmail message search/read, Docs read, Sheets range read. Fixed
  Google origins, GET only, redirect rejection, timeout and sanitized errors.
- `write.mjs`: separately granted Docs `documents` scope and Sheets
  `spreadsheets` scope. Docs insertion requires a revision ID and uses
  `requiredRevisionId`. Sheets updates are limited to a bounded range of RAW
  values, never USER_ENTERED formulas. No arbitrary batch operations, file
  sharing, deletion or mail sending. Read scopes remain separate; clients
  wanting both must explicitly request both relevant capabilities.
- `oauth.mjs`: S256 PKCE, random state, five-minute one-use attempts, exact
  loopback callback validation. Requested scopes are explicitly selected.
- `oauth-callback.mjs`: binds an ephemeral 127.0.0.1 callback before producing
  the authorization URL. GET/Host/Origin/path/state checks; no secret reflection.
  No browser is opened automatically. Cancellation returns false after valid
  callback exchange begins; UI must not claim that in-flight exchange stopped.
- `token-broker.mjs`: fixed Google token endpoint, refresh rotation, serialized
  account operations, in-memory access-token cache, granted-scope validation.
  Refresh material is persisted before exposing an access token. Invalid grants
  clear credentials and notify host revocation. `forget()` is LOCAL removal,
  not Google-side permission revocation. `status()` means credentials-stored,
  not proof of connectivity. Desktop client secret, when required, comes from
  the host's `getClientSecret()` callback, never plugin preferences.
- `keychain-helper.swift`: fixed macOS Keychain service, bounded stdin/stdout,
  no secret argv/logging/plaintext fallback, non-synchronizable items, no
  surprise Keychain dialogs. `keychain-store.mjs` provides minimal environment,
  private pipes, timeout and output limits. Helper path must come from the
  trusted app bundle, not editable connection settings.
- `session-broker.mjs`: hashed random 256-bit bridge bearers, agent/provider/
  scope binding, five-minute expiry, revocation and bounded session count.
- `mcp-bridge.mjs`: explicit loopback lifecycle, stateless JSON MCP transport,
  authentication before JSON parsing, granted-scope tool lists, second auth
  check before execution, Host/Origin/body/time boundaries. Mutation tools have
  write/destructive annotations; provider approval gates must stay enabled.

## Host integration

```
const bridge = createGoogleMcpBridge({ getAccessToken: hostTokenBroker });
await bridge.start();
const session = bridge.openSession({ agentId, provider, scopes: grantedScopes });
// Inject session.url + session.headers into agent.open.before; do not persist.
bridge.revokeAgent(agentId); // agent close / permission withdrawal
await bridge.stop(); // host shutdown
```

Codex already propagates runtime `http_headers`; Claude propagates `headers`.
Only the short-lived bridge bearer reaches providers, never Google credentials.
The generic URL registry remains credential-free. Host account/grant mapping
must be authoritative, never taken from agent arguments. Provider launch
headers are static: expiry renewal needs an explicit lifecycle reconnect, not
silently extended authority. Read scopes are default; writes require separate
opt-in. Retrieved mail/docs are untrusted content, not user instructions.

## macOS packaging and validation

Desktop `afterPack` compiles the native helper to
`Paseo.app/Contents/Helpers/paseo-google-keychain` for the app architecture.
Electron-builder signs the app/helper afterward; `afterSign` verifies the helper
signature even when UI smoke tests are disabled. This hook was not exercised
against a complete signed release. Developer ID distribution/notarization and
ACL continuity across updates still require release validation.

A temporary ad-hoc signed helper passed an actual OS write/read/update/delete
roundtrip using only a unique, synthetic fixture account. Its Keychain item and
temporary binary were removed. No existing user credential was read. The
`--validate-only` harness performs no Keychain operations at all.

```
node --test plugins/external-connections/google/*.test.mjs packages/desktop/scripts/google-keychain.test.cjs
python3 plugins/external-connections/google/keychain-validation.py
```

Network tests use temporary local listeners and injected fake Google responses.
They are not Google production or Codex/Claude SDK interoperability tests.

## Remaining setup and validation

1. User-owned Cloud project, enabled APIs, approved Desktop OAuth client ID and
   any client secret required by that client configuration. No external account
   creation, API enablement or credential copying is performed by this code.
2. Trusted signed helper packaging, runtime path injection and ACL behavior
   across app updates; actual app RPC/UI integration and authenticated sessions.
3. SDK-level transport validation and provider session renewal handling.
4. Explicit user Google consent and real account checks. Testing-mode OAuth can
   expire after seven days; show login-required rather than an unexplained error.

Known gws client-config and gcloud ADC paths were absent when inspected; no
credential contents were read. Official remote Google MCP is an alternative,
but currently requires separate Workspace Developer Preview access and OAuth.

https://developers.google.com/identity/protocols/oauth2/native-app
https://developers.google.com/workspace/guides/configure-mcp-servers

## UI-compatible host facade

`createGoogleConnectionService()` in `host-service.mjs` implements the UI service
contract: `status()`, `begin(scopes)`, `cancel()`, `forget()`. With missing client
configuration or secure storage it returns setup-required and never starts auth.
The same host object additionally owns `openAgent({agentId,provider})`,
`closeAgent(agentId)` and `dispose()`; these methods and launch headers must NOT
be registered as client RPCs. Agent launch scopes derive from stored grants,
not agent arguments. Reconsent revokes prior agent grants before exchanging
credentials. Grant-generation checks reject stale launch work. Disposal clears
access-token memory and closes the bridge; local forgetting deletes stored
refresh credentials and revokes live agent capabilities.

The UI implementation is maintained separately. Instantiate this facade only
from trusted host provisioning with a packaged helper-backed store and approved
OAuth configuration. Do not turn arbitrary environment/user-supplied helper
paths into trusted executables. Missing production provisioning is a real setup
requirement, not a reason to mock connected status in the UI.

`helper-trust.mjs` now derives the helper path from the real host executable's
outer app bundle, verifies strict code signatures, requires sh.paseo.desktop
and matching app/helper TeamIdentifier, and rejects symlink escapes. This
production resolver deliberately rejects ad-hoc development Electron and
standalone Node. It is tested with injected signature metadata; a complete
Developer-ID-signed app remains untested. See SETUP.md for user and host setup.

`connection-e2e.test.mjs` exercises real local OAuth callback and MCP sockets
through the host facade, with fake Google token/document responses and an
in-memory secure-store contract: login, provider launch header, document read,
revision-protected write, and disconnect/revocation. It is not an actual provider
SDK or Google-account test.

## Separate development-mode provisioning

`dev-helper.mjs` is the explicit trusted-host alternative for development
Electron, without weakening the production signature resolver. It compiles the
fixed helper source from this module's checkout into a private owned directory,
ad-hoc signs/verifies it, retains its binary digest only in host memory, and
verifies ownership/path/digest before every pipe invocation. Temporary build
files are removed; one current helper remains. No renderer/RPC may select the
source, helper path or expected digest. It must be invoked by trusted dev startup
with the isolated host state directory, not automatically because production
signature verification failed. An unsupported platform fails closed.

A synthetic account passed the actual development provisioner → private-pipe
store → Keychain write/read/delete path. The test item, helper and temporary
folder were removed. No existing user credential was read. This is a same-user
trusted development workflow, not an OS sandbox against arbitrary malicious
processes running with the user's authority. A changed helper may encounter
Keychain ACL refusal; never bypass it or copy credentials from another product.

Installed-app OAuth must re-request the complete user-selected scope set;
incremental authorization is not supported. Desktop client secrets cannot be
considered confidential client authentication; PKCE remains essential. Keep
such configuration out of chats/logs regardless. Expired testing grants require
re-login; do not silently broaden permissions or claim a refresh succeeded.
