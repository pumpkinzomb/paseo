import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopLocalUpdateStatus } from "@/desktop/host";
import type { LocalAppUpdate } from "@/components/app-version-status";
import { resolveAppVersion } from "@/utils/app-version";

export function eligibleLocalUpdate(status: DesktopLocalUpdateStatus | null): boolean {
  return Boolean(
    status?.canApply === true &&
    status.phase === "idle" &&
    (!status.failure || (status.failure.code === "blocked" && status.failure.retryable === true)) &&
    status.candidate?.version?.trim() &&
    /^[a-f0-9]{64}$/.test(status.candidate?.token ?? ""),
  );
}

export function useLocalAppUpdate() {
  const [status, setStatus] = useState<DesktopLocalUpdateStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<"blocked" | "failed" | "recovery_required" | null>(null);
  const [failureReason, setFailureReason] = useState<"transport_mismatch" | null>(null);
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
        if (!disposed && !locked.current) {
          setStatus(next);
          if (next.failure) {
            setFailure(next.failure.code);
            setFailureReason(next.failure.reason ?? null);
          }
        }
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
    setFailure(null);
    setFailureReason(null);
    let failed = false;
    void (async () => {
      try {
        await bridge.request(token);
      } catch {
        failed = true;
        const next = await bridge.status().catch(() => null);
        if (!alive.current) return;
        setFailure(next?.failure?.code ?? "failed");
        setFailureReason(next?.failure?.reason ?? null);
        if (
          next?.failure?.retryable === true &&
          eligibleLocalUpdate(next) &&
          next.candidate?.token === token
        ) {
          consumed.current = null;
          setStatus(next);
        } else setStatus(null);
      } finally {
        locked.current = false;
        if (alive.current) {
          setPending(false);
          if (!failed) setStatus(null);
        }
      }
    })();
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
            retryable: status.failure?.retryable === true,
            onUpdateAndRestart: request,
          }
        : { status: "unavailable" },
    [status, ready, pending, request],
  );
  return {
    version: status?.currentVersion || resolveAppVersion(),
    serverId: status?.serverId,
    update,
    ready,
    failure,
    failureReason,
  };
}
