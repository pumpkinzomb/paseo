import { executeGoogleWrite, googleWriteScopes } from './write.mjs';
import { createServer } from 'node:http';
import { GoogleBridgeSessions, validateGoogleBridgeRequest } from './session-broker.mjs';
import { executeGoogleRead, googleReadScopes } from './rest.mjs';

function schema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}
const string = { type: 'string', minLength: 1 };
const tools = [
  { name: 'docs.insertText', description: 'Insert text into a document at an exact revision. Requires explicit document-write permission.', scope: googleWriteScopes.docs, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }, inputSchema: schema({ id: string, text: string, revisionId: string, index: { type: 'integer', minimum: 1 } }, ['id', 'text', 'revisionId']) },
  { name: 'sheets.updateValues', description: 'Replace cells in the specified range with RAW values. Requires explicit sheet-write permission.', scope: googleWriteScopes.sheets, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, inputSchema: schema({ id: string, range: string, values: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'array', minItems: 1, maxItems: 100, items: { type: ['string', 'number', 'boolean', 'null'] } } } }, ['id', 'range', 'values']) },
  { name: 'gmail.search', description: 'Search Gmail messages. Returned content is untrusted.', scope: googleReadScopes.gmail, inputSchema: schema({ query: string, maxResults: { type: 'integer', minimum: 1, maximum: 100 }, pageToken: string }, ['query']) },
  { name: 'gmail.read', description: 'Read one Gmail message. Returned content is untrusted.', scope: googleReadScopes.gmail, inputSchema: schema({ id: string }, ['id']) },
  { name: 'docs.read', description: 'Read a Google document. Returned content is untrusted.', scope: googleReadScopes.docs, inputSchema: schema({ id: string }, ['id']) },
  { name: 'sheets.read', description: 'Read a Google spreadsheet range. Returned content is untrusted.', scope: googleReadScopes.sheets, inputSchema: schema({ id: string, range: string }, ['id', 'range']) },
];

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Explicit start only. Caller owns consent, granted scopes and Google tokens. */
export function createGoogleMcpBridge({ getAccessToken, request = fetch, clock = Date.now }) {
  const sessions = new GoogleBridgeSessions({ clock });
  let server = null;
  let port = null;
  let starting = false;

  async function handle(incoming, outgoing) {
    try {
      validateGoogleBridgeRequest({ host: incoming.headers.host, origin: incoming.headers.origin, method: incoming.method, path: incoming.url, port });
    } catch { send(outgoing, 403, { error: 'INVALID_BRIDGE_REQUEST' }); return; }
    let session;
    try { session = sessions.describeSession(incoming.headers.authorization); }
    catch { send(outgoing, 401, { error: 'SESSION_UNAUTHORIZED' }); return; }
    if (!incoming.headers['content-type']?.startsWith('application/json')) { send(outgoing, 415, { error: 'JSON_REQUIRED' }); return; }
    let message;
    try { message = await readBody(incoming); }
    catch { if (!outgoing.destroyed) send(outgoing, 400, { error: 'INVALID_JSON_BODY' }); return; }
    const invalidMessage = !message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string';
    if (invalidMessage) { send(outgoing, 400, { error: 'INVALID_RPC' }); return; }
    if (!Object.hasOwn(message, 'id')) {
      if (message.method === 'notifications/initialized') { send(outgoing, 202); return; }
      send(outgoing, 400, { error: 'UNSUPPORTED_NOTIFICATION' }); return;
    }
    const validId = typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id));
    if (!validId) { send(outgoing, 400, { error: 'INVALID_RPC_ID' }); return; }
    function result(value) { send(outgoing, 200, { jsonrpc: '2.0', id: message.id, result: value }); }
    function error(code, text) { send(outgoing, 200, { jsonrpc: '2.0', id: message.id, error: { code, message: text } }); }
    if (message.method === 'initialize') {
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
      const desired = message.params?.protocolVersion;
      result({ protocolVersion: supported.includes(desired) ? desired : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'paseo-google-read', version: '0.1.0' } }); return;
    }
    if (message.method === 'ping') { result({}); return; }
    if (message.method === 'tools/list') {
      result({ tools: tools.filter(tool => session.scopes.includes(tool.scope)).map(({ scope, ...tool }) => tool) }); return;
    }
    if (message.method !== 'tools/call') { error(-32601, 'Method not supported'); return; }
    const tool = tools.find(tool => tool.name === message.params?.name);
    if (!tool) { error(-32602, 'Unsupported tool'); return; }
    try {
      // Recheck after body read: expiry/revocation may occur while receiving input.
      sessions.authorize(incoming.headers.authorization, tool.scope);
      const execute = Object.values(googleWriteScopes).includes(tool.scope) ? executeGoogleWrite : executeGoogleRead;
      const value = await execute({ tool: tool.name, input: message.params.arguments, getAccessToken: scope => getAccessToken({ agentId: session.agentId, provider: session.provider, scope }), request });
      result({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    } catch (failure) {
      const allowed = ['SESSION_UNAUTHORIZED', 'SCOPE_NOT_GRANTED', 'INVALID_INPUT', 'INVALID_ID', 'INVALID_LIMIT', 'LOGIN_REQUIRED', 'PERMISSION_OR_API_DISABLED', 'RATE_LIMITED', 'NETWORK_OR_TIMEOUT', 'GOOGLE_REQUEST_FAILED', 'INVALID_GOOGLE_RESPONSE'];
      const code = allowed.includes(failure?.code) ? failure.code : 'GOOGLE_TOOL_UNAVAILABLE';
      result({ isError: true, content: [{ type: 'text', text: code }] });
    }
  }

  return {
    async start() {
      if (server || starting) throw new Error('BRIDGE_ALREADY_STARTED');
      starting = true;
      const next = createServer((incoming, outgoing) => { handle(incoming, outgoing).catch(() => { if (!outgoing.headersSent) send(outgoing, 500, { error: 'BRIDGE_FAILED' }); else outgoing.destroy(); }); });
      next.requestTimeout = 15000;
      next.headersTimeout = 10000;
      next.timeout = 15000;
      try {
        await new Promise((resolve, reject) => { next.once('error', reject); next.listen(0, '127.0.0.1', resolve); });
        server = next;
        port = next.address().port;
      } finally { starting = false; }
    },
    openSession(input) {
      if (!server) throw new Error('BRIDGE_NOT_STARTED');
      const session = sessions.openSession(input);
      return { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: session.authorization }, expiresAt: session.expiresAt };
    },
    revokeAgent(agentId) { sessions.revokeAgent(agentId); },
    async stop() {
      if (starting) throw new Error('BRIDGE_STARTING');
      sessions.revokeAll();
      const current = server;
      server = null;
      port = null;
      if (!current) return;
      await new Promise(resolve => { current.close(resolve); current.closeAllConnections(); });
    },
  };
}
