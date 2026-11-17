import path from "node:path"

import { closeSession } from "../agent/agent"
import { Icon } from "../ui/icons"
import { color, space, text } from "../ui/theme"
import { Backdrop, Button, Label, Paragraph, TextField, overlayStyle } from "../ui/ui"
import { isDirectory } from "../tools"
import {
  createWorkspace,
  findSession,
  findWorkspace,
  removeSession,
  removeWorkspace,
  setDialog,
  startSession,
  updateSession,
  type AppState,
} from "../store"

const DIALOG_WIDTH = 460

function DialogShell({
  title,
  description,
  children,
  onClose,
}: {
  title: string
  description: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <Backdrop width={DIALOG_WIDTH} top={140}>
      <div
        testId="dialog"
        onMouseDownOutside={onClose}
        style={{ ...overlayStyle(space.xl, space.xl), width: DIALOG_WIDTH, gap: space.lg }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <Label size={text.title} color={color.text}>
            {title}
          </Label>
          <Paragraph size={text.small} color={color.tertiary}>
            {description}
          </Paragraph>
        </div>
        {children}
      </div>
    </Backdrop>
  )
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
      }}
    >
      <Icon name="circleAlert" size={12} color={color.danger} />
      <Label size={text.small} color={color.danger}>
        {message}
      </Label>
    </div>
  )
}

function Actions({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: space.md,
      }}
    >
      {children}
    </div>
  )
}

export function Dialogs({ state }: { state: AppState }) {
  const dialog = state.overlay
  if (!dialog || dialog.kind === "palette") return null
  const close = () => setDialog(null)

  if (dialog.kind === "add-workspace") {
    const submit = () => {
      const candidate = path.resolve(dialog.value.trim().replace(/^~/, process.env.HOME ?? "~"))
      if (!isDirectory(candidate)) {
        setDialog({ ...dialog, error: "That path is not a directory on this machine." })
        return
      }
      if (state.workspaces.some((workspace) => workspace.path === candidate)) {
        setDialog({ ...dialog, error: "That directory is already a workspace." })
        return
      }
      close()
      const workspace = createWorkspace(candidate, path.basename(candidate))
      startSession(workspace.id)
    }
    return (
      <DialogShell
        title="Add a workspace"
        description="The agent can read, edit, and run commands inside this directory and nowhere else."
        onClose={close}
      >
        <TextField
          testId="workspace-path"
          value={dialog.value}
          placeholder="/Users/you/projects/app"
          onChange={(value) => setDialog({ ...dialog, value, error: null })}
          onSubmit={submit}
        />
        {dialog.error ? <ErrorLine message={dialog.error} /> : null}
        <Actions>
          <Button label="Cancel" variant="ghost" onClick={close} />
          <Button
            label="Add workspace"
            variant="primary"
            testId="confirm-add-workspace"
            onClick={submit}
            hint="↩"
          />
        </Actions>
      </DialogShell>
    )
  }

  if (dialog.kind === "rename-session") {
    const submit = () => {
      const title = dialog.value.trim()
      close()
      if (title) updateSession(dialog.sessionId, (session) => ({ ...session, title }))
    }
    return (
      <DialogShell
        title="Rename this session"
        description="The name shows in the sidebar, the palette, and the pane header."
        onClose={close}
      >
        <TextField
          testId="session-title"
          value={dialog.value}
          placeholder="What this session is about"
          onChange={(value) => setDialog({ ...dialog, value })}
          onSubmit={submit}
        />
        <Actions>
          <Button label="Cancel" variant="ghost" onClick={close} />
          <Button
            label="Rename"
            variant="primary"
            testId="confirm-rename-session"
            onClick={submit}
            hint="↩"
          />
        </Actions>
      </DialogShell>
    )
  }

  if (dialog.kind === "delete-session") {
    const session = findSession(state, dialog.sessionId)
    return (
      <DialogShell
        title="Delete this session?"
        description={`"${session?.title ?? "This session"}" and its saved history are removed. The files it changed are not touched.`}
        onClose={close}
      >
        <Actions>
          <Button label="Cancel" variant="ghost" onClick={close} />
          <Button
            label="Delete session"
            variant="danger"
            testId="confirm-delete-session"
            onClick={() => {
              close()
              // Drop its agent unsaved, or a later restart writes the checkpoint back.
              void closeSession(dialog.sessionId)
              removeSession(dialog.sessionId)
            }}
          />
        </Actions>
      </DialogShell>
    )
  }

  const workspace = findWorkspace(state, dialog.workspaceId)
  const count = state.sessions.filter(
    (session) => session.workspaceId === dialog.workspaceId,
  ).length
  return (
    <DialogShell
      title="Remove this workspace?"
      description={`"${workspace?.name ?? "This workspace"}" and its ${count} session${count === 1 ? "" : "s"} are removed from fx. The directory on disk is not touched.`}
      onClose={close}
    >
      <Actions>
        <Button label="Cancel" variant="ghost" onClick={close} />
        <Button
          label="Remove workspace"
          variant="danger"
          testId="confirm-remove-workspace"
          onClick={() => {
            close()
            for (const session of state.sessions) {
              if (session.workspaceId === dialog.workspaceId) void closeSession(session.id)
            }
            removeWorkspace(dialog.workspaceId)
          }}
        />
      </Actions>
    </DialogShell>
  )
}
