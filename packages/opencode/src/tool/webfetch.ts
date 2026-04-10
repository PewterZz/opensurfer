import z from "zod"
import { Tool } from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { abortAfterAny } from "../util/abort"
import { iife } from "@/util/iife"
import { Global } from "@/global"
import path from "path"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const PAGE_SIZE = 30_000 // chars per page when content is too long
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

/**
 * Fetch a Reddit post or subreddit listing via old.reddit.com plain HTML.
 * old.reddit.com is a server-rendered fallback that works without JavaScript or auth
 * for public content. The JSON API is rate-limited / unreliable without OAuth.
 */
async function fetchReddit(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("reddit.com")) return null

    // Always use old.reddit.com — plain HTML, no JS, reliable
    const cleanPath = u.pathname.replace(/\/?$/, "")
    const oldUrl = `https://old.reddit.com${cleanPath}?limit=50`

    const res = await fetch(oldUrl, {
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    })
    if (!res.ok) return null
    const html = await res.text()
    return parseOldRedditHTML(html)
  } catch {
    return null
  }
}

/** Parse old.reddit.com HTML into readable markdown. */
function parseOldRedditHTML(html: string): string | null {
  const lines: string[] = []

  // ── Page title ──────────────────────────────────────────────────────────────
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const pageTitle = titleMatch ? titleMatch[1].replace(/ : .*$/, "").trim() : ""
  if (pageTitle) lines.push(`# ${pageTitle}`, "")

  // ── Post / thing entries ────────────────────────────────────────────────────
  // Each submission is wrapped in <div class="thing ..."> with data-* attributes
  const titleLinkRe = /<a[^>]+class="[^"]*\btitle\b[^"]*"[^>]+href="([^"]*)"[^>]*>([^<]+)<\/a>/i
  const subredditRe = /data-subreddit="([^"]*)"/i
  const numCommentsRe = /data-comments-count="([^"]*)"/i

  // Split into thing blocks
  const thingBlocks = html.split(/(?=<div[^>]+class="[^"]*\bthing\b)/i).slice(1)
  let postCount = 0

  for (const block of thingBlocks) {
    // Skip comment-type things (they have class "comment")
    if (/class="[^"]*\bcomment\b/.test(block.substring(0, 300))) continue

    const authorMatch = block.match(/data-author="([^"]*)"/)
    const scoreMatch = block.match(/data-score="([^"]*)"/)
    const subredditMatch = block.match(subredditRe)
    const numCommentsMatch = block.match(numCommentsRe)
    const titleLinkMatch = block.match(titleLinkRe)

    if (!titleLinkMatch) continue

    const title = titleLinkMatch[2].trim()
    const href = titleLinkMatch[1].replace(/&amp;/g, "&")
    const author = authorMatch?.[1] ?? "?"
    const score = scoreMatch?.[1] ?? "?"
    const subreddit = subredditMatch?.[1] ?? ""
    const numComments = numCommentsMatch?.[1] ?? "?"

    const sub = subreddit ? `r/${subreddit} · ` : ""
    lines.push(`## ${title}`)
    lines.push(`${sub}**${score} pts** · ${numComments} comments · u/${author}`)
    if (href && !href.startsWith("/r/") && !href.startsWith("https://www.reddit.com/r/")) {
      lines.push(`Link: ${href}`)
    }
    lines.push("")
    postCount++
    if (postCount >= 25) break
  }

  // ── Self-post body ──────────────────────────────────────────────────────────
  // If this is a single post, there's a .usertext-body div with the post content
  const usertextMatch = html.match(
    /<div[^>]+class="[^"]*\busertext-body\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
  )
  if (usertextMatch) {
    const bodyHtml = usertextMatch[1]
    const bodyText = bodyHtml
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .trim()
    if (bodyText && postCount <= 1) {
      lines.push("**Post body:**", bodyText, "")
    }
  }

  // ── Comments ────────────────────────────────────────────────────────────────
  // Comments appear after the main post; each has class "comment"
  const commentBlocks = html.split(/(?=<div[^>]+class="[^"]*\bcomment\b)/i).slice(1)
  if (commentBlocks.length > 0) {
    lines.push("## Top Comments", "")
    let commentCount = 0
    for (const cb of commentBlocks) {
      if (commentCount >= 20) break
      const cAuthorMatch = cb.match(/data-author="([^"]*)"/)
      const cScoreMatch = cb.match(/data-score="([^"]*)"/)
      const mdMatch = cb.match(/<div[^>]+class="[^"]*\bmd\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      if (!mdMatch || !cAuthorMatch) continue
      const author = cAuthorMatch[1]
      if (!author || author === "[deleted]") continue
      const score = cScoreMatch?.[1] ?? "?"
      const commentText = mdMatch[1]
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .trim()
      if (!commentText) continue
      lines.push(`**u/${author}** (${score} pts)`)
      lines.push(commentText, "")
      commentCount++
    }
  }

  const result = lines.join("\n").trim()
  return result.length > 100 ? result : null
}

/**
 * Fetch a tweet or profile from X.com (Twitter) via nitter — a privacy-preserving,
 * no-auth HTML mirror. Tries multiple instances in order until one responds.
 */
async function fetchFromNitter(url: string, signal: AbortSignal): Promise<string | null> {
  // Verified live nitter instances (checked 2026-04; nitter.net serves 200 but returns no content)
  const NITTER_INSTANCES = [
    "tw1tter.com",
    "nitter.net",
  ]

  let twitterPath: string
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("twitter.com") && !u.hostname.endsWith("x.com")) return null
    twitterPath = u.pathname + u.search
  } catch {
    return null
  }

  for (const instance of NITTER_INSTANCES) {
    try {
      const nitterUrl = `https://${instance}${twitterPath}`
      const res = await fetch(nitterUrl, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
          Accept: "text/html",
        },
      })
      if (!res.ok) continue
      const html = await res.text()
      // Nitter's tweet content is in .tweet-content / .tweet-body
      const md = convertNitterHTML(html)
      if (md && md.length > 50) return md
    } catch {
      continue // try next instance
    }
  }
  return null
}

/**
 * Convert Nitter HTML to readable text.
 * Extracts each tweet-content block directly rather than trying to slice the
 * deeply-nested timeline div (whose closing tag boundary is unreliable).
 */
function convertNitterHTML(html: string): string {
  function decodeEntities(s: string): string {
    return s
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
  }

  function stripTags(s: string): string {
    return decodeEntities(
      s
        .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
        .replace(/<[^>]+>/g, "")
        .replace(/[ \t]+/g, " ")
        .trim()
    )
  }

  const chunks: string[] = []

  // Extract tweet author + content pairs
  // tweet-header contains display name; tweet-content contains the text
  const tweetRe = /<div class="tweet-header">([\s\S]*?)<\/div>[\s\S]*?<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
  let m: RegExpExecArray | null
  while ((m = tweetRe.exec(html)) !== null) {
    const authorBlock = m[1]
    const contentBlock = m[2]
    const nameMatch = authorBlock.match(/<a[^>]*class="[^"]*fullname[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    const handleMatch = authorBlock.match(/<a[^>]*class="[^"]*username[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    const author = nameMatch ? stripTags(nameMatch[1]) : ""
    const handle = handleMatch ? stripTags(handleMatch[1]) : ""
    const text = stripTags(contentBlock)
    if (text) chunks.push(author && handle ? `**${author}** ${handle}\n${text}` : text)
  }

  if (chunks.length) return chunks.join("\n\n---\n\n")

  // Fallback: grab all tweet-content divs individually (single-tweet pages)
  const contentRe = /<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
  while ((m = contentRe.exec(html)) !== null) {
    const text = stripTags(m[1])
    if (text) chunks.push(text)
  }

  return chunks.join("\n\n") || ""
}

/** Extract a YouTube video ID from a URL */
function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0]
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v")
  } catch { /* fall through */ }
  return null
}

/** Parse a WebVTT string into plain readable text */
function parseVtt(vtt: string): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of vtt.split("\n")) {
    const line = raw.trim()
    if (!line || line === "WEBVTT" || /^\d+$/.test(line) || /^\d{2}:\d{2}.*-->/.test(line) || line.startsWith("NOTE ")) continue
    const text = line.replace(/<[^>]+>/g, "").trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    lines.push(text)
  }
  return lines.join(" ").replace(/\s+/g, " ").trim()
}

/** Cached yt-dlp availability — checked once per process lifetime */
let ytdlpAvailable: boolean | undefined = undefined

async function hasYtdlp(): Promise<boolean> {
  if (ytdlpAvailable !== undefined) return ytdlpAvailable
  try {
    const p = Bun.spawn(["yt-dlp", "--version"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    await p.exited
    ytdlpAvailable = p.exitCode === 0
  } catch {
    ytdlpAvailable = false
  }
  return ytdlpAvailable
}

/** Kill a spawned process when a signal fires; returns a cleanup function */
function killOnAbort(proc: ReturnType<typeof Bun.spawn>, signal: AbortSignal): () => void {
  const handler = () => { try { proc.kill() } catch { /* already exited */ } }
  signal.addEventListener("abort", handler, { once: true })
  return () => signal.removeEventListener("abort", handler)
}

/**
 * Extract a YouTube (or any video) transcript using yt-dlp.
 * yt-dlp handles YouTube's auth/cookie complexity and works with 1000+ sites.
 * Returns null if yt-dlp is not installed or transcript cannot be retrieved.
 */
async function fetchTranscriptWithYtdlp(url: string, signal: AbortSignal): Promise<string | null> {
  if (!await hasYtdlp()) return null

  const tmpBase = `/tmp/opensurfer_transcript_${Date.now()}_${Math.random().toString(36).slice(2)}`

  try {
    // Fetch video metadata (title, channel) as JSON
    const metaProc = Bun.spawn([
      "yt-dlp", "--dump-json", "--no-playlist", "--quiet",
      "--retries", "3",
      url,
    ], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const cleanupMeta = killOnAbort(metaProc, signal)
    const metaText = await new Response(metaProc.stdout).text()
    await metaProc.exited
    cleanupMeta()

    if (signal.aborted) return null
    // Non-zero exit means rate-limit, geo-block, private video, etc — bail early
    if (metaProc.exitCode !== 0) return null

    let title = url, channel = ""
    try {
      const meta = JSON.parse(metaText)
      title = meta.title ?? url
      channel = meta.uploader ?? meta.channel ?? ""
    } catch { /* use URL as title */ }

    // Download subtitles only (no video).
    // --sleep-requests 1: wait 1s between requests to avoid 429s when fetching
    // multiple videos in one session. --retries 3: retry on transient failures.
    const subtitleProc = Bun.spawn([
      "yt-dlp",
      "--write-auto-sub", "--write-sub",
      "--skip-download",
      "--sub-lang", "en.*",
      "--sub-format", "vtt",
      "--no-playlist",
      "--quiet",
      "--retries", "3",
      "--sleep-requests", "1",
      "-o", tmpBase,
      url,
    ], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    const cleanupSub = killOnAbort(subtitleProc, signal)
    await subtitleProc.exited
    cleanupSub()

    if (signal.aborted) return null
    if (subtitleProc.exitCode !== 0) {
      return `# ${title}\n**Channel:** ${channel}\n\n_Transcript unavailable (rate-limited, geo-blocked, or no captions)._`
    }

    // Find the generated VTT file — yt-dlp appends the lang code, e.g. tmpBase.en.vtt
    // Scan /tmp directly (not /) to avoid a slow full-filesystem walk.
    const filename = tmpBase.replace("/tmp/", "")
    const glob = new Bun.Glob(`${filename}*.vtt`)
    let vttPath: string | null = null
    for await (const f of glob.scan("/tmp")) { vttPath = `/tmp/${f}`; break }

    if (!vttPath) {
      return `# ${title}\n**Channel:** ${channel}\n\n_No transcript available (video may not have captions)._`
    }

    const vtt = await Bun.file(vttPath).text()
    Bun.spawn(["rm", "-f", vttPath], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })

    const transcript = parseVtt(vtt)
    if (!transcript) return `# ${title}\n**Channel:** ${channel}\n\n_Transcript was empty._`
    return `# ${title}\n**Channel:** ${channel}\n\n## Transcript\n\n${transcript}`
  } catch {
    return null
  }
}

/**
 * Hacker News via the official Firebase API + Algolia for search/comments.
 * Handles: /item/<id> (post + comments), /user/<name> (profile), front page.
 */
async function fetchHackerNews(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("ycombinator.com") && !u.hostname.endsWith("news.ycombinator.com")) return null

    // Single item: https://news.ycombinator.com/item?id=12345
    const itemId = u.searchParams.get("id")
    if (itemId && u.pathname === "/item") {
      const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${itemId}.json`, { signal })
      if (!res.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item: any = await res.json()
      if (!item) return null

      const lines: string[] = [
        `# ${item.title ?? item.type}`,
        `**${item.score} points** by ${item.by} · ${item.descendants ?? 0} comments`,
        "",
      ]
      if (item.url) lines.push(`**URL:** ${item.url}`, "")
      if (item.text) {
        // HN stores text as HTML
        lines.push(item.text.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"'), "")
      }

      // Fetch top-level comments from Algolia (much simpler than recursive Firebase calls)
      const algolia = await fetch(
        `https://hn.algolia.com/api/v1/items/${itemId}`,
        { signal, headers: { "User-Agent": "OpenSurfer/1.0" } },
      )
      if (algolia.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await algolia.json()
        lines.push("## Top Comments", "")

        function renderChildren(children: unknown[], depth: number, max = 3): void {
          if (depth > max) return
          for (const c of children as Array<Record<string, unknown>>) {
            if (!c.text || c.deleted) continue
            const indent = "  ".repeat(depth)
            const text = String(c.text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
            lines.push(`${indent}**${c.author}** (${c.points ?? 0} pts)`)
            lines.push(`${indent}${text}`, "")
            if (Array.isArray(c.children)) renderChildren(c.children, depth + 1, max)
          }
        }

        if (Array.isArray(data.children)) renderChildren(data.children, 0)
      }

      return lines.join("\n")
    }

    // User profile: /user?id=name
    const userId = u.searchParams.get("id")
    if (userId && u.pathname === "/user") {
      const res = await fetch(`https://hacker-news.firebaseio.com/v0/user/${userId}.json`, { signal })
      if (!res.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user: any = await res.json()
      return `# HN User: ${user.id}\n\n**Karma:** ${user.karma}\n**Created:** ${new Date(user.created * 1000).toDateString()}\n\n${user.about ? user.about.replace(/<[^>]+>/g, "") : ""}`
    }

    // Front page / top stories
    const topRes = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", { signal })
    if (!topRes.ok) return null
    const ids: number[] = await topRes.json()
    const top20 = await Promise.all(
      ids.slice(0, 20).map((id) =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then((r) => r.json() as Promise<any>)
          .catch(() => null),
      ),
    )
    const lines = ["# Hacker News — Top Stories", ""]
    for (const story of top20) {
      if (!story?.title) continue
      const link = story.url ? `[${story.title}](${story.url})` : story.title
      lines.push(`- ${link} — **${story.score} pts** · [${story.descendants ?? 0} comments](https://news.ycombinator.com/item?id=${story.id})`)
    }
    return lines.join("\n")
  } catch {
    return null
  }
}

/**
 * GitHub via the REST API — no auth needed for public repos.
 * Handles: repos, files, issues, PRs, user profiles, org pages.
 */
async function fetchGitHub(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("github.com")) return null
    const parts = u.pathname.replace(/^\//, "").split("/")

    const apiBase = "https://api.github.com"
    const headers: Record<string, string> = {
      "User-Agent": "OpenSurfer/1.0",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    }
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
    if (token) headers["Authorization"] = `Bearer ${token}`

    // User or org profile: github.com/{user}
    if (parts.length === 1) {
      const [user] = parts
      const [userRes, reposRes] = await Promise.all([
        fetch(`${apiBase}/users/${user}`, { signal, headers }),
        fetch(`${apiBase}/users/${user}/repos?sort=stars&per_page=10`, { signal, headers }),
      ])
      if (!userRes.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const u2: any = await userRes.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repos: any[] = reposRes.ok ? await reposRes.json() : []
      const lines = [
        `# ${u2.name ?? u2.login} (${u2.login})`,
        u2.bio ?? "",
        `**Followers:** ${u2.followers} · **Following:** ${u2.following} · **Public repos:** ${u2.public_repos}`,
        u2.company ? `**Company:** ${u2.company}` : "",
        u2.location ? `**Location:** ${u2.location}` : "",
        "",
        "## Top Repositories",
        "",
        ...repos.map((r) => `- **[${r.full_name}](${r.html_url})** — ${r.description ?? ""} (★${r.stargazers_count})`),
      ]
      return lines.filter((l) => l !== "").join("\n")
    }

    const [owner, repo, section, ...rest] = parts

    // Repo root: github.com/{owner}/{repo}
    if (!section) {
      const [repoRes, readmeRes] = await Promise.all([
        fetch(`${apiBase}/repos/${owner}/${repo}`, { signal, headers }),
        fetch(`${apiBase}/repos/${owner}/${repo}/readme`, { signal, headers: { ...headers, Accept: "application/vnd.github.raw+json" } }),
      ])
      if (!repoRes.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await repoRes.json()
      const readme = readmeRes.ok ? await readmeRes.text() : null
      const lines = [
        `# ${r.full_name}`,
        r.description ?? "",
        `**Stars:** ${r.stargazers_count} · **Forks:** ${r.forks_count} · **Language:** ${r.language ?? "N/A"} · **License:** ${r.license?.name ?? "None"}`,
        r.topics?.length ? `**Topics:** ${r.topics.join(", ")}` : "",
        "",
      ]
      if (readme) lines.push("## README", "", readme.slice(0, 8000))
      return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n")
    }

    // Issues list: github.com/{owner}/{repo}/issues
    if (section === "issues" && !rest.length) {
      const res = await fetch(`${apiBase}/repos/${owner}/${repo}/issues?state=open&per_page=20`, { signal, headers })
      if (!res.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const issues: any[] = await res.json()
      const lines = [`# ${owner}/${repo} — Open Issues`, ""]
      for (const issue of issues) {
        lines.push(`- [#${issue.number}](${issue.html_url}) **${issue.title}** — ${issue.comments} comments, by ${issue.user.login}`)
      }
      return lines.join("\n")
    }

    // Single issue or PR
    if ((section === "issues" || section === "pull") && rest[0]) {
      const num = rest[0]
      const endpoint = section === "pull" ? "pulls" : "issues"
      const [issueRes, commentsRes] = await Promise.all([
        fetch(`${apiBase}/repos/${owner}/${repo}/${endpoint}/${num}`, { signal, headers }),
        fetch(`${apiBase}/repos/${owner}/${repo}/issues/${num}/comments?per_page=30`, { signal, headers }),
      ])
      if (!issueRes.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const issue: any = await issueRes.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const comments: any[] = commentsRes.ok ? await commentsRes.json() : []
      const lines = [
        `# ${issue.title}`,
        `**${owner}/${repo}#${num}** · ${issue.state} · opened by ${issue.user.login}`,
        "",
        issue.body ?? "_No description_",
        "",
        `## Comments (${comments.length})`,
        "",
        ...comments.map((c) => `**${c.user.login}:**\n${c.body}\n`),
      ]
      return lines.join("\n")
    }

    // File/blob: github.com/{owner}/{repo}/blob/{branch}/{...path}
    if (section === "blob" && rest.length >= 2) {
      const [_branch, ...fileParts] = rest
      const filePath = fileParts.join("/")
      const res = await fetch(`${apiBase}/repos/${owner}/${repo}/contents/${filePath}`, {
        signal,
        headers: { ...headers, Accept: "application/vnd.github.raw+json" },
      })
      if (!res.ok) return null
      const content = await res.text()
      const ext = filePath.split(".").pop() ?? ""
      return `# ${filePath}\n\n\`\`\`${ext}\n${content.slice(0, 20000)}\n\`\`\``
    }

    return null // let general fetch handle other GitHub pages
  } catch {
    return null
  }
}

/**
 * Fetch HuggingFace model cards, datasets, spaces, papers, and org/user profiles
 * via the HuggingFace Hub API — fully public, no auth required for public repos.
 */
async function fetchHuggingFace(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("huggingface.co")) return null

    const parts = u.pathname.replace(/^\//, "").replace(/\/$/, "").split("/")
    const apiBase = "https://huggingface.co/api"
    const headers: Record<string, string> = {
      "User-Agent": "OpenSurfer/1.0",
      Accept: "application/json",
    }
    const hfToken = process.env.HF_TOKEN ?? process.env.HUGGINGFACE_TOKEN
    if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`

    // ── Papers: /papers/{arxiv_id} ─────────────────────────────────────────
    if (parts[0] === "papers" && parts[1]) {
      const arxivId = parts[1]
      // Delegate to arXiv handler by rewriting the URL
      return fetchArxiv(`https://arxiv.org/abs/${arxivId}`, signal)
    }

    // ── Blog posts: /blog/{slug} ────────────────────────────────────────────
    if (parts[0] === "blog" && parts[1]) {
      const slug = parts[1]
      // HuggingFace blog has a raw markdown endpoint
      const mdUrl = `https://huggingface.co/blog/raw/${slug}`
      const res = await fetch(mdUrl, { signal, headers: { ...headers, Accept: "text/plain, text/markdown, */*" } })
      if (res.ok) {
        const md = await res.text()
        if (md.length > 100) return md.slice(0, 20000)
      }
      return null
    }

    // ── Spaces: /spaces/{owner}/{space} ─────────────────────────────────────
    if (parts[0] === "spaces" && parts[1] && parts[2]) {
      const [, owner, space] = parts
      const res = await fetch(`${apiBase}/spaces/${owner}/${space}`, { signal, headers })
      if (!res.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json()
      const lines = [
        `# ${data.id ?? `${owner}/${space}`} (Space)`,
        data.cardData?.short_description ?? data.cardData?.title ?? "",
        `**Likes:** ${data.likes ?? 0} · **SDK:** ${data.cardData?.sdk ?? "unknown"} · **Runtime:** ${data.runtime?.stage ?? "unknown"}`,
        "",
      ]
      if (data.cardData?.tags?.length) lines.push(`**Tags:** ${data.cardData.tags.join(", ")}`, "")
      if (data.cardData?.short_description) lines.push(data.cardData.short_description)
      lines.push(`\nhttps://huggingface.co/spaces/${owner}/${space}`)
      return lines.join("\n").trim()
    }

    // ── Datasets: /datasets/{owner}/{dataset} ───────────────────────────────
    if (parts[0] === "datasets" && parts[1]) {
      const datasetId = parts.slice(1).join("/")
      const [infoRes, readmeRes] = await Promise.all([
        fetch(`${apiBase}/datasets/${datasetId}`, { signal, headers }),
        fetch(`https://huggingface.co/datasets/${datasetId}/raw/main/README.md`, {
          signal,
          headers: { ...headers, Accept: "text/plain, */*" },
        }),
      ])
      if (!infoRes.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await infoRes.json()
      const readme = readmeRes.ok ? await readmeRes.text() : null
      const lines = [
        `# ${data.id ?? datasetId} (Dataset)`,
        data.description ?? data.cardData?.pretty_name ?? "",
        `**Downloads (month):** ${(data.downloads ?? 0).toLocaleString()} · **Likes:** ${data.likes ?? 0}`,
        data.cardData?.license ? `**License:** ${data.cardData.license}` : "",
        data.tags?.length ? `**Tags:** ${data.tags.join(", ")}` : "",
        "",
      ]
      if (readme) {
        // Strip YAML front matter from README
        const body = readme.replace(/^---[\s\S]*?---\n/, "").trim()
        lines.push("## Dataset Card", "", body.slice(0, 8000))
      }
      return lines.filter(Boolean).join("\n")
    }

    // ── User / Org profile: /{user} ─────────────────────────────────────────
    if (parts.length === 1) {
      const user = parts[0]
      const [userRes, modelsRes] = await Promise.all([
        fetch(`${apiBase}/users/${user}`, { signal, headers }),
        fetch(`${apiBase}/models?author=${encodeURIComponent(user)}&sort=likes&limit=10`, { signal, headers }),
      ])
      // Try org endpoint if user not found
      const profileRes = userRes.ok ? userRes : await fetch(`${apiBase}/organizations/${user}`, { signal, headers })
      if (!profileRes.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profile: any = await profileRes.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const models: any[] = modelsRes.ok ? await modelsRes.json() : []
      const lines = [
        `# ${profile.fullname ?? profile.name ?? user} (@${user})`,
        profile.type === "org" ? `**Organization**` : `**User** · **Followers:** ${profile.numFollowers ?? 0}`,
        "",
      ]
      if (models.length > 0) {
        lines.push("## Top Models", "")
        for (const m of models.slice(0, 10)) {
          lines.push(`- **[${m.id}](https://huggingface.co/${m.id})** — ★${m.likes ?? 0} likes · ${(m.downloads ?? 0).toLocaleString()} downloads/mo`)
        }
      }
      return lines.join("\n").trim()
    }

    // ── Model card: /{owner}/{model} (and sub-paths like /tree, /resolve) ───
    if (parts.length >= 2) {
      const [owner, model] = parts
      const modelId = `${owner}/${model}`
      const [infoRes, readmeRes] = await Promise.all([
        fetch(`${apiBase}/models/${modelId}`, { signal, headers }),
        fetch(`https://huggingface.co/${modelId}/raw/main/README.md`, {
          signal,
          headers: { ...headers, Accept: "text/plain, */*" },
        }),
      ])
      if (!infoRes.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await infoRes.json()
      const readme = readmeRes.ok ? await readmeRes.text() : null
      const lines = [
        `# ${data.id ?? modelId}`,
        data.cardData?.model_name ?? data.cardData?.pretty_name ?? "",
        `**Downloads (month):** ${(data.downloads ?? 0).toLocaleString()} · **Likes:** ${data.likes ?? 0} · **Pipeline:** ${data.pipeline_tag ?? "unknown"}`,
        data.cardData?.license ? `**License:** ${data.cardData.license}` : "",
        data.tags?.length ? `**Tags:** ${data.tags.slice(0, 15).join(", ")}` : "",
        "",
      ]
      if (readme) {
        const body = readme.replace(/^---[\s\S]*?---\n/, "").trim()
        lines.push("## Model Card", "", body.slice(0, 10000))
      }
      return lines.filter(Boolean).join("\n")
    }

    return null
  } catch {
    return null
  }
}

/**
 * Stack Overflow / Stack Exchange via the public API (no auth for read-only).
 * Returns question + all answers sorted by score.
 */
async function fetchStackExchange(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("stackoverflow.com") && !u.hostname.endsWith("stackexchange.com") && !u.hostname.endsWith("serverfault.com") && !u.hostname.endsWith("superuser.com")) return null

    // Extract question ID: /questions/{id}/{slug}
    const qMatch = u.pathname.match(/\/questions\/(\d+)/)
    if (!qMatch) return null
    const qId = qMatch[1]

    // Determine the site parameter
    const site = u.hostname.replace(/^www\./, "").replace(".com", "").replace(".net", "")

    const apiUrl = `https://api.stackexchange.com/2.3/questions/${qId}?site=${site}&filter=withbody&order=desc&sort=votes`
    const [qRes, aRes] = await Promise.all([
      fetch(apiUrl, { signal }),
      fetch(`https://api.stackexchange.com/2.3/questions/${qId}/answers?site=${site}&filter=withbody&order=desc&sort=votes&pagesize=10`, { signal }),
    ])
    if (!qRes.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qData: any = await qRes.json()
    const question = qData.items?.[0]
    if (!question) return null

    function stripHtmlBasic(html: string): string {
      return html
        .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
        .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
        .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n").trim()
    }

    const lines = [
      `# ${question.title}`,
      `**Tags:** ${question.tags?.join(", ")} · **Score:** ${question.score} · **Views:** ${question.view_count}`,
      "",
      stripHtmlBasic(question.body ?? ""),
      "",
    ]

    if (aRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aData: any = await aRes.json()
      const answers = aData.items ?? []
      lines.push(`## Answers (${answers.length})`, "")
      for (const a of answers) {
        const accepted = a.is_accepted ? " ✓ **Accepted**" : ""
        lines.push(`### Score: ${a.score}${accepted} — by ${a.owner?.display_name}`, "")
        lines.push(stripHtmlBasic(a.body ?? ""), "")
      }
    }

    return lines.join("\n")
  } catch {
    return null
  }
}

/**
 * arXiv papers via the official API — returns title, authors, abstract, and links.
 * Handles abs/, pdf/, html/ URL patterns.
 */
async function fetchArxiv(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("arxiv.org")) return null

    // Extract paper ID from /abs/1234.5678, /pdf/1234.5678, /html/1234.5678
    const idMatch = u.pathname.match(/\/(abs|pdf|html|e-print)\/([0-9]{4}\.[0-9]+(v\d+)?|[a-z\-]+\/[0-9]+)/)
    if (!idMatch) return null
    const paperId = idMatch[2]

    const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(paperId)}`
    const res = await fetch(apiUrl, { signal, headers: { "User-Agent": "OpenSurfer/1.0" } })
    if (!res.ok) return null
    const xml = await res.text()

    const title = xml.match(/<title>([^<]+)<\/title>/)?.[1]?.replace(/\s+/g, " ").trim()
    if (!title || title === "ArXiv Query") return null

    const summary = xml.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, " ").trim()
    const authors = [...xml.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]).join(", ")
    const published = xml.match(/<published>([^<]+)<\/published>/)?.[1]?.slice(0, 10)
    const categories = [...xml.matchAll(/<category term="([^"]+)"/g)].map((m) => m[1]).join(", ")
    const doi = xml.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/)?.[1]

    const lines = [
      `# ${title}`,
      `**Authors:** ${authors}`,
      `**Published:** ${published} · **Categories:** ${categories}`,
      doi ? `**DOI:** ${doi}` : "",
      `**arXiv:** https://arxiv.org/abs/${paperId}`,
      `**PDF:** https://arxiv.org/pdf/${paperId}`,
      "",
      "## Abstract",
      "",
      summary ?? "_No abstract available_",
    ]
    return lines.filter((l) => l !== "").join("\n")
  } catch {
    return null
  }
}

/**
 * Try to extract plaintext from a PDF URL using pdftotext (poppler-utils).
 * Returns null if pdftotext is not installed or extraction fails.
 */
async function extractPdfText(pdfUrl: string, signal: AbortSignal): Promise<string | null> {
  try {
    // Check pdftotext is available
    const which = Bun.spawn(["which", "pdftotext"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    await which.exited
    if (which.exitCode !== 0) return null

    // Download PDF to tmp
    const tmpPdf = `/tmp/opensurfer_paper_${Date.now()}.pdf`
    const tmpTxt = `/tmp/opensurfer_paper_${Date.now()}.txt`
    try {
      const res = await fetch(pdfUrl, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
          Accept: "application/pdf, */*",
        },
      })
      if (!res.ok || !res.headers.get("content-type")?.includes("pdf")) return null
      const buf = await res.arrayBuffer()
      await Bun.write(tmpPdf, buf)

      const proc = Bun.spawn(["pdftotext", "-layout", "-l", "12", tmpPdf, tmpTxt], {
        stdout: "ignore", stderr: "ignore", stdin: "ignore",
      })
      await proc.exited
      if (proc.exitCode !== 0) return null

      const text = await Bun.file(tmpTxt).text().catch(() => null)
      if (!text || text.trim().length < 200) return null
      return text.trim().slice(0, 30000)
    } finally {
      Bun.spawn(["rm", "-f", tmpPdf, tmpTxt], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    }
  } catch {
    return null
  }
}

/** Extract a DOI from a URL string (matches 10.XXXX/...) */
function extractDOI(url: string): string | null {
  const m = url.match(/\b(10\.\d{4,}\/[^\s"<>&#?]+)/)
  return m ? m[1].replace(/[.)]+$/, "") : null
}

/**
 * Fetch OpenReview paper (ICLR, NeurIPS, COLM, TMLR, etc.) via the OpenReview API.
 * Returns full abstract + all forum notes (reviews, author responses if public).
 */
async function fetchOpenReview(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("openreview.net")) return null

    const forumId = u.searchParams.get("id")
    if (!forumId) return null

    const apiUrl = `https://api2.openreview.net/notes?forum=${encodeURIComponent(forumId)}&details=replyCount&limit=50`
    const res = await fetch(apiUrl, { signal, headers: { "User-Agent": "OpenSurfer/1.0", Accept: "application/json" } })
    if (!res.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json()
    const notes: any[] = data.notes ?? []
    if (!notes.length) return null

    // The first note is the submission itself
    const submission = notes[0]
    const content = submission.content ?? {}
    const title = content.title?.value ?? content.title ?? "Untitled"
    const authors = Array.isArray(content.authors?.value)
      ? content.authors.value.join(", ")
      : Array.isArray(content.authors) ? content.authors.join(", ") : ""
    const abstract = content.abstract?.value ?? content.abstract ?? ""
    const venue = content.venue?.value ?? content.venue ?? ""
    const keywords = Array.isArray(content.keywords?.value)
      ? content.keywords.value.join(", ")
      : ""
    const pdfPath = content.pdf?.value ?? content.pdf ?? ""
    const pdfUrl = pdfPath ? `https://openreview.net${pdfPath}` : ""

    const lines = [
      `# ${title}`,
      authors ? `**Authors:** ${authors}` : "",
      venue ? `**Venue:** ${venue}` : "",
      keywords ? `**Keywords:** ${keywords}` : "",
      pdfUrl ? `**PDF:** ${pdfUrl}` : "",
      `**OpenReview:** https://openreview.net/forum?id=${forumId}`,
      "",
      "## Abstract",
      "",
      abstract || "_No abstract available_",
    ]

    // Include public reviews if available
    const reviews = notes.slice(1).filter((n: any) => {
      const inv = n.invitations?.[0] ?? ""
      return inv.includes("Review") || inv.includes("review")
    })
    if (reviews.length > 0) {
      lines.push("", `## Reviews (${reviews.length})`, "")
      for (const r of reviews.slice(0, 5)) {
        const rc = r.content ?? {}
        const rating = rc.rating?.value ?? rc.rating ?? ""
        const summary = rc.summary?.value ?? rc.summary ?? rc.strengths?.value ?? ""
        if (rating) lines.push(`**Rating:** ${rating}`)
        if (summary) {
          lines.push(String(summary).slice(0, 500))
          lines.push("")
        }
      }
    }

    const result = lines.filter(Boolean).join("\n")

    // Try to also get full PDF text
    if (pdfUrl) {
      const pdfText = await extractPdfText(pdfUrl, signal)
      if (pdfText) return `${result}\n\n## Full Paper\n\n${pdfText}`
    }

    return result
  } catch {
    return null
  }
}

/**
 * Fetch an ACL Anthology paper (ACL, EMNLP, NAACL, EACL, COLING, etc.)
 * via the Anthology's structured API — all papers are open access.
 */
async function fetchAclAnthology(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("aclanthology.org")) return null

    // URL format: aclanthology.org/{paper_id} e.g. 2023.acl-long.1
    const paperId = u.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.pdf$/, "")
    if (!paperId) return null

    const apiUrl = `https://aclanthology.org/${paperId}.json`
    const res = await fetch(apiUrl, { signal, headers: { "User-Agent": "OpenSurfer/1.0", Accept: "application/json" } })
    if (!res.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json()

    const lines = [
      `# ${data.title ?? "Untitled"}`,
      `**Authors:** ${(data.author ?? []).map((a: any) => a.full ?? `${a.given ?? ""} ${a.family ?? ""}`).join(", ")}`,
      `**Venue:** ${data.booktitle ?? data.venue ?? ""} · **Year:** ${data.year ?? ""}`,
      data.doi ? `**DOI:** ${data.doi}` : "",
      `**PDF:** https://aclanthology.org/${paperId}.pdf`,
      `**Anthology:** https://aclanthology.org/${paperId}`,
      "",
      "## Abstract",
      "",
      data.abstract ?? "_No abstract available_",
    ]

    const result = lines.filter(Boolean).join("\n")

    // Try to get full PDF text (ACL papers are open access)
    const pdfText = await extractPdfText(`https://aclanthology.org/${paperId}.pdf`, signal)
    if (pdfText) return `${result}\n\n## Full Paper\n\n${pdfText}`

    return result
  } catch {
    return null
  }
}

/**
 * Semantic Scholar API — resolves any paper by DOI, arXiv ID, or ACL ID.
 * Returns abstract + metadata + open access PDF URL if available.
 */
async function fetchViaSemanticScholar(
  paperId: string, // "DOI:10.xxx/yyy" | "ARXIV:2301.xxx" | "ACL:2023.acl-long.1" | SS paper hash
  signal: AbortSignal,
): Promise<{ text: string; oaPdfUrl?: string } | null> {
  try {
    const fields = "title,authors,year,abstract,openAccessPdf,publicationVenue,citationCount,externalIds,tldr"
    const res = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperId)}?fields=${fields}`,
      { signal, headers: { "User-Agent": "OpenSurfer/1.0", Accept: "application/json" } },
    )
    if (!res.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = await res.json()
    if (!d.title) return null

    const oaPdfUrl: string | undefined = d.openAccessPdf?.url

    const lines = [
      `# ${d.title}`,
      `**Authors:** ${(d.authors ?? []).map((a: any) => a.name).join(", ")}`,
      `**Year:** ${d.year ?? "?"} · **Venue:** ${d.publicationVenue?.name ?? d.publicationVenue?.alternateNames?.[0] ?? ""}`,
      `**Citations:** ${d.citationCount ?? 0}`,
      d.externalIds?.DOI ? `**DOI:** ${d.externalIds.DOI}` : "",
      d.externalIds?.ArXiv ? `**arXiv:** https://arxiv.org/abs/${d.externalIds.ArXiv}` : "",
      oaPdfUrl ? `**Open Access PDF:** ${oaPdfUrl}` : "",
      "",
      "## Abstract",
      "",
      d.abstract ?? "_No abstract available_",
      d.tldr?.text ? `\n**TL;DR:** ${d.tldr.text}` : "",
    ]
    return { text: lines.filter((l) => l !== "").join("\n"), oaPdfUrl }
  } catch {
    return null
  }
}

/**
 * Try to get the open-access PDF URL for a DOI via the Unpaywall API.
 * Unpaywall is completely legal — it only returns publisher-authorised OA copies.
 */
async function findOALocationViaUnpaywall(doi: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=opensurf@opensurf.app`,
      { signal, headers: { "User-Agent": "OpenSurfer/1.0", Accept: "application/json" } },
    )
    if (!res.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json()
    // Best OA location first, then any OA location
    const best = data.best_oa_location ?? data.oa_locations?.[0]
    return best?.url_for_pdf ?? best?.url ?? null
  } catch {
    return null
  }
}

/**
 * Sci-Hub fallback — tries multiple active instances to find a hosted PDF for a DOI.
 * Used only when no open-access version is found via Unpaywall or Semantic Scholar.
 */
async function fetchViaSciHub(doi: string, signal: AbortSignal): Promise<string | null> {
  const SCIHUB_INSTANCES = [
    "https://sci-hub.se",
    "https://sci-hub.st",
    "https://sci-hub.ru",
  ]
  for (const base of SCIHUB_INSTANCES) {
    try {
      const res = await fetch(`${base}/${doi}`, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      })
      if (!res.ok) continue
      const html = await res.text()

      // Sci-Hub embeds the PDF in an iframe or embed — extract the src
      const pdfMatch =
        html.match(/(?:iframe|embed)[^>]+src=["']([^"']*\.pdf[^"']*)["']/i) ??
        html.match(/location\.href\s*=\s*["']([^"']*\.pdf[^"']*)["']/i) ??
        html.match(/src\s*=\s*["'](\/\/[^"']+\.pdf[^"']*)["']/i)

      if (!pdfMatch) continue

      let pdfUrl = pdfMatch[1]
      if (pdfUrl.startsWith("//")) pdfUrl = "https:" + pdfUrl
      else if (pdfUrl.startsWith("/")) pdfUrl = base + pdfUrl

      // Try to extract text from the PDF
      const pdfText = await extractPdfText(pdfUrl, signal)
      if (pdfText) return `_[Full text via Sci-Hub — ${base}]_\n\n${pdfText}`

      // pdftotext not available — return the PDF URL
      return `_[Paper found on Sci-Hub — PDF available at: ${pdfUrl}]_`
    } catch { /* try next */ }
  }
  return null
}

/**
 * Main academic paper dispatcher. Handles NeurIPS, IEEE, CVPR, ACM, ICLR,
 * and any venue whose papers have DOIs.
 *
 * Resolution order:
 *   1. OpenReview API (ICLR, NeurIPS, COLM, TMLR)
 *   2. ACL Anthology (ACL, EMNLP, NAACL, EACL, COLING)
 *   3. Semantic Scholar by DOI / arXiv ID (abstract + OA PDF)
 *   4. Unpaywall (finds legal OA copy for any DOI)
 *   5. Sci-Hub (last resort for paywalled DOIs)
 */
async function fetchAcademicPaper(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, "")

    // ── OpenReview ─────────────────────────────────────────────────────────────
    if (host.endsWith("openreview.net")) {
      return fetchOpenReview(url, signal)
    }

    // ── ACL Anthology ──────────────────────────────────────────────────────────
    if (host.endsWith("aclanthology.org")) {
      return fetchAclAnthology(url, signal)
    }

    // ── CVF Open Access (CVPR, ECCV, ICCV) ─────────────────────────────────────
    if (host.endsWith("thecvf.com")) {
      // CVF pages have paper title in <meta name="citation_title"> and abstract in the page
      // Try Semantic Scholar by scraping the title from the HTML
      const res = await fetch(url, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
          Accept: "text/html",
        },
      })
      if (!res.ok) return null
      const html = await res.text()
      const titleMatch = html.match(/<meta\s+name="citation_title"\s+content="([^"]+)"/i)
      const doiMatch = html.match(/<meta\s+name="citation_doi"\s+content="([^"]+)"/i)
      const pdfMatch = html.match(/<meta\s+name="citation_pdf_url"\s+content="([^"]+)"/i)
      const abstractMatch = html.match(/<div\s+id="abstract"[^>]*>([\s\S]*?)<\/div>/i)

      const title = titleMatch?.[1] ?? ""
      const doi = doiMatch?.[1] ?? extractDOI(url)
      const pdfUrl = pdfMatch?.[1] ?? ""
      const abstract = abstractMatch?.[1]?.replace(/<[^>]+>/g, "").trim() ?? ""

      if (!title) return null

      // Try Semantic Scholar for full metadata
      if (doi) {
        const ss = await fetchViaSemanticScholar(`DOI:${doi}`, signal)
        if (ss) {
          const pdfText = pdfUrl ? await extractPdfText(pdfUrl, signal) : null
          return pdfText ? `${ss.text}\n\n## Full Paper\n\n${pdfText}` : ss.text
        }
      }

      const lines = [`# ${title}`, "", abstract ? `## Abstract\n\n${abstract}` : "", pdfUrl ? `**PDF:** ${pdfUrl}` : ""]
      const pdfText = pdfUrl ? await extractPdfText(pdfUrl, signal) : null
      if (pdfText) lines.push("", "## Full Paper", "", pdfText)
      return lines.filter(Boolean).join("\n")
    }

    // ── NeurIPS papers site ─────────────────────────────────────────────────────
    if (host.endsWith("neurips.cc") || host.endsWith("papers.nips.cc")) {
      const res = await fetch(url, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
          Accept: "text/html",
        },
      })
      if (!res.ok) return null
      const html = await res.text()
      const titleMatch = html.match(/<h4[^>]*>(.*?)<\/h4>/i) ?? html.match(/<title[^>]*>([^|<]+)/i)
      const abstractMatch = html.match(/<h4>Abstract<\/h4>\s*<p[^>]*>([\s\S]*?)<\/p>/i)
      const pdfMatch = html.match(/href="([^"]*\.pdf)"/i)
      const doi = extractDOI(html) ?? extractDOI(url)

      const title = titleMatch?.[1]?.replace(/<[^>]+>/g, "").trim() ?? ""
      const abstract = abstractMatch?.[1]?.replace(/<[^>]+>/g, "").trim() ?? ""
      const pdfUrl = pdfMatch ? (pdfMatch[1].startsWith("http") ? pdfMatch[1] : `https://${host}${pdfMatch[1]}`) : ""

      if (!title) return null
      // Enrich with Semantic Scholar
      if (doi) {
        const ss = await fetchViaSemanticScholar(`DOI:${doi}`, signal)
        if (ss) return ss.text
      }
      const lines = [`# ${title}`, "", abstract ? `## Abstract\n\n${abstract}` : "", pdfUrl ? `**PDF:** ${pdfUrl}` : ""]
      return lines.filter(Boolean).join("\n")
    }

    // ── PMLR (ICML, AISTATS, JMLR, CoRL) ──────────────────────────────────────
    if (host.endsWith("mlr.press") || host.endsWith("jmlr.org")) {
      const res = await fetch(url, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
          Accept: "text/html",
        },
      })
      if (!res.ok) return null
      const html = await res.text()
      const titleMatch = html.match(/<meta\s+name="citation_title"\s+content="([^"]+)"/i) ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
      const abstractMatch = html.match(/<div\s+(?:id|class)="(?:abstract|paper-abstract)"[^>]*>([\s\S]*?)<\/div>/i)
      const pdfMatch = html.match(/<meta\s+name="citation_pdf_url"\s+content="([^"]+)"/i)
      const doiMatch = html.match(/<meta\s+name="citation_doi"\s+content="([^"]+)"/i)

      const title = titleMatch?.[1]?.replace(/<[^>]+>/g, "").trim() ?? ""
      const abstract = abstractMatch?.[1]?.replace(/<[^>]+>/g, "").trim() ?? ""
      const pdfUrl = pdfMatch?.[1] ?? ""
      const doi = doiMatch?.[1] ?? extractDOI(url)

      if (!title) return null
      if (doi) {
        const ss = await fetchViaSemanticScholar(`DOI:${doi}`, signal)
        if (ss) {
          const pdfText = pdfUrl ? await extractPdfText(pdfUrl, signal) : null
          return pdfText ? `${ss.text}\n\n## Full Paper\n\n${pdfText}` : ss.text
        }
      }
      const lines = [`# ${title}`, "", abstract ? `## Abstract\n\n${abstract}` : "", pdfUrl ? `**PDF:** ${pdfUrl}` : ""]
      return lines.filter(Boolean).join("\n")
    }

    // ── IEEE Xplore ─────────────────────────────────────────────────────────────
    if (host.endsWith("ieeexplore.ieee.org")) {
      // Extract article number from /document/{id}
      const articleIdMatch = u.pathname.match(/\/document\/(\d+)/)
      if (!articleIdMatch) return null
      const articleId = articleIdMatch[1]

      // IEEE has an internal API used by its frontend
      const ieeeApiUrl = `https://ieeexplore.ieee.org/rest/document/${articleId}`
      const res = await fetch(ieeeApiUrl, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
          Accept: "application/json",
          Referer: url,
        },
      })
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d: any = await res.json()
        const doi = d.doi ?? d.articleNumber
        const lines = [
          `# ${d.title ?? "Untitled"}`,
          `**Authors:** ${(d.authors ?? []).map((a: any) => a.fullName ?? a.lastName).join(", ")}`,
          `**Published:** ${d.publicationDate ?? d.publicationYear ?? ""}`,
          `**Venue:** ${d.publicationTitle ?? ""}`,
          d.doi ? `**DOI:** ${d.doi}` : "",
          "",
          "## Abstract",
          "",
          d.abstract ?? "_Abstract not available — paywalled_",
        ]
        const result = lines.filter(Boolean).join("\n")

        // Try OA via Semantic Scholar or Unpaywall
        if (doi) {
          const ss = await fetchViaSemanticScholar(`DOI:${doi}`, signal)
          if (ss?.oaPdfUrl) {
            const pdfText = await extractPdfText(ss.oaPdfUrl, signal)
            return pdfText ? `${ss.text}\n\n## Full Paper\n\n${pdfText}` : ss.text
          }
          const oaUrl = await findOALocationViaUnpaywall(doi, signal)
          if (oaUrl) {
            const pdfText = await extractPdfText(oaUrl, signal)
            if (pdfText) return `${result}\n\n_[Full text via Unpaywall open-access copy]_\n\n${pdfText}`
            return `${result}\n\n**Open Access PDF:** ${oaUrl}`
          }
          const scihub = await fetchViaSciHub(doi, signal)
          if (scihub) return `${result}\n\n${scihub}`
        }
        return result
      }
      return null
    }

    // ── ACM Digital Library ─────────────────────────────────────────────────────
    if (host.endsWith("dl.acm.org")) {
      const doi = extractDOI(url) ?? extractDOI(u.pathname)
      if (!doi) return null

      // Try Semantic Scholar first (often has abstract + OA PDF)
      const ss = await fetchViaSemanticScholar(`DOI:${doi}`, signal)
      if (ss) {
        if (ss.oaPdfUrl) {
          const pdfText = await extractPdfText(ss.oaPdfUrl, signal)
          if (pdfText) return `${ss.text}\n\n## Full Paper\n\n${pdfText}`
        }
        // Try Unpaywall
        const oaUrl = await findOALocationViaUnpaywall(doi, signal)
        if (oaUrl) {
          const pdfText = await extractPdfText(oaUrl, signal)
          if (pdfText) return `${ss.text}\n\n_[Full text via open-access copy]_\n\n${pdfText}`
          return `${ss.text}\n\n**Open Access PDF:** ${oaUrl}`
        }
        // Sci-Hub fallback
        const scihub = await fetchViaSciHub(doi, signal)
        if (scihub) return `${ss.text}\n\n${scihub}`
        return ss.text
      }
      return null
    }

    // ── Generic DOI-bearing academic URL ───────────────────────────────────────
    const doi = extractDOI(url)
    if (doi) {
      const ss = await fetchViaSemanticScholar(`DOI:${doi}`, signal)
      if (ss) {
        if (ss.oaPdfUrl) {
          const pdfText = await extractPdfText(ss.oaPdfUrl, signal)
          if (pdfText) return `${ss.text}\n\n## Full Paper\n\n${pdfText}`
        }
        const oaUrl = await findOALocationViaUnpaywall(doi, signal)
        if (oaUrl) return `${ss.text}\n\n**Open Access PDF:** ${oaUrl}`
        const scihub = await fetchViaSciHub(doi, signal)
        if (scihub) return `${ss.text}\n\n${scihub}`
        return ss.text
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Medium articles via freedium.cfd — bypasses Medium's metered paywall.
 * Also handles Substack paywalls via archive.ph.
 */
async function fetchPaywallBypass(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, "")

    // Medium — route through freedium.cfd
    if (host === "medium.com" || host.endsWith(".medium.com")) {
      const freediumUrl = `https://freedium.cfd/${url}`
      const res = await fetch(freediumUrl, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
          Accept: "text/html",
        },
      })
      if (!res.ok) return null
      const html = await res.text()
      return convertHTMLToMarkdown(html)
    }

    // Major paywalled news outlets — route through archive.ph
    const PAYWALL_DOMAINS = new Set([
      "nytimes.com", "washingtonpost.com", "bloomberg.com",
      "ft.com", "wsj.com", "theathletic.com", "thetimes.co.uk",
    ])
    if (PAYWALL_DOMAINS.has(host)) {
      // archive.ph/newest/{url} redirects to the most recent snapshot
      const archiveUrl = `https://archive.ph/newest/${url}`
      const res = await fetch(archiveUrl, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
          Accept: "text/html",
        },
        redirect: "follow",
      })
      if (!res.ok) return null
      const html = await res.text()
      const md = convertHTMLToMarkdown(html)
      if (md.length > 200) return `_[Via archive.ph]_\n\n${md}`
    }

    return null
  } catch {
    return null
  }
}

/**
 * Fetch a Substack newsletter post or publication listing via RSS feed.
 * RSS gives full article text for free posts and metadata for paywalled ones.
 */
async function fetchSubstack(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    // Must be a *.substack.com URL or a custom domain that looks like a Substack
    const isSubstack = u.hostname.endsWith(".substack.com")
    if (!isSubstack) return null

    const pub = u.hostname.replace(/\.substack\.com$/, "")
    const feedUrl = `https://${u.hostname}/feed`

    const res = await fetch(feedUrl, {
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
    })
    if (!res.ok) return null
    const xml = await res.text()

    // Check if request is for a specific post
    const isPost = u.pathname.startsWith("/p/")

    const lines: string[] = []

    if (isPost) {
      // Find the specific post by matching the URL slug
      const slug = u.pathname.replace(/^\/p\//, "").replace(/\/$/, "")
      // Extract all <item> blocks
      const itemRe = /<item>([\s\S]*?)<\/item>/gi
      let match: RegExpExecArray | null
      while ((match = itemRe.exec(xml)) !== null) {
        const item = match[1]
        const linkMatch = item.match(/<link>([^<]+)<\/link>/)
        if (!linkMatch || !linkMatch[1].includes(slug)) continue

        const titleMatch = item.match(/<title><!\[CDATA\[([^\]]*)\]\]><\/title>/) ?? item.match(/<title>([^<]+)<\/title>/)
        const authorMatch = item.match(/<dc:creator><!\[CDATA\[([^\]]*)\]\]><\/dc:creator>/) ?? item.match(/<dc:creator>([^<]+)<\/dc:creator>/)
        const dateMatch = item.match(/<pubDate>([^<]+)<\/pubDate>/)
        const contentMatch = item.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/)
        const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)

        const title = titleMatch?.[1] ?? "Untitled"
        const author = authorMatch?.[1] ?? pub
        const date = dateMatch?.[1] ?? ""

        lines.push(`# ${title}`)
        lines.push(`**${pub}.substack.com** · ${author}${date ? " · " + date : ""}`, "")

        const bodyHtml = contentMatch?.[1] ?? descMatch?.[1] ?? ""
        if (bodyHtml) {
          const bodyText = bodyHtml
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n\n")
            .replace(/<\/h[1-6]>/gi, "\n")
            .replace(/<\/li>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&nbsp;/g, " ")
            .trim()
          lines.push(bodyText)
        } else {
          lines.push("_[Paywalled — free preview only. Use /auth to log in and try again.]_")
        }
        break
      }
    } else {
      // Publication listing — show recent posts
      lines.push(`# ${pub}.substack.com`, "")
      const itemRe = /<item>([\s\S]*?)<\/item>/gi
      let match: RegExpExecArray | null
      let count = 0
      while ((match = itemRe.exec(xml)) !== null && count < 20) {
        const item = match[1]
        const titleMatch = item.match(/<title><!\[CDATA\[([^\]]*)\]\]><\/title>/) ?? item.match(/<title>([^<]+)<\/title>/)
        const linkMatch = item.match(/<link>([^<]+)<\/link>/)
        const authorMatch = item.match(/<dc:creator><!\[CDATA\[([^\]]*)\]\]><\/dc:creator>/) ?? item.match(/<dc:creator>([^<]+)<\/dc:creator>/)
        const dateMatch = item.match(/<pubDate>([^<]+)<\/pubDate>/)
        const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)

        const title = titleMatch?.[1] ?? "Untitled"
        const link = linkMatch?.[1] ?? ""
        const author = authorMatch?.[1] ?? ""
        const date = dateMatch?.[1]?.replace(/\s+\d{2}:\d{2}:\d{2}\s+\+\d{4}$/, "") ?? ""
        const desc = descMatch?.[1]
          ?.replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim()
          .slice(0, 160) ?? ""

        lines.push(`## ${title}`)
        if (author || date) lines.push(`${author ? "by " + author : ""}${date ? " · " + date : ""}`)
        if (desc) lines.push(desc)
        if (link) lines.push(`${link}`)
        lines.push("")
        count++
      }
    }

    const result = lines.join("\n").trim()
    return result.length > 100 ? result : null
  } catch {
    return null
  }
}

/**
 * Fetch a dev.to article or user profile via the official DEV Community API.
 * Completely open — no auth required for public content.
 */
async function fetchDevTo(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("dev.to")) return null

    const parts = u.pathname.replace(/^\//, "").replace(/\/$/, "").split("/")
    // /username/article-slug
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const [username, slug] = parts
      const apiUrl = `https://dev.to/api/articles/${username}/${slug}`
      const res = await fetch(apiUrl, { signal, headers: { Accept: "application/json" } })
      if (!res.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const article: any = await res.json()
      const lines = [
        `# ${article.title}`,
        `**dev.to** · ${article.user?.name ?? username} · ${article.readable_publish_date ?? ""}`,
        `${article.tag_list?.map((t: string) => "#" + t).join(" ") ?? ""}`,
        "",
        article.body_markdown ?? article.description ?? "",
      ]
      return lines.join("\n").trim()
    }

    // /username — user profile with recent articles
    if (parts.length === 1 && parts[0]) {
      const username = parts[0]
      const apiUrl = `https://dev.to/api/articles?username=${encodeURIComponent(username)}&per_page=20`
      const res = await fetch(apiUrl, { signal, headers: { Accept: "application/json" } })
      if (!res.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const articles: any[] = await res.json()
      if (!articles.length) return null
      const lines = [`# ${username} on dev.to`, ""]
      for (const a of articles) {
        lines.push(`## ${a.title}`)
        lines.push(`${a.readable_publish_date ?? ""} · ${a.positive_reactions_count ?? 0} reactions · ${a.comments_count ?? 0} comments`)
        if (a.description) lines.push(a.description)
        lines.push(`https://dev.to/${a.slug ?? a.path}`, "")
      }
      return lines.join("\n").trim()
    }

    // Front page / tag listing
    const tag = parts[0]?.startsWith("t/") ? parts[0].slice(2) : null
    const apiUrl = tag
      ? `https://dev.to/api/articles?tag=${encodeURIComponent(tag)}&per_page=20`
      : "https://dev.to/api/articles?per_page=20"
    const res = await fetch(apiUrl, { signal, headers: { Accept: "application/json" } })
    if (!res.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const articles: any[] = await res.json()
    const lines = [tag ? `# dev.to #${tag}` : "# dev.to — Latest Articles", ""]
    for (const a of articles) {
      lines.push(`- **[${a.title}](https://dev.to/${a.slug ?? a.path})** — ${a.user?.name ?? ""} · ${a.positive_reactions_count ?? 0} ❤`)
    }
    return lines.join("\n").trim()
  } catch {
    return null
  }
}

/**
 * Fetch a Lobste.rs story with comments via the JSON API.
 * Lobste.rs is HN-style but focused on tech; the API returns full comment trees.
 */
async function fetchLobsters(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("lobste.rs")) return null

    // Story: /s/{hash}/{slug} or /s/{hash}
    const storyMatch = u.pathname.match(/^\/s\/([a-z0-9]+)/)
    if (storyMatch) {
      const hash = storyMatch[1]
      const apiUrl = `https://lobste.rs/s/${hash}.json`
      const res = await fetch(apiUrl, { signal, headers: { Accept: "application/json" } })
      if (!res.ok) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json()
      const lines = [
        `# ${data.title}`,
        `**lobste.rs** · ${data.score} points · ${data.comment_count} comments · ${data.submitter_user.username}`,
        data.tags?.length ? `Tags: ${data.tags.join(", ")}` : "",
        "",
      ]
      if (data.url) lines.push(`Link: ${data.url}`, "")
      if (data.description_plain) lines.push(data.description_plain, "")

      lines.push("## Comments", "")
      function renderLobsterComments(comments: unknown[], depth = 0): void {
        for (const c of comments as Array<Record<string, unknown>>) {
          if ((c.deleted_at as string | null) || (c.is_deleted as boolean)) continue
          const indent = "  ".repeat(depth)
          lines.push(`${indent}**${c.commenting_user ? (c.commenting_user as Record<string,string>).username : "?"}** (${c.score ?? 0} pts)`)
          const body = String(c.comment_plain ?? c.comment ?? "")
            .trim()
            .split("\n")
          for (const bl of body) lines.push(`${indent}${bl}`)
          lines.push("")
          if (Array.isArray(c.children) && c.children.length > 0) {
            renderLobsterComments(c.children, depth + 1)
          }
        }
      }
      renderLobsterComments(data.comments ?? [])
      return lines.join("\n").trim()
    }

    // Front page / listing
    const apiUrl = "https://lobste.rs/hottest.json"
    const res = await fetch(apiUrl, { signal, headers: { Accept: "application/json" } })
    if (!res.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stories: any[] = await res.json()
    const lines = ["# Lobste.rs — Hottest Stories", ""]
    for (const s of stories.slice(0, 25)) {
      lines.push(`- **[${s.title}](${s.url || "https://lobste.rs" + s.comments_url})** — ${s.score} pts · ${s.comment_count} comments`)
    }
    return lines.join("\n").trim()
  } catch {
    return null
  }
}

/**
 * Fetch an Instagram public profile or post via imginn.com — a public Instagram mirror
 * that renders content server-side without requiring login.
 */
async function fetchInstagram(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("instagram.com")) return null

    // Rewrite instagram.com URL to imginn.com
    const imginnUrl = `https://imginn.com${u.pathname}`
    const res = await fetch(imginnUrl, {
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: "https://imginn.com/",
      },
    })
    if (!res.ok) return null
    const html = await res.text()

    // Extract page title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = titleMatch?.[1]?.replace(/ • Instagram.*$/i, "").trim() ?? ""

    // Extract bio / caption text — imginn puts it in .desc or .caption elements
    const captionMatch = html.match(/<p[^>]+class="[^"]*(?:desc|caption|bio)[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    const caption = captionMatch?.[1]
      ?.replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#039;/g, "'")
      .trim()

    // Extract post items for profile pages
    const postMatches = [...html.matchAll(/<a[^>]+href="(\/p\/[^"]+)"[^>]*>[\s\S]*?<\/a>/gi)]
    const posts = postMatches.slice(0, 12).map((m) => `https://instagram.com${m[1]}`)

    const lines: string[] = []
    if (title) lines.push(`# ${title}`, "")
    if (caption) lines.push(caption, "")
    if (posts.length > 0) {
      lines.push("## Recent Posts", "")
      for (const p of posts) lines.push(`- ${p}`)
    }

    const result = lines.join("\n").trim()
    return result.length > 80 ? result : null
  } catch {
    return null
  }
}

/**
 * Fetch TikTok video metadata and description via ProxiTok instances.
 * ProxiTok is an open-source TikTok frontend that doesn't require login.
 */
async function fetchTikTok(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("tiktok.com")) return null

    const PROXITOK_INSTANCES = [
      "proxitok.pabloferreiro.es",
      "proxitok.privacy.com.de",
      "tok.habedieeh.re",
    ]

    for (const instance of PROXITOK_INSTANCES) {
      try {
        const proxyUrl = `https://${instance}${u.pathname}${u.search}`
        const res = await fetch(proxyUrl, {
          signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        })
        if (!res.ok) continue
        const html = await res.text()

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
        const title = titleMatch?.[1]?.replace(/\s*[-|].*$/, "").trim() ?? ""

        // ProxiTok puts video description in .video-caption or similar
        const descMatch = html.match(/<(?:p|div)[^>]+class="[^"]*(?:caption|description|video-desc)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i)
        const desc = descMatch?.[1]
          ?.replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim()

        const statsMatch = html.match(/(\d[\d,KM.]*)\s*(?:likes?|hearts?)/i)
        const viewsMatch = html.match(/(\d[\d,KM.]*)\s*views?/i)

        const lines: string[] = []
        if (title) lines.push(`# ${title}`, "")
        if (desc) lines.push(desc, "")
        if (statsMatch || viewsMatch) {
          const stats = [
            viewsMatch ? `${viewsMatch[1]} views` : "",
            statsMatch ? `${statsMatch[1]} likes` : "",
          ].filter(Boolean)
          lines.push(stats.join(" · "))
        }
        lines.push(`_[Via ProxiTok — ${instance}]_`)

        const result = lines.join("\n").trim()
        if (result.length > 60) return result
      } catch { /* try next instance */ }
    }
    return null
  } catch {
    return null
  }
}

/** Fetch a Wikipedia article as clean text via the Extracts API — no navboxes, refs, or edit links */
async function fetchWikipediaArticle(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith("wikipedia.org")) return null

    // Extract article title from path like /wiki/LeBron_James
    const titleMatch = u.pathname.match(/^\/wiki\/(.+)$/)
    if (!titleMatch) return null
    const title = decodeURIComponent(titleMatch[1])

    // Wikipedia Extracts API returns clean article HTML (no infoboxes, navboxes, references)
    const apiUrl = `https://${u.hostname}/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&format=json&formatversion=2&redirects=1`
    const res = await fetch(apiUrl, { signal, headers: { "User-Agent": "OpenSurfer/1.0" } })
    if (!res.ok) return null

    const data = await res.json() as { query?: { pages?: Array<{ extract?: string; title?: string }> } }
    const extract = data?.query?.pages?.[0]?.extract
    if (!extract) return null

    // Convert the clean Wikipedia HTML to markdown
    const td = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" })
    td.remove(["script", "style", "meta", "link"])
    return td.turndown(extract)
  } catch {
    return null
  }
}

/** Return a page of content with navigation hints if the full content is longer */
function paginate(content: string, page: number, url: string): string {
  const totalPages = Math.ceil(content.length / PAGE_SIZE)
  if (totalPages <= 1) return content

  const start = page * PAGE_SIZE
  const end = Math.min(start + PAGE_SIZE, content.length)
  const chunk = content.slice(start, end)

  const header = `[Page ${page + 1} of ${totalPages} — ${content.length.toLocaleString()} chars total]\n\n`
  const footer =
    end < content.length
      ? `\n\n---\n[End of page ${page + 1}. Call webfetch with page=${page + 1} to read the next page.]`
      : `\n\n---\n[End of content — page ${page + 1} of ${totalPages}]`

  return header + chunk + footer
}

/**
 * Read ~/.config/opensurfer/cookies.txt (Netscape format) and return a Cookie
 * header value for the given hostname. Returns "" if the file doesn't exist or
 * has no matching cookies.
 *
 * Users export this file from their browser using any "cookies.txt" extension
 * (e.g. https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/).
 * yt-dlp users can also run: yt-dlp --cookies-from-browser chrome --cookies ~/.config/opensurfer/cookies.txt
 *
 * Netscape format per line (tab-separated):
 *   domain  includeSubdomains  path  secure  expiry  name  value
 */
async function readCookiesForHost(hostname: string): Promise<string> {
  try {
    const cookiesPath = path.join(Global.Path.config, "cookies.txt")
    const text = await Bun.file(cookiesPath).text()
    const host = hostname.replace(/^www\./, "")
    const cookies: string[] = []
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue
      const parts = line.split("\t")
      if (parts.length < 7) continue
      const [domain, , , , expiryStr, name, value] = parts
      const cookieDomain = domain.replace(/^\./, "")
      // Match exact domain or subdomain
      if (host !== cookieDomain && !host.endsWith(`.${cookieDomain}`)) continue
      // Skip expired cookies (0 = session cookie, keep those)
      const expiry = parseInt(expiryStr)
      if (expiry && expiry < Date.now() / 1000) continue
      cookies.push(`${name}=${value}`)
    }
    return cookies.join("; ")
  } catch {
    return ""
  }
}

export const WebFetchTool = Tool.define("webfetch", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().describe("The URL to fetch content from"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe("The format to return the content in (text, markdown, or html). Defaults to markdown."),
    timeout: z.number().describe("Optional timeout in seconds (max 120)").optional(),
    page: z.number().int().min(0).default(0).describe("Page number for long content (0-indexed). Each page is 30,000 chars. Check the header of any response to see total pages."),
  }),
  async execute(params, ctx) {
    // Validate URL
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    await ctx.ask({
      permission: "webfetch",
      patterns: [params.url],
      always: ["*"],
      metadata: {
        url: params.url,
        format: params.format,
        timeout: params.timeout,
      },
    })

    const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

    const { signal, clearTimeout } = abortAfterAny(timeout, ctx.abort)

    // Reddit: use old.reddit.com plain HTML — works without auth, no JS required
    if (/reddit\.com/i.test(params.url)) {
      const reddit = await fetchReddit(params.url, signal)
      if (reddit) {
        clearTimeout()
        return { output: paginate(reddit, params.page ?? 0, params.url), title: params.url, metadata: { type: "reddit" } }
      }
      // Fall through if old.reddit.com fails (e.g. age-gated or private sub)
    }

    // X.com / Twitter: route through nitter — no auth required, plain HTML
    if (/(?:twitter|x)\.com/i.test(params.url)) {
      const nitter = await fetchFromNitter(params.url, signal)
      if (nitter) {
        clearTimeout()
        return { output: paginate(nitter, params.page ?? 0, params.url), title: params.url, metadata: { type: "twitter-nitter" } }
      }
      // Fall through to general fetch if all nitter instances are down
    }

    // Hacker News: use official Firebase API + Algolia for comments
    if (/ycombinator\.com/i.test(params.url)) {
      const hn = await fetchHackerNews(params.url, signal)
      if (hn) {
        clearTimeout()
        return { output: paginate(hn, params.page ?? 0, params.url), title: params.url, metadata: { type: "hackernews" } }
      }
    }

    // GitHub: use REST API for repos, files, issues, PRs, profiles
    if (/github\.com/i.test(params.url)) {
      const gh = await fetchGitHub(params.url, signal)
      if (gh) {
        clearTimeout()
        return { output: paginate(gh, params.page ?? 0, params.url), title: params.url, metadata: { type: "github" } }
      }
      // Fall through for pages the API doesn't cover (releases, actions, etc.)
    }

    // HuggingFace: use Hub API for models, datasets, spaces, papers, profiles
    if (/huggingface\.co/i.test(params.url)) {
      const hf = await fetchHuggingFace(params.url, signal)
      if (hf) {
        clearTimeout()
        return { output: paginate(hf, params.page ?? 0, params.url), title: params.url, metadata: { type: "huggingface" } }
      }
      // Fall through for pages not covered by the API (e.g. docs, forums)
    }

    // Stack Overflow / Stack Exchange: use public API for Q&A
    if (/(?:stackoverflow|stackexchange|serverfault|superuser)\.com/i.test(params.url)) {
      const se = await fetchStackExchange(params.url, signal)
      if (se) {
        clearTimeout()
        return { output: paginate(se, params.page ?? 0, params.url), title: params.url, metadata: { type: "stackexchange" } }
      }
    }

    // arXiv: use official API for clean paper metadata and abstract
    if (/arxiv\.org/i.test(params.url)) {
      const arxiv = await fetchArxiv(params.url, signal)
      if (arxiv) {
        clearTimeout()
        return { output: paginate(arxiv, params.page ?? 0, params.url), title: params.url, metadata: { type: "arxiv" } }
      }
    }

    // Academic papers: OpenReview, ACL Anthology, CVPR/CVF, NeurIPS, PMLR, IEEE, ACM + Sci-Hub fallback
    if (/openreview\.net|aclanthology\.org|thecvf\.com|neurips\.cc|nips\.cc|mlr\.press|jmlr\.org|ieeexplore\.ieee\.org|dl\.acm\.org/i.test(params.url)) {
      const paper = await fetchAcademicPaper(params.url, signal)
      if (paper) {
        clearTimeout()
        return { output: paginate(paper, params.page ?? 0, params.url), title: params.url, metadata: { type: "academic-paper" } }
      }
    }

    // Substack: fetch via RSS feed — works without JS or auth for free posts
    if (/\.substack\.com/i.test(params.url)) {
      const sub = await fetchSubstack(params.url, signal)
      if (sub) {
        clearTimeout()
        return { output: paginate(sub, params.page ?? 0, params.url), title: params.url, metadata: { type: "substack" } }
      }
    }

    // dev.to: fetch via official DEV Community API — no auth required
    if (/\bdev\.to\b/i.test(params.url)) {
      const devto = await fetchDevTo(params.url, signal)
      if (devto) {
        clearTimeout()
        return { output: paginate(devto, params.page ?? 0, params.url), title: params.url, metadata: { type: "devto" } }
      }
    }

    // Lobste.rs: fetch via JSON API — full story + comment tree
    if (/\blobste\.rs\b/i.test(params.url)) {
      const lobsters = await fetchLobsters(params.url, signal)
      if (lobsters) {
        clearTimeout()
        return { output: paginate(lobsters, params.page ?? 0, params.url), title: params.url, metadata: { type: "lobsters" } }
      }
    }

    // Instagram: route through imginn.com — public profiles/posts without login
    if (/instagram\.com/i.test(params.url)) {
      const ig = await fetchInstagram(params.url, signal)
      if (ig) {
        clearTimeout()
        return { output: paginate(ig, params.page ?? 0, params.url), title: params.url, metadata: { type: "instagram" } }
      }
      // Fall through — imginn may not have the content
    }

    // TikTok: route through ProxiTok instances — video descriptions without login
    if (/tiktok\.com/i.test(params.url)) {
      const tt = await fetchTikTok(params.url, signal)
      if (tt) {
        clearTimeout()
        return { output: paginate(tt, params.page ?? 0, params.url), title: params.url, metadata: { type: "tiktok" } }
      }
    }

    // Paywalled sites: Medium via freedium.cfd, major news via archive.ph
    if (/medium\.com|nytimes\.com|washingtonpost\.com|bloomberg\.com|ft\.com|wsj\.com|theathletic\.com|thetimes\.co\.uk/i.test(params.url)) {
      const bypassed = await fetchPaywallBypass(params.url, signal)
      if (bypassed) {
        clearTimeout()
        return { output: paginate(bypassed, params.page ?? 0, params.url), title: params.url, metadata: { type: "paywall-bypass" } }
      }
      // Fall through — maybe the user isn't behind the paywall yet
    }

    // Video URLs: extract transcript via yt-dlp (supports YouTube, Vimeo, Twitter/X, etc.)
    // yt-dlp handles auth/cookies internally and works reliably where direct API calls fail.
    if (youtubeVideoId(params.url) || /\/(watch|shorts|clip|v)\b/.test(params.url)) {
      const transcript = await fetchTranscriptWithYtdlp(params.url, signal)
      clearTimeout()
      if (transcript) {
        return {
          output: paginate(transcript, params.page ?? 0, params.url),
          title: params.url,
          metadata: { type: "video-transcript" },
        }
      }
      // Fall through to regular fetch if yt-dlp is not installed or transcript unavailable
    }

    // Build Accept header based on requested format with q parameters for fallbacks
    let acceptHeader = "*/*"
    switch (params.format) {
      case "markdown":
        acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
        break
      case "text":
        acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        break
      case "html":
        acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
        break
      default:
        acceptHeader =
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    }
    // Inject cookies from ~/.config/opensurfer/cookies.txt if available
    const cookieHeader = await readCookiesForHost(new URL(params.url).hostname)
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept: acceptHeader,
      "Accept-Language": "en-US,en;q=0.9",
    }
    if (cookieHeader) headers["Cookie"] = cookieHeader

    const response = await iife(async () => {
      try {
        const initial = await fetch(params.url, { signal, headers })

        // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
        return initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
          ? await fetch(params.url, { signal, headers: { ...headers, "User-Agent": "opencode" } })
          : initial
      } finally {
        clearTimeout()
      }
    })

    if (!response.ok) {
      throw new Error(`Request failed with status code: ${response.status}`)
    }

    // Check content length
    const contentLength = response.headers.get("content-length")
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)")
    }

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)")
    }

    const contentType = response.headers.get("content-type") || ""
    const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
    const title = `${params.url} (${contentType})`

    // Check if response is an image
    const isImage = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"

    if (isImage) {
      const base64Content = Buffer.from(arrayBuffer).toString("base64")
      return {
        title,
        output: "Image fetched successfully",
        metadata: { type: "image" },
        attachments: [
          {
            type: "file",
            mime,
            url: `data:${mime};base64,${base64Content}`,
          },
        ],
      }
    }

    const content = new TextDecoder().decode(arrayBuffer)
    const page = params.page ?? 0

    // Handle content based on requested format and actual content type
    switch (params.format) {
      case "markdown":
        if (contentType.includes("text/html")) {
          // For Wikipedia, use the Extracts API — much cleaner and more compact
          const wikiContent = await fetchWikipediaArticle(params.url, signal)
          if (wikiContent) {
            return { output: paginate(wikiContent, page, params.url), title, metadata: { type: "fetch" } }
          }

          const markdown = convertHTMLToMarkdown(content)

          // Detect JS-wall (page renders nothing without JavaScript)
          if (isJsWall(content, markdown)) {
            // Tier 1: extract SSR-embedded data (Next.js, Nuxt, JSON-LD) — local, no deps
            const ssr = extractSsrContent(content)
            if (ssr && ssr.length > 100) {
              return { output: paginate(ssr, page, params.url), title, metadata: { type: "fetch" } }
            }

            // Tier 2: Jina Reader — opt-in via OPENSURFER_JINA_FALLBACK=1
            const jina = await fetchWithJina(params.url, signal)
            if (jina && jina.length > 100) {
              return { output: paginate(jina, page, params.url), title, metadata: { type: "fetch" } }
            }

            // Tier 3: Wayback Machine — public archive snapshot
            const wayback = await fetchFromWayback(params.url, signal)
            if (wayback && wayback.length > 100) {
              return { output: paginate(`_[Archived snapshot via Wayback Machine]_\n\n${wayback}`, page, params.url), title, metadata: { type: "fetch" } }
            }

            // All fallbacks failed — return a clear error
            return {
              output: `This page requires JavaScript to render its content and no cached/alternative version was available.\n\nTo enable Jina Reader fallback (which renders JS server-side), set the environment variable:\n  OPENSURFER_JINA_FALLBACK=1`,
              title,
              metadata: { type: "fetch" },
            }
          }

          return { output: paginate(markdown, page, params.url), title, metadata: { type: "fetch" } }
        }
        return { output: paginate(content, page, params.url), title, metadata: { type: "fetch" } }

      case "text":
        if (contentType.includes("text/html")) {
          const text = await extractTextFromHTML(content)
          return { output: paginate(text, page, params.url), title, metadata: { type: "fetch" } }
        }
        return { output: paginate(content, page, params.url), title, metadata: { type: "fetch" } }

      case "html":
        return {
          output: content,
          title,
          metadata: { type: "fetch" },
        }

      default:
        return {
          output: content,
          title,
          metadata: { type: "fetch" },
        }
    }
  },
})

async function extractTextFromHTML(html: string) {
  let text = ""
  let skipContent = false

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true
      },
      text() {
        // Skip text content inside these elements
      },
    })
    .on("*", {
      element(element) {
        // Reset skip flag when entering other elements
        if (!["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)) {
          skipContent = false
        }
      },
      text(input) {
        if (!skipContent) {
          text += input.text
        }
      },
    })
    .transform(new Response(html))

  await rewriter.text()
  return text.trim()
}

/**
 * Lightweight readability extraction — finds the main content block without a DOM.
 * Strategy mirrors Firefox Reader Mode: strip noise, score candidate blocks by text
 * density, reward semantic tags and common CMS class names.
 */
function extractMainContent(html: string): string {
  // 1. Strip definite noise at the top level
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")

  // 2. Try semantic / well-known content containers in priority order
  const CONTENT_PATTERNS: RegExp[] = [
    // HTML5 semantic
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    // ARIA landmark
    /<[a-z\d]+[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[a-z\d]+>/i,
    // Common CMS / news site class names
    /<[a-z\d]+[^>]+class="[^"]*(?:post-content|entry-content|article-content|article-body|story-body|page-content|main-content|content-body|body-content|editorial|prose)[^"]*"[^>]*>([\s\S]*?)<\/[a-z\d]+>/i,
    // Common CMS id names
    /<[a-z\d]+[^>]+id="(?:content|main-content|article|post|story|entry|page-content|primary)[^"]*"[^>]*>([\s\S]*?)<\/[a-z\d]+>/i,
    // Fallback: largest div with substantial text
  ]

  for (const pat of CONTENT_PATTERNS) {
    const m = h.match(pat)
    if (m?.[1] && stripTags(m[1]).length > 200) {
      h = m[1]
      break
    }
  }

  // If no semantic container found, fall back to <body> with noise stripped
  const bodyMatch = h.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) h = bodyMatch[1]

  // 3. Strip remaining noise blocks within the selected content
  const NOISE_TAGS = ["nav", "header", "footer", "aside", "figure", "figcaption"]
  for (const tag of NOISE_TAGS) {
    h = h.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, "gi"), "")
  }

  // Strip elements with class/id names associated with ads, cookies, modals, share widgets
  const NOISE_CLASS = /(?:ad|advertisement|banner|cookie|popup|modal|overlay|sidebar|widget|share-bar|social|related|comment|promo|newsletter|subscribe)/i
  h = h.replace(/<[a-z\d]+[^>]+(?:class|id)="[^"]*"[^>]*>([\s\S]*?)<\/[a-z\d]+>/gi, (match, inner) => {
    const classId = match.match(/(?:class|id)="([^"]*)"/)?.[1] ?? ""
    return NOISE_CLASS.test(classId) && stripTags(inner).length < 500 ? "" : match
  })

  return h
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
}

/** Detect pages that require JavaScript to render meaningful content */
function isJsWall(html: string, strippedText: string): boolean {
  if (html.length < 2000) return false // tiny response, not a JS wall
  if (strippedText.length > 400) return false // enough text content — not walled
  return /javascript\s+(is\s+)?(required|must be enabled|not enabled|needs to be enabled)|enable\s+javascript|requires?\s+javascript|please\s+enable\s+js|noscript/i.test(html)
}

/**
 * Extract structured content embedded by SSR frameworks before JS hydration.
 * Handles Next.js (__NEXT_DATA__), Nuxt (__NUXT__), and JSON-LD (application/ld+json).
 * Returns markdown-formatted text or null if nothing useful found.
 */
function extractSsrContent(html: string): string | null {
  const chunks: string[] = []

  // Next.js: window.__NEXT_DATA__ = {...}  or  <script id="__NEXT_DATA__" type="application/json">
  const nextMatch =
    html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i) ??
    html.match(/window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>)/)
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1])
      const props = data?.props?.pageProps
      // Extract common text fields — title, description, body, content, text, article
      const text = [
        props?.title, props?.description, props?.body, props?.content,
        props?.text, props?.article?.body, props?.article?.description,
        props?.post?.content, props?.post?.title,
      ].filter(Boolean).join("\n\n")
      if (text.length > 100) chunks.push(text)
    } catch { /* ignore malformed JSON */ }
  }

  // Nuxt: window.__NUXT__ = {...}
  const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>)/)
  if (nuxtMatch) {
    try {
      const data = JSON.parse(nuxtMatch[1])
      // Nuxt stores page data in state
      const state = data?.state ?? data?.data
      const text = JSON.stringify(state ?? data).replace(/["{}[\]]/g, " ").replace(/,\s*/g, " ").slice(0, 2000)
      if (text.length > 100) chunks.push(text)
    } catch { /* ignore */ }
  }

  // JSON-LD: <script type="application/ld+json">
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let ldMatch: RegExpExecArray | null
  while ((ldMatch = ldRe.exec(html)) !== null) {
    try {
      const ld = JSON.parse(ldMatch[1])
      const items = Array.isArray(ld) ? ld : [ld]
      for (const item of items) {
        const parts = [
          item?.headline ?? item?.name,
          item?.description,
          item?.articleBody,
          item?.text,
        ].filter((s) => typeof s === "string" && s.length > 20)
        if (parts.length) chunks.push(parts.join("\n\n"))
      }
    } catch { /* ignore */ }
  }

  if (!chunks.length) return null
  return chunks.join("\n\n---\n\n").trim()
}

/**
 * Fetch a URL via Jina Reader (r.jina.ai) — handles JS rendering server-side.
 * Opt-in only: requires OPENSURFER_JINA_FALLBACK=1 env var to respect privacy preferences.
 */
async function fetchWithJina(url: string, signal: AbortSignal): Promise<string | null> {
  if (!process.env.OPENSURFER_JINA_FALLBACK) return null
  try {
    const jinaUrl = `https://r.jina.ai/${url}`
    const res = await fetch(jinaUrl, {
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/plain, text/markdown, */*",
      },
    })
    if (!res.ok) return null
    const text = await res.text()
    return text.trim() || null
  } catch {
    return null
  }
}

/**
 * Fetch the most recent Wayback Machine snapshot for a URL.
 * Returns the snapshot content as markdown, or null if unavailable.
 */
async function fetchFromWayback(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const availUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`
    const availRes = await fetch(availUrl, { signal })
    if (!availRes.ok) return null
    const avail = await availRes.json() as { archived_snapshots?: { closest?: { url?: string; available?: boolean } } }
    const snapshotUrl = avail?.archived_snapshots?.closest?.url
    if (!snapshotUrl || !avail?.archived_snapshots?.closest?.available) return null

    const snapRes = await fetch(snapshotUrl, {
      signal,
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" },
    })
    if (!snapRes.ok) return null
    const html = await snapRes.text()
    return convertHTMLToMarkdown(html)
  } catch {
    return null
  }
}

function convertHTMLToMarkdown(html: string): string {
  const main = extractMainContent(html)
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link", "img", "figure", "video", "audio"])
  const md = turndownService.turndown(main)
  // TurndownService leaves multiple consecutive blank lines between block elements — collapse them
  return md.replace(/\n{3,}/g, "\n\n").trim()
}
