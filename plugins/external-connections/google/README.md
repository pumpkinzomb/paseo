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
