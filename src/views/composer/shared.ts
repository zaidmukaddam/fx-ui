export const MENTION_RESULTS = 8

export function rank(
  items: string[],
  query: string,
  limit: number,
  text: (item: string) => string = (item) => item,
): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return items.slice(0, limit)
  return items
    .filter((item) => text(item).toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        text(a).toLowerCase().indexOf(needle) - text(b).toLowerCase().indexOf(needle),
    )
    .slice(0, limit)
}
