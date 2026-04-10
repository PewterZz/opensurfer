import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

export namespace Flag {
  export const OTEL_EXPORTER_OTLP_ENDPOINT = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  export const OTEL_EXPORTER_OTLP_HEADERS = process.env["OTEL_EXPORTER_OTLP_HEADERS"]

  export const OPENSURFER_AUTO_SHARE = truthy("OPENSURFER_AUTO_SHARE")
  export const OPENSURFER_AUTO_HEAP_SNAPSHOT = truthy("OPENSURFER_AUTO_HEAP_SNAPSHOT")
  export const OPENSURFER_GIT_BASH_PATH = process.env["OPENSURFER_GIT_BASH_PATH"]
  export const OPENSURFER_CONFIG = process.env["OPENSURFER_CONFIG"]
  export declare const OPENSURFER_PURE: boolean
  export declare const OPENSURFER_TUI_CONFIG: string | undefined
  export declare const OPENSURFER_CONFIG_DIR: string | undefined
  export declare const OPENSURFER_PLUGIN_META_FILE: string | undefined
  export const OPENSURFER_CONFIG_CONTENT = process.env["OPENSURFER_CONFIG_CONTENT"]
  export const OPENSURFER_DISABLE_AUTOUPDATE = truthy("OPENSURFER_DISABLE_AUTOUPDATE")
  export const OPENSURFER_ALWAYS_NOTIFY_UPDATE = truthy("OPENSURFER_ALWAYS_NOTIFY_UPDATE")
  export const OPENSURFER_DISABLE_PRUNE = truthy("OPENSURFER_DISABLE_PRUNE")
  export const OPENSURFER_DISABLE_TERMINAL_TITLE = truthy("OPENSURFER_DISABLE_TERMINAL_TITLE")
  export const OPENSURFER_SHOW_TTFD = truthy("OPENSURFER_SHOW_TTFD")
  export const OPENSURFER_PERMISSION = process.env["OPENSURFER_PERMISSION"]
  export const OPENSURFER_DISABLE_DEFAULT_PLUGINS = truthy("OPENSURFER_DISABLE_DEFAULT_PLUGINS")
  export const OPENSURFER_DISABLE_LSP_DOWNLOAD = truthy("OPENSURFER_DISABLE_LSP_DOWNLOAD")
  export const OPENSURFER_ENABLE_EXPERIMENTAL_MODELS = truthy("OPENSURFER_ENABLE_EXPERIMENTAL_MODELS")
  export const OPENSURFER_DISABLE_AUTOCOMPACT = truthy("OPENSURFER_DISABLE_AUTOCOMPACT")
  export const OPENSURFER_DISABLE_MODELS_FETCH = truthy("OPENSURFER_DISABLE_MODELS_FETCH")
  export const OPENSURFER_DISABLE_MOUSE = truthy("OPENSURFER_DISABLE_MOUSE")
  export const OPENSURFER_DISABLE_CLAUDE_CODE = truthy("OPENSURFER_DISABLE_CLAUDE_CODE")
  export const OPENSURFER_DISABLE_CLAUDE_CODE_PROMPT =
    OPENSURFER_DISABLE_CLAUDE_CODE || truthy("OPENSURFER_DISABLE_CLAUDE_CODE_PROMPT")
  export const OPENSURFER_DISABLE_CLAUDE_CODE_SKILLS =
    OPENSURFER_DISABLE_CLAUDE_CODE || truthy("OPENSURFER_DISABLE_CLAUDE_CODE_SKILLS")
  export const OPENSURFER_DISABLE_EXTERNAL_SKILLS =
    OPENSURFER_DISABLE_CLAUDE_CODE_SKILLS || truthy("OPENSURFER_DISABLE_EXTERNAL_SKILLS")
  export declare const OPENSURFER_DISABLE_PROJECT_CONFIG: boolean
  export const OPENSURFER_FAKE_VCS = process.env["OPENSURFER_FAKE_VCS"]
  export declare const OPENSURFER_CLIENT: string
  export const OPENSURFER_SERVER_PASSWORD = process.env["OPENSURFER_SERVER_PASSWORD"]
  export const OPENSURFER_SERVER_USERNAME = process.env["OPENSURFER_SERVER_USERNAME"]
  export const OPENSURFER_ENABLE_QUESTION_TOOL = truthy("OPENSURFER_ENABLE_QUESTION_TOOL")

  // Experimental
  export const OPENSURFER_EXPERIMENTAL = truthy("OPENSURFER_EXPERIMENTAL")
  export const OPENSURFER_EXPERIMENTAL_FILEWATCHER = Config.boolean("OPENSURFER_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  )
  export const OPENSURFER_EXPERIMENTAL_DISABLE_FILEWATCHER = Config.boolean(
    "OPENSURFER_EXPERIMENTAL_DISABLE_FILEWATCHER",
  ).pipe(Config.withDefault(false))
  export const OPENSURFER_EXPERIMENTAL_ICON_DISCOVERY =
    OPENSURFER_EXPERIMENTAL || truthy("OPENSURFER_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["OPENSURFER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const OPENSURFER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("OPENSURFER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const OPENSURFER_ENABLE_EXA =
    truthy("OPENSURFER_ENABLE_EXA") || OPENSURFER_EXPERIMENTAL || truthy("OPENSURFER_EXPERIMENTAL_EXA")
  export const OPENSURFER_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("OPENSURFER_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const OPENSURFER_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("OPENSURFER_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const OPENSURFER_EXPERIMENTAL_OXFMT = OPENSURFER_EXPERIMENTAL || truthy("OPENSURFER_EXPERIMENTAL_OXFMT")
  export const OPENSURFER_EXPERIMENTAL_LSP_TY = truthy("OPENSURFER_EXPERIMENTAL_LSP_TY")
  export const OPENSURFER_EXPERIMENTAL_LSP_TOOL = OPENSURFER_EXPERIMENTAL || truthy("OPENSURFER_EXPERIMENTAL_LSP_TOOL")
  export const OPENSURFER_DISABLE_FILETIME_CHECK = Config.boolean("OPENSURFER_DISABLE_FILETIME_CHECK").pipe(
    Config.withDefault(false),
  )
  export const OPENSURFER_EXPERIMENTAL_PLAN_MODE = OPENSURFER_EXPERIMENTAL || truthy("OPENSURFER_EXPERIMENTAL_PLAN_MODE")
  export const OPENSURFER_EXPERIMENTAL_WORKSPACES = OPENSURFER_EXPERIMENTAL || truthy("OPENSURFER_EXPERIMENTAL_WORKSPACES")
  export const OPENSURFER_EXPERIMENTAL_MARKDOWN = !falsy("OPENSURFER_EXPERIMENTAL_MARKDOWN")
  export const OPENSURFER_MODELS_URL = process.env["OPENSURFER_MODELS_URL"]
  export const OPENSURFER_MODELS_PATH = process.env["OPENSURFER_MODELS_PATH"]
  export const OPENSURFER_DISABLE_EMBEDDED_WEB_UI = truthy("OPENSURFER_DISABLE_EMBEDDED_WEB_UI")
  export const OPENSURFER_DB = process.env["OPENSURFER_DB"]
  export const OPENSURFER_DISABLE_CHANNEL_DB = truthy("OPENSURFER_DISABLE_CHANNEL_DB")
  export const OPENSURFER_SKIP_MIGRATIONS = truthy("OPENSURFER_SKIP_MIGRATIONS")
  export const OPENSURFER_STRICT_CONFIG_DEPS = truthy("OPENSURFER_STRICT_CONFIG_DEPS")

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for OPENSURFER_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "OPENSURFER_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("OPENSURFER_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for OPENSURFER_TUI_CONFIG
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "OPENSURFER_TUI_CONFIG", {
  get() {
    return process.env["OPENSURFER_TUI_CONFIG"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for OPENSURFER_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "OPENSURFER_CONFIG_DIR", {
  get() {
    return process.env["OPENSURFER_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for OPENSURFER_PURE
// This must be evaluated at access time, not module load time,
// because the CLI can set this flag at runtime
Object.defineProperty(Flag, "OPENSURFER_PURE", {
  get() {
    return truthy("OPENSURFER_PURE")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for OPENSURFER_PLUGIN_META_FILE
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "OPENSURFER_PLUGIN_META_FILE", {
  get() {
    return process.env["OPENSURFER_PLUGIN_META_FILE"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for OPENSURFER_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "OPENSURFER_CLIENT", {
  get() {
    return process.env["OPENSURFER_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
