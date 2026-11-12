# External connections

Built-in host-scoped remote MCP registry. Configure trusted HTTPS servers (or a loopback HTTP bridge) under Plugins → External connections. Configuration is opt-in and defaults disabled; Codex and Claude provider selection is explicit. Both lead and child interactive agents receive the selected servers when a new provider process opens. History-only opens receive none. No existing session is restarted by saving.

This is a connection framework, not a Google connector. Google Docs, Sheets and Gmail need a separately configured trusted MCP bridge and its own OAuth consent, scopes and token lifecycle. The registry does not copy ChatGPT/Claude connections, perform OAuth, test server health, store credentials or advertise read-only enforcement. Endpoint credentials, query strings and fragments are rejected; secrets must be managed by the external bridge. A configured/enabled row does not prove authentication or connectivity. Provider approval policies still apply to tool calls.

Settings updates take effect at the next agent process open. Disabling/removing an entry does not revoke remote OAuth permissions or detach tools from an already running process; end/reopen affected sessions and revoke permissions at the service when required.
