/** Read-only REST foundation. Not registered as an authenticated connection. */
export const googleReadScopes = Object.freeze({
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  docs: 'https://www.googleapis.com/auth/documents.readonly',
  sheets: 'https://www.googleapis.com/auth/spreadsheets.readonly',
});

export class GoogleReadError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GoogleReadError';
    this.code = code;
  }
}

function text(value, maxLength = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new GoogleReadError('INVALID_INPUT');
  }
  return value;
}

function identifier(value) {
  const id = text(value, 256);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new GoogleReadError('INVALID_ID');
  return id;
}

function plan(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GoogleReadError('INVALID_INPUT');
  }
  switch (tool) {
    case 'gmail.search': {
      const count = input.maxResults ?? 20;
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        throw new GoogleReadError('INVALID_LIMIT');
      }
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      url.searchParams.set('q', text(input.query));
      url.searchParams.set('maxResults', String(count));
      if (input.pageToken !== undefined) url.searchParams.set('pageToken', text(input.pageToken, 4096));
      return { url, scope: googleReadScopes.gmail };
    }
    case 'gmail.read':
      return { url: new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${identifier(input.id)}?format=full`), scope: googleReadScopes.gmail };
    case 'docs.read':
      return { url: new URL(`https://docs.googleapis.com/v1/documents/${identifier(input.id)}`), scope: googleReadScopes.docs };
    case 'sheets.read':
      return { url: new URL(`https://sheets.googleapis.com/v4/spreadsheets/${identifier(input.id)}/values/${encodeURIComponent(text(input.range))}`), scope: googleReadScopes.sheets };
    default:
      throw new GoogleReadError('UNSUPPORTED_TOOL');
  }
}

export async function executeGoogleRead({ tool, input, getAccessToken, request = fetch }) {
  const { url, scope } = plan(tool, input);
  const token = await getAccessToken(scope);
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) {
    throw new GoogleReadError('LOGIN_REQUIRED');
  }
  let response;
  try {
    response = await request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Do not expose URLs, tokens, or response bodies through transport errors.
    throw new GoogleReadError('NETWORK_OR_TIMEOUT');
  }
  if (response.status === 401) throw new GoogleReadError('LOGIN_REQUIRED');
  if (response.status === 403) throw new GoogleReadError('PERMISSION_OR_API_DISABLED');
  if (response.status === 429) throw new GoogleReadError('RATE_LIMITED');
  if (!response.ok) throw new GoogleReadError('GOOGLE_REQUEST_FAILED');
  try {
    return await response.json();
  } catch {
    throw new GoogleReadError('INVALID_GOOGLE_RESPONSE');
  }
}
