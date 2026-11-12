import { googleWriteScopes } from './write.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { googleReadScopes } from './rest.mjs';

export class GoogleBridgeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GoogleBridgeError';
    this.code = code;
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Host-private capability store. It opens no listener and owns no Google tokens. */
export class GoogleBridgeSessions {
  #sessions = new Map();
  #clock;
  #ttl;
  constructor({ clock = Date.now, sessionTtlMs = 300000 } = {}) {
    if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 1000 || sessionTtlMs > 86400000) throw new GoogleBridgeError('INVALID_SESSION_TTL');
    this.#ttl = sessionTtlMs;
    this.#clock = clock;
  }

  #prune() {
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt <= this.#clock()) this.#sessions.delete(key);
    }
  }

  openSession({ agentId, provider, scopes }) {
    this.#prune();
    const validAgent = typeof agentId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(agentId);
    if (!validAgent || !['codex', 'claude'].includes(provider)) throw new GoogleBridgeError('INVALID_SESSION');
    const allowed = new Set([...Object.values(googleReadScopes), ...Object.values(googleWriteScopes)]);
    if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => !allowed.has(scope))) throw new GoogleBridgeError('INVALID_SCOPES');
    if (this.#sessions.size >= 128) throw new GoogleBridgeError('SESSION_LIMIT');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.#clock() + this.#ttl;
    this.#sessions.set(digest(token), { agentId, provider, scopes: new Set(scopes), expiresAt });
    return { authorization: `Bearer ${token}`, expiresAt };
  }

  describeSession(authorization) {
    this.#prune();
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new GoogleBridgeError('SESSION_UNAUTHORIZED');
    const session = this.#sessions.get(digest(authorization.slice(7)));
    if (!session) throw new GoogleBridgeError('SESSION_UNAUTHORIZED');
    return { agentId: session.agentId, provider: session.provider, scopes: [...session.scopes] };
  }

  authorize(authorization, scope) {
    const session = this.describeSession(authorization);
    if (!session.scopes.includes(scope)) throw new GoogleBridgeError('SCOPE_NOT_GRANTED');
    return { agentId: session.agentId, provider: session.provider };
  }

  revokeAgent(agentId) {
    for (const [key, session] of this.#sessions) {
      if (session.agentId === agentId) this.#sessions.delete(key);
    }
  }

  revokeAll() {
    this.#sessions.clear();
  }
}

/** Apply before parsing MCP input. Native provider requests must not carry Origin. */
export function validateGoogleBridgeRequest({ host, origin, method, path, port }) {
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
  const validHost = validPort && host === `127.0.0.1:${port}`;
  if (!validHost || origin !== undefined || path !== '/mcp' || method !== 'POST') throw new GoogleBridgeError('INVALID_BRIDGE_REQUEST');
}
