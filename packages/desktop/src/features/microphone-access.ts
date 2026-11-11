export type MicrophoneAccessState =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export interface MicrophoneAccessPorts {
  platform: string;
  getStatus(): MicrophoneAccessState;
  askForAccess(): Promise<boolean>;
  explainDenied(): Promise<void>;
}

export function createMicrophoneAccess(ports: MicrophoneAccessPorts) {
  let pending: Promise<MicrophoneAccessState> | null = null;
  function getStatus(): MicrophoneAccessState {
    return ports.platform === "darwin" ? ports.getStatus() : "granted";
  }
  async function requestOnce(): Promise<MicrophoneAccessState> {
    let state = getStatus();
    if (state === "not-determined") {
      const granted = await ports.askForAccess();
      state = granted ? "granted" : ports.getStatus();
      if (state === "not-determined") state = "denied";
      return state;
    }
    if (state === "denied" || state === "restricted") await ports.explainDenied();
    return state;
  }
  async function requestAccess(): Promise<MicrophoneAccessState> {
    if (pending) return pending;
    pending = requestOnce();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }
  return { getStatus, requestAccess };
}
