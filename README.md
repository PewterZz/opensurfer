<p align="center">
  <strong>OpenSurfer</strong>
</p>

<p align="center">
  Terminal-based AI research agent. Search the web, read any site, get sourced answers — from your terminal, with any LLM.
</p>

<p align="center">
  <a href="https://github.com/PewterZz/opensurfer">GitHub</a> ·
  <a href="https://github.com/PewterZz/opensurfer/issues">Issues</a> ·
  <a href="packages/opencode/README.md">Full Docs</a>
</p>

---

OpenSurfer is a fork of [OpenCode](https://opencode.ai) repurposed as a research and browsing agent. Instead of writing code, it searches the web, fetches content from 25+ sites natively (no JS walls, no logins for most), and synthesizes sourced answers.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/PewterZz/opensurfer/dev/install | bash
```

Then set a provider key and start:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY, GEMINI_API_KEY, or configure Ollama
opensurfer
```

**Update:** re-run the same install command — it detects the installed version and only downloads if newer.

## What works out of the box

- Reddit, Twitter/X, Hacker News, GitHub, HuggingFace, Stack Overflow
- Wikipedia, arXiv, Substack, dev.to, Lobste.rs
- ICLR/NeurIPS (OpenReview), CVPR/ECCV (CVF), ICML (PMLR), ACL papers
- Medium, NYT, Bloomberg, FT, WSJ (paywall bypass)
- YouTube transcripts

See [`packages/opencode/README.md`](packages/opencode/README.md) for full documentation.

## License

MIT
