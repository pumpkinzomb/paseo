import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { googleBeginRpc, googleCancelRpc, googleForgetRpc, googleStatusRpc, type GoogleConnectionStatus, type GoogleScope } from "../shared/google-rpc.js";

const scopeLabels: Record<GoogleScope, string> = {
  "https://www.googleapis.com/auth/documents.readonly": "Google Docs 읽기",
  "https://www.googleapis.com/auth/documents": "Google Docs 읽기·수정",
  "https://www.googleapis.com/auth/spreadsheets.readonly": "Google Sheets 읽기",
  "https://www.googleapis.com/auth/spreadsheets": "Google Sheets 읽기·수정",
  "https://www.googleapis.com/auth/gmail.readonly": "Gmail 읽기 (발송 없음)",
};
const statusLabels: Record<GoogleConnectionStatus["status"], string> = {
  "setup-required": "연결 준비 필요",
  "not-connected": "인증 없음",
  authorizing: "Google 승인 대기 중",
  exchanging: "인증 정보 교환 중",
  "credentials-stored": "인증 저장됨 · 실제 연결 미확인",
};

export function GoogleSettings() {
  const getStatus = useRpc(googleStatusRpc);
  const begin = useRpc(googleBeginRpc);
  const cancel = useRpc(googleCancelRpc);
  const forget = useRpc(googleForgetRpc);
  const [status, setStatus] = useState<GoogleConnectionStatus | null>(null);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [docs, setDocs] = useState(true);
  const [docsWrite, setDocsWrite] = useState(false);
  const [sheets, setSheets] = useState(false);
  const [sheetsWrite, setSheetsWrite] = useState(false);
  const [gmail, setGmail] = useState(false);
  const mounted = useRef(false);
  const statusRequest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++statusRequest.current;
    try {
      const result = await getStatus({});
      if (mounted.current && request === statusRequest.current) {
        setStatus(result);
        setError(undefined);
      }
    } catch {
      if (mounted.current && request === statusRequest.current) setError("Google 인증 상태를 확인하지 못했습니다. 다시 확인해 주세요.");
    }
  }, [getStatus]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; statusRequest.current += 1; };
  }, [refresh]);
  const pending = status?.status === "authorizing" || status?.status === "exchanging";
  useEffect(() => {
    if (!pending) return;
    const interval = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(interval);
  }, [pending, refresh]);
  const scopes = useMemo(() => {
    const result: GoogleScope[] = [];
    if (docs) result.push(docsWrite ? "https://www.googleapis.com/auth/documents" : "https://www.googleapis.com/auth/documents.readonly");
    if (sheets) result.push(sheetsWrite ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly");
    if (gmail) result.push("https://www.googleapis.com/auth/gmail.readonly");
    return result;
  }, [docs, docsWrite, sheets, sheetsWrite, gmail]);
  const changeDocs = useCallback((value: boolean) => { setDocs(value); if (!value) setDocsWrite(false); }, []);
  const changeSheets = useCallback((value: boolean) => { setSheets(value); if (!value) setSheetsWrite(false); }, []);
  const start = useCallback(async () => {
    if (busy || pending || !status || status.status === "setup-required" || scopes.length === 0) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await begin({ scopes });
      // The RPC schema validates the URL too; keep the browser boundary explicit.
      const url = new URL(result.authorizationUrl);
      if (url.protocol !== "https:" || url.host !== "accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password || url.hash) throw new Error("Invalid authorization URL");
      await openExternalUrl(url.toString());
    } catch {
      if (mounted.current) setNotice("Google 인증 화면을 열지 못했습니다. 상태를 확인한 후 다시 시도해 주세요.");
    } finally {
      await refresh();
      if (mounted.current) setBusy(false);
    }
  }, [begin, busy, pending, refresh, scopes, status]);
  const cancelAuthorization = useCallback(async () => {
    setBusy(true);
    try {
      const result = await cancel({});
      if (mounted.current) setNotice(result.cancelled ? "인증 요청을 취소했습니다." : "취소되지 않았습니다. 인증 처리가 이미 시작됐거나 완료됐을 수 있습니다.");
    } catch {
      if (mounted.current) setNotice("인증 요청을 취소하지 못했습니다. 다시 확인해 주세요.");
    } finally {
      await refresh();
      if (mounted.current) setBusy(false);
    }
  }, [cancel, refresh]);
  const forgetCredentials = useCallback(async () => {
    if (!confirmForget) { setConfirmForget(true); return; }
    setBusy(true);
    try {
      const result = await forget({});
      if (mounted.current) {
        setNotice(result.forgotten ? "이 기기의 인증 정보를 제거했습니다. Google 계정에서 허용한 권한은 유지됩니다." : "인증 정보가 제거되지 않았습니다. 상태를 다시 확인해 주세요.");
        setConfirmForget(false);
      }
    } catch {
      if (mounted.current) setNotice("이 기기의 인증 정보를 제거하지 못했습니다. 다시 확인해 주세요.");
    } finally {
      await refresh();
      if (mounted.current) setBusy(false);
    }
  }, [confirmForget, forget, refresh]);
  const cancelForget = useCallback(() => setConfirmForget(false), []);
  const setupHint = status?.reason === "secure-store-unavailable"
    ? "이 기기에 안전한 인증 정보 저장소가 준비되지 않아 로그인을 시작할 수 없습니다. 비밀번호나 토큰을 일반 설정에 저장하지 않습니다."
    : "Google OAuth 앱 설정이 필요합니다. 설정이 준비되면 여기서 Google 계정 승인을 진행할 수 있습니다.";
  return <SettingsSection title="Google 계정">
    <SettingsCard>
      <SettingsRow label={status ? statusLabels[status.status] : error ? "인증 상태 확인 실패" : "인증 상태 확인 중…"} error={error}
        hint={status?.status === "setup-required" ? setupHint : "인증 저장은 Docs·Sheets·Gmail 도구의 실제 사용 성공을 뜻하지 않습니다."} />
      <SettingsAction label="인증 상태 다시 확인" actionLabel="새로고침" onPress={refresh} />
      {status && status.scopes.length > 0 ? <SettingsRow label="저장 또는 요청 중인 권한" hint={status.scopes.map((scope) => `${scopeLabels[scope]}\n${scope}`).join("\n\n")} /> : null}
      {notice ? <SettingsRow label="안내" hint={notice} /> : null}
    </SettingsCard>
    <SettingsCard>
      <SettingsRow label="요청할 Google 권한" hint="수정 권한은 기본으로 꺼져 있습니다. 아래 선택은 로그인 버튼을 눌러 Google에서 승인해야 적용됩니다." />
      <SettingsSwitch label="Google Docs 읽기" value={docs} onValueChange={changeDocs} disabled={busy || pending} />
      <SettingsSwitch label="Google Docs 수정도 허용" hint="전체 문서 읽기·수정 권한을 요청합니다." value={docsWrite} onValueChange={setDocsWrite} disabled={!docs || busy || pending} />
      <SettingsSwitch label="Google Sheets 읽기" value={sheets} onValueChange={changeSheets} disabled={busy || pending} />
      <SettingsSwitch label="Google Sheets 수정도 허용" hint="전체 스프레드시트 읽기·수정 권한을 요청합니다." value={sheetsWrite} onValueChange={setSheetsWrite} disabled={!sheets || busy || pending} />
      <SettingsSwitch label="Gmail 읽기" hint="메일 발송 권한은 요청하지 않습니다." value={gmail} onValueChange={setGmail} disabled={busy || pending} />
      <SettingsRow label="이번에 요청할 범위" hint={scopes.length ? scopes.map((scope) => `${scopeLabels[scope]}\n${scope}`).join("\n\n") : "최소 한 가지 권한을 선택하세요."} />
      <SettingsAction label="선택한 권한으로 Google 인증" actionLabel={busy ? "처리 중…" : "Google 로그인"} onPress={start} disabled={busy || pending || !status || status.status === "setup-required" || scopes.length === 0} />
      {pending ? <SettingsAction label="진행 중인 인증 요청" actionLabel="취소" onPress={cancelAuthorization} disabled={busy} /> : null}
      {status?.status === "credentials-stored" ? <SettingsAction label={confirmForget ? "로컬 연결을 해제하고 저장된 Google 인증을 제거할까요?" : "로컬 연결 해제"} hint="로컬 인증 정보만 제거하며 Google 계정의 앱 접근 권한은 취소하지 않습니다." actionLabel={confirmForget ? "제거 확인" : "제거"} onPress={forgetCredentials} disabled={busy} /> : null}
      {confirmForget ? <SettingsAction label="인증 제거 취소" actionLabel="취소" onPress={cancelForget} disabled={busy} /> : null}
    </SettingsCard>
  </SettingsSection>;
}
