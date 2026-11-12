import { createGoogleTokenBroker } from './token-broker.mjs';
import { createGoogleMcpBridge } from './mcp-bridge.mjs';
import { startGoogleOAuthCallback } from './oauth-callback.mjs';

/** Construct only in trusted host code. Never return the extra host methods over RPC. */
export function createGoogleConnectionService({ clientId, store, getClientSecret, request = fetch, openCallback = startGoogleOAuthCallback, createBridge = createGoogleMcpBridge } = {}) {
  const account = 'paseo-google';
  let phase = null;
  let login = null;
  let disposed = false;
  let grantRevision = 0;
  let bridgeStarted = false;
  let startingBridge = null;
  const reason = !clientId ? 'oauth-client-missing' : !store ? 'secure-store-unavailable' : null;
  const broker = reason ? null : createGoogleTokenBroker({ clientId, store, getClientSecret, request, onInvalidated: () => bridge.revokeAll() });
  // A bridge wrapper exposes no credentials through status/begin RPC.
  const rawBridge = reason ? null : createBridge({ request, sessionTtlMs: 86400000, getAccessToken: ({ scope }) => broker.getAccessToken({ account, scope }) });
  const agents = new Set();
  const bridge = {
    revokeAll() { grantRevision++; for (const agent of agents) rawBridge.revokeAgent(agent); agents.clear(); },
  };

  function ready() {
    if (disposed) throw new Error('GOOGLE_SERVICE_STOPPED');
    if (reason) throw new Error('GOOGLE_SETUP_REQUIRED');
  }

  async function endLogin() {
    const current = login;
    if (!current) return;
    if (!current.cancel()) await current.completion.catch(() => {});
    login = null;
    phase = null;
  }

  return {
    async status() {
      if (reason) return { status: 'setup-required', scopes: [], reason };
      ready();
      if (phase) return { status: phase, scopes: [] };
      return broker.status(account);
    },
    async begin(scopes) {
      ready();
      if (phase) throw new Error('GOOGLE_AUTH_ALREADY_ACTIVE');
      phase = 'authorizing';
      let flow;
      try {
        flow = await openCallback({ clientId, scopes, onExchange: exchange => {
          phase = 'exchanging';
          bridge.revokeAll();
          return broker.acceptAuthorization({ account, exchange, requestedScopes: scopes });
        } });
      } catch { phase = null; throw new Error('GOOGLE_AUTH_START_FAILED'); }
      if (disposed) { flow.cancel(); throw new Error('GOOGLE_SERVICE_STOPPED'); }
      login = flow;
      flow.completion.then(() => {
        // Reconsent may change account/grants. Existing capabilities must not survive.
        bridge.revokeAll();
      }).catch(() => {}).finally(() => {
        if (login === flow) { login = null; phase = null; }
      });
      return { authorizationUrl: flow.authorizationUrl };
    },
    async cancel() {
      ready();
      if (!login) return false;
      const cancelled = login.cancel();
      if (cancelled) { login = null; phase = null; }
      return cancelled;
    },
    async forget() {
      ready();
      if (phase && !login) throw new Error('GOOGLE_AUTH_STARTING');
      await endLogin();
      bridge.revokeAll();
      await broker.forget(account);
    },
    async openAgent({ agentId, provider }) {
      ready();
      if (phase) throw new Error('GOOGLE_AUTH_IN_PROGRESS');
      const revision = grantRevision;
      const state = await broker.status(account);
      if (state.status !== 'credentials-stored') throw new Error('LOGIN_REQUIRED');
      if (!bridgeStarted) {
        if (!startingBridge) startingBridge = rawBridge.start().then(() => { bridgeStarted = true; }).finally(() => { startingBridge = null; });
        await startingBridge;
      }
      if (disposed) throw new Error('GOOGLE_SERVICE_STOPPED');
      if (phase || revision !== grantRevision) throw new Error('GOOGLE_GRANTS_CHANGED');
      // Grant scopes are derived from host storage, never supplied by the agent.
      const session = rawBridge.openSession({ agentId, provider, scopes: state.scopes });
      agents.add(agentId);
      return session;
    },
    closeAgent(agentId) {
      if (rawBridge) rawBridge.revokeAgent(agentId);
      agents.delete(agentId);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await endLogin();
      if (startingBridge) await startingBridge.catch(() => {});
      if (rawBridge) await rawBridge.stop();
      agents.clear();
      if (broker) broker.clearCache();
    },
  };
}
