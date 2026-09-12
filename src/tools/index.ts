import { agentTools } from "./agents"
import { extensionTools } from "./extend"
import { fileTools } from "./files"
import { shellTools } from "./shell"
import { vcsTools } from "./vcs"
import { webTools } from "./web"
import { type HostTool, type ToolContext } from "./kit"

export {
  denyPendingApprovals,
  dismissPendingQuestions,
  forgetGrants,
  resolveApproval,
  resolveQuestion,
} from "./approvals"
export { adopt, forgetToolResults, searchRows, type HostTool } from "./kit"
export {
  globToRegExp,
  isAttachment,
  isDirectory,
  listWorkspaceFiles,
  resolveInside,
} from "./paths"
export { stopAllBackgroundCommands, stopBackgroundCommands } from "./shell"
export { GATEWAY_URL, IMAGE_TYPES, MAX_IMAGE_BYTES, htmlToText } from "./web"
export { editsForFile, findEditSession, forgetEdits, lastEdit, undoEdit, undoLastEdit } from "./edits"
export { stopBackgroundCommand } from "./shell"

export function createTools(context: ToolContext): HostTool[] {
  return [
    ...fileTools(context),
    ...shellTools(context),
    ...webTools(context),
    ...vcsTools(context),
    ...agentTools(context, createTools),
    ...extensionTools(context),
  ]
}
