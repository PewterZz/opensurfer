import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./websearch.txt"
import { abortAfterAny } from "../util/abort"

const DEFAULT_NUM_RESULTS = 8

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"

/**
 * Detect the best available HTTP client in priority order:
 *   1. curl-impersonate — exact Firefox TLS fingerprint (best)
 *   2. curl            — different fingerprint than Bun's BoringSSL (good)
 *   3. null            — fall back to Bun fetch (worst for bot detection)
 */
let curlBin: string | null | undefined = undefined // undefined = not yet detected

async function detectCurlBin(): Promise<string | null> {
  if (curlBin !== undefined) return curlBin
  for (const bin of ["curl-impersonate-ff", "curl-impersonate", "curl"]) {
    try {
      const p = Bun.spawn([bin, "--version"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
      await p.exited
      if (p.exitCode === 0) { curlBin = bin; return bin }
    } catch { /* try next */ }
  }
  curlBin = null
  return null
}

/**
 * HTTP GET/POST via curl (or curl-impersonate).
 * Uses a per-domain cookie jar file so cookies persist across calls automatically.
 * Falls back to Bun fetch if curl is unavailable.
 */
async function httpFetch(
  url: string,
  opts: {
    headers?: Record<string, string>
    method?: "GET" | "POST"
    body?: string
    contentType?: string
    cookieJar?: string
    signal?: AbortSignal  // fix 1: accept signal so callers can cancel the subprocess
  } = {},
): Promise<string> {
  const bin = await detectCurlBin()

  if (bin) {
    // -f: exit non-zero on HTTP 4xx/5xx (fix 2: detect bot-challenge pages/rate-limits)
    const args = [bin, "-sS", "-f", "-L", "--max-time", "20", "--compressed"]
    if (opts.cookieJar) args.push("-b", opts.cookieJar, "-c", opts.cookieJar)
    const headers = {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      DNT: "1",
      "Upgrade-Insecure-Requests": "1",
      ...opts.headers,
    }
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`)
    if (opts.method === "POST" && opts.body) {
      args.push("-X", "POST", "--data-raw", opts.body)
      if (opts.contentType) args.push("-H", `Content-Type: ${opts.contentType}`)
    }
    args.push(url)
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore", stdin: "ignore" })

    // fix 1: kill the curl subprocess if the caller's AbortSignal fires
    const onAbort = () => { try { proc.kill() } catch { /* already exited */ } }
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    const output = await new Response(proc.stdout).text()
    await proc.exited
    opts.signal?.removeEventListener("abort", onAbort)

    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError")
    if (proc.exitCode !== 0) throw new Error(`curl exited ${proc.exitCode}`)
    return output
  }

  // Fallback: Bun fetch (different TLS fingerprint — may trigger bot detection)
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    signal: opts.signal,
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Cache-Control": "max-age=0",
      DNT: "1",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": opts.method === "POST" ? "same-origin" : "none",
      "Sec-Fetch-User": "?1",
      ...(opts.contentType ? { "Content-Type": opts.contentType } : {}),
      ...opts.headers,
    },
    body: opts.body,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** Normalise a URL for deduplication — strips tracking params, trailing slashes, fragments */
function normaliseUrl(url: string): string {
  try {
    const u = new URL(url)
    // Remove common tracking/referral query params
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "source", "fbclid", "gclid"]) {
      u.searchParams.delete(k)
    }
    u.hash = ""
    return u.origin + u.pathname.replace(/\/$/, "") + (u.search === "?" ? "" : u.search)
  } catch {
    return url
  }
}

/** Decode a Bing redirect URL (u=a1BASE64 param), trying base64url then standard base64 */
function decodeBingUrl(href: string): string {
  if (!href.includes("bing.com/ck/a") && !href.includes("/ck/a?")) return href
  try {
    const u = new URL(href.startsWith("/") ? `https://www.bing.com${href}` : href)
    const uParam = u.searchParams.get("u") ?? ""
    if (!uParam.startsWith("a1")) return href
    const b64 = uParam.slice(2)
    // Try base64url first, then fall back to standard base64
    for (const enc of ["base64url", "base64"] as const) {
      try {
        const decoded = Buffer.from(b64, enc).toString("utf8")
        if (decoded.startsWith("http")) return decoded
      } catch { /* next */ }
    }
  } catch { /* keep original */ }
  return href
}

interface SearchResult {
  title: string
  url: string
  snippet: string
  engine?: string
}

// Scrape Bing HTML results (independent index, real parseable HTML)
async function searchBing(
  query: string,
  numResults: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  // httpFetch uses curl/curl-impersonate to avoid TLS fingerprint detection.
  // Use a per-request unique jar path (fix 3: prevents concurrent searches racing on the same file).
  const jar = `/tmp/opensurfer_bing_${Date.now()}_${Math.random().toString(36).slice(2)}.jar`
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${numResults}&mkt=en-US&setlang=en-US&cc=US`
  let html: string
  try {
    html = await httpFetch(url, {
      headers: { Referer: "https://www.bing.com/" },
      cookieJar: jar,
      signal,
    })
  } finally {
    Bun.spawn(["rm", "-f", jar], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  }

  const results: SearchResult[] = []
  const seen = new Set<string>()

  // Split on each b_algo result block — avoids nested </li> truncation bug.
  // Use a regex split to handle multi-class attributes like class="b_algo b_something".
  const chunks = html.split(/class="[^"]*\bb_algo\b[^"]*"/)
  // chunk[0] is everything before the first result; skip it
  for (let i = 1; i < chunks.length && results.length < numResults; i++) {
    const chunk = chunks[i]

    // Find the first <h2><a href="..."> — the result title+link
    const linkMatch = chunk.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!linkMatch) continue

    let href = decodeBingUrl(linkMatch[1].replace(/&amp;/g, "&"))

    // Skip Bing-internal / navigation URLs and non-HTTP
    if (!href.startsWith("http")) continue
    try {
      const host = new URL(href).hostname
      if (host.includes("bing.") || host.includes("microsoft.")) continue
    } catch { continue }

    const key = normaliseUrl(href)
    if (seen.has(key)) continue
    seen.add(key)

    const title = linkMatch[2].replace(/<[^>]+>/g, "").trim()
    if (!title) continue

    // Grab first substantial <p> text as the snippet
    const snippetMatch = chunk.match(/<p[^>]*>([\s\S]{15,400}?)<\/p>/)
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : ""

    results.push({ title, url: href, snippet, engine: "bing" })
  }

  return results
}

// Scrape DuckDuckGo HTML results (zero-config fallback)
async function searchDuckDuckGo(
  query: string,
  numResults: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  // DDG HTML is designed for non-JS access; POST like the real form does.
  // httpFetch handles cookie jar and TLS fingerprint bypass via curl.
  // Per-request unique jar (fix 3: prevents concurrent searches racing on the same file).
  const jar = `/tmp/opensurfer_ddg_${Date.now()}_${Math.random().toString(36).slice(2)}.jar`
  const body = new URLSearchParams({ q: query, kl: "us-en", b: "", df: "" })
  let html: string
  try {
    html = await httpFetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      body: body.toString(),
      contentType: "application/x-www-form-urlencoded",
      headers: {
        Origin: "https://html.duckduckgo.com",
        Referer: "https://html.duckduckgo.com/",
      },
      cookieJar: jar,
      signal,
    })
  } finally {
    Bun.spawn(["rm", "-f", jar], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  }

  const results: SearchResult[] = []
  const seen = new Set<string>()

  // Split on DDG result containers — keeps link + snippet together, preventing index mis-alignment
  const chunks = html.split(/class="[^"]*\bresult\b[^"]*\bresults_links\b[^"]*"/)

  for (let i = 1; i < chunks.length && results.length < numResults; i++) {
    const chunk = chunks[i]

    // Extract the result__a link
    const linkMatch = chunk.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!linkMatch) continue

    let href = linkMatch[1]
    // Decode DDG redirect URLs (/l/?uddg=ENCODED or //duckduckgo.com/l/?uddg=ENCODED)
    try {
      if (href.includes("duckduckgo.com/l/") || href.startsWith("/l/") || href.startsWith("//")) {
        const full = href.startsWith("//") ? "https:" + href : href.startsWith("/") ? "https://duckduckgo.com" + href : href
        const uddg = new URL(full).searchParams.get("uddg")
        if (uddg) href = decodeURIComponent(uddg)
      }
    } catch { /* keep original */ }

    if (!href.startsWith("http")) continue
    const key = normaliseUrl(href)
    if (seen.has(key)) continue
    seen.add(key)

    const title = linkMatch[2].replace(/<[^>]+>/g, "").trim()
    if (!title) continue

    // Extract snippet from the same block
    const snippetMatch = chunk.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/)
      ?? chunk.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : ""

    results.push({ title, url: href, snippet, engine: "ddg" })
  }

  return results
}

// Search using SearXNG JSON API
async function searchSearXNG(
  instanceUrl: string,
  query: string,
  numResults: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL(`${instanceUrl}/search`)
  url.searchParams.set("q", query)
  url.searchParams.set("format", "json")
  url.searchParams.set("categories", "general")
  url.searchParams.set("language", "auto")

  const response = await fetch(url.toString(), {
    signal,
    headers: {
      Accept: "application/json",
      "User-Agent": "OpenSurfer/1.0 (https://github.com/PewterZz/opensurfer)",
    },
  })

  if (!response.ok) throw new Error(`SearXNG returned ${response.status}`)

  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string; engine?: string }> }
  if (!Array.isArray(data.results)) throw new Error("SearXNG response has no results array")

  return data.results.slice(0, numResults).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
    engine: r.engine,
  }))
}


// Known noise domains that appear when engines have no real results
const NOISE_DOMAINS = new Set([
  // Shopping
  "amazon.com", "amazon.co.uk", "amazon.de", "amazon.co.jp",
  "walmart.com", "target.com", "bestbuy.com", "ebay.com",
  "kitchenaid.com", "kitchenaidhq.com",
  // Microsoft self-referential
  "learn.microsoft.com", "support.microsoft.com", "answers.microsoft.com",
  // Bing quiz SEO spam farms
  "bingehomepagequiz.com", "binghomepagequiz.com", "binghomepagequiz.us",
  "bingentertainmentquiz.com", "bingquiz.org", "bingnewsquizz.com",
  "culturequizz.com", "bing-quiz.com", "bingdailyquiz.com",
  // Non-English platforms that Bing injects despite mkt=en-US
  "zhihu.com",           // Chinese Q&A
  "baidu.com",           // Chinese search
  "weibo.com",           // Chinese social
  "tieba.baidu.com",     // Chinese forums
  "bilibili.com",        // Chinese video (as a search result; yt-dlp handles video fetching)
  "douban.com",          // Chinese reviews
  "qq.com", "163.com", "sohu.com", "sina.com.cn",
  "naver.com",           // Korean portal
  "vk.com",              // Russian social
])

/**
 * Drop results from noise/non-English domains and cap any single domain
 * at MAX_PER_DOMAIN results — prevents one site (e.g. zhihu.com) from
 * filling half the result list with different article paths.
 */
const MAX_PER_DOMAIN = 2

function filterRelevantResults(results: SearchResult[], _query: string): SearchResult[] {
  const domainCount = new Map<string, number>()
  return results.filter((r) => {
    try {
      const host = new URL(r.url).hostname.replace(/^www\./, "")
      if (NOISE_DOMAINS.has(host)) return false
      const count = domainCount.get(host) ?? 0
      if (count >= MAX_PER_DOMAIN) return false
      domainCount.set(host, count + 1)
    } catch { /* invalid URL — keep */ }
    return true
  })
}

function formatResults(results: SearchResult[], query: string): string {
  const relevant = filterRelevantResults(results, query)

  if (relevant.length === 0) {
    return `No results found for: **${query}**\n\nThis topic may not have a significant public web presence, or the name may be misspelled.`
  }

  const lines = [`Search results for: **${query}**`, ""]

  for (let i = 0; i < relevant.length; i++) {
    const r = relevant[i]
    lines.push(`${i + 1}. **${r.title}**`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
    lines.push("")
  }

  return lines.join("\n")
}

function metadataUrls(results: SearchResult[], query: string) {
  return filterRelevantResults(results, query).map((r) => ({ title: r.title, url: r.url }))
}

const Parameters = z.object({
  query: z.string().describe("Search query"),
  numResults: z.number().optional().describe(`Number of search results to return (default: ${DEFAULT_NUM_RESULTS})`),
})

export const WebSearchTool = Tool.define("websearch", async () => {
  return {
    get description() {
      return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
    },
    parameters: Parameters,
    async execute(params, ctx) {
      await ctx.ask({
        permission: "websearch",
        patterns: [params.query],
        always: ["*"],
        metadata: { query: params.query, numResults: params.numResults },
      })

      const numResults = params.numResults ?? DEFAULT_NUM_RESULTS
      const { signal, clearTimeout } = abortAfterAny(25000, ctx.abort)

      const broadcast = (instance: string) =>
        ctx.metadata({ metadata: { currentInstance: instance, query: params.query } })

      try {
        // 1. Try user-configured SearXNG instance (best quality)
        const configuredUrl = process.env["OPENSURFER_SEARCH_URL"] || process.env["OPENSURFER_SEARCH_URL"]
        if (configuredUrl) {
          try {
            broadcast(configuredUrl.replace(/\/$/, ""))
            const results = await searchSearXNG(configuredUrl.replace(/\/$/, ""), params.query, numResults, signal)
            clearTimeout()
            return {
              output: formatResults(results, params.query),
              title: `Search: ${params.query}`,
              metadata: { source: "searxng", instance: configuredUrl, urls: metadataUrls(results, params.query) },
            }
          } catch (err) {
            // Fall through to public instances
          }
        }

        // 2. Bing + DuckDuckGo in parallel (two independent indexes)
        // Request extra results from each engine to account for deduplication loss
        const fetchCount = Math.ceil(numResults * 1.5)
        broadcast("bing.com + duckduckgo.com")
        const [bingRes, ddgRes] = await Promise.allSettled([
          searchBing(params.query, fetchCount, signal).then(async (r) => {
            // If Bing returned suspiciously few results, retry once with a fresh session
            if (r.length < 2) return searchBing(params.query, fetchCount, signal)
            return r
          }),
          searchDuckDuckGo(params.query, fetchCount, signal),
        ])

        // If the abort signal fired, both engines will have rejected — surface that
        // as a timeout error rather than silently returning "no results found"
        if (signal.aborted) throw new DOMException("Aborted", "AbortError")

        // Merge: Bing first, then DDG — deduplicate by normalised URL
        const seenKeys = new Set<string>()
        const merged: SearchResult[] = []
        const addResults = (list: SearchResult[]) => {
          for (const r of list) {
            if (!r.url.startsWith("http")) continue
            const key = normaliseUrl(r.url)
            if (!seenKeys.has(key)) {
              seenKeys.add(key)
              merged.push(r)
            }
          }
        }
        if (bingRes.status === "fulfilled") addResults(bingRes.value)
        if (ddgRes.status === "fulfilled") addResults(ddgRes.value)

        const results = merged.slice(0, numResults)
        const sources = [
          bingRes.status === "fulfilled" ? "bing" : null,
          ddgRes.status === "fulfilled" ? "duckduckgo" : null,
        ].filter(Boolean).join("+")

        clearTimeout()
        return {
          output: formatResults(results, params.query),
          title: `Search: ${params.query}`,
          metadata: { source: sources, instance: "bing+duckduckgo", urls: metadataUrls(results, params.query) },
        }
      } catch (error) {
        clearTimeout()
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Search request timed out")
        }
        throw error
      }
    },
  }
})
