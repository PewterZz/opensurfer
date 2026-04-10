# OpenSurfer

A terminal-based AI research agent. Ask questions, get sourced answers synthesized from the web — all from your terminal, with any LLM provider.

Built as a fork of [OpenCode](https://opencode.ai). The architecture (tool system, agent framework, session management, plugin system) is unchanged. The focus is shifted from coding assistant to research and browsing agent.

---

## What it does

- **Web search** — searches Bing + DuckDuckGo in parallel, deduplicates results
- **Native site handlers** — fetches clean content without JS walls or paywalls for 25+ sites
- **Deep research** — multi-step searches, cross-referenced, with sources
- **Browser auth** — `/auth` command extracts cookies from your browser (yt-dlp or Firefox SQLite) so authenticated content works
- **Any LLM** — works with Anthropic, OpenAI, Google Gemini, Ollama, and any OpenAI-compatible endpoint

## Natively supported sites

No JS required, no login needed (unless noted):

| Category | Sites |
|---|---|
| Social | Reddit (old.reddit.com), Twitter/X (Nitter), Instagram (imginn), TikTok (ProxiTok) |
| Dev | GitHub (REST API), HuggingFace (Hub API), Stack Overflow (SE API), Hacker News (Firebase), dev.to (API), Lobste.rs (JSON API) |
| Knowledge | Wikipedia (Extracts API), arXiv (XML API), Substack (RSS) |
| Research | OpenReview (ICLR/NeurIPS), ACL Anthology, CVF (CVPR/ECCV/ICCV), PMLR (ICML), IEEE Xplore, ACM DL |
| Paywalled | Medium (freedium.cfd), NYT / WaPo / Bloomberg / FT / WSJ (archive.ph) |
| Video | YouTube (yt-dlp transcript) |

For paywalled research papers: tries Semantic Scholar → Unpaywall (legal OA) → Sci-Hub in order.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/PewterZz/opensurfer/dev/install | bash
```

This installs the `opensurfer` binary to `~/.opensurfer/bin/` and adds it to your PATH. Also installs optional dependencies (yt-dlp, chafa, curl-impersonate, carbonyl) if available.

**Options:**
```bash
# Specific version
curl -fsSL https://raw.githubusercontent.com/PewterZz/opensurfer/dev/install | bash -s -- --version 1.0.0

# Skip optional deps
curl -fsSL https://raw.githubusercontent.com/PewterZz/opensurfer/dev/install | bash -s -- --no-optional

# Don't modify shell config
curl -fsSL https://raw.githubusercontent.com/PewterZz/opensurfer/dev/install | bash -s -- --no-modify-path
```

**Update:** re-run the same install command — it detects the current version and only downloads if newer.

**From source** (requires [Bun](https://bun.sh)):
```bash
git clone https://github.com/PewterZz/opensurfer
cd opensurf && bun install
cd packages/opencode && bun run src/index.ts
```

---

## Configuration

Config file: `~/.config/opensurfer/opensurfer.json` (global) or `./opensurfer.json` (per-project).

The config format is identical to OpenCode — any existing `opencode.json` is automatically read as a fallback.

### Add a provider

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-..."
    }
  }
}
```

Or set environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`.

### Use a local model (Ollama)

```json
{
  "providers": {
    "ollama": {
      "name": "ollama",
      "type": "openai",
      "url": "http://localhost:11434/v1"
    }
  }
}
```

### Use a custom SearXNG instance (better search quality)

```bash
export OPENSURFER_SEARCH_URL="https://your-searxng-instance.example.com"
```

---

## Browser auth (`/auth`)

For sites that require login (LinkedIn, Quora, Spotify, Twitter, etc.):

1. Run `/auth` in the TUI
2. Pick a site from the list
3. Log in in the browser window that opens
4. OpenSurfer extracts the cookies automatically (via yt-dlp or Firefox SQLite)

Cookies are saved to `~/.config/opensurfer/cookies.txt` and used on subsequent fetches.

**Requirements:** either `yt-dlp` installed (`pip install yt-dlp`) for all browsers, or Firefox for direct SQLite extraction.

---

## Full text from PDFs

Research papers on open-access venues (arXiv, ACL Anthology, CVPR) return full text automatically.

For paywalled papers (IEEE, ACM), full text is extracted if `pdftotext` is installed:

```bash
sudo apt install poppler-utils   # Ubuntu/Debian
brew install poppler              # macOS
```

---

## Environment variables

| Variable | Description |
|---|---|
| `OPENSURFER_SEARCH_URL` | SearXNG instance URL for higher-quality search |
| `OPENSURFER_SERVER_USERNAME` | Username for headless server mode |
| `OPENSURFER_SERVER_PASSWORD` | Password for headless server mode |
| `OPENSURFER_CONFIG` | Path to a specific config file |
| `OPENSURFER_CONFIG_DIR` | Override config directory |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub API token (5000 req/hr vs 60 unauthenticated) |
| `HF_TOKEN` / `HUGGINGFACE_TOKEN` | HuggingFace token (for private models/datasets) |

---

## Keybinds

| Key | Action |
|---|---|
| `ctrl+p` | Command palette |
| `ctrl+n` | New session |
| `ctrl+r` | Search sessions |
| `esc` | Cancel / go back |
| `/auth` | Browser cookie login |
| `/share` | Create shareable link |

---

## Credits

- [OpenCode](https://opencode.ai) — the upstream project this is forked from
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — browser cookie extraction
- [Nitter](https://github.com/zedeus/nitter) / [tw1tter.com](https://tw1tter.com) — Twitter/X mirror
- [freedium.cfd](https://freedium.cfd) — Medium paywall bypass
- [imginn.com](https://imginn.com) — Instagram mirror
- [ProxiTok](https://github.com/pablouser1/ProxiTok) — TikTok mirror
- [Unpaywall](https://unpaywall.org) — legal open-access paper finder
- [Semantic Scholar](https://www.semanticscholar.org) — academic paper API

## License

MIT — same as the upstream OpenCode project.
