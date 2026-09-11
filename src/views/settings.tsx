import { Children, useRef, useState } from "react"

import { version } from "../../package.json"
import { reloadSkills } from "../agent/agent"
import { refreshCredentials, setUseCli, signOutOfProvider } from "../agent/credentials"
import { cliSignedIn, fxStatus, fxVersion, FX_BINARY } from "../agent/cli"
import { useMountEffect } from "../ui/hooks"
import {
  addMcpServer,
  beginServerSignIn,
  listMcpServers,
  removeMcpServer,
  signOutOfServer,
} from "../workspace/mcp"
import {
  beginSignIn,
  openExternally,
  PROVIDERS,
  type PendingSignIn,
  type ProviderId,
} from "../agent/oauth"
import { loadSkills } from "../workspace/skills"
import { checkForUpdate, relaunch } from "../update"
import { useT, LANGUAGES, resolveLang } from "../ui/i18n"
import {
  DEFAULT_MODEL,
  DIR,
  apiKeySource,
  findSession,
  findWorkspace,
  setLang,
  setSettings,
  setState,
  type Account,
  type AppState,
  type UpdateStatus,
} from "../store"
import { ModelChoice, keyOf } from "./models"
import {
  color,
  columnFor,
  PANE_PADDING,
  radius,
  space,
  text,
  titlebarBand,
  TRAFFIC_LIGHT_INSET,
} from "../ui/theme"
import { Button, Kbd, Label, Paragraph, TextField, overlayStyle } from "../ui/ui"
import { Icon } from "../ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@gpuix/react/select"

type Server = ReturnType<typeof listMcpServers>[number]

type Loaded = {
  fx: string | null
  fxStatus: string
  skills: string[]
  servers: Server[]
  cli: ProviderId[]
}

function needsSetup(state: AppState): boolean {
  return !state.useCli && apiKeySource(state) === "none" && state.accounts.length === 0
}

function SetupBanner({ state }: { state: AppState }) {
  const t = useT()
  if (!needsSetup(state)) return null
  return (
    <div
      testId="settings-setup"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: space.lg,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: color.border,
        minWidth: 0,
      }}
    >
      <Label size={text.small} color={color.text}>
        {t("settings.setup.title")}
      </Label>
      <Paragraph size={text.micro} color={color.ghost}>
        {t("settings.setup.desc")}
      </Paragraph>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const rows = Children.toArray(children)
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md, minWidth: 0 }}>
      <Label size={text.micro} color={color.ghost}>
        {title.toUpperCase()}
      </Label>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: color.border,
          minWidth: 0,
        }}
      >
        {rows.map((row, index) => (
          <div
            key={index}
            style={index === 0 ? { minWidth: 0 } : { borderTopWidth: 1, borderColor: color.border, minWidth: 0 }}
          >
            {row}
          </div>
        ))}
      </div>
    </div>
  )
}

function Row({
  title,
  detail,
  danger,
  children,
  expanded,
}: {
  title: string
  detail: string
  danger?: boolean
  children?: React.ReactNode
  expanded?: React.ReactNode
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.md,
        padding: space.lg,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: space.lg }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 }}>
          <Label size={text.small} color={color.text}>
            {title}
          </Label>
          <Paragraph size={text.micro} color={danger ? color.danger : color.ghost}>
            {detail}
          </Paragraph>
        </div>
        {children}
      </div>
      {expanded}
    </div>
  )
}

function masked(key: string): string {
  return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "•".repeat(key.length)
}

function ApiKeyRow({ state }: { state: AppState }) {
  const t = useT()
  const fromEnv = Boolean(process.env.AI_GATEWAY_API_KEY)
  const [draft, setDraft] = useState<string | null>(null)
  const editing = draft !== null

  const save = () => {
    const key = (draft ?? "").trim()
    if (!key) return
    setState((current) => ({ ...current, apiKey: key }))
    setDraft(null)
  }

  return (
    <Row
      title={t("settings.apiKey.title")}
      detail={
        fromEnv
          ? t("settings.apiKey.fromEnv")
          : state.apiKey
            ? t("settings.apiKey.saved", { masked: masked(state.apiKey) })
            : t("settings.apiKey.needed")
      }
      expanded={
        editing ? (
          <TextField
            testId="api-key"
            value={draft}
            placeholder={t("settings.apiKeyPlaceholder")}
            onChange={setDraft}
            onSubmit={save}
          />
        ) : null
      }
    >
      {fromEnv ? null : editing ? (
        <>
          <Button label={t("btn.cancel")} variant="ghost" size="sm" onClick={() => setDraft(null)} />
          <Button
            label={t("settings.save")}
            variant="primary"
            size="sm"
            testId="settings-save-key"
            onClick={save}
            hint="↩"
          />
        </>
      ) : (
        <>
          {state.apiKey ? (
            <Button
              label={t("settings.clear")}
              variant="ghost"
              size="sm"
              testId="settings-clear-key"
              onClick={() => setState((current) => ({ ...current, apiKey: null }))}
            />
          ) : null}
          <Button
            label={state.apiKey ? t("settings.replace") : t("settings.add")}
            size="sm"
            variant={state.apiKey ? "secondary" : "primary"}
            testId="settings-api-key"
            onClick={() => setDraft("")}
          />
        </>
      )}
    </Row>
  )
}

function AddMcpServerRow({ onChanged }: { onChanged: () => void }) {
  const t = useT()
  const [name, setName] = useState<string | null>(null)
  const [source, setSource] = useState("")
  const [error, setError] = useState<string | null>(null)
  const adding = name !== null

  const cancel = () => {
    setName(null)
    setSource("")
    setError(null)
  }

  const save = () => {
    try {
      addMcpServer(name ?? "", source)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return
    }
    cancel()
    void reloadSkills().then(onChanged)
  }

  return (
    <Row
      title={t("settings.addServer.title")}
      detail={error ?? t("settings.addServer.desc")}
      danger={Boolean(error)}
      expanded={
        adding ? (
          <>
            <TextField
              testId="mcp-name"
              value={name}
              placeholder={t("settings.addServer.namePlaceholder")}
              onChange={setName}
              onSubmit={save}
            />
            <TextField
              testId="mcp-source"
              value={source}
              placeholder={t("settings.addServer.sourcePlaceholder")}
              onChange={setSource}
              onSubmit={save}
            />
          </>
        ) : null
      }
    >
      {adding ? (
        <>
          <Button label={t("btn.cancel")} variant="ghost" size="sm" onClick={cancel} />
          <Button
            label={t("settings.add")}
            variant="primary"
            size="sm"
            hint="↩"
            testId="mcp-save"
            onClick={save}
          />
        </>
      ) : (
        <Button
          label={t("settings.add")}
          size="sm"
          testId="mcp-add"
          onClick={() => {
            setName("")
            setError(null)
          }}
        />
      )}
    </Row>
  )
}

function McpServerRow({
  server,
  onChanged,
}: {
  server: Server
  onChanged: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signIn = async () => {
    setError(null)
    setBusy(true)
    try {
      const flow = await beginServerSignIn(server.name, server.url!, null, openExternally)
      await flow.completed
      await reloadSkills()
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const detail = error
    ? error
    : busy
      ? t("settings.mcpRow.waiting")
      : server.url
        ? server.signedIn
          ? t("settings.mcpRow.signedIn", { host: new URL(server.url).host, tools: server.tools })
          : t("settings.mcpRow.notSignedIn", { host: new URL(server.url).host })
        : t("settings.mcpRow.local", { tools: server.tools })

  return (
    <Row title={server.name} detail={detail}>
      {server.url ? (
        <Button
          label={server.signedIn ? t("settings.signOut") : t("settings.signIn")}
          size="sm"
          disabled={busy}
          testId={`mcp-${server.signedIn ? "signout" : "signin"}-${server.name}`}
          onClick={() => {
            if (!server.signedIn) {
              void signIn()
              return
            }
            signOutOfServer(server.name)
            void reloadSkills().then(onChanged)
          }}
        />
      ) : null}
      <Button
        label={t("settings.remove")}
        variant="ghost"
        size="sm"
        disabled={busy}
        testId={`mcp-remove-${server.name}`}
        onClick={() => {
          signOutOfServer(server.name)
          removeMcpServer(server.name)
          void reloadSkills().then(onChanged)
        }}
      />
    </Row>
  )
}

function ProviderRow({
  account,
  provider,
  viaCli,
  onChanged,
}: {
  account: Account | undefined
  viaCli: boolean
  provider: ProviderId
  onChanged: () => void
}) {
  const t = useT()
  const spec = PROVIDERS[provider]
  const [pending, setPending] = useState<PendingSignIn | null>(null)
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)

  const finish = () => {
    setPending(null)
    setCode("")
    setError(null)
    void refreshCredentials()
    onChanged()
  }

  const start = async () => {
    setError(null)
    try {
      const flow = await beginSignIn(provider)
      setPending(flow)
      void openExternally(flow.url)
      flow.completed.then(finish, (reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const paste = () => {
    if (!pending || !code.trim()) return
    pending.submit(code).then(finish, (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    )
  }

  const detail = pending
    ? t("settings.provider.waiting")
    : account
      ? t("settings.provider.signedIn", { as: account.account ? ` as ${account.account}` : "" })
      : viaCli
        ? t("settings.provider.viaCli")
        : t("settings.provider.run", { label: spec.label })

  return (
    <Row
      title={spec.label}
      detail={error ?? detail}
      danger={Boolean(error)}
      expanded={
        pending ? (
          <TextField
            testId={`code-${provider}`}
            value={code}
            placeholder={t("settings.provider.waiting")}
            onChange={setCode}
            onSubmit={paste}
          />
        ) : null
      }
    >
      {pending ? (
        <>
          <Button
            label={t("btn.cancel")}
            variant="ghost"
            size="sm"
            onClick={() => {
              pending.cancel()
              setPending(null)
              setCode("")
            }}
          />
          <Button
            label={t("settings.finish")}
            variant="primary"
            size="sm"
            disabled={!code.trim()}
            testId={`settings-paste-${provider}`}
            onClick={paste}
            hint="↩"
          />
        </>
      ) : account ? (
        <Button
          label={t("settings.signOut")}
          size="sm"
          testId={`settings-signout-${provider}`}
          onClick={() => {
            signOutOfProvider(provider)
            onChanged()
          }}
        />
      ) : (
        <Button
          label={t("settings.signIn")}
          size="sm"
          variant="primary"
          testId={`settings-signin-${provider}`}
          onClick={() => void start()}
        />
      )}
    </Row>
  )
}

function KiroRow({ account }: { account: Account | undefined }) {
  const t = useT()
  return (
    <Row
      title="Kiro"
      detail={account ? t("settings.kiro.detected") : t("settings.kiro.notFound")}
    >
      <Label size={text.small} color={account ? color.tertiary : color.ghost}>
        {account ? t("settings.kiro.detectedTag") : t("settings.kiro.notFoundTag")}
      </Label>
    </Row>
  )
}

function LanguageRow({ state }: { state: AppState }) {
  const t = useT()
  const effective = resolveLang(state.lang)
  const options: { value: string; label: string }[] = [
    { value: "", label: t("settings.lang.automatic") },
    ...LANGUAGES.map((entry) => ({ value: entry.value, label: entry.label })),
  ]
  const current = options.find((entry) => entry.value === state.lang) ?? options[0]!
  const currentLabel =
    state.lang === "" ? `${t("settings.lang.automatic")} · ${effective}` : current.label
  return (
    <Row title={t("settings.lang.title")} detail={t("settings.lang.desc")}>
      <Select value={state.lang} onValueChange={(value) => setLang(String(value))}>
        <SelectTrigger asChild>
          <div
            testId="language-picker"
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              height: 24,
              paddingLeft: space.sm,
              paddingRight: space.sm,
              borderRadius: radius.sm,
              cursor: "pointer",
              userSelect: "none",
              hover: { backgroundColor: color.hover },
            }}
          >
            <Label size={text.small} color={color.tertiary}>
              {currentLabel}
            </Label>
            <Icon name="chevronDown" size={11} color={color.ghost} />
          </div>
        </SelectTrigger>
        <SelectContent
          side="bottom"
          align="end"
          sideOffset={8}
          style={{ ...overlayStyle(space.xs, space.xs), width: 240 }}
        >
          {options.map((option) => (
            <SelectItem
              key={option.value || "auto"}
              value={option.value}
              testId={`language-${option.value || "auto"}`}
              style={(itemState) => ({
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                flexShrink: 0,
                paddingLeft: space.md,
                paddingRight: space.md,
                paddingTop: space.sm,
                paddingBottom: space.sm,
                borderRadius: radius.sm,
                cursor: "pointer",
                backgroundColor: itemState.highlighted ? color.selected : undefined,
              })}
            >
              {(itemState) => (
                <>
                  <Label grow size={text.small} color={color.text}>
                    {option.label}
                  </Label>
                  {itemState.selected ? (
                    <Icon name="check" size={11} color={color.text} />
                  ) : null}
                </>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  )
}

function UpdateRow({ update }: { update: UpdateStatus }) {
  const t = useT()
  return (
    <Row
      title={t("settings.version.title")}
      detail={
        update.stage === "downloading"
          ? t("settings.version.downloading")
          : update.stage === "ready"
            ? t("settings.version.ready", { version: update.version })
            : update.stage === "error"
              ? update.message
              : t("settings.version.idle")
      }
      danger={update.stage === "error"}
    >
      {update.stage === "ready" ? (
        <Button
          label={t("settings.version.restart")}
          variant="primary"
          size="sm"
          testId="restart-to-update"
          onClick={() => void relaunch(update.appPath)}
        />
      ) : update.stage === "downloading" ? (
        <Label size={text.small} color={color.ghost}>
          {version}
        </Label>
      ) : (
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Label size={text.small} color={color.ghost}>
            {version}
          </Label>
          <Button
            label={t("settings.version.check")}
            size="sm"
            testId="check-for-updates"
            onClick={() => void checkForUpdate()}
          />
        </div>
      )}
    </Row>
  )
}

export function Settings({ state }: { state: AppState }) {
  const t = useT()
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  const focused = state.panes[state.focusedPane]?.sessionId ?? null
  const workspace = findWorkspace(state, findSession(state, focused)?.workspaceId ?? null)

  const alive = useRef(true)

  const reload = () => {
    void (async () => {
      const [version, status, skills] = await Promise.all([
        fxVersion(),
        fxStatus(),
        workspace ? loadSkills(workspace.path) : Promise.resolve({ names: [] as string[] }),
      ])
      if (!alive.current) return
      setLoaded({
        fx: version,
        fxStatus: status,
        skills: skills.names,
        servers: listMcpServers(),
        cli: (["grok", "codex"] as const).filter(cliSignedIn),
      })
    })()
  }

  useMountEffect(() => {
    reload()
    return () => {
      alive.current = false
    }
  })

  const changed = reload

  return (
    <div
      testId="settings"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.xl,
        minWidth: 0,
      }}
    >
      <SetupBanner state={state} />
      <Section title={t("settings.section.models")}>
        <ApiKeyRow state={state} />
        {(["grok", "codex"] as const).map((provider) => (
          <ProviderRow
            key={provider}
            provider={provider}
            account={state.accounts.find((entry) => entry.provider === provider)}
            viaCli={loaded?.cli.includes(provider) ?? false}
            onChanged={changed}
          />
        ))}
        <KiroRow account={state.accounts.find((entry) => entry.provider === "kiro")} />
        <Row
          title={t("settings.startsOn.title")}
          detail={
            state.defaultModel
              ? t("settings.startsOn.pinned")
              : t("settings.startsOn.auto", { model: DEFAULT_MODEL.name })
          }
        >
          <ModelChoice
            testId="default-model"
            value={keyOf(state.defaultModel)}
            label={t("settings.startsOn.automatic")}
            maxWidth={220}
            automatic={t("settings.startsOn.followLast")}
            onChange={(chosen) =>
              setState((current) => ({ ...current, defaultModel: chosen }))
            }
          />
        </Row>
      </Section>

      <Section title={t("settings.section.language")}>
        <LanguageRow state={state} />
      </Section>

      <Section title={t("settings.section.runtime")}>
        <Row
          title={t("settings.cli.title")}
          detail={
            state.useCli
              ? loaded
                ? loaded.fx
                  ? t("settings.cli.on", { binary: FX_BINARY, version: loaded.fx, status: loaded.fxStatus })
                  : loaded.fxStatus
                : t("settings.cli.reading")
              : t("settings.cli.off")
          }
        >
          <Button
            label={state.useCli ? t("settings.cli.turnOff") : t("settings.cli.turnOn")}
            size="sm"
            testId="settings-use-cli"
            onClick={() => void setUseCli(!state.useCli).then(reload)}
          />
        </Row>
        <Row
          title={t("settings.permission.title")}
          detail={t("settings.permission.desc")}
        >
          <Label size={text.small} color={color.tertiary}>
            {findSession(state, focused)?.mode ?? "ask"}
          </Label>
        </Row>
      </Section>

      <Section title={t("settings.section.extensions")}>
        <Row
          title={t("settings.skills.title")}
          detail={
            !loaded
              ? t("settings.skills.reading")
              : loaded.skills.length > 0
                ? loaded.skills.join(", ")
                : t("settings.skills.none")
          }
        >
          <Button
            label={t("settings.reload")}
            size="sm"
            testId="settings-reload"
            onClick={() => void reloadSkills().then(changed)}
          />
        </Row>
        <Row
          title={t("settings.mcp.title")}
          detail={
            !loaded
              ? t("settings.mcp.reading")
              : loaded.servers.length > 0
                ? t("settings.mcp.some")
                : t("settings.mcp.none")
          }
        />
        {(loaded?.servers ?? []).map((server) => (
          <McpServerRow
            key={server.name}
            server={server}
            onChanged={changed}
          />
        ))}
        <AddMcpServerRow onChanged={changed} />
      </Section>

      <Section title={t("settings.section.about")}>
        <UpdateRow update={state.update} />
        <Row title={t("settings.state.title")} detail={DIR}>
          <Label size={text.small} color={color.ghost}>
            {t("settings.state.detail", {
              workspaces: state.workspaces.length,
              sessions: state.sessions.length,
            })}
          </Label>
        </Row>
      </Section>
    </div>
  )
}

export function SettingsPage({
  state,
  needsInset,
  width,
}: {
  state: AppState
  needsInset: boolean
  width: number
}) {
  const t = useT()
  const { column, gutter } = columnFor(width)
  return (
    <div
      testId="settings-page"
      style={{
        flexGrow: 1,
        minWidth: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: color.background,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          ...titlebarBand,
          paddingLeft: needsInset ? TRAFFIC_LIGHT_INSET : PANE_PADDING,
          paddingRight: space.lg,
          userSelect: "none",
          flexShrink: 0,
        }}
      >
        <Label size={text.body} color={color.text}>
          {t("settings.title")}
        </Label>
        <div style={{ flexGrow: 1, minWidth: 0 }} />
        <Label size={text.micro} color={color.ghost}>
          {t("settings.savedAsYouGo")}
        </Label>
        <Kbd keys="esc" />
        <Button label={t("settings.done")} size="sm" testId="settings-done" onClick={() => setSettings(false)} />
      </div>

      <div
        testId="settings-scroll"
        style={{
          flexGrow: 1,
          minHeight: 0,
          overflowY: "scroll",
          paddingLeft: gutter,
          paddingRight: gutter,
          paddingBottom: space.xxl,
        }}
      >
        <div style={{ width: column, minWidth: 0 }}>
          <Settings state={state} />
        </div>
      </div>
    </div>
  )
}
