import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./codesearch.txt"
import { abortAfterAny } from "../util/abort"

// Public SearXNG instances known to have JSON API enabled
const SEARXNG_FALLBACK_INSTANCES = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://paulgo.io",
]

interface SearchResult {
  title: string
  url: string
  snippet: string
}

async function searchSearXNG(
  instanceUrl: string,
  query: string,
  numResults: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL(`${instanceUrl}/search`)
  url.searchParams.set("q", query)
  url.searchParams.set("format", "json")
  url.searchParams.set("categories", "it")  // IT/tech category for better technical results
  url.searchParams.set("language", "auto")

  const response = await fetch(url.toString(), {
    signal,
    headers: {
      Accept: "application/json",
      "User-Agent": "OpenSurfer/1.0 (https://github.com/PewterZz/opensurfer)",
    },
  })

  if (!response.ok) throw new Error(`SearXNG returned ${response.status}`)

  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> }
  if (!Array.isArray(data.results)) throw new Error("No results array")

  return data.results.slice(0, numResults).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }))
}

async function searchDuckDuckGo(
  query: string,
  numResults: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  // Append site filters for authoritative technical documentation
  const techQuery = `${query} site:docs.* OR site:developer.mozilla.org OR site:github.com OR site:stackoverflow.com`

  const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(techQuery)}`, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.5",
    },
  })

  if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`)

  const html = await response.text()
  return parseDDGLite(html, numResults)
}

function parseDDGLite(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const linkRe = /<a\s[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<td\s[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g
  const links: Array<{ href: string; title: string }> = []
  let m: RegExpExecArray | null

  while ((m = linkRe.exec(html)) !== null) {
    const title = m[2].replace(/<[^>]+>/g, "").trim()
    if (title) links.push({ href: m[1], title })
  }

  const snippets: string[] = []
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
  }

  for (let i = 0; i < Math.min(links.length, limit); i++) {
    const { href, title } = links[i]
    let url = href
    try {
      const full = href.startsWith("//") ? "https:" + href : href
      url = new URL(full).searchParams.get("uddg") || full
    } catch {}
    results.push({ title, url, snippet: snippets[i] || "" })
  }

  return results
}

function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return "No documentation or reference results found. Try rephrasing or using the websearch tool."
  }

  const lines = [`Documentation/reference results for: **${query}**`, ""]
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    lines.push(`${i + 1}. **${r.title}**`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
    lines.push("")
  }
  return lines.join("\n")
}

export const CodeSearchTool = Tool.define("codesearch", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z
      .string()
      .describe(
        "Search query to find documentation, API references, or technical specifications. Examples: 'React useState hook', 'Python pandas dataframe API', 'WebAssembly specification', 'Express.js middleware'",
      ),
    numResults: z
      .number()
      .min(1)
      .max(20)
      .default(8)
      .describe("Number of results to return (default: 8)"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "codesearch",
      patterns: [params.query],
      always: ["*"],
      metadata: { query: params.query },
    })

    const { signal, clearTimeout } = abortAfterAny(25000, ctx.abort)

    try {
      // Try configured SearXNG instance first (uses IT/tech category)
      const configuredUrl = process.env["OPENSURFER_SEARCH_URL"] || process.env["OPENSURFER_SEARCH_URL"]
      if (configuredUrl) {
        try {
          const results = await searchSearXNG(configuredUrl.replace(/\/$/, ""), params.query, params.numResults, signal)
          clearTimeout()
          return { output: formatResults(results, params.query), title: `Docs: ${params.query}`, metadata: { source: "searxng" } }
        } catch {}
      }

      // Try public SearXNG instances
      for (const instance of SEARXNG_FALLBACK_INSTANCES) {
        try {
          const results = await searchSearXNG(instance, params.query, params.numResults, signal)
          clearTimeout()
          return { output: formatResults(results, params.query), title: `Docs: ${params.query}`, metadata: { source: "searxng" } }
        } catch {}
      }

      // Fall back to DuckDuckGo with tech site filters
      const results = await searchDuckDuckGo(params.query, params.numResults, signal)
      clearTimeout()
      return { output: formatResults(results, params.query), title: `Docs: ${params.query}`, metadata: { source: "duckduckgo" } }
    } catch (error) {
      clearTimeout()
      if (error instanceof Error && error.name === "AbortError") throw new Error("Search timed out")
      throw error
    }
  },
})
