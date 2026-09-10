const isBrowser = typeof window !== "undefined"

export const FONT = isBrowser ? "Lilex" : "Geist Mono"

export const color = {
  background: "#000000",
  raised: "#0a0a0a",
  muted: "#161616",
  selected: "#171717",

  hover: "#ffffff0a",
  hoverStrong: "#ffffff14",
  pressed: "#ffffff1f",

  border: "#262626",
  ring: "#666666",

  text: "#ededed",
  secondary: "#a1a1a1",
  tertiary: "#8a8a8a",
  faint: "#626262",
  ghost: "#525252",

  primary: "#ededed",
  onPrimary: "#000000",
  primaryHover: "#ffffff",

  danger: "#f36356",
  dangerSurface: "#f363561f",
} as const

export const space = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
} as const

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
} as const

export const text = {
  micro: 11,
  small: 12,
  body: 13,
  title: 14,
} as const

const IS_MAC = typeof process !== "undefined" && process.platform === "darwin"

export const TITLEBAR_CENTER = IS_MAC ? 32 : 12

const TITLEBAR_ROW = 26

export const titlebarBand = {
  height: TITLEBAR_CENTER + TITLEBAR_ROW / 2 + space.sm,
  paddingTop: TITLEBAR_CENTER - TITLEBAR_ROW / 2,
  paddingBottom: space.sm,
} as const

export const TRAFFIC_LIGHT_INSET = IS_MAC ? 96 : 0

export const CONTENT_WIDTH = 860

export const PANE_PADDING = 28

export function columnFor(paneWidth: number): { column: number; gutter: number } {
  const padding = paneWidth < 420 ? space.lg : PANE_PADDING
  const column = Math.min(CONTENT_WIDTH, Math.max(0, paneWidth - padding * 2))
  return { column, gutter: Math.max(padding, Math.round((paneWidth - column) / 2)) }
}

export const nativeTheme = {
  appearance: "dark" as const,
  bg: color.background,
  border: color.border,
  text: color.text,
  textMuted: color.secondary,
  textFaint: color.ghost,
  textDim: color.tertiary,
  accent: color.text,
  caret: color.text,
  codeText: color.text,
  codeWash: "#ffffff08",
  diffAdd: "#12261a",
  diffDel: "#2a1315",
  diffHunkBg: "#ffffff08",
  fontSans: FONT,
  fontMono: FONT,
  syntax: {
    comment: "#626262",
    keyword: "#c7a2ff",
    string: "#7cd07c",
    stringSpecial: "#7cd07c",
    escape: "#f5a623",
    number: "#f5a623",
    boolean: "#f5a623",
    typeName: "#8ab4f8",
    typeBuiltin: "#8ab4f8",
    constructor: "#8ab4f8",
    function: "#8ab4f8",
    functionBuiltin: "#8ab4f8",
    macroName: "#c7a2ff",
    property: "#ededed",
    constant: "#f5a623",
    variable: "#ededed",
    variableSpecial: "#a1a1a1",
    parameter: "#ededed",
    operator: "#8a8a8a",
    punctuation: "#8a8a8a",
    tag: "#c7a2ff",
    attribute: "#8ab4f8",
    label: "#a1a1a1",
    invalid: "#f36356",
  },
  metrics: {
    codeTextSize: 12,
    codeLineHeight: 19,
    diffTextSize: 12,
    diffLineHeight: 19,
    mdTextSize: text.body,
    mdLineHeight: 21,
    mdBlockGap: 12,
    mdHeadingSizes: [18, 16, 14, 13],
    mdCodeRadius: radius.md,
    mdInlineCodeRadius: radius.sm,
  },
}
