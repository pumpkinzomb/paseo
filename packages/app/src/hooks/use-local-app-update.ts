import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopLocalUpdateStatus } from "@/desktop/host";
import type { LocalAppUpdate } from "@/components/app-version-status";
import { resolveAppVersion } from "@/utils/app-version";

export function eligibleLocalUpdate(status: DesktopLocalUpdateStatus | null): boolean {
  return Boolean(
    status?.canApply === true &&
    status.phase === "idle" &&
    status.candidate?.version?.trim() &&
    /^[a-f0-9]{64}$/.test(status.candidate?.token ?? ""),
  );
}

export function useLocalAppUpdate() {
  const [status, setStatus] = useState<DesktopLocalUpdateStatus | null>(null);
  const [pending, setPending] = useState(false);
  const alive = useRef(false);
  const locked = useRef(false);
  const consumed = useRef<string | null>(null);
  const bridge = typeof window === "undefined" ? undefined : window.paseoDesktop?.localUpdate;
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let reading = false;
    const read = async () => {
      if (!bridge || reading || locked.current) return;
      reading = true;
      try {
        const next = await bridge.status();
        if (!disposed && !locked.current) setStatus(next);
      } catch {
        if (!disposed && !locked.current) setStatus(null);
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = bridge ? setInterval(() => void read(), 15000) : undefined;
    const focus = () => {
      void read();
    };
    if (bridge && typeof window !== "undefined") window.addEventListener("focus", focus);
    return () => {
      disposed = true;
      alive.current = false;
      if (timer) clearInterval(timer);
      if (typeof window !== "undefined") window.removeEventListener("focus", focus);
    };
  }, [bridge]);
  const request = useCallback(() => {
    const token = status?.candidate?.token;
    if (
      !bridge ||
      !eligibleLocalUpdate(status) ||
      !token ||
      locked.current ||
      consumed.current === token
    )
      return;
    locked.current = true;
    consumed.current = token;
    setPending(true);
    void bridge
      .request(token)
      .catch(() => {
        // Never leak native errors/paths and do not offer a failed consumed token again.
        if (alive.current) setStatus(null);
      })
      .finally(() => {
        locked.current = false;
        if (alive.current) {
          setPending(false);
          setStatus(null);
        }
      });
  }, [bridge, status]);
  const ready =
    (eligibleLocalUpdate(status) && status?.candidate?.token !== consumed.current) || pending;
  const update = useMemo<LocalAppUpdate>(
    () =>
      status?.candidate && ready
        ? {
            status: "verified",
            releaseId: status.candidate.version,
            pending,
            onUpdateAndRestart: request,
          }
        : { status: "unavailable" },
    [status, ready, pending, request],
  );
  return { version: status?.currentVersion || resolveAppVersion(), update, ready };
}
