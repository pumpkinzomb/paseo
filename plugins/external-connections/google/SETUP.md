# Google setup required before first real connection

No account setup or real Google authentication has been performed by these
changes. The current app must show setup-required until prerequisites exist.

## User-controlled Google Cloud steps

1. Select a Google Cloud project you own or are authorized to administer.
2. Enable Google Docs API, Google Sheets API and Gmail API for the services you
   want. Drive API is not required by the current ID-based document/sheet tools;
   file discovery/Picker would be a separate capability.
3. Configure Google Auth Platform branding/audience/contact information. For
   personal development with an external Testing app, add your Google account
   as a test user. A managed Workspace organization may impose admin restrictions.
4. Create an OAuth client of type **Desktop app**, not Web application. Preserve
   its client ID and downloaded installed-app configuration. If a client secret
   is included, supply it only through the app's host-private secure setup flow,
   not a conversation, MCP URL, query parameter, agent environment or git file.
5. Select requested permissions in Paseo and explicitly start Google sign-in.
   The system browser signs into Google; the app uses an ephemeral 127.0.0.1
   callback with PKCE/state validation. Never reuse another app's client ID or
   callback URL.
6. Review consent: Gmail read, Docs read and Sheets read are separate from Docs
   edit and Sheets edit. Writing is opt-in. Mail sending is not supported.
7. After login, run a small authorized read test against a document/sheet ID you
   own. Perform a harmless test edit only after confirming the target and change.

Testing-mode authorizations involving these scopes can expire after seven days.
Publishing or sharing the OAuth app more broadly may require verification,
particularly for restricted Gmail scopes. The app should report reconnect or
client configuration errors, not repeatedly request broad permissions.

## Host/app prerequisites (not user Google setup)

- Trusted helper binary included in the signed Paseo macOS app. Current strict
  resolver requires app/helper matching TeamIdentifier and bundle identifier
  sh.paseo.desktop. Ad-hoc development Electron or standalone Node is deliberately
  unsupported by this resolver; a trusted development provisioning path must be
  designed separately rather than accepting an arbitrary executable path.
- OAuth public client configuration must be provisioned through the host-owned
  settings interface, and any client secret/refresh token stored in Keychain.
- UI service wiring, agent lifecycle injection/renewal and application packaging
  must be verified before the feature can be described as ready for real use.

Official references:
https://developers.google.com/identity/protocols/oauth2/native-app
https://developers.google.com/workspace/guides/create-credentials
https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
