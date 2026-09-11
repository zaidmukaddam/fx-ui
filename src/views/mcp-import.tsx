import { useState } from "react"

import { reloadSkills } from "../agent/agent"
import { getState, HOME_DIR, setState, useApp } from "../store"
import { useMountEffect } from "../ui/hooks"
import { color, space, text } from "../ui/theme"
import { Button, Label, Paragraph } from "../ui/ui"
import { pruneMcpGrants, signOutOfServer } from "../workspace/mcp"
import { isRemote } from "../workspace/mcp/config"
import { discoverMcpImports, importMcpServers, sameMcpImport, type McpImportEntry, type McpImportSource } from "../workspace/mcp/import"

export function McpImport({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [sources, setSources] = useState<McpImportSource[] | null>(null)
  const [selected, setSelected] = useState<McpImportEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const running = useApp().sessions.some((session) => session.status === "running")
  const refresh = () => {
    try {
      setSources(discoverMcpImports())
      setSelected([])
      setError(null)
    } catch {
      setError("The fx MCP config could not be read. Fix it before importing.")
    }
  }
  useMountEffect(refresh)

  const importSelected = async () => {
    if (busy || !selected.length || getState().sessions.some((session) => session.status === "running")) return
    setBusy(true)
    setError(null)
    try {
      const imported = importMcpServers(selected)
      for (const name of imported.imported) signOutOfServer(name)
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((session) => ({
          ...session,
          grants: pruneMcpGrants(session.grants),
        })),
      }))
      setResult(`Imported ${imported.imported.length} server${imported.imported.length === 1 ? "" : "s"}.${imported.skipped.length ? ` Skipped ${imported.skipped.length} already configured or unavailable.` : ""}`)
      refresh()
      onChanged()
      if (imported.imported.length) await reloadSkills()
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The servers could not be imported.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div testId="mcp-import-panel" style={{ display: "flex", flexDirection: "column", gap: space.lg, minWidth: 0 }}>
      <Paragraph size={text.small} color={color.tertiary}>
        Choose servers to copy into fx. Enabled servers connect after import; OAuth servers need a separate sign-in.
      </Paragraph>
      <div testId="mcp-import-list" style={{ display: "flex", flexDirection: "column", gap: space.lg, maxHeight: 300, overflowY: "scroll", minWidth: 0 }}>
        {sources === null && !error ? <Label size={text.small} color={color.faint}>Looking for configs…</Label> : null}
        {sources?.length === 0 ? <Paragraph size={text.small} color={color.faint}>No global MCP configs found in Cursor, Devin, or Windsurf.</Paragraph> : null}
        {sources?.map((source) => (
          <div key={source.id} style={{ display: "flex", flexDirection: "column", gap: space.sm, minWidth: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Label size={text.small}>{source.label}</Label>
              <Label truncate size={text.micro} color={color.ghost}>{source.file.replace(HOME_DIR, "~")}</Label>
            </div>
            {source.problem ? <Paragraph size={text.micro} color={color.danger}>{source.problem}</Paragraph> : null}
            {!source.problem && source.entries.length === 0 ? <Label size={text.micro} color={color.faint}>No servers in this config.</Label> : null}
            {source.entries.map((entry) => {
              const picked = selected.some((item) => item.id === entry.id)
              const detail = entry.problem ?? `${entry.config && isRemote(entry.config) ? "Remote" : "Local"}${entry.config?.disabled ? " · stays disabled" : ""}`
              return (
                <div key={entry.id} testId={`mcp-import-entry-${entry.id}`} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: space.lg, paddingTop: space.xs, paddingBottom: space.xs, minWidth: 0 }}>
                  <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0, gap: 2 }}>
                    <Label truncate size={text.small} color={entry.problem ? color.faint : color.text}>{entry.name}</Label>
                    <Paragraph size={text.micro} color={color.ghost}>{detail}</Paragraph>
                  </div>
                  <Button label={picked ? "Selected" : "Select"} icon={picked ? "check" : undefined} size="sm" variant={picked ? "secondary" : "ghost"}
                    testId={`mcp-import-select-${entry.id}`} disabled={busy || !!entry.problem}
                    onClick={() => setSelected((current) => picked
                      ? current.filter((item) => item.id !== entry.id)
                      : [...current.filter((item) => !sameMcpImport(item, entry)), entry])} />
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {error ? <Paragraph size={text.small} color={color.danger}>{error}</Paragraph> : null}
      {result ? <Label size={text.small} color={color.secondary}>{result}</Label> : null}
      {running ? <Paragraph size={text.micro} color={color.faint}>Wait for running turns to finish before importing.</Paragraph> : null}
      <div style={{ display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: space.md }}>
        <Button label={result ? "Done" : "Cancel"} size="sm" variant="ghost" disabled={busy} onClick={onClose} />
        <Button label={busy ? "Connecting…" : `Import${selected.length ? ` ${selected.length}` : " selected"}`} testId="mcp-import-confirm" size="sm" variant="primary" disabled={busy || running || !selected.length} onClick={() => void importSelected()} />
      </div>
    </div>
  )
}
