import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"
import { extractToolCalls, render } from "./protocol"

function debugLog(payload: Record<string, unknown>) {
  const path = process.env.OPENSURFER_CLAUDE_CLI_DEBUG
  if (!path) return
  try {
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n")
  } catch {}
}

export interface ClaudeCliModelOptions {
  binary: string
  modelId: string
  extraArgs?: string[]
}

const SYSTEM_PROMPT_BUDGET = 2500

const MINIMAL_SYSTEM_PROMPT = [
  "You are a research assistant answering the user's questions accurately using the tools the host harness exposes to you.",
  "",
  "When to use tools:",
  "- For current events, specific facts, numbers, or anything that needs a source, call the search/fetch tools.",
  "- For pure reasoning, math, or conversational replies, answer directly.",
  "",
  "Tool-use rules (the host harness manages execution — you do not run tools yourself):",
  "- Emit at most one tool call per turn, then stop generating.",
  "- The call format and the list of available tools are provided in the harness message that opens the conversation. Follow it exactly.",
  "- Do not claim a listed tool is unavailable. If it's in the list, you CAN call it.",
  "- After a tool result arrives on the next turn, continue from that result. Do not re-emit the call.",
  "- Never invoke any built-in Claude Code tool (Bash, Read, Write, Edit, WebSearch, WebFetch, Glob, Grep, Task, TodoWrite). They are disabled.",
  "",
  "Search tips:",
  "- Be specific and literal — use the actual terms, not paraphrases.",
  "- Include the year for time-sensitive topics (e.g. `LLM benchmarks 2026`).",
  "- Quote exact phrases to force matches.",
  "- On retry, rephrase substantially; never repeat the same query.",
  "- Cap total tool calls at 4 per question, then answer with what you have.",
  "",
  "Answering:",
  "- Cite sources inline when you quote specific facts or numbers.",
  "- Say \"I don't have a confident answer\" when the data is genuinely missing.",
  "- Keep answers focused; prefer short paragraphs or bullet lists over long essays unless the user asks for depth.",
].join("\n")

interface StreamJsonEvent {
  type: string
  // system init
  subtype?: string
  session_id?: string
  // assistant message
  message?: {
    id?: string
    content?: Array<{ type: string; text?: string; thinking?: string }>
  }
  // result
  is_error?: boolean
  result?: string
  stop_reason?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  total_cost_usd?: number
  // generic
  error?: unknown
}

type InvokeBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }

export class ClaudeCliLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = "claude-cli"
  readonly modelId: string
  readonly supportedUrls = {}

  private readonly binary: string
  private readonly extraArgs: readonly string[]

  constructor(options: ClaudeCliModelOptions) {
    this.binary = options.binary
    this.modelId = options.modelId
    this.extraArgs = options.extraArgs ?? []
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const run = await this.invoke(options)
    const { stripped, calls } = extractToolCalls(run.text)

    const content: LanguageModelV3GenerateResult["content"] = []
    if (stripped) content.push({ type: "text", text: stripped })
    for (const call of calls) {
      content.push({
        type: "tool-call",
        toolCallId: randomUUID(),
        toolName: call.toolName,
        input: call.input,
      })
    }

    return {
      content,
      finishReason: computeFinishReason(run.stopReason, calls.length > 0),
      usage: computeUsage(run.usage),
      warnings: [],
      response: run.sessionId ? { id: run.sessionId } : undefined,
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const self = this
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(ctrl) {
        let reasoningId: string | undefined
        let textId: string | undefined
        let toolCallsEmitted = 0
        let suppressed = false

        const closeOpen = () => {
          if (reasoningId) {
            ctrl.enqueue({ type: "reasoning-end", id: reasoningId })
            reasoningId = undefined
          }
          if (textId) {
            ctrl.enqueue({ type: "text-end", id: textId })
            textId = undefined
          }
        }

        const emitTextDelta = (delta: string) => {
          if (!delta) return
          if (reasoningId) {
            ctrl.enqueue({ type: "reasoning-end", id: reasoningId })
            reasoningId = undefined
          }
          if (!textId) {
            textId = randomUUID()
            ctrl.enqueue({ type: "text-start", id: textId })
          }
          ctrl.enqueue({ type: "text-delta", id: textId, delta })
        }

        const emitToolCalls = (calls: ReturnType<typeof extractToolCalls>["calls"]) => {
          for (const call of calls) {
            const toolCallId = randomUUID()
            ctrl.enqueue({ type: "tool-input-start", id: toolCallId, toolName: call.toolName })
            ctrl.enqueue({ type: "tool-input-delta", id: toolCallId, delta: call.input })
            ctrl.enqueue({ type: "tool-input-end", id: toolCallId })
            ctrl.enqueue({
              type: "tool-call",
              toolCallId,
              toolName: call.toolName,
              input: call.input,
            })
            toolCallsEmitted += 1
          }
        }

        try {
          ctrl.enqueue({ type: "stream-start", warnings: [] })

          const run = await self.invoke(options, (block) => {
            if (suppressed) return
            if (block.kind === "thinking") {
              if (textId) {
                ctrl.enqueue({ type: "text-end", id: textId })
                textId = undefined
              }
              if (!reasoningId) {
                reasoningId = randomUUID()
                ctrl.enqueue({ type: "reasoning-start", id: reasoningId })
              }
              ctrl.enqueue({ type: "reasoning-delta", id: reasoningId, delta: block.text })
              return
            }
            const { stripped, calls } = extractToolCalls(block.text)
            if (calls.length > 0) {
              emitTextDelta(stripped)
              closeOpen()
              emitToolCalls(calls)
              suppressed = true
              return
            }
            emitTextDelta(block.text)
          })

          // If no block callbacks fired (e.g. only the `result` event arrived with
          // accumulated text), fall back to parsing the final text here.
          if (!suppressed && !textId && !reasoningId && run.text) {
            const { stripped, calls } = extractToolCalls(run.text)
            emitTextDelta(stripped)
            emitToolCalls(calls)
          }

          closeOpen()

          ctrl.enqueue({
            type: "finish",
            finishReason: computeFinishReason(run.stopReason, toolCallsEmitted > 0),
            usage: computeUsage(run.usage),
          })
          ctrl.close()
        } catch (err) {
          closeOpen()
          ctrl.enqueue({ type: "error", error: err })
          ctrl.close()
        }
      },
    })

    return { stream }
  }

  private async invoke(
    options: LanguageModelV3CallOptions,
    onBlock?: (block: InvokeBlock) => void,
  ): Promise<InvokeResult> {
    const rendered = render(options)
    const incomingSystemBytes = Buffer.byteLength(rendered.systemPrompt, "utf8")
    const systemReplaced = incomingSystemBytes > SYSTEM_PROMPT_BUDGET
    const systemPrompt = systemReplaced ? MINIMAL_SYSTEM_PROMPT : rendered.systemPrompt
    const conversation = rendered.toolInstructions
      ? `${rendered.toolInstructions}\n\n${rendered.conversation}`
      : rendered.conversation
    const invokeId = randomUUID().slice(0, 8)
    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--tools",
      "",
      "--model",
      this.modelId,
      "--system-prompt",
      systemPrompt,
      ...this.extraArgs,
    ]

    debugLog({
      event: "spawn",
      invokeId,
      binary: this.binary,
      modelId: this.modelId,
      args: args.map((a, i) => (args[i - 1] === "--system-prompt" ? `<${a.length}B>` : a)),
      systemPromptBytes: Buffer.byteLength(systemPrompt, "utf8"),
      conversationBytes: Buffer.byteLength(conversation, "utf8"),
      incomingSystemBytes,
      toolInstructionsBytes: Buffer.byteLength(rendered.toolInstructions, "utf8"),
      systemReplaced,
      systemPromptFull: systemPrompt,
      conversationFull: conversation,
      cwd: process.cwd(),
      anthropicAuthToken: !!process.env.ANTHROPIC_AUTH_TOKEN,
      anthropicApiKey: !!process.env.ANTHROPIC_API_KEY,
      claudeCodeOauthToken: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
      claudeEnvKeys: Object.keys(process.env).filter((k) => /claude|anthropic/i.test(k)),
      home: process.env.HOME,
    })

    return new Promise<InvokeResult>((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      })

      const onAbort = () => child.kill("SIGTERM")
      options.abortSignal?.addEventListener("abort", onAbort, { once: true })

      let stdoutBuf = ""
      const rawLines: string[] = []
      const result: InvokeResult = {
        text: "",
        stopReason: undefined,
        usage: undefined,
        sessionId: undefined,
      }

      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk
        let nl: number
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim()
          stdoutBuf = stdoutBuf.slice(nl + 1)
          if (!line) continue
          rawLines.push(line)
          handleEvent(line, result, onBlock)
        }
      })

      // Drain stderr so the pipe buffer doesn't block the child. Collect for
      // error diagnostics only.
      let stderrBuf = ""
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => {
        stderrBuf += chunk
        if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-64 * 1024)
      })

      child.on("error", (err) => {
        options.abortSignal?.removeEventListener("abort", onAbort)
        reject(err)
      })

      child.on("close", (code) => {
        options.abortSignal?.removeEventListener("abort", onAbort)
        if (stdoutBuf.trim()) handleEvent(stdoutBuf.trim(), result, onBlock)
        debugLog({
          event: "close",
          invokeId,
          code,
          textBytes: Buffer.byteLength(result.text, "utf8"),
          textFull: result.text,
          stopReason: result.stopReason,
          sessionId: result.sessionId,
          stderr: stderrBuf.trim().slice(0, 4000),
          rawLines,
        })
        if (code !== 0 && !result.text) {
          reject(
            new Error(
              `claude exited with code ${code}${stderrBuf ? `: ${stderrBuf.trim().slice(0, 500)}` : ""}`,
            ),
          )
          return
        }
        resolve(result)
      })

      child.stdin.write(conversation, "utf8")
      child.stdin.end()
    })
  }
}

interface InvokeResult {
  text: string
  stopReason: string | undefined
  usage: StreamJsonEvent["usage"] | undefined
  sessionId: string | undefined
}

function handleEvent(line: string, result: InvokeResult, onBlock?: (block: InvokeBlock) => void) {
  let event: StreamJsonEvent
  try {
    event = JSON.parse(line) as StreamJsonEvent
  } catch {
    return
  }
  if (event.type === "system" && event.session_id) {
    result.sessionId = event.session_id
    return
  }
  if (event.type === "result") {
    // Only use result.result as a fallback if we have no streamed text yet.
    if (!result.text && typeof event.result === "string" && event.result) {
      result.text = event.result
    }
    result.stopReason = event.stop_reason
    result.usage = event.usage
    return
  }
  if (event.type === "assistant" && event.message?.content) {
    for (const part of event.message.content) {
      if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
        onBlock?.({ kind: "thinking", text: part.thinking })
        continue
      }
      if (part.type === "text" && typeof part.text === "string" && part.text) {
        result.text += part.text
        onBlock?.({ kind: "text", text: part.text })
      }
    }
  }
}

function computeFinishReason(
  stopReason: string | undefined,
  hasToolCalls: boolean,
): LanguageModelV3FinishReason {
  if (hasToolCalls) return { unified: "tool-calls", raw: stopReason }
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return { unified: "stop", raw: stopReason }
    case "max_tokens":
      return { unified: "length", raw: stopReason }
    case "tool_use":
      return { unified: "tool-calls", raw: stopReason }
    default:
      return { unified: "stop", raw: stopReason }
  }
}

function computeUsage(raw: StreamJsonEvent["usage"]): LanguageModelV3Usage {
  const input = raw?.input_tokens
  const cacheRead = raw?.cache_read_input_tokens
  const cacheWrite = raw?.cache_creation_input_tokens
  const output = raw?.output_tokens
  return {
    inputTokens: {
      total: input,
      noCache: input !== undefined && cacheRead !== undefined ? input - cacheRead : input,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output,
      reasoning: undefined,
    },
    raw: raw as unknown as Record<string, never>,
  }
}
