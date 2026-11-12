import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { preferences } from "../shared/preferences.js";

type ReadySettings = Extract<SettingsState<typeof preferences.schema>, { status: "ready" }>;
type Connection = ReadySettings["values"]["connections"][number];
type Provider = Connection["providers"][number];

function ConnectionEditor({
  settings,
  connection,
  onClose,
}: {
  settings: ReadySettings;
  connection?: Connection;
  onClose(): void;
}) {
  // Preserve both the snapshot and revision while editing so another client's changes
  // are never silently overwritten by this form.
  const [base] = useState(() => ({ values: settings.values, revision: settings.revision }));
  const [draft, setDraft] = useState<Connection>(
    () =>
      connection ?? {
        id: "",
        name: "",
        url: "",
        enabled: false,
        providers: ["codex", "claude"],
      },
  );
  const [error, setError] = useState<string>();
  const setProvider = useCallback((provider: Provider, enabled: boolean) => {
    setDraft((current) => ({
      ...current,
      providers: enabled
        ? [...current.providers.filter((value) => value !== provider), provider]
        : current.providers.filter((value) => value !== provider),
    }));
  }, []);
  const changeName = useCallback(
    (name: string) => setDraft((current) => ({ ...current, name })),
    [],
  );
  const changeId = useCallback((id: string) => setDraft((current) => ({ ...current, id })), []);
  const changeUrl = useCallback((url: string) => setDraft((current) => ({ ...current, url })), []);
  const changeEnabled = useCallback(
    (enabled: boolean) => setDraft((current) => ({ ...current, enabled })),
    [],
  );
  const changeCodex = useCallback((value: boolean) => setProvider("codex", value), [setProvider]);
  const changeClaude = useCallback((value: boolean) => setProvider("claude", value), [setProvider]);
  const save = useCallback(async () => {
    const connections = connection
      ? base.values.connections.map((item) => (item.id === connection.id ? draft : item))
      : [...base.values.connections, draft];
    const parsed = preferences.schema.safeParse({ ...base.values, connections });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
      return;
    }
    setError(undefined);
    if (await settings.save(parsed.data, base.revision)) onClose();
  }, [base, connection, draft, onClose, settings]);
  return (
    <SettingsSection title={connection ? "연결 설정 수정" : "연결 추가"}>
      <SettingsCard>
        <SettingsInput
          label="이름"
          initialValue={draft.name}
          placeholder="예: 회사 문서 도구"
          onChangeText={changeName}
          disabled={settings.saving}
        />
        <SettingsInput
          label="연결 ID"
          initialValue={draft.id}
          placeholder="예: company-docs"
          hint="다른 연결과 구분되는 영문 소문자 ID"
          onChangeText={changeId}
          disabled={settings.saving || Boolean(connection)}
        />
        <SettingsInput
          label="MCP 서버 주소"
          initialValue={draft.url}
          placeholder="https://example.com/mcp"
          hint="HTTPS 또는 로컬 HTTP 주소. 비밀번호·토큰·쿼리 문자열을 넣지 마세요."
          onChangeText={changeUrl}
          disabled={settings.saving}
        />
        <SettingsSwitch
          label="Codex에서 사용"
          value={draft.providers.includes("codex")}
          onValueChange={changeCodex}
          disabled={settings.saving}
        />
        <SettingsSwitch
          label="Claude에서 사용"
          value={draft.providers.includes("claude")}
          onValueChange={changeClaude}
          disabled={settings.saving}
        />
        <SettingsSwitch
          label="도구 제공 활성화"
          value={draft.enabled}
          hint="신뢰하는 서버만 활성화하세요. 선택한 공급자의 이 기기 내 모든 리드·하위 에이전트에 도구가 제공됩니다. 도구 호출 시 해당 서버로 데이터가 전달될 수 있습니다."
          onValueChange={changeEnabled}
          disabled={settings.saving}
        />
        <SettingsAction
          label="연결 설정 저장"
          actionLabel={settings.saving ? "저장 중…" : "저장"}
          error={error ?? settings.saveError}
          onPress={save}
          disabled={settings.saving}
        />
        <SettingsAction
          label="변경 취소"
          actionLabel="취소"
          onPress={onClose}
          disabled={settings.saving}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function ConnectionCard({
  connection,
  settings,
  onEdit,
}: {
  connection: Connection;
  settings: ReadySettings;
  onEdit(connection: Connection): void;
}) {
  const [removing, setRemoving] = useState(false);
  const edit = useCallback(() => onEdit(connection), [connection, onEdit]);
  const cancel = useCallback(() => setRemoving(false), []);
  const remove = useCallback(async () => {
    if (!removing) {
      setRemoving(true);
      return;
    }
    if (
      await settings.save(
        {
          ...settings.values,
          connections: settings.values.connections.filter((item) => item.id !== connection.id),
        },
        settings.revision,
      )
    )
      setRemoving(false);
  }, [connection.id, removing, settings]);
  return (
    <SettingsCard>
      <SettingsRow
        label={connection.name}
        hint={`${connection.url}\n${connection.enabled ? "도구 제공 설정 켜짐" : "도구 제공 설정 꺼짐"} · ${connection.providers.join(", ")}`}
      />
      <SettingsAction
        label="연결 설정"
        actionLabel="수정"
        onPress={edit}
        disabled={settings.saving}
      />
      <SettingsAction
        label={removing ? "이 연결 설정을 제거할까요?" : "연결 설정 제거"}
        hint={
          removing
            ? "외부 계정 권한은 취소되지 않으며 실행 중인 에이전트에는 즉시 적용되지 않습니다."
            : undefined
        }
        actionLabel={removing ? "제거 확인" : "제거"}
        disabled={settings.saving}
        onPress={remove}
      />
      {removing ? (
        <SettingsAction
          label="제거 취소"
          actionLabel="취소"
          onPress={cancel}
          disabled={settings.saving}
        />
      ) : null}
    </SettingsCard>
  );
}

function ConnectionList({ settings }: { settings: ReadySettings }) {
  const [editor, setEditor] = useState<{ connection?: Connection } | null>(null);
  const close = useCallback(() => setEditor(null), []);
  const add = useCallback(() => setEditor({}), []);
  const edit = useCallback((connection: Connection) => setEditor({ connection }), []);
  if (editor)
    return <ConnectionEditor settings={settings} connection={editor.connection} onClose={close} />;
  return (
    <SettingsSection title="등록된 MCP 서버">
      {settings.values.connections.length === 0 ? (
        <SettingsRow
          label="아직 등록한 외부 도구가 없습니다"
          hint="준비된 MCP 서버 주소를 추가하세요."
        />
      ) : null}
      {settings.values.connections.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          settings={settings}
          onEdit={edit}
        />
      ))}
      <SettingsAction
        label="새 외부 도구"
        actionLabel="추가"
        onPress={add}
        disabled={settings.saving}
        error={settings.saveError}
      />
    </SettingsSection>
  );
}

export function ConnectionsSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme.colors.foreground]);
  if (settings.status === "loading") return <Text style={textStyle}>연결 설정을 불러오는 중…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="외부 도구">
        <SettingsRow label="연결 설정을 불러오지 못했습니다" error={settings.error} />
        <SettingsAction
          label="설정 다시 불러오기"
          actionLabel="새로고침"
          onPress={settings.reload}
        />
      </SettingsSection>
    );
  return (
    <>
      <SettingsSection title="외부 도구 연결">
        <SettingsRow
          label="공통 MCP 연결 설정"
          hint="이 기기의 선택한 Codex·Claude 리드 및 하위 에이전트 전체에 외부 도구를 제공합니다. 저장은 연결 성공이나 로그인 완료를 뜻하지 않습니다."
        />
        <SettingsRow
          label="적용 시점"
          hint="읽기 전용이나 호출별 승인을 강제하는 설정이 아닙니다. 실제 권한은 서버와 에이전트 승인 모드에 따릅니다. 변경은 다음에 새로 열리는 에이전트 실행부터 적용됩니다. 이미 실행 중인 세션의 도구는 즉시 바뀌지 않습니다."
        />
        <SettingsRow
          label="Google 및 기타 서비스"
          hint="Google Docs·Sheets·Gmail은 신뢰할 수 있는 Google MCP 서버와 별도 OAuth 인증이 필요합니다. 이 화면은 Google 로그인이나 계정 권한 승인을 대신하지 않습니다. 인증이 필요한 서버는 별도 구성이 필요합니다."
        />
      </SettingsSection>
      <ConnectionList settings={settings} />
    </>
  );
}
