## Project context

This is **OpenSurfer** — a fork of [OpenCode](https://github.com/sst/opencode) repurposed as a terminal-based AI research and web browsing agent. It is NOT a coding assistant. The architecture (tool system, agent framework, session management, plugin system) is inherited from OpenCode unchanged. What differs:

- **Identity:** research agent, not coding agent
- **Primary tools:** `webfetch` (25+ native site handlers) and `websearch`
- **System prompts:** completely rewritten for research workflows (`src/session/prompt/*.txt`)
- **Branding:** OpenSurfer, config at `~/.config/opensurfer/`, env vars `OPENSURFER_*`
- **New feature:** `/auth` command for browser cookie extraction (`src/util/browser-auth.ts`)

Before modifying files, read **`MERGE_UPSTREAM.md`** — it lists which files must be preserved from our fork vs which are safe to take from upstream OpenCode.

## General

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.
- The main package is at `packages/opencode/` (directory name unchanged from upstream for tooling compatibility).

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

### Naming Enforcement (Read This)

THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE.

- Use single word names by default for new locals, params, and helper functions.
- Multi-word names are allowed only when a single word would be unclear or ambiguous.
- Do not introduce new camelCase compounds when a short single-word alternative is clear.
- Before finishing edits, review touched lines and shorten newly introduced identifiers where possible.
- Good short names to prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
- Examples to avoid unless truly required: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## Build verification

After any change to source files, verify the build compiles:

```bash
cd packages/opencode
bun run --conditions=browser src/index.ts --version
# Should print a version string without errors
```

## Key files for research agent features

When working on OpenSurfer-specific functionality, these are the files most likely to need changes:

| What you're changing | File |
|---|---|
| How sites are fetched (new site handler) | `src/tool/webfetch.ts` |
| Agent behavior / search strategy | `src/session/prompt/default.txt`, `src/session/prompt/anthropic.txt` |
| Tool descriptions shown to the model | `src/tool/webfetch.txt`, `src/tool/websearch.txt` |
| `/auth` browser cookie command | `src/util/browser-auth.ts`, `src/cli/cmd/tui/app.tsx` |
| Home screen placeholders | `src/cli/cmd/tui/routes/home.tsx` |
| Session history sidebar | `src/cli/cmd/tui/feature-plugins/sidebar/lsp.tsx` |
| Which tools are available per provider | `src/tool/registry.ts` |
| Agent names and descriptions | `src/agent/agent.ts` |
