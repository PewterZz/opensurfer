#!/usr/bin/env bun
/**
 * Standalone search engine diagnostic.
 * Usage: bun script/test-search.ts "your query here"
 * Output written to /tmp/ws-test.txt AND printed to stdout.
 *
 * Tests Bing, DDG, and Mojeek independently and shows how many results
 * each engine returns, what they are, and any errors.
 */

const query = process.argv[2] ?? "ohnepixel wiki biography"

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const SEC_CH_UA = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"'

async function detectCurlBin(): Promise<string | null> {
  const home = process.env.HOME ?? ""
  for (const bin of [`${home}/.local/bin/curl-impersonate`, "curl-impersonate-ff", "curl-impersonate", "curl"]) {
    try {
      const p = Bun.spawn([bin, "--version"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
      await p.exited
      if (p.exitCode === 0) { console.log("curl bin:", bin); return bin }
    } catch {}
  }
  return null
}

async function httpFetch(
  url: string,
  opts: { headers?: Record<string, string>; method?: "GET" | "POST"; body?: string; contentType?: string; cookieJar?: string } = {},
): Promise<string> {
  const bin = await detectCurlBin()
  if (bin) {
    const args = [bin, "-sS", "-L", "--max-time", "20", "--compressed"]
    if (bin.includes("curl-impersonate")) args.push("--impersonate", "chrome131")
    if (opts.cookieJar) args.push("-b", opts.cookieJar, "-c", opts.cookieJar)
    const headers: Record<string, string> = {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "max-age=0",
      "Upgrade-Insecure-Requests": "1",
      "sec-ch-ua": SEC_CH_UA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      ...opts.headers,
    }
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`)
    if (opts.method === "POST" && opts.body) {
      args.push("-X", "POST", "--data-raw", opts.body)
      if (opts.contentType) args.push("-H", `Content-Type: ${opts.contentType}`)
    }
    args.push(url)
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    if (proc.exitCode !== 0) throw new Error(`curl exited ${proc.exitCode}: ${err.trim()}`)
    return out
  }
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: { "User-Agent": BROWSER_UA, ...opts.headers },
    body: opts.body,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

function normaliseUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "source", "fbclid", "gclid"])
      u.searchParams.delete(k)
    u.hash = ""
    return u.origin + u.pathname.replace(/\/$/, "") + (u.search === "?" ? "" : u.search)
  } catch {
    return url
  }
}

function decodeBingUrl(href: string): string {
  if (!href.includes("bing.com/ck/a") && !href.includes("/ck/a?")) return href
  try {
    const rawMatch = href.match(/[?&]u=(a1[A-Za-z0-9+/=_-]+)/)
    if (!rawMatch) return href
    const b64 = rawMatch[1].slice(2)
    for (const enc of ["base64url", "base64"] as const) {
      try {
        const decoded = Buffer.from(b64, enc).toString("utf8")
        if (decoded.startsWith("http")) return decoded
      } catch {}
    }
  } catch {}
  return href
}

interface Result { title: string; url: string; snippet: string }

async function testBing(q: string): Promise<{ results: Result[]; rawChunks: number; htmlLen: number }> {
  const jar = `/tmp/ws_test_bing_${Date.now()}.jar`
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=10&mkt=en-US&setlang=en-US&cc=US`
  let html: string
  try {
    // Pre-warm session to get MUID cookie — without this Bing returns degraded bot results
    await httpFetch("https://www.bing.com/", { cookieJar: jar }).catch(() => {})
    html = await httpFetch(url, { headers: { Referer: "https://www.bing.com/" }, cookieJar: jar })
  } finally {
    Bun.spawn(["rm", "-f", jar], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  }
  const chunks = html.split(/class="[^"]*\bb_algo\b[^"]*"/)
  const results: Result[] = []
  for (let i = 1; i < chunks.length && results.length < 10; i++) {
    const chunk = chunks[i]
    const linkMatch = chunk.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!linkMatch) continue
    let href = decodeBingUrl(linkMatch[1].replace(/&amp;/g, "&"))
    if (!href.startsWith("http")) continue
    try {
      const host = new URL(href).hostname
      if (host.includes("bing.") || host.includes("microsoft.")) continue
    } catch { continue }
    const canonical = normaliseUrl(href)
    const title = linkMatch[2].replace(/<[^>]+>/g, "").trim()
    if (!title) continue
    const snippetMatch = chunk.match(/<p[^>]*>([\s\S]{15,400}?)<\/p>/)
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : ""
    results.push({ title, url: canonical, snippet })
  }
  return { results, rawChunks: chunks.length - 1, htmlLen: html.length }
}

async function testDDG(q: string): Promise<{ results: Result[]; htmlLen: number }> {
  const body = new URLSearchParams({ q, kl: "us-en", b: "", df: "" })
  const html = await httpFetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    body: body.toString(),
    contentType: "application/x-www-form-urlencoded",
    headers: {
      Origin: "https://html.duckduckgo.com",
      Referer: "https://html.duckduckgo.com/",
      "Sec-Fetch-Site": "same-origin",
    },
  })
  const results: Result[] = []
  // Split on result containers — class contains "result" and "results_links"
  const chunks = html.split(/class="[^"]*\bresult\b[^"]*\bresults_links\b[^"]*"/)
  for (let i = 1; i < chunks.length && results.length < 10; i++) {
    const chunk = chunks[i]
    const linkMatch = chunk.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!linkMatch) continue
    let href = linkMatch[1]
    try {
      if (href.includes("duckduckgo.com/l/") || href.startsWith("/l/") || href.startsWith("//")) {
        const full = href.startsWith("//") ? "https:" + href : href.startsWith("/") ? "https://duckduckgo.com" + href : href
        const uddg = new URL(full).searchParams.get("uddg")
        if (uddg) href = decodeURIComponent(uddg)
      }
    } catch {}
    if (!href.startsWith("http")) continue
    const canonical = normaliseUrl(href)
    const title = linkMatch[2].replace(/<[^>]+>/g, "").trim()
    if (!title) continue
    const snippetMatch = chunk.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/)
      ?? chunk.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : ""
    results.push({ title, url: canonical, snippet })
  }
  return { results, htmlLen: html.length }
}

async function testMojeek(q: string): Promise<{ results: Result[]; rawChunks: number; htmlLen: number }> {
  const url = `https://www.mojeek.com/search?q=${encodeURIComponent(q)}&hp=1`
  const html = await httpFetch(url, { headers: { Referer: "https://www.mojeek.com/" } })
  const results: Result[] = []
  const chunks = html.split("<!--rs-->")
  for (let i = 1; i < chunks.length && results.length < 10; i++) {
    const chunk = chunks[i]
    const linkMatch = chunk.match(/<a[^>]+class="title"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!linkMatch) continue
    const href = linkMatch[1]
    if (!href.startsWith("http")) continue
    const canonical = normaliseUrl(href)
    const title = linkMatch[2].replace(/<[^>]+>/g, "").trim()
    if (!title) continue
    const snippetMatch = chunk.match(/<p class="s">([\s\S]*?)<\/p>/)
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : ""
    results.push({ title, url: canonical, snippet })
  }
  return { results, rawChunks: chunks.length - 1, htmlLen: html.length }
}

function printResults(label: string, r: Result[], extra: string) {
  const lines: string[] = []
  lines.push(`\n${"=".repeat(60)}`)
  lines.push(`${label} — ${r.length} result(s)  ${extra}`)
  lines.push("=".repeat(60))
  for (let i = 0; i < r.length; i++) {
    lines.push(`[${i + 1}] ${r[i].title}`)
    lines.push(`    ${r[i].url}`)
    if (r[i].snippet) lines.push(`    ${r[i].snippet.slice(0, 120)}`)
  }
  return lines.join("\n")
}

const outLines: string[] = []
const OUT_FILE = "/tmp/ws-test.txt"

function log(s: string) {
  console.log(s)
  outLines.push(s)
}

log(`\nWebSearch diagnostic — query: "${query}"`)
log(`Timestamp: ${new Date().toISOString()}`)

const [bingR, ddgR, mojeekR] = await Promise.allSettled([
  testBing(query),
  testDDG(query),
  testMojeek(query),
])

if (bingR.status === "fulfilled") {
  const { results, rawChunks, htmlLen } = bingR.value
  log(printResults("BING", results, `raw b_algo chunks=${rawChunks}, htmlLen=${htmlLen}`))
} else {
  log(`\nBING FAILED: ${bingR.reason}`)
}

if (ddgR.status === "fulfilled") {
  const { results, htmlLen } = ddgR.value
  log(printResults("DDG", results, `htmlLen=${htmlLen}`))
} else {
  log(`\nDDG FAILED: ${ddgR.reason}`)
}

if (mojeekR.status === "fulfilled") {
  const { results, rawChunks, htmlLen } = mojeekR.value
  log(printResults("MOJEEK", results, `raw <!--rs--> chunks=${rawChunks}, htmlLen=${htmlLen}`))
} else {
  log(`\nMOJEEK FAILED: ${mojeekR.reason}`)
}

await Bun.write(OUT_FILE, outLines.join("\n") + "\n")
log(`\nOutput saved to ${OUT_FILE}`)
