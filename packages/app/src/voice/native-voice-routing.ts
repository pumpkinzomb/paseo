/** Stored Codex snapshots omit live capabilities until the session is loaded.
 * Native voice negotiation loads that session on the host; do not require the
 * unrelated local STT/TTS setup first. An explicit provider opt-out still wins.
 */
export function shouldUseNativeVoice(
  agent:
    | { provider: string; capabilities: { supportsNativeVoice?: boolean } }
    | undefined,
  peerAvailable: boolean
): boolean {
  if (!peerAvailable || !agent) return false;
  return agent.capabilities.supportsNativeVoice ?? agent.provider === "codex";
}
