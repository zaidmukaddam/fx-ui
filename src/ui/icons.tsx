import iconArrowUp from "../../assets/icons/arrow-up.svg" with { type: "text" }
import iconBot from "../../assets/icons/bot.svg" with { type: "text" }
import iconBox from "../../assets/icons/box.svg" with { type: "text" }
import iconCheck from "../../assets/icons/check.svg" with { type: "text" }
import iconChevronDown from "../../assets/icons/chevron-down.svg" with { type: "text" }
import iconChevronRight from "../../assets/icons/chevron-right.svg" with { type: "text" }
import iconCircleAlert from "../../assets/icons/circle-alert.svg" with { type: "text" }
import iconCircleCheck from "../../assets/icons/circle-check.svg" with { type: "text" }
import iconColumns from "../../assets/icons/columns-2.svg" with { type: "text" }
import iconCommand from "../../assets/icons/command.svg" with { type: "text" }
import iconCopy from "../../assets/icons/copy.svg" with { type: "text" }
import iconDownload from "../../assets/icons/download.svg" with { type: "text" }
import iconEllipsis from "../../assets/icons/ellipsis.svg" with { type: "text" }
import iconFileDiff from "../../assets/icons/file-diff.svg" with { type: "text" }
import iconFilePen from "../../assets/icons/file-pen-line.svg" with { type: "text" }
import iconFileSearch from "../../assets/icons/file-search.svg" with { type: "text" }
import iconFileText from "../../assets/icons/file-text.svg" with { type: "text" }
import iconFolder from "../../assets/icons/folder.svg" with { type: "text" }
import iconFxMark from "../../assets/icons/fx-mark.svg" with { type: "text" }
import iconFolderPlus from "../../assets/icons/folder-plus.svg" with { type: "text" }
import iconGitBranch from "../../assets/icons/git-branch.svg" with { type: "text" }
import iconGlobe from "../../assets/icons/globe.svg" with { type: "text" }
import iconHistory from "../../assets/icons/history.svg" with { type: "text" }
import iconImage from "../../assets/icons/image.svg" with { type: "text" }
import iconInfo from "../../assets/icons/info.svg" with { type: "text" }
import iconLink from "../../assets/icons/link.svg" with { type: "text" }
import iconList from "../../assets/icons/list.svg" with { type: "text" }
import iconMessage from "../../assets/icons/message-square.svg" with { type: "text" }
import iconPanelLeft from "../../assets/icons/panel-left.svg" with { type: "text" }
import iconPanelRightClose from "../../assets/icons/panel-right-close.svg" with { type: "text" }
import iconPlug from "../../assets/icons/plug.svg" with { type: "text" }
import iconPlus from "../../assets/icons/plus.svg" with { type: "text" }
import iconScrollText from "../../assets/icons/scroll-text.svg" with { type: "text" }
import iconSearch from "../../assets/icons/search.svg" with { type: "text" }
import iconSettings from "../../assets/icons/settings.svg" with { type: "text" }
import iconShieldAlert from "../../assets/icons/shield-alert.svg" with { type: "text" }
import iconSparkle from "../../assets/icons/sparkle.svg" with { type: "text" }
import iconSquare from "../../assets/icons/square.svg" with { type: "text" }
import iconTerminal from "../../assets/icons/terminal.svg" with { type: "text" }
import iconTrash from "../../assets/icons/trash.svg" with { type: "text" }
import iconX from "../../assets/icons/x.svg" with { type: "text" }

export const ICONS = {
  arrowUp: iconArrowUp,
  bot: iconBot,
  box: iconBox,
  check: iconCheck,
  chevronDown: iconChevronDown,
  chevronRight: iconChevronRight,
  circleAlert: iconCircleAlert,
  circleCheck: iconCircleCheck,
  columns: iconColumns,
  command: iconCommand,
  copy: iconCopy,
  download: iconDownload,
  ellipsis: iconEllipsis,
  fileDiff: iconFileDiff,
  filePen: iconFilePen,
  fileSearch: iconFileSearch,
  fileText: iconFileText,
  folder: iconFolder,
  folderPlus: iconFolderPlus,
  fxMark: iconFxMark,
  gitBranch: iconGitBranch,
  globe: iconGlobe,
  history: iconHistory,
  image: iconImage,
  info: iconInfo,
  link: iconLink,
  list: iconList,
  message: iconMessage,
  panelLeft: iconPanelLeft,
  panelRightClose: iconPanelRightClose,
  plug: iconPlug,
  plus: iconPlus,
  scrollText: iconScrollText,
  search: iconSearch,
  settings: iconSettings,
  shieldAlert: iconShieldAlert,
  sparkle: iconSparkle,
  square: iconSquare,
  terminal: iconTerminal,
  trash: iconTrash,
  x: iconX,
} as const

export type IconName = keyof typeof ICONS

export function Icon({
  name,
  size = 14,
  color,
}: {
  name: IconName
  size?: number
  color: string
}) {
  return (
    <svg
      source={ICONS[name]}
      style={{ width: size, height: size, flexShrink: 0, color }}
    />
  )
}
