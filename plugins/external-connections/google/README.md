# Google REST connection foundation

This is an offline-tested read adapter, NOT an installed Google connection or a
running MCP bridge. No Google credentials are read or stored by this module.
No new dependency, build output, listener, or authentication side effect exists.

Supported operations: Gmail message search/read, Docs read, Sheets range read.
All requests are GET, fixed Google origins, no redirects, and time-limited.
The caller must supply an access-token function that authorizes the exact scope.
Gmail sending/drafting and document writes are deliberately unsupported.

Run targeted tests without installing dependencies:

```
node --test plugins/external-connections/google/rest.test.mjs
```

## Required next integration slice

1. Obtain user-approved Google Cloud project/API/desktop OAuth client setup.
   Never reuse another product's OAuth client or copy its refresh tokens.
2. Native browser OAuth authorization-code + PKCE, random state, short-lived
   loopback callback, explicit scope selection. Never put tokens in logs, URL
   settings, source control, or model-visible tool responses.
3. Store refresh credentials in macOS Keychain via an audited OS binding; fail
   closed if unavailable. No plaintext fallback. Access tokens remain in memory.
   Serialize refresh, retain rotated refresh tokens, and make invalid_grant an
   actionable login-required state. Testing-mode OAuth can expire after 7 days.
4. Authenticated local MCP bridge with strict Origin/Host validation, bounded
   requests, and a daemon-owned lifecycle. The existing URL-only registry must
   gain a secure per-session header mechanism before exposing private Google
   tools: loopback alone is not authorization against other local clients.
5. UI login/reconnect/disconnect and live connection probe. Revocation is an
   explicit operation. Do not label a saved URL as connected.
6. Expose tools only for granted services; preserve provider tool approvals.
   Treat retrieved mail/docs as untrusted content, not new user instructions.
7. Add document editing only as a separately consented capability with its own
   tools and scopes. Mail sending remains absent by default.

Official remote MCP is an alternative but currently requires Google Workspace
Developer Preview membership and separate OAuth implementation:
https://developers.google.com/workspace/guides/configure-mcp-servers

Native OAuth reference:
https://developers.google.com/identity/protocols/oauth2/native-app

## OAuth foundation implemented

`oauth.mjs` creates a five-minute, one-use PKCE S256 authorization attempt.
It accepts only selected read scopes and an explicit 127.0.0.1 HTTP callback
port. Callback origin/path/state and duplicate parameters are validated;
consent denial, cancellation and expiration invalidate the attempt. The caller
receives token-exchange form data, not a token. No browser/socket/HTTP request
is started by this module. Keep returned form data host-private and never log it.

## Confirmed integration boundary

Both existing provider adapters already propagate runtime MCP HTTP headers:
Codex uses `http_headers`; Claude uses `headers`. A separate host-owned hook can
request `bridge.openSession({ agentId, provider })` and inject its `{ url,
headers }` only into the provider launch. The generic saved connection registry
must remain credential-free. Existing provider approval gates must remain active.
The bridge bearer is unrelated to Google OAuth tokens and must expire/revoke
on agent close; request authorization must check it before processing MCP JSON.
Bridge sessions need a server-side agent/granted-scope binding, not bearer
claims trusted from arbitrary clients. Limit loopback listeners and reject
unexpected Origin/Host and redirects; never expose them via LAN or relay.

No existing Keychain binding was found in server/desktop source. Do not use
`security ... -w <token>` because process arguments can disclose tokens. Use
an OS-native credential helper with bounded stdin/stdout and fixed service/account
names, or an audited native binding. Helper selection, packaging and OS access
behavior remain unimplemented; fail closed until this exists. Do not claim that
refresh tokens are securely stored yet. Do not write them to plugin preferences.

The callback listener may only finish a pending OAuth attempt; it is not a
credential-bearing MCP endpoint. It must bind its chosen port before producing
the OAuth URL, close on completion/timeout, and never treat a callback as an
agent tool request. Token exchange must verify actual granted scopes, store
refresh material only after successful secure storage, and expose only account
metadata/status to the UI. No broad Drive access or write scope is implied by
these three read scopes. Requested document writes and spreadsheet writes need
separate opt-in capabilities and tools; mail sending is not in this design.

## Native storage and broker groundwork

`keychain-helper.swift` now implements fixed-service macOS Security.framework
read/write/delete via bounded stdin JSON and stdout JSON. No secret argv,
shell invocation, logging, synchronizable item, or plaintext storage fallback.
`LAContext.interactionNotAllowed` fails closed instead of opening surprise OS
prompts. `--validate-only` exits before all Keychain operations. Build + six
input-validation fixtures passed without touching the user's Keychain. This
is NOT an end-to-end Keychain test. Signed helper packaging, caller pipe timeout/
output limits, Keychain ACL behavior and host integration remain to be verified.
The helper is not installed or invoked by the running app.

Run native validation (temporary compiled binary is removed):

```
python3 plugins/external-connections/google/keychain-validation.py
```

`session-broker.mjs` stores only digests of random 256-bit session bearers,
binds each to agent/provider/read scopes, limits active sessions to 128, prunes
expired entries, and supports agent/all revocation. Its five-minute bearer
expiry is deliberately short; provider launch headers are static, so future
host integration must renew/reopen its bridge session at the agent lifecycle
boundary rather than silently extending expired authority. No listener exists.
The request guard permits only exact loopback Host, absent Origin and POST /mcp;
future MCP HTTP integration must either support this restricted JSON response
transport or deliberately extend the method policy with equivalent auth checks.
No unauthenticated tools/list, tools/call, or metadata endpoint is provided.
