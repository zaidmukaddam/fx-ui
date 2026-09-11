// Map fx-ui's Kiro model id to the id Kiro's runtime expects. Kept in its own
// module (no imports) so it is reusable and testable in isolation.

export function runtimeModelId(model: string): string {
  if (model === "auto-kiro") return "auto"
  return model
    .replace(/^(claude)-(sonnet|haiku|opus)-(\d+)-(\d+)$/i, "$1-$2-$3.$4")
    .replace(/-(\d{8}|latest)$/i, "")
}
