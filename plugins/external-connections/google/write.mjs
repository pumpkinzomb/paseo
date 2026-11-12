import { GoogleReadError } from './rest.mjs';

export const googleWriteScopes = Object.freeze({
  docs: 'https://www.googleapis.com/auth/documents',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
});
function text(value, max = 1024) {
  if (typeof value !== 'string' || !value || value.length > max) throw new GoogleReadError('INVALID_INPUT');
  return value;
}
function id(value) {
  const result = text(value, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new GoogleReadError('INVALID_ID');
  return result;
}
export async function executeGoogleWrite({ tool, input, getAccessToken, request = fetch }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GoogleReadError('INVALID_INPUT');
  let url;
  let body;
  let method;
  let scope;
  if (tool === 'docs.insertText') {
    const documentId = id(input.id);
    const content = text(input.text, 50000);
    const revisionId = text(input.revisionId, 1024);
    if (input.index !== undefined && (!Number.isInteger(input.index) || input.index < 1)) throw new GoogleReadError('INVALID_INPUT');
    const location = input.index === undefined ? { endOfSegmentLocation: {} } : { location: { index: input.index } };
    url = `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`;
    body = { writeControl: { requiredRevisionId: revisionId }, requests: [{ insertText: { text: content, ...location } }] };
    method = 'POST'; scope = googleWriteScopes.docs;
  } else if (tool === 'sheets.updateValues') {
    const spreadsheetId = id(input.id);
    const range = text(input.range);
    const values = input.values;
    const validValues = Array.isArray(values) && values.length > 0 && values.length <= 100 && values.every(row => Array.isArray(row) && row.length > 0 && row.length <= 100 && row.every(cell => cell === null || typeof cell === 'string' || typeof cell === 'boolean' || (typeof cell === 'number' && Number.isFinite(cell))));
    if (!validValues || JSON.stringify(values).length > 50000) throw new GoogleReadError('INVALID_INPUT');
    url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    body = { range, majorDimension: 'ROWS', values };
    method = 'PUT'; scope = googleWriteScopes.sheets;
  } else { throw new GoogleReadError('UNSUPPORTED_TOOL'); }
  const token = await getAccessToken(scope);
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new GoogleReadError('LOGIN_REQUIRED');
  let response;
  try {
    response = await request(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch { throw new GoogleReadError('NETWORK_OR_TIMEOUT'); }
  if (response.status === 401) throw new GoogleReadError('LOGIN_REQUIRED');
  if (response.status === 403) throw new GoogleReadError('PERMISSION_OR_API_DISABLED');
  if (response.status === 429) throw new GoogleReadError('RATE_LIMITED');
  if (!response.ok) throw new GoogleReadError('GOOGLE_REQUEST_FAILED');
  try { return await response.json(); } catch { throw new GoogleReadError('INVALID_GOOGLE_RESPONSE'); }
}
