import {
  appendMessage,
  findSession,
  getState,
  newId,
  updateSession,
} from "../store"

type Decision = "allowed" | "granted" | "denied"

const pendingApprovals = new Map<string, (decision: Decision) => void>()

export type ApprovalRequest = {
  sessionId: string
  toolName: string
  title: string
  detail: string
  language?: string
  patch?: string
  scope: string
  routine: boolean
}

export function resolveApproval(
  sessionId: string,
  approvalId: string,
  decision: Decision,
): void {
  const resolve = pendingApprovals.get(approvalId)
  if (!resolve) return
  pendingApprovals.delete(approvalId)

  updateSession(sessionId, (session) => ({
    ...session,
    grants:
      decision === "granted"
        ? [...new Set([...session.grants, scopeOfApproval(session.id, approvalId)])]
        : session.grants,
    messages: session.messages.map((message) =>
      message.kind === "approval" && message.approvalId === approvalId
        ? { ...message, decision }
        : message,
    ),
  }))
  resolve(decision)
}

function scopeOfApproval(sessionId: string, approvalId: string): string {
  const session = findSession(getState(), sessionId)
  const message = session?.messages.find(
    (entry) => entry.kind === "approval" && entry.approvalId === approvalId,
  )
  return message?.kind === "approval" ? message.scope : ""
}

export function forgetGrants(sessionId: string, scope?: string): void {
  updateSession(sessionId, (session) => ({
    ...session,
    grants: scope ? session.grants.filter((grant) => grant !== scope) : [],
  }))
}

export function denyPendingApprovals(sessionId: string): void {
  const session = findSession(getState(), sessionId)
  if (!session) return
  for (const message of session.messages) {
    if (message.kind === "approval" && message.decision === "pending") {
      resolveApproval(sessionId, message.approvalId, "denied")
    }
  }
}

export async function requestApproval(request: ApprovalRequest): Promise<boolean> {
  const session = findSession(getState(), request.sessionId)
  if (!session) return false
  if (session.mode === "full-access") return true
  if (session.grants.includes(request.scope)) return true
  if (session.mode === "auto" && request.routine) return true

  const approvalId = newId()
  appendMessage(request.sessionId, {
    id: newId(),
    kind: "approval",
    at: Date.now(),
    approvalId,
    toolName: request.toolName,
    title: request.title,
    detail: request.detail,
    language: request.language,
    patch: request.patch,
    scope: request.scope,
    decision: "pending",
  })

  const decision = await new Promise<Decision>((resolve) => {
    pendingApprovals.set(approvalId, resolve)
  })
  return decision !== "denied"
}

const pendingQuestions = new Map<string, (answer: string | null) => void>()

export function resolveQuestion(
  sessionId: string,
  questionId: string,
  answer: string | null,
): void {
  const resolve = pendingQuestions.get(questionId)
  if (!resolve) return
  pendingQuestions.delete(questionId)

  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.kind === "question" && message.questionId === questionId
        ? { ...message, answer }
        : message,
    ),
  }))
  resolve(answer)
}

export function dismissPendingQuestions(sessionId: string): void {
  const session = findSession(getState(), sessionId)
  if (!session) return
  for (const message of session.messages) {
    if (message.kind === "question" && message.answer === null) {
      resolveQuestion(sessionId, message.questionId, null)
    }
  }
}

export function askUserQuestion(
  sessionId: string,
  question: string,
  options: string[],
): Promise<string | null> {
  const questionId = newId()
  appendMessage(sessionId, {
    id: newId(),
    kind: "question",
    at: Date.now(),
    questionId,
    question,
    options,
    answer: null,
  })
  return new Promise((resolve) => {
    pendingQuestions.set(questionId, resolve)
  })
}
