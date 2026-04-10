# Merging Upstream (OpenCode → OpenSurfer)

This document tells future agents and contributors which files are safe to pull from upstream OpenCode, which must be preserved from our fork, and which need careful manual merging.

**Upstream repo:** `https://github.com/sst/opencode`  
**Our fork:** `https://github.com/PewterZz/opensurfer`

---

## TL;DR decision tree

```
Is the file in the OURS list below?          → Keep our version, discard upstream
Is the file in the UPSTREAM list below?      → Take upstream freely
Is the file in the CAREFUL list below?       → Read both diffs, merge by section
Is the file not listed?                      → Take upstream (no fork changes)
```

---

## 🔴 KEEP OURS — never overwrite with upstream

These files are the core of what makes OpenSurfer different from OpenCode. Upstream changes should be reviewed but almost never applied without deliberate decision.

### New files (don't exist upstream)
| File | What it does |
|---|---|
| `packages/opencode/src/util/browser-auth.ts` | `/auth` command: browser cookie extraction via yt-dlp or Firefox SQLite |
| `packages/opencode/src/cli/cmd/tui/context/theme/opensurfer.json` | Our theme file (copy of upstream's opencode.json theme) |
| `MERGE_UPSTREAM.md` | This file |

### Identity & branding
| File | Our change | Risk if overwritten |
|---|---|---|
| `src/global/index.ts` | `app = "opensurfer"` — sets all XDG dirs to `~/.config/opensurfer/` | Config dirs revert to `~/.opencode/` |
| `src/index.ts` | `scriptName("opensurfer")`, env marker `OPENSURFER` | CLI reverts to `opencode` binary name |
| `src/cli/logo.ts` | SURF block art replacing CODE | Logo reverts |
| `src/cli/ui.ts` | "opensurf" wordmark | Wordmark reverts |
| `src/cli/cmd/tui/app.tsx` | Terminal title "OpenSurfer", `/auth` command registered globally | Auth command breaks, title reverts |

### System prompts — completely rewritten
All files under `src/session/prompt/` are entirely rewritten for a research agent identity. Upstream versions are for a coding agent. **Never take upstream.**

| File | Upstream purpose | Our purpose |
|---|---|---|
| `src/session/prompt/default.txt` | Coding agent, code style rules | Research agent, smart search guidance |
| `src/session/prompt/anthropic.txt` | Claude coding agent | Claude research agent, deep research mode |
| `src/session/prompt/gpt.txt` | GPT coding agent | GPT research agent |
| `src/session/prompt/gemini.txt` | Gemini coding agent | Gemini research agent |
| `src/session/prompt/beast.txt` | Beast mode coding | Beast mode research |
| `src/session/prompt/kimi.txt` | Kimi coding | Kimi research |
| `src/session/prompt/codex.txt` | Codex coding | Codex research |
| `src/session/prompt/copilot-gpt-5.txt` | Copilot coding | Copilot research |
| `src/session/prompt/trinity.txt` | Trinity coding | Trinity research |

### Agent configuration
| File | Our change | Risk if overwritten |
|---|---|---|
| `src/agent/agent.ts` | `build` agent renamed to `research`, descriptions updated, `.opensurfer` paths | Agent reverts to coding mode |
| `src/agent/prompt/explore.txt` | Research specialist framing | Reverts to file explorer framing |

### Tool system — our primary feature surface
| File | Our change | Risk if overwritten |
|---|---|---|
| `src/tool/webfetch.ts` | 2000+ lines of native site handlers (Reddit, Twitter, HN, GitHub, HuggingFace, arXiv, academic papers, Substack, dev.to, Lobste.rs, Instagram, TikTok, paywall bypass, Sci-Hub, PDF extraction, cookie injection) | All native fetching lost |
| `src/tool/webfetch.txt` | Tool description listing all natively supported sites | Agent stops using direct fetch |
| `src/tool/websearch.ts` | May contain opensurfer-specific search URL handling | Search reverts |
| `src/tool/websearch.txt` | Rewritten with query construction guidance | Search quality degrades |
| `src/tool/codesearch.txt` | Reframed as "documentation search" not "code search" | Agent confused about tool purpose |
| `src/tool/registry.ts` | Websearch/codesearch ungated from opencode-provider-only restriction | Search locks behind provider wall |

### TUI — research-specific UI
| File | Our change | Risk if overwritten |
|---|---|---|
| `src/cli/cmd/tui/routes/home.tsx` | Research-focused placeholder suggestions | Coding placeholders return |
| `src/cli/cmd/tui/routes/session/index.tsx` | Animated globe + wave search indicator | Animation lost |
| `src/cli/cmd/tui/feature-plugins/sidebar/lsp.tsx` | Replaced LSP panel with session History panel | History panel replaced by LSP info |
| `src/cli/cmd/tui/feature-plugins/home/tips-view.tsx` | Tips rewritten for research workflows, `opensurfer` CLI name | Coding tips return |
| `src/cli/cmd/tui/feature-plugins/sidebar/footer.tsx` | Minor opensurfer branding | Minor |

---

## 🟡 CAREFUL — merge section by section

Take upstream changes but preserve our specific modifications within the file.

### Config system
**`src/config/config.ts`**
- Upstream: may add new config keys, providers, migration logic
- Ours: `opencode.json` → `opensurfer.json` as primary config name; backward-compat fallback still reads `opencode.json`; all `OPENCODE_` env vars renamed to `OPENSURFER_`
- **Merge rule:** Take upstream's structural/logic changes. Restore our filename and env var changes afterward. Watch the config candidate list — it must include both `["opensurfer.json", "opensurfer.jsonc", "opencode.json", "opencode.jsonc"]` for backward compat.

**`src/config/paths.ts`**
- Upstream: may update path resolution logic
- Ours: `.opensurfer` target in `Filesystem.up()` calls instead of `.opencode`
- **Merge rule:** Take upstream logic, restore `.opensurfer` targets

**`src/config/tui.ts` and `src/config/tui-migrate.ts`**
- Upstream: may add new TUI config keys
- Ours: `opensurfer.json` references instead of `opencode.json`
- **Merge rule:** Take upstream, restore filename references

### Flag system
**`src/flag/flag.ts`**
- Upstream: new feature flags added regularly
- Ours: all flags renamed `OPENCODE_X` → `OPENSURFER_X`
- **Merge rule:** Take upstream's new flags, apply `s/OPENCODE_/OPENSURFER_/g` to new additions only

### Provider system
**`src/provider/provider.ts`**
- Upstream: new providers, model updates, auth changes
- Ours: HTTP headers `x-opencode-*` → `x-opensurfer-*`, `HTTP-Referer` → `https://opensurf.app/`, User-Agent `opencode/` → `opensurfer/`
- **Merge rule:** Take upstream's provider additions. Re-apply header/UA changes after merge.

**`src/provider/models.ts`**  
- Upstream: model list updates (high value, take freely)
- Ours: env var renames only
- **Merge rule:** Take upstream models. Check for any new `OPENCODE_` flags and rename.

### CLI commands
**`src/cli/cmd/providers.ts`**
- Upstream: provider management improvements
- Ours: describes reference `opensurfer.json`, env vars renamed
- **Merge rule:** Take upstream. Restore `opensurfer.json` references and env var names.

**`src/cli/cmd/uninstall.ts`**
- Upstream: uninstall logic updates
- Ours: `# opencode` → `# opensurfer` in shell config cleanup
- **Merge rule:** Take upstream. Restore the shell config marker string.

**`src/cli/cmd/tui/component/dialog-provider.tsx`**  
**`src/cli/cmd/tui/component/dialog-go-upsell.tsx`**
- Upstream: UI improvements to provider selection dialogs
- Ours: "OpenCode Zen" / "OpenCode Go" upsell text replaced with "OpenSurfer" equivalents (or removed)
- **Merge rule:** Take upstream UI improvements, but remove or replace any OpenCode-brand upsell copy

### Session infrastructure
**`src/session/index.ts`** and related session files  
- Upstream: session management improvements (high value)
- Ours: only env var renames (`OPENSURFER_*`) and service tag renames (`@opensurfer/`)
- **Merge rule:** Take upstream freely, then run: `sed -i 's/OPENCODE_/OPENSURFER_/g; s/@opencode\//@opensurfer\//g'`

### Server routes
Files under `src/server/routes/`
- Upstream: API additions and improvements
- Ours: "OpenCode" → "OpenSurfer" in description strings, service tag renames
- **Merge rule:** Take upstream. Run global rename script afterward (see below).

### LSP system
Files under `src/lsp/`
- Upstream: LSP improvements and fixes
- Ours: only service tag renames and temp dir name (`opensurfer-jdtls-data`)
- **Merge rule:** Take upstream freely. Re-apply the temp dir name change in `lsp/server.ts`.

### Installation
**`src/installation/index.ts`**
- Upstream: version bump logic, new platform support
- Ours: service name renamed; brew/scoop registry URLs left as upstream `opencode` (correct — those are the upstream package registries)
- **Merge rule:** Take upstream. Do NOT rename the brew formula or scoop bucket references (they point to upstream's published packages, which is intentional for the upgrade path).

---

## 🟢 TAKE UPSTREAM — safe to pull directly

These files have only superficial env-var renames (applied by the post-merge script below) or no fork changes at all. Take upstream improvements freely.

```
src/lsp/*                    (LSP client/server — we don't use it but it's harmless)
src/git/*                    (git operations)
src/file/*                   (file watching, ripgrep, time)
src/storage/*                (database layer)
src/bus/*                    (event bus)
src/pty/*                    (terminal sessions)
src/mcp/*                    (MCP protocol — auth, oauth, server)
src/permission/*             (permission system)
src/worktree/*               (git worktrees)
src/project/*                (project detection)
src/snapshot/*               (session snapshots)
src/share/*                  (session sharing)
src/sync/*                   (sync layer)
src/effect/*                 (Effect utilities)
src/util/*  (except browser-auth.ts — that's ours)
src/npm/*
src/skill/*
src/question/*
src/command/*
src/format/*
src/shell/*
src/server/server.ts
src/server/router.ts
src/server/proxy.ts
src/server/instance.ts
src/plugin/*
src/acp/*
src/auth/*
src/account/*
```

---

## Post-merge rename script

After taking any upstream file, run this to restore our naming conventions:

```bash
cd packages/opencode/src

# Rename env vars
find . -name "*.ts" -o -name "*.tsx" | xargs sed -i 's/OPENCODE_/OPENSURFER_/g'

# Rename path references
find . -name "*.ts" -o -name "*.tsx" | xargs sed -i 's/\.opencode\b/.opensurfer/g'

# Rename service tags (NOT package imports)
find . -name "*.ts" -o -name "*.tsx" | xargs sed -i 's|@opencode/|@opensurfer/|g'

# Rename config filenames
find . -name "*.ts" -o -name "*.tsx" | xargs sed -i \
  's/opencode\.jsonc/opensurfer.jsonc/g; s/opencode\.json/opensurfer.json/g'

# Rename HTTP headers and User-Agent
find . -name "*.ts" -o -name "*.tsx" | xargs sed -i \
  's/x-opencode-/x-opensurfer-/g; s/"X-Title": "opencode"/"X-Title": "OpenSurfer"/g'
find . -name "*.ts" -o -name "*.tsx" | xargs sed -i \
  's|`opencode/${|`opensurfer/${|g'

# Rename user-visible "OpenCode" → "OpenSurfer"
find . -name "*.ts" -o -name "*.tsx" | xargs sed -i 's/OpenCode/OpenSurfer/g'

# After running, manually restore backward-compat in config.ts:
# The candidates list should include both opensurfer.json AND opencode.json
# Do NOT rename brew/scoop registry URLs in installation/index.ts
```

**Always verify the build after merging:**
```bash
cd packages/opencode
bun run --conditions=browser src/index.ts --version
```

---

## Key invariants to preserve

These things must always be true after any merge:

1. **`src/global/index.ts`** — `const app = "opensurfer"` (sets all XDG dirs)
2. **`src/index.ts`** — `.scriptName("opensurfer")`
3. **`src/tool/registry.ts`** — websearch and codesearch must NOT be gated behind `providerID === "opencode"`. The conditional that restricts them must remain deleted.
4. **`src/config/config.ts`** — config candidate list must include `opensurfer.json` first, then `opencode.json` as fallback for migration
5. **`src/session/prompt/*.txt`** — must contain research agent identity, not coding agent identity
6. **`src/tool/webfetch.ts`** — all native site handlers must be present; the file is ~2500 lines; if upstream's webfetch.ts is much shorter, that means they've not added our handlers
7. **`src/util/browser-auth.ts`** — this file does not exist upstream; never delete it
8. **`src/cli/cmd/tui/feature-plugins/sidebar/lsp.tsx`** — our version is the History panel; upstream version is LSP diagnostics; they're completely different files with the same path

---

## How to pull upstream

```bash
# Add upstream remote if not already added
git remote add upstream https://github.com/sst/opencode

# Fetch upstream
git fetch upstream

# Check what changed
git log upstream/main..HEAD --oneline           # our commits
git log HEAD..upstream/main --oneline           # upstream commits we don't have

# See which files upstream changed
git diff HEAD...upstream/main --name-only

# Merge (expect conflicts in the CAREFUL files)
git merge upstream/main

# After resolving conflicts, run the post-merge rename script above
# Then verify: bun run --conditions=browser src/index.ts --version
```
