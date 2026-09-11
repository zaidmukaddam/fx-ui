import path from "node:path"

import { Icon } from "../ui/icons"
import { useT } from "../ui/i18n"
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
  const t = useT()
  const dialog = state.overlay
  if (!dialog || dialog.kind === "palette") return null
  const close = () => setDialog(null)

  if (dialog.kind === "add-workspace") {
    const submit = () => {
      const candidate = path.resolve(dialog.value.trim().replace(/^~/, process.env.HOME ?? "~"))
      if (!isDirectory(candidate)) {
        setDialog({ ...dialog, error: t("dialog.addWorkspace.notDir") })
        return
      }
      if (state.workspaces.some((workspace) => workspace.path === candidate)) {
        setDialog({ ...dialog, error: t("dialog.addWorkspace.exists") })
        return
      }
      close()
      const workspace = createWorkspace(candidate, path.basename(candidate))
      startSession(workspace.id)
    }
    return (
      <DialogShell
        title={t("dialog.addWorkspace.title")}
        description={t("dialog.addWorkspace.desc")}
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
          <Button label={t("btn.cancel")} variant="ghost" onClick={close} />
          <Button
            label={t("btn.addWorkspace")}
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
        title={t("dialog.renameSession.title")}
        description={t("dialog.renameSession.desc")}
        onClose={close}
      >
        <TextField
          testId="session-title"
          value={dialog.value}
          placeholder={t("dialog.renameSession.placeholder")}
          onChange={(value) => setDialog({ ...dialog, value })}
          onSubmit={submit}
        />
        <Actions>
          <Button label={t("btn.cancel")} variant="ghost" onClick={close} />
          <Button
            label={t("btn.rename")}
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
        title={t("dialog.deleteSession.title")}
        description={t("dialog.deleteSession.desc", {
          title: session?.title ?? t("dialog.deleteSession.fallback"),
        })}
        onClose={close}
      >
        <Actions>
          <Button label={t("btn.cancel")} variant="ghost" onClick={close} />
          <Button
            label={t("btn.deleteSession")}
            variant="danger"
            testId="confirm-delete-session"
            onClick={() => {
              close()
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
      title={t("dialog.removeWorkspace.title")}
      description={t("dialog.removeWorkspace.desc", {
        name: workspace?.name ?? t("dialog.removeWorkspace.fallback"),
        count,
      })}
      onClose={close}
    >
      <Actions>
        <Button label={t("btn.cancel")} variant="ghost" onClick={close} />
        <Button
          label={t("btn.removeWorkspace")}
          variant="danger"
          testId="confirm-remove-workspace"
          onClick={() => {
            close()
            removeWorkspace(dialog.workspaceId)
          }}
        />
      </Actions>
    </DialogShell>
  )
}
