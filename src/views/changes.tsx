import path from "node:path"

import { useRef, useState } from "react"
import { useGpuix, type PublicInstance } from "@gpuix/react"
import type { EventPayload } from "@gpuix/native"

import { Icon, type IconName } from "../ui/icons"
import { color, nativeTheme, radius, space, text } from "../ui/theme"
import { Badge, IconButton, Label } from "../ui/ui"
import { useMountEffect } from "../ui/hooks"
import { notice, useApp, type Workspace } from "../store"
import { findEditSession, undoEdit } from "../tools"
import { openExternally } from "../workspace/open"
import {
  activateDiff,
  closeDiffTab,
  ensureCombinedDiff,
  MAX_UNTRACKED_PATCHES,
  refreshGitStatus,
  viewDiff,
  type ChangedFile,
  type DiffScope,
  type DiffTab,
  type GitStatus,
} from "../workspace/git"

const CODE_TONE: Record<string, string> = {
  A: color.secondary,
  D: color.danger,
  M: color.tertiary,
  R: color.tertiary,
  U: color.danger,
  "?": color.secondary,
}

function Stats({ file }: { file: ChangedFile }) {
  if (file.added === null && file.deleted === null) return null
  return (
    <div style={{ display: "flex", flexDirection: "row", gap: space.sm, flexShrink: 0 }}>
      {file.added ? (
        <Label size={text.micro} color={color.tertiary}>
          {`+${file.added}`}
        </Label>
      ) : null}
      {file.deleted ? (
        <Label size={text.micro} color={color.faint}>
          {`−${file.deleted}`}
        </Label>
      ) : null}
    </div>
  )
}

function FileRow({
  workspaceId,
  file,
  scope,
}: {
  workspaceId: string
  file: ChangedFile
  scope: DiffScope
}) {
  return (
    <div
      testId={`change-${scope}-${file.repoPath}`}
      onClick={() => viewDiff(workspaceId, file, scope)}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        height: 28,
        paddingLeft: space.xl,
        paddingRight: space.md,
        flexShrink: 0,
        borderRadius: radius.sm,
        cursor: "pointer",
        userSelect: "none",
        hover: { backgroundColor: color.hover },
      }}
    >
      <Badge tone={CODE_TONE[file.code] ?? color.tertiary}>{file.code}</Badge>
      <Label grow truncate size={text.small} color={color.text}>
        {file.path}
      </Label>
      <Stats file={file} />
      <Icon name="chevronRight" size={11} color={color.ghost} />
    </div>
  )
}

function Group({
  title,
  workspaceId,
  files,
  scope,
}: {
  title: string
  workspaceId: string
  files: ChangedFile[]
  scope: DiffScope
}) {
  if (files.length === 0) return null
  return (
    <div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 26,
          paddingLeft: space.lg,
          flexShrink: 0,
        }}
      >
        <Label size={text.micro} color={color.ghost}>
          {`${title.toUpperCase()} · ${files.length}`}
        </Label>
      </div>
      {files.map((file) => (
        <FileRow
          key={`${scope}:${file.repoPath}`}
          workspaceId={workspaceId}
          file={file}
          scope={scope}
        />
      ))}
    </div>
  )
}

function EmptyHint({ icon, children }: { icon?: IconName; children: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        padding: space.xl,
        minHeight: 60,
      }}
    >
      {icon ? <Icon name={icon} size={20} color={color.faint} /> : null}
      <Label size={text.small} color={color.faint}>
        {children}
      </Label>
    </div>
  )
}

function ChangeStats({ files }: { files: ChangedFile[] }) {
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0)
  if (added === 0 && deleted === 0) return null
  return (
    <div style={{ display: "flex", flexDirection: "row", gap: space.sm, flexShrink: 0 }}>
      {added ? (
        <Label size={text.micro} color={color.tertiary}>
          {`+${added}`}
        </Label>
      ) : null}
      {deleted ? (
        <Label size={text.micro} color={color.faint}>
          {`−${deleted}`}
        </Label>
      ) : null}
    </div>
  )
}

function FileTab({
  workspaceId,
  tab,
  active,
}: {
  workspaceId: string
  tab: DiffTab
  active: boolean
}) {
  return (
    <div
      testId={`change-tab-${tab.key}`}
      onClick={() => activateDiff(workspaceId, tab.key)}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        height: 26,
        maxWidth: 180,
        flexShrink: 0,
        paddingLeft: space.md,
        paddingRight: space.xs,
        borderRadius: radius.sm,
        cursor: "pointer",
        userSelect: "none",
        backgroundColor: active ? color.selected : undefined,
        hover: { backgroundColor: active ? color.selected : color.hover },
      }}
    >
      <Badge tone={CODE_TONE[tab.file.code] ?? color.tertiary}>{tab.file.code}</Badge>
      <Label truncate size={text.small} color={active ? color.text : color.secondary}>
        {path.basename(tab.file.path)}
      </Label>
      {tab.scope !== "worktree" ? (
        <Label size={text.micro} color={color.ghost}>
          {tab.scope === "untracked" ? "new" : tab.scope}
        </Label>
      ) : null}
      <IconButton
        icon="x"
        tooltip="Close tab"
        size={16}
        testId={`change-tab-close-${tab.key}`}
        onClick={() => closeDiffTab(workspaceId, tab.key)}
      />
    </div>
  )
}

function FilesTab({ active, count, onClick }: { active: boolean; count: number; onClick: () => void }) {
  return (
    <div
      testId="change-tab-files"
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        height: 26,
        paddingLeft: space.md,
        paddingRight: space.md,
        flexShrink: 0,
        borderRadius: radius.sm,
        cursor: "pointer",
        userSelect: "none",
        backgroundColor: active ? color.selected : undefined,
        hover: { backgroundColor: active ? color.selected : color.hover },
      }}
    >
      <Icon name="list" size={11} color={active ? color.text : color.ghost} />
      <Label size={text.small} color={active ? color.text : color.secondary}>
        Files
      </Label>
      {count > 0 ? (
        <Label size={text.micro} color={color.faint}>
          {`${count}`}
        </Label>
      ) : null}
    </div>
  )
}

function ChangedFiles({ workspaceId, status }: { workspaceId: string; status: GitStatus }) {
  const staged = status.files.filter((file) => file.staged)
  const worktree = status.files.filter((file) => file.unstaged)
  const untracked = status.files.filter((file) => file.untracked)
  return (
    <div
      style={{
        flexShrink: 0,
        maxHeight: "35%",
        overflowY: "scroll",
        paddingTop: space.sm,
        paddingBottom: space.sm,
        paddingLeft: space.xs,
        paddingRight: space.xs,
      }}
    >
      <Group title="Staged" workspaceId={workspaceId} files={staged} scope="staged" />
      <Group title="Modified" workspaceId={workspaceId} files={worktree} scope="worktree" />
      <Group title="Untracked" workspaceId={workspaceId} files={untracked} scope="untracked" />
    </div>
  )
}

export function ChangesView({
  workspace,
  onClose,
}: {
  workspace: Workspace
  onClose: () => void
}) {
  const state = useApp()
  const status = state.git[workspace.id]
  const view = state.diffView[workspace.id]
  const renderer = useGpuix().renderer
  const stripRef = useRef<PublicInstance | null>(null)
  const seenTabs = useRef(0)
  const [wordDiff, setWordDiff] = useState(true)

  useMountEffect(() => {
    void refreshGitStatus(workspace.id).then(() =>
      ensureCombinedDiff(workspace.id),
    )
  })

  const tabs = view?.tabs ?? []
  const active = tabs.find((tab) => tab.key === view?.active) ?? null
  const home = active === null
  const combined = view?.combined ?? null

  if (active && tabs.length > seenTabs.current) {
    setTimeout(() => {
      const strip = stripRef.current
      if (strip) renderer?.scrollTo?.(strip.id, -1_000_000, 0)
    }, 0)
  }
  seenTabs.current = tabs.length

  const sessionIds = state.sessions
    .filter((session) => session.workspaceId === workspace.id)
    .map((session) => session.id)
  const undoSession = active ? findEditSession(sessionIds, active.file.path) : null

  const undo = () => {
    if (!active || !undoSession) return
    try {
      notice(undoSession, "info", undoEdit(undoSession, active.file.path))
    } catch (error) {
      notice(
        undoSession,
        "error",
        error instanceof Error ? error.message : String(error),
      )
    }
    void refreshGitStatus(workspace.id)
  }

  const files = status?.files ?? []
  const unshown = Math.max(
    0,
    files.filter((file) => file.untracked).length - MAX_UNTRACKED_PATCHES,
  )
  const location = home
    ? status
      ? `${files.length} changed file${files.length === 1 ? "" : "s"}`
      : "Changes"
    : active.file.path

  const openFromHeader = (event: EventPayload) => {
    const repoPath = (event.value ?? "").replace(/^[ab]\//, "")
    const file = files.find((entry) => entry.repoPath === repoPath)
    if (!file) return
    viewDiff(
      workspace.id,
      file,
      file.unstaged ? "worktree" : file.staged ? "staged" : "untracked",
    )
  }

  return (
    <div
      testId="changes-view"
      style={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        minHeight: 0,
        backgroundColor: color.background,
      }}
    >
      {tabs.length > 0 ? (
        <div
          testId="changes-tabs"
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            height: 34,
            paddingLeft: space.sm,
            paddingRight: space.sm,
            flexShrink: 0,
            borderBottomWidth: 1,
            borderColor: color.border,
            userSelect: "none",
          }}
        >
          <FilesTab
            active={home}
            count={files.length}
            onClick={() => activateDiff(workspace.id, null)}
          />
          <div
            ref={stripRef}
            testId="changes-tabstrip"
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
              flexGrow: 1,
              minWidth: 0,
              height: "100%",
              overflowX: "scroll",
            }}
          >
            {tabs.map((tab) => (
              <FileTab
                key={tab.key}
                workspaceId={workspace.id}
                tab={tab}
                active={tab.key === active?.key}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          height: 34,
          paddingLeft: space.lg,
          paddingRight: space.sm,
          flexShrink: 0,
          borderBottomWidth: 1,
          borderColor: color.border,
          userSelect: "none",
        }}
      >
        <Icon name="gitBranch" size={11} color={color.ghost} />
        <Label size={text.micro} color={color.tertiary}>
          {status?.branch ?? "…"}
        </Label>
        <Label size={text.micro} color={color.ghost}>
          /
        </Label>
        <Label grow truncate size={text.micro} color={color.secondary}>
          {location}
        </Label>
        {home ? <ChangeStats files={files} /> : null}
        <IconButton
          glyph="Aa"
          tooltip={wordDiff ? "Showing word diff" : "Showing line diff"}
          size={22}
          active={wordDiff}
          testId="changes-word-diff"
          onClick={() => setWordDiff(!wordDiff)}
        />
        {undoSession ? (
          <IconButton
            icon="history"
            tooltip="Undo the last edit to this file"
            size={22}
            testId="changes-undo"
            onClick={undo}
          />
        ) : null}
        {active ? (
          <IconButton
            icon="externalLink"
            tooltip="Open in editor"
            size={22}
            testId="changes-open"
            onClick={() =>
              void openExternally(path.resolve(workspace.path, active.file.path))
            }
          />
        ) : null}
        <IconButton
          icon="refreshCw"
          tooltip="Refresh"
          size={22}
          testId="changes-refresh"
          onClick={() => void refreshGitStatus(workspace.id)}
        />
        <IconButton
          icon="x"
          tooltip="Close changes"
          size={22}
          testId="changes-close"
          onClick={onClose}
        />
      </div>

      {status === undefined ? (
        <EmptyHint icon="refreshCw">Checking for changes…</EmptyHint>
      ) : status === null ? (
        <EmptyHint icon="circleAlert">Not a git repository</EmptyHint>
      ) : home ? (
        files.length === 0 ? (
          <EmptyHint icon="circleCheck">No changes in this workspace</EmptyHint>
        ) : (
          <>
            <ChangedFiles workspaceId={workspace.id} status={status} />
            {combined?.error ? (
              <EmptyHint icon="circleAlert">{combined.error}</EmptyHint>
            ) : combined === null || combined.patch === null ? (
              <EmptyHint icon="refreshCw">Loading diff…</EmptyHint>
            ) : combined.patch === "" ? null : (
              <div
                style={{
                  flexGrow: 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                  borderTopWidth: 1,
                  borderColor: color.border,
                }}
              >
                {unshown > 0 ? (
                  <div
                    testId="changes-unshown"
                    style={{
                      paddingLeft: space.lg,
                      paddingTop: space.sm,
                      paddingBottom: space.sm,
                      flexShrink: 0,
                    }}
                  >
                    <Label size={text.micro} color={color.tertiary}>
                      {`${unshown} more untracked file${unshown === 1 ? " is" : "s are"} not shown here. Open ${unshown === 1 ? "it" : "them"} from the list above.`}
                    </Label>
                  </div>
                ) : null}
                <diff
                  testId="changes-combined"
                  patch={combined.patch}
                  wordDiff={wordDiff}
                  scroll
                  theme={nativeTheme}
                  onToggleFile={openFromHeader}
                  style={{ flexGrow: 1, minHeight: 0 }}
                />
              </div>
            )}
          </>
        )
      ) : (
        <div
          style={{
            flexGrow: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {active.error ? (
            <EmptyHint icon="circleAlert">{active.error}</EmptyHint>
          ) : active.patch === null ? (
            <EmptyHint icon="refreshCw">Loading…</EmptyHint>
          ) : active.patch === "" ? (
            <EmptyHint icon="circleCheck">No textual changes</EmptyHint>
          ) : (
            <diff
              patch={active.patch}
              wordDiff={wordDiff}
              scroll
              theme={nativeTheme}
              style={{ flexGrow: 1, minHeight: 0 }}
            />
          )}
        </div>
      )}
    </div>
  )
}
