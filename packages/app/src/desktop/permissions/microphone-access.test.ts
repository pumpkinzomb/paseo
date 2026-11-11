import { describe, expect, it, vi } from "vitest";
import { ensureMicrophoneAccess } from "./microphone-access";
describe("microphone capture gate", () => {
  it("requests native permission for the running macOS app", async () => {
    const requestAccess = vi.fn().mockResolvedValue("granted");
    await ensureMicrophoneAccess({
      platform: "darwin",
      microphone: { requestAccess, getStatus: vi.fn() },
    });
    expect(requestAccess).toHaveBeenCalledOnce();
  });
  it("blocks capture when the native app denied access", async () => {
    await expect(
      ensureMicrophoneAccess({
        platform: "darwin",
        microphone: { requestAccess: vi.fn().mockResolvedValue("denied"), getStatus: vi.fn() },
      }),
    ).rejects.toMatchObject({ name: "NotAllowedError" });
  });
  it("requires a native update rather than trusting browser permission on an old macOS bridge", async () => {
    await expect(ensureMicrophoneAccess({ platform: "darwin" })).rejects.toThrow();
  });
  it("does not introduce a desktop requirement in browsers", async () => {
    await expect(ensureMicrophoneAccess(null)).resolves.toBeUndefined();
  });
});
