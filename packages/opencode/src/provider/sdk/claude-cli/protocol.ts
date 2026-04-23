import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider"

const iife = <T>(fn: () => T): T => fn()

const TOOL_CALL_OPEN = "<tool_call>"
const TOOL_CALL_CLOSE = "</tool_call>"

// Claude's native canonical format. It often emits this instead of our prescribed
// <tool_call> tags regardless of instructions, so we accept both.
const FUNCTION_CALLS_OPEN = "<function_calls>"
const FUNCTION_CALLS_CLOSE = "</function_calls>"

const WRAPPER_PAIRS: Array<{ open: string; close: string }> = [
  { open: TOOL_CALL_OPEN, close: TOOL_CALL_CLOSE },
  { open: FUNCTION_CALLS_OPEN, close: FUNCTION_CALLS_CLOSE },
]

export interface ParsedToolCall {
  toolName: string
  input: string
  raw: string
}

export interface RenderedPrompt {
  systemPrompt: string
  toolInstructions: string
  conversation: string
}

export function render(options: LanguageModelV3CallOptions): RenderedPrompt {
  const systemParts: string[] = []
  const turnParts: string[] = []

  for (const msg of options.prompt) {
    if (msg.role === "system") {
      systemParts.push(msg.content)
      continue
    }
    turnParts.push(renderTurn(msg))
  }

  return {
    systemPrompt: systemParts.join("\n\n"),
    toolInstructions: buildToolInstructions(options.tools ?? [], options.toolChoice),
    conversation: turnParts.join("\n\n"),
  }
}

function renderTurn(msg: LanguageModelV3Message): string {
  const label = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "Tool"
  if (typeof msg.content === "string") return `${label}: ${msg.content}`

  const chunks: string[] = []
  for (const part of msg.content) {
    switch (part.type) {
      case "text":
        chunks.push(part.text)
        break
      case "reasoning":
        // Prior reasoning is not re-sent; claude handles its own reasoning per turn
        break
      case "file":
        chunks.push(`[file omitted: ${part.mediaType}]`)
        break
      case "tool-call":
        chunks.push(renderToolCall(part))
        break
      case "tool-result":
        chunks.push(renderToolResult(part))
        break
      case "tool-approval-response":
        chunks.push(`[tool-approval: ${part.approved ? "approved" : "denied"}]`)
        break
    }
  }
  return `${label}: ${chunks.filter(Boolean).join("\n")}`
}

function renderToolCall(part: LanguageModelV3ToolCallPart): string {
  const args =
    typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}, stableReplacer)
  const payload = JSON.stringify(
    { id: part.toolCallId, name: part.toolName, arguments: safeParse(args) },
    stableReplacer,
  )
  return `${TOOL_CALL_OPEN}\n${payload}\n${TOOL_CALL_CLOSE}`
}

function renderToolResult(part: LanguageModelV3ToolResultPart): string {
  const body = stringifyToolResult(part.output)
  return `<tool_result name="${part.toolName}" tool_call_id="${part.toolCallId}">\n${body}\n</tool_result>`
}

function stringifyToolResult(output: LanguageModelV3ToolResultPart["output"]): string {
  switch (output.type) {
    case "text":
      return output.value
    case "json":
    case "error-json":
      return JSON.stringify(output.value, null, 2)
    case "error-text":
      return `[error] ${output.value}`
    case "execution-denied":
      return `[denied]${output.reason ? ` ${output.reason}` : ""}`
    case "content":
      return output.value
        .map((c) => {
          if (c.type === "text") return c.text
          if ("mediaType" in c && c.mediaType) return `[media: ${c.mediaType}]`
          return "[media]"
        })
        .join("\n")
    default:
      return JSON.stringify(output)
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function stableReplacer(_key: string, value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}

function buildToolInstructions(
  tools: LanguageModelV3CallOptions["tools"],
  toolChoice: LanguageModelV3CallOptions["toolChoice"],
): string {
  const functions = (tools ?? []).filter((t): t is LanguageModelV3FunctionTool => t.type === "function")
  if (functions.length === 0) return ""

  const descriptions = functions
    .map((t) => {
      const schema = JSON.stringify(t.inputSchema ?? {}, stableReplacer)
      const desc = t.description ? `\n  description: ${t.description.replace(/\n/g, "\n  ")}` : ""
      return `- ${t.name}${desc}\n  input_schema: ${schema}`
    })
    .join("\n")

  const mustCall = iife(() => {
    if (!toolChoice) return ""
    if (toolChoice.type === "tool")
      return `\nYou MUST call the tool "${toolChoice.toolName}" on this turn.`
    if (toolChoice.type === "required")
      return "\nYou MUST call a tool on this turn; do not answer with prose."
    if (toolChoice.type === "none")
      return "\nDo NOT call any tool on this turn; reply with prose only."
    return ""
  })

  return [
    "# Tool use protocol (host-managed)",
    "",
    "The tools listed below in `Available tools` ARE available to you RIGHT NOW.",
    "They are executed by the host harness, not by you. You call them by emitting a text block in a specific format — the harness parses it, runs the tool, and returns the result on the next turn.",
    "",
    "Do NOT claim a tool is 'unavailable', 'not accessible', or 'missing'. If a tool is in `Available tools`, you CAN call it.",
    "Do NOT use any built-in Claude Code tool (Bash, Read, Write, Edit, WebSearch, WebFetch, Glob, Grep, Task, TodoWrite, etc.) — they are disabled.",
    "",
    "To call a tool, output EXACTLY one block in this format and then STOP generating:",
    "",
    `${TOOL_CALL_OPEN}`,
    '{"name": "<tool_name>", "arguments": {<json-arguments>}}',
    `${TOOL_CALL_CLOSE}`,
    "",
    "Rules:",
    "- The block must contain a single valid JSON object with keys `name` and `arguments`.",
    "- `arguments` MUST match the tool's `input_schema`.",
    "- Emit at most ONE tool_call per turn, then stop generating.",
    "- If no tool is needed, reply with prose; do not emit an empty tool_call block.",
    "- After the harness returns a `<tool_result>` on the next turn, continue from that result.",
    mustCall,
    "",
    "Available tools:",
    descriptions,
  ]
    .filter(Boolean)
    .join("\n")
}

export function extractToolCalls(text: string): { stripped: string; calls: ParsedToolCall[] } {
  const calls: ParsedToolCall[] = []
  let cursor = 0
  let stripped = ""
  while (cursor < text.length) {
    const next = findNextWrapper(text, cursor)
    if (!next) {
      stripped += text.slice(cursor)
      break
    }
    const close = text.indexOf(next.pair.close, next.start + next.pair.open.length)
    if (close === -1) {
      // unterminated block — drop trailing partial output (likely runaway continuation)
      stripped += text.slice(cursor, next.start)
      break
    }
    stripped += text.slice(cursor, next.start)
    const body = text.slice(next.start + next.pair.open.length, close).trim()
    const parsed = parseToolCallBody(body)
    if (parsed) {
      calls.push({ ...parsed, raw: body })
      // Discard everything after the tool_call. Claude often hallucinates a
      // <tool_result> and keeps generating; anything after the block is not
      // actually from the tool, so we drop it and let the harness re-prompt
      // with the real result.
      return { stripped: stripped.trim(), calls }
    }
    cursor = close + next.pair.close.length
  }
  return { stripped: stripped.trim(), calls }
}

function findNextWrapper(text: string, from: number) {
  let best: { start: number; pair: (typeof WRAPPER_PAIRS)[number] } | undefined
  for (const pair of WRAPPER_PAIRS) {
    const idx = text.indexOf(pair.open, from)
    if (idx === -1) continue
    if (!best || idx < best.start) best = { start: idx, pair }
  }
  return best
}

function parseToolCallBody(body: string): { toolName: string; input: string } | undefined {
  // Body may be a bare JSON object, a JSON array wrapping one call, or may contain
  // a nested <tool_call>…</tool_call> (the <function_calls> wrapper sometimes
  // nests the real call inside, and Claude sometimes wraps the object in []).
  const inner = extractInnerToolCall(body)
  const jsonText = inner ?? body
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return undefined
  }
  const obj = Array.isArray(parsed) ? parsed[0] : parsed
  if (!obj || typeof obj !== "object") return undefined
  const record = obj as Record<string, unknown>
  const toolName =
    typeof record.name === "string"
      ? record.name
      : typeof record.tool_name === "string"
        ? (record.tool_name as string)
        : undefined
  if (!toolName) return undefined
  const rawArgs = record.arguments ?? record.input ?? record.parameters
  const input = rawArgs === undefined ? "{}" : JSON.stringify(rawArgs)
  return { toolName, input }
}

function extractInnerToolCall(body: string): string | undefined {
  const open = body.indexOf(TOOL_CALL_OPEN)
  if (open === -1) return undefined
  const close = body.indexOf(TOOL_CALL_CLOSE, open + TOOL_CALL_OPEN.length)
  if (close === -1) return undefined
  return body.slice(open + TOOL_CALL_OPEN.length, close).trim()
}
