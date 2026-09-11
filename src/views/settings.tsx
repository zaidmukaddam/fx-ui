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
  setMcpDisabled,
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
import {
  DEFAULT_MODEL,
  DIR,
  apiKeySource,
  findSession,
  findWorkspace,
  getState,
  setSettings,
  setState,
  type Account,
  type AppState,
  type UpdateStatus,
} from "../store"
import { ModelChoice, keyOf } from "./models"
import { McpImport } from "./mcp-import"
import { expandMcpValue } from "../workspace/mcp/variables"
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
import { Button, Kbd, Label, Paragraph, TextField } from "../ui/ui"

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
        Nothing can answer a prompt yet
      </Label>
      <Paragraph size={text.micro} color={color.ghost}>
        Paste an AI Gateway key or sign in to Grok or Codex below.
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
      title="AI Gateway API key"
      detail={
        fromEnv
          ? "Taken from AI_GATEWAY_API_KEY in the environment, which wins over a saved one."
          : state.apiKey
            ? `${masked(state.apiKey)} · saved in ~/.fx-ui/state.json, readable only by you.`
            : "Needed for every model the Gateway serves. A subscription below needs no key."
      }
      expanded={
        editing ? (
          <TextField
            testId="api-key"
            value={draft}
            placeholder="vck_…"
            onChange={setDraft}
            onSubmit={save}
          />
        ) : null
      }
    >
      {fromEnv ? null : editing ? (
        <>
          <Button label="Cancel" variant="ghost" size="sm" onClick={() => setDraft(null)} />
          <Button
            label="Save"
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
              label="Clear"
              variant="ghost"
              size="sm"
              testId="settings-clear-key"
              onClick={() => setState((current) => ({ ...current, apiKey: null }))}
            />
          ) : null}
          <Button
            label={state.apiKey ? "Replace" : "Add"}
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
      title="Add a server"
      detail={
        error ??
        "A URL for a remote server, or the command that starts a local one. It connects straight away."
      }
      danger={Boolean(error)}
      expanded={
        adding ? (
          <>
            <TextField
              testId="mcp-name"
              value={name}
              placeholder="linear"
              onChange={setName}
              onSubmit={save}
            />
            <TextField
              testId="mcp-source"
              value={source}
              placeholder="https://mcp.linear.app/mcp or npx -y some-server"
              onChange={setSource}
              onSubmit={save}
            />
          </>
        ) : null
      }
    >
      {adding ? (
        <>
          <Button label="Cancel" variant="ghost" size="sm" onClick={cancel} />
          <Button
            label="Add"
            variant="primary"
            size="sm"
            hint="↩"
            testId="mcp-save"
            onClick={save}
          />
        </>
      ) : (
        <Button
          label="Add"
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
  running,
  onChanged,
}: {
  server: Server
  running: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signIn = async () => {
    setError(null)
    setBusy(true)
    try {
      const flow = await beginServerSignIn(server.name, expandMcpValue(server.url!), null, openExternally)
      await flow.completed
      await reloadSkills()
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  let host = "Remote"
  try {
    if (server.url) host = new URL(server.url).host
  } catch {}
  const detail = error
    ? error
    : busy
      ? "Waiting for the browser to finish the sign-in."
      : server.disabled
        ? "Disabled. This server will not connect until enabled."
      : server.url
        ? server.signedIn
          ? `${host} · signed in · ${server.tools} tools`
          : `${host} · ${server.tools} tools. Sign in if this server requires OAuth.`
        : `Local · ${server.tools} tools`

  return (
    <Row title={server.name} detail={detail}>
      {server.url && !server.disabled ? (
        <Button
          label={server.signedIn ? "Sign out" : "Sign in"}
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
      <Button label={server.disabled ? "Enable" : "Disable"} size="sm" variant="ghost" disabled={busy || running}
        testId={`mcp-toggle-${server.name}`}
        onClick={() => {
          if (busy || getState().sessions.some((session) => session.status === "running")) return
          setBusy(true)
          setError(null)
          void (async () => {
            try {
              setMcpDisabled(server.name, !server.disabled)
              await reloadSkills()
              onChanged()
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason))
            } finally {
              setBusy(false)
            }
          })()
        }} />
      <Button
        label="Remove"
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
    ? "Waiting for the browser. If it shows a code to copy instead, paste it here."
    : account
      ? `Signed in${account.account ? ` as ${account.account}` : ""}. Its models are in the picker.`
      : viaCli
        ? `Signed in with the fx CLI, which only that runtime can use. Sign in here to reach it in this process.`
        : `Run turns on your ${spec.label} subscription instead of the Gateway key.`

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
            placeholder="Paste the code the browser showed"
            onChange={setCode}
            onSubmit={paste}
          />
        ) : null
      }
    >
      {pending ? (
        <>
          <Button
            label="Cancel"
            variant="ghost"
            size="sm"
            onClick={() => {
              pending.cancel()
              setPending(null)
              setCode("")
            }}
          />
          <Button
            label="Finish"
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
          label="Sign out"
          size="sm"
          testId={`settings-signout-${provider}`}
          onClick={() => {
            signOutOfProvider(provider)
            onChanged()
          }}
        />
      ) : (
        <Button
          label="Sign in"
          size="sm"
          variant="primary"
          testId={`settings-signin-${provider}`}
          onClick={() => void start()}
        />
      )}
    </Row>
  )
}

function UpdateRow({ update }: { update: UpdateStatus }) {
  return (
    <Row
      title="Version"
      detail={
        update.stage === "downloading"
          ? "Downloading the update…"
          : update.stage === "ready"
            ? `Update ${update.version} downloaded`
            : update.stage === "error"
              ? update.message
              : "fx-ui"
      }
      danger={update.stage === "error"}
    >
      {update.stage === "ready" ? (
        <Button
          label="Restart to update"
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
            label="Check for updates"
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
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [importing, setImporting] = useState(false)

  const focused = state.panes[state.focusedPane]?.sessionId ?? null
  const workspace = findWorkspace(state, findSession(state, focused)?.workspaceId ?? null)
  const running = state.sessions.some((session) => session.status === "running")

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
      <Section title="Models">
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
        <Row
          title="New sessions start on"
          detail={
            state.defaultModel
              ? "Every new session opens on this model, whatever the last one used."
              : `A new session follows the last one in that workspace. The first opens on a signed-in subscription's own model, or ${DEFAULT_MODEL.name} on the Gateway.`
          }
        >
          <ModelChoice
            testId="default-model"
            value={keyOf(state.defaultModel)}
            label="Automatic"
            maxWidth={220}
            automatic="Follow the last session"
            onChange={(chosen) =>
              setState((current) => ({ ...current, defaultModel: chosen }))
            }
          />
        </Row>
      </Section>

      <Section title="Runtime">
        <Row
          title="Run through the fx CLI"
          detail={
            state.useCli
              ? loaded
                ? loaded.fx
                  ? `Using ${FX_BINARY} ${loaded.fx} · ${loaded.fxStatus}`
                  : loaded.fxStatus
                : "Reading the binary…"
              : "Hands turns to the fx binary, which carries providers this app does not."
          }
        >
          <Button
            label={state.useCli ? "Turn off" : "Turn on"}
            size="sm"
            testId="settings-use-cli"
            onClick={() => void setUseCli(!state.useCli).then(reload)}
          />
        </Row>
        <Row
          title="Permission mode"
          detail="Set per session, from the composer. `ask` stops before every write and command."
        >
          <Label size={text.small} color={color.tertiary}>
            {findSession(state, focused)?.mode ?? "ask"}
          </Label>
        </Row>
      </Section>

      <Section title="Extensions">
        <Row
          title="Skills"
          detail={
            !loaded
              ? "Reading…"
              : loaded.skills.length > 0
                ? loaded.skills.join(", ")
                : "None in this workspace. Add SKILL.md files under .fx/skills or ~/.fx/skills."
          }
        >
          <Button
            label="Reload"
            size="sm"
            testId="settings-reload"
            onClick={() => void reloadSkills().then(changed)}
          />
        </Row>
        <Row
          title="MCP servers"
          detail={
            !loaded
              ? "Reading…"
              : loaded.servers.length > 0
                ? running
                  ? "Wait for running turns to finish before importing, enabling, or disabling servers."
                  : "Configured in ~/.fx-ui/mcp.json, never from a workspace. A remote server's tools ask before they run."
                : "None configured. Add them to ~/.fx-ui/mcp.json: a `command` for a local one, a `url` for a remote one."
          }
          expanded={importing ? <McpImport onClose={() => setImporting(false)} onChanged={changed} /> : null}
        >
          {!importing ? <Button label="Import" size="sm" testId="mcp-import" onClick={() => setImporting(true)} /> : null}
        </Row>
        {(loaded?.servers ?? []).map((server) => (
          <McpServerRow
            key={server.name}
            server={server}
            running={running}
            onChanged={changed}
          />
        ))}
        <AddMcpServerRow onChanged={changed} />
      </Section>

      <Section title="About">
        <UpdateRow update={state.update} />
        <Row title="State" detail={DIR}>
          <Label size={text.small} color={color.ghost}>
            {`${state.workspaces.length} workspaces · ${state.sessions.length} sessions`}
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
          Settings
        </Label>
        <div style={{ flexGrow: 1, minWidth: 0 }} />
        <Label size={text.micro} color={color.ghost}>
          Saved as you go
        </Label>
        <Kbd keys="esc" />
        <Button label="Done" size="sm" testId="settings-done" onClick={() => setSettings(false)} />
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
