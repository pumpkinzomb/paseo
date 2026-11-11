// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNativeVoicePeer } from "./native-voice-peer.web";

const permissions = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock("@/desktop/permissions/microphone-access", () => ({
  ensureMicrophoneAccess: permissions.ensure,
}));

class FakePeer extends EventTarget {
  static instances: FakePeer[] = [];
  connectionState = "new";
  localDescription = { sdp: "offer" };
  channel = Object.assign(new EventTarget(), { close: vi.fn() });
  close = vi.fn(() => {
    this.connectionState = "closed";
  });
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "offer" });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn(async () => {
    this.connectionState = "connected";
  });
  constructor() {
    super();
    FakePeer.instances.push(this);
  }
}
function setup() {
  const track = { stop: vi.fn(), enabled: true };
  const media = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn().mockResolvedValue(media);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    negotiate: vi.fn().mockResolvedValue("answer"),
    stopRemote: vi.fn().mockResolvedValue(undefined),
    onSpeech: vi.fn(),
    onTranscript: vi.fn(),
    onPlaying: vi.fn(),
    onEnded: vi.fn(),
  };
  return { options, controller, track, media, getUserMedia };
}
beforeEach(() => {
  permissions.ensure.mockReset().mockResolvedValue(undefined);
  FakePeer.instances = [];
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("native voice peer ownership", () => {
  it("mutes its microphone and releases tracks and remote session exactly once", async () => {
    const { options, track } = setup();
    const peer = await startNativeVoicePeer(options);
    expect(peer.toggleMute()).toBe(true);
    expect(track.enabled).toBe(false);
    await peer.stop();
    await peer.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(options.stopRemote).toHaveBeenCalledOnce();
    expect(FakePeer.instances[0].close).toHaveBeenCalledOnce();
  });
  it("releases its microphone if negotiation fails", async () => {
    const { options, track } = setup();
    options.negotiate.mockRejectedValue(new Error("denied"));
    await expect(startNativeVoicePeer(options)).rejects.toThrow("denied");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(options.stopRemote).not.toHaveBeenCalled();
  });
  it("releases tracks obtained after startup was cancelled", async () => {
    const { options, controller, track, media, getUserMedia } = setup();
    let resolveMedia!: (value: typeof media) => void;
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        resolveMedia = resolve;
      }),
    );
    const startup = startNativeVoicePeer(options);
    const rejected = expect(startup).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    controller.abort();
    resolveMedia(media);
    await rejected;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(options.negotiate).not.toHaveBeenCalled();
  });
  it("waits for the same remote teardown after abort and explicit stop overlap", async () => {
    const { options, controller, track } = setup();
    let resolveStop!: () => void;
    options.stopRemote.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveStop = resolve;
      }),
    );
    const peer = await startNativeVoicePeer(options);
    controller.abort();
    let stopped = false;
    const stopping = peer.stop().then(() => {
      stopped = true;
      return undefined;
    });
    await Promise.resolve();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(options.stopRemote).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    resolveStop();
    await stopping;
    expect(stopped).toBe(true);
  });
  it("does not capture or negotiate when the OS permission request is denied", async () => {
    const { options, getUserMedia } = setup();
    permissions.ensure.mockRejectedValue(new Error("Microphone access denied"));
    await expect(startNativeVoicePeer(options)).rejects.toThrow("Microphone access denied");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(options.negotiate).not.toHaveBeenCalled();
    expect(FakePeer.instances[0].close).toHaveBeenCalledOnce();
  });
});
