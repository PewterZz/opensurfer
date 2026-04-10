import path from "path"
import os from "os"
import { Global } from "@/global"

export interface AuthSite {
  /** Display name shown in the TUI picker */
  label: string
  /** The login page URL to open in the browser */
  loginUrl: string
  /** Cookie domains to capture (without leading dot) */
  domains: string[]
  /** Short description shown as a hint in the picker */
  hint?: string
}

export const AUTH_SITES: AuthSite[] = [
  {
    label: "LinkedIn",
    loginUrl: "https://www.linkedin.com/login",
    domains: ["linkedin.com"],
    hint: "Professional network — articles, profiles, job posts",
  },
  {
    label: "Quora",
    loginUrl: "https://www.quora.com/login",
    domains: ["quora.com"],
    hint: "Q&A — bypasses the login wall on popular questions",
  },
  {
    label: "Instagram",
    loginUrl: "https://www.instagram.com/accounts/login",
    domains: ["instagram.com"],
    hint: "Public profiles and posts",
  },
  {
    label: "Pinterest",
    loginUrl: "https://www.pinterest.com/login",
    domains: ["pinterest.com"],
    hint: "Images and boards",
  },
  {
    label: "Discord",
    loginUrl: "https://discord.com/login",
    domains: ["discord.com"],
    hint: "Public server channels (where accessible)",
  },
  {
    label: "Spotify",
    loginUrl: "https://accounts.spotify.com/login",
    domains: ["spotify.com"],
    hint: "Track info, artist pages, playlist metadata",
  },
  {
    label: "Medium",
    loginUrl: "https://medium.com/m/signin",
    domains: ["medium.com"],
    hint: "Bypasses the metered paywall using your account",
  },
  {
    label: "The New York Times",
    loginUrl: "https://myaccount.nytimes.com/auth/login",
    domains: ["nytimes.com"],
    hint: "Full articles for subscribers",
  },
  {
    label: "The Washington Post",
    loginUrl: "https://subscribe.washingtonpost.com/signin",
    domains: ["washingtonpost.com"],
    hint: "Full articles for subscribers",
  },
  {
    label: "Bloomberg",
    loginUrl: "https://www.bloomberg.com/account/login",
    domains: ["bloomberg.com"],
    hint: "Full articles for subscribers",
  },
  {
    label: "Reddit (account features)",
    loginUrl: "https://www.reddit.com/login",
    domains: ["reddit.com"],
    hint: "Age-gated or NSFW content",
  },
  {
    label: "X / Twitter",
    loginUrl: "https://twitter.com/i/flow/login",
    domains: ["twitter.com", "x.com"],
    hint: "Full tweet threads, DMs (if accessible)",
  },
]

/** Detect which browser is likely the system default */
export type BrowserName = "chrome" | "chromium" | "firefox" | "safari" | "edge"

async function detectBrowserName(): Promise<BrowserName | null> {
  // Check environment clues first
  if (process.env.BROWSER) {
    const b = process.env.BROWSER.toLowerCase()
    if (b.includes("firefox")) return "firefox"
    if (b.includes("chrom")) return b.includes("chromium") ? "chromium" : "chrome"
  }

  // Check which browser executables are present
  for (const [bin, name] of [
    ["google-chrome", "chrome"],
    ["chromium-browser", "chromium"],
    ["chromium", "chromium"],
    ["firefox", "firefox"],
    ["microsoft-edge", "edge"],
  ] as const) {
    try {
      const p = Bun.spawn(["which", bin], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
      await p.exited
      if (p.exitCode === 0) return name
    } catch { /* try next */ }
  }
  return null
}

/** Open a URL in the default system browser */
export function openInSystemBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open"
  Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
}

interface NetscapeCookie {
  domain: string
  includeSubdomains: boolean
  path: string
  secure: boolean
  expiry: number
  name: string
  value: string
}

/**
 * Extract cookies for a set of domains using yt-dlp's browser cookie extraction.
 * Uses a real YouTube URL with --skip-download so yt-dlp never invokes the system browser.
 */
async function extractViaYtdlp(browser: BrowserName, domains: string[]): Promise<NetscapeCookie[] | null> {
  try {
    const p = Bun.spawn(["yt-dlp", "--version"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    await p.exited
    if (p.exitCode !== 0) return null
  } catch {
    return null
  }

  const tmpOut = `/tmp/opensurfer_cookies_${Date.now()}.txt`
  try {
    const proc = Bun.spawn(
      [
        "yt-dlp",
        "--cookies-from-browser", browser,
        "--cookies", tmpOut,
        "--skip-download",
        "--no-write-info-json",
        "--no-write-thumbnail",
        "--quiet",
        // A real URL yt-dlp recognises — it will export cookies then exit without launching any browser
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    )
    await proc.exited
    const text = await Bun.file(tmpOut).text().catch(() => null)
    if (!text) return null
    return parseNetscapeCookies(text, domains)
  } finally {
    Bun.spawn(["rm", "-f", tmpOut], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  }
}

/**
 * Extract Firefox cookies directly from its SQLite database.
 * No encryption — works even while Firefox is running (WAL mode allows concurrent reads).
 */
async function extractViaFirefoxSqlite(domains: string[]): Promise<NetscapeCookie[] | null> {
  try {
    const { Database } = await import("bun:sqlite")

    // Find Firefox profile directory
    const profileDirs: string[] = []
    if (process.platform === "darwin") {
      profileDirs.push(path.join(os.homedir(), "Library/Application Support/Firefox/Profiles"))
    } else {
      profileDirs.push(path.join(os.homedir(), ".mozilla/firefox"))
    }

    let cookiesDbPath: string | null = null
    for (const dir of profileDirs) {
      try {
        const entries = await Array.fromAsync(
          (async function* () {
            const { readdir } = await import("fs/promises")
            for (const entry of await readdir(dir)) {
              yield entry
            }
          })(),
        )
        const profile = entries.find((e) => e.endsWith(".default-release") || e.endsWith(".default"))
        if (profile) {
          cookiesDbPath = path.join(dir, profile, "cookies.sqlite")
          break
        }
      } catch { /* try next */ }
    }
    if (!cookiesDbPath) return null

    // Copy DB to /tmp to avoid issues if Firefox has a write lock
    const tmpDb = `/tmp/opensurfer_ff_cookies_${Date.now()}.sqlite`
    await Bun.write(tmpDb, Bun.file(cookiesDbPath))

    try {
      const db = new Database(tmpDb, { readonly: true })
      const domainPatterns = domains.flatMap((d) => [`%${d}`, `%.${d}`])
      const placeholders = domainPatterns.map(() => "?").join(", ")
      const rows = db
        .query(
          `SELECT host, name, value, path, expiry, isSecure FROM moz_cookies WHERE host LIKE ${placeholders.replace(/\?/g, () => "?")}`,
        )
        .all(...domainPatterns) as Array<{
        host: string
        name: string
        value: string
        path: string
        expiry: number
        isSecure: number
      }>
      db.close()

      return rows.map((r) => ({
        domain: r.host,
        includeSubdomains: r.host.startsWith("."),
        path: r.path,
        secure: r.isSecure === 1,
        expiry: r.expiry,
        name: r.name,
        value: r.value,
      }))
    } finally {
      Bun.spawn(["rm", "-f", tmpDb], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    }
  } catch {
    return null
  }
}

/** Parse a Netscape cookies.txt string, filtering to requested domains */
function parseNetscapeCookies(text: string, domains: string[]): NetscapeCookie[] {
  const result: NetscapeCookie[] = []
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue
    const parts = line.split("\t")
    if (parts.length < 7) continue
    const [domain, includeSubdomains, path, secure, expiryStr, name, value] = parts
    const cookieDomain = domain.replace(/^\./, "")
    const matches = domains.some((d) => cookieDomain === d || cookieDomain.endsWith(`.${d}`))
    if (!matches) continue
    result.push({
      domain,
      includeSubdomains: includeSubdomains === "TRUE",
      path,
      secure: secure === "TRUE",
      expiry: parseInt(expiryStr) || 0,
      name,
      value: value ?? "",
    })
  }
  return result
}

/** Serialise cookies to Netscape format lines */
function serializeCookies(cookies: NetscapeCookie[]): string {
  return cookies
    .map(
      (c) =>
        [
          c.domain,
          c.includeSubdomains ? "TRUE" : "FALSE",
          c.path,
          c.secure ? "TRUE" : "FALSE",
          c.expiry,
          c.name,
          c.value,
        ].join("\t"),
    )
    .join("\n")
}

/**
 * Merge newly extracted cookies for `domains` into the global cookies.txt file.
 * Existing cookies for other domains are preserved; old cookies for these domains are replaced.
 */
async function mergeCookiesFile(domains: string[], newCookies: NetscapeCookie[]): Promise<void> {
  const cookiesPath = path.join(Global.Path.config, "cookies.txt")
  let existing = ""
  try {
    existing = await Bun.file(cookiesPath).text()
  } catch { /* file doesn't exist yet */ }

  // Keep lines for domains NOT in our update set
  const kept: string[] = ["# Netscape HTTP Cookie File", "# Managed by OpenSurfer — do not edit manually"]
  for (const line of existing.split("\n")) {
    if (!line || line.startsWith("#")) continue
    const parts = line.split("\t")
    if (parts.length < 7) continue
    const cookieDomain = parts[0].replace(/^\./, "")
    const belongsToUpdated = domains.some((d) => cookieDomain === d || cookieDomain.endsWith(`.${d}`))
    if (!belongsToUpdated) kept.push(line)
  }

  const newLines = serializeCookies(newCookies)
  const final = [...kept, newLines].filter(Boolean).join("\n") + "\n"
  await Bun.write(cookiesPath, final)
}

export interface AuthResult {
  ok: boolean
  cookieCount: number
  method: "ytdlp" | "firefox-sqlite" | null
  error?: string
}

/**
 * Main entry point: extract cookies for the given site and save them.
 * Tries yt-dlp first (handles all browsers + encryption), then Firefox SQLite directly.
 */
export async function extractAndSaveCookies(site: AuthSite): Promise<AuthResult> {
  const browser = await detectBrowserName()

  // Tier 1: yt-dlp (handles Chrome encryption, all platforms)
  if (browser) {
    const cookies = await extractViaYtdlp(browser, site.domains)
    if (cookies && cookies.length > 0) {
      await mergeCookiesFile(site.domains, cookies)
      return { ok: true, cookieCount: cookies.length, method: "ytdlp" }
    }
  }

  // Tier 2: Firefox SQLite (unencrypted, readable without yt-dlp)
  const ffCookies = await extractViaFirefoxSqlite(site.domains)
  if (ffCookies && ffCookies.length > 0) {
    await mergeCookiesFile(site.domains, ffCookies)
    return { ok: true, cookieCount: ffCookies.length, method: "firefox-sqlite" }
  }

  return {
    ok: false,
    cookieCount: 0,
    method: null,
    error:
      browser === null
        ? "Could not detect a browser. Install yt-dlp or use Firefox and try again."
        : `Could not extract cookies from ${browser}. Install yt-dlp for best compatibility.`,
  }
}
