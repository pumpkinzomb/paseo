/** Codex stores a realtime backend handoff as an un-attributed userMessage.
 * Match its complete transport shape only, at the provider boundary. A client ID
 * identifies authored task input and always wins, even if it contains this XML.
 * The provider schema has no origin discriminator for these legacy items.
 */
export function isCodexRealtimeHandoff(text: string, clientId?: string | null): boolean {
  if (clientId) return false;
  return /^\s*<realtime_delegation>\s*<input>[\s\S]*?<\/input>\s*<transcript_delta>[\s\S]*?<\/transcript_delta>\s*<\/realtime_delegation>\s*$/.test(
    text,
  );
}
