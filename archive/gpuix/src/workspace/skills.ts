import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { createSkillsAdapter } from "libfx/skills"
import { loadSkillFile } from "libfx/skills/node"

import { DIR, HOME_DIR } from "../store"
import type { HostTool } from "../tools"

const MAX_SKILLS = 64

const OTHER_HARNESSES = [".claude", ".agents"]

const CATALOG_BUDGET = 16_000
const MAX_DESCRIPTION = 250

export type LoadedSkills = {
  instructions: string
  tools: HostTool[]
  names: string[]
  commands: SkillCommand[]
  problems: { file: string; reason: string }[]
}

const EMPTY: LoadedSkills = {
  instructions: "",
  tools: [],
  names: [],
  commands: [],
  problems: [],
}

export type SkillCommand = {
  name: string
  description: string
  instructions: string
}

export function splitCommand(
  draft: string,
  commands: SkillCommand[],
): { command: SkillCommand; rest: string } | null {
  const match = /^\/([^\s/]+)\s*([\s\S]*)$/.exec(draft.trim())
  if (!match) return null
  const command = commands.find((entry) => entry.name === match[1])
  return command ? { command, rest: (match[2] ?? "").trim() } : null
}

function skillDirectories(root: string): string[] {
  return [path.join(DIR, "skills"), path.join(root, ".fx", "skills")]
}

async function markdownIn(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
      .map((name) => path.join(directory, name))
  } catch {
    return []
  }
}

async function skillFoldersIn(directory: string): Promise<string[]> {
  try {
    const names = await readdir(directory)
    return names
      .sort()
      .map((name) => path.join(directory, name, "SKILL.md"))
      .filter((file) => existsSync(file))
  } catch {
    return []
  }
}

function descriptionOf(source: string): string | null {
  const lines = source.split("\n")
  const end = lines.indexOf("---", 1)
  if (lines[0] !== "---" || end < 0) return null
  const frontmatter = lines.slice(1, end)
  const start = frontmatter.findIndex((line) => line.startsWith("description:"))
  if (start < 0) return null

  const first = frontmatter[start]!.slice("description:".length).trim()
  const rest: string[] = []
  for (const line of frontmatter.slice(start + 1)) {
    if (/^\S/.test(line)) break
    rest.push(line.trim())
  }
  const text = (/^[>|][0-9+-]*$/.test(first) ? rest : [first, ...rest])
    .filter(Boolean)
    .join(" ")
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text)
  if (!quoted) return text
  return quoted[1] === "'"
    ? quoted[2]!.replaceAll("''", "'")
    : quoted[2]!.replaceAll('\\"', '"')
}

async function readSkill(file: string): Promise<Awaited<ReturnType<typeof loadSkillFile>>> {
  const source = await readFile(file, "utf8")
  const record = await loadSkillFile(file, { readFile: async () => source })
  return { ...record, description: descriptionOf(source) ?? record.description }
}

function catalogOf(commands: SkillCommand[]): string {
  if (commands.length === 0) return ""
  const overhead = commands.reduce((total, command) => total + command.name.length + 5, 0)
  const room = Math.min(
    MAX_DESCRIPTION,
    Math.floor((CATALOG_BUDGET - overhead) / commands.length),
  )
  const lines = commands.map(({ name, description }) => {
    if (room < 2 || !description) return `- ${name}`
    const trimmed =
      description.length > room ? `${description.slice(0, room - 1)}…` : description
    return `- ${name}: ${trimmed}`
  })
  return [
    "Skills you can use. Before work one of them covers, read it in full with the skill tool.",
    ...lines,
  ].join("\n")
}

async function loadOwnSkills(root: string): Promise<LoadedSkills> {
  const files: string[] = []
  for (const directory of skillDirectories(root)) {
    files.push(...(await markdownIn(directory)))
  }
  if (files.length === 0) return EMPTY

  const records: Awaited<ReturnType<typeof loadSkillFile>>[] = []
  const problems: { file: string; reason: string }[] = []
  const seen = new Set<string>()

  for (const file of files) {
    if (records.length >= MAX_SKILLS) {
      problems.push({ file, reason: `more than ${MAX_SKILLS} skills, so it was skipped` })
      continue
    }
    try {
      const record = await readSkill(file)
      if (seen.has(record.name)) {
        const index = records.findIndex((entry) => entry.name === record.name)
        records[index] = record
      } else {
        seen.add(record.name)
        records.push(record)
      }
    } catch (error) {
      problems.push({
        file,
        reason: error instanceof Error ? error.message : "could not be read",
      })
    }
  }

  if (records.length === 0) return { ...EMPTY, problems }

  try {
    const adapter = createSkillsAdapter(records)
    return {
      instructions: adapter.instructions,
      tools: adapter.tools as HostTool[],
      names: records.map((record) => record.name),
      commands: records.map((record) => ({
        name: record.name,
        description: record.description ?? "",
        instructions: record.instructions,
      })),
      problems,
    }
  } catch (error) {
    return {
      ...EMPTY,
      problems: [
        ...problems,
        {
          file: "skills",
          reason: error instanceof Error ? error.message : "could not be combined",
        },
      ],
    }
  }
}

async function loadOtherSkills(
  root: string,
): Promise<Pick<LoadedSkills, "commands" | "problems">> {
  const files: string[] = []
  for (const home of [root, HOME_DIR]) {
    for (const harness of OTHER_HARNESSES) {
      files.push(...(await skillFoldersIn(path.join(home, harness, "skills"))))
    }
  }
  const results = await Promise.allSettled(files.map((file) => readSkill(file)))

  const commands: SkillCommand[] = []
  const problems: LoadedSkills["problems"] = []
  const seen = new Set<string>()
  results.forEach((result, index) => {
    const folder = path.dirname(files[index]!)
    if (result.status === "rejected") {
      problems.push({
        file: folder,
        reason: result.reason instanceof Error ? result.reason.message : "could not be read",
      })
      return
    }
    const name = result.value.name === "SKILL" ? path.basename(folder) : result.value.name
    if (seen.has(name)) return
    seen.add(name)
    commands.push({
      name,
      description: result.value.description ?? "",
      instructions: `Base directory for this skill: ${folder}\n\n${result.value.instructions}`,
    })
  })
  return { commands, problems }
}

export async function loadSkills(root: string): Promise<LoadedSkills> {
  const [own, other] = await Promise.all([loadOwnSkills(root), loadOtherSkills(root)])
  const taken = new Set(own.commands.map((command) => command.name))
  const borrowed = other.commands.filter((command) => !taken.has(command.name))
  return {
    ...own,
    instructions: [own.instructions, catalogOf(borrowed)].filter(Boolean).join("\n\n"),
    commands: [...own.commands, ...borrowed],
    problems: [...own.problems, ...other.problems],
  }
}
