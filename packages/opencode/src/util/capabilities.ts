export interface Capabilities {
  chafa: boolean
  streamlink: boolean
  carbonyl: boolean
  browsh: boolean
  ytdlp: boolean
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([cmd, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

let cached: Promise<Capabilities> | null = null

export function detectCapabilities(): Promise<Capabilities> {
  if (!cached) {
    cached = Promise.all([
      commandExists("chafa"),
      commandExists("streamlink"),
      commandExists("carbonyl"),
      commandExists("browsh"),
      commandExists("yt-dlp"),
    ]).then(([chafa, streamlink, carbonyl, browsh, ytdlp]) => ({
      chafa,
      streamlink,
      carbonyl,
      browsh,
      ytdlp,
    }))
  }
  return cached
}

export const STREAMING_SITES = [
  "twitch.tv",
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "dailymotion.com",
  "kick.com",
  "rumble.com",
  "bilibili.com",
  "tiktok.com",
]

export function isStreamingUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "")
    return STREAMING_SITES.some((s) => hostname === s || hostname.endsWith("." + s))
  } catch {
    return false
  }
}

/** Launch streamlink → mpv for a streaming URL */
export function launchStreamlink(url: string): void {
  Bun.spawn(["streamlink", url, "best"], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  })
}

/** Open URL in Carbonyl, Browsh, or system browser — in a new terminal window */
export function openInBrowser(url: string, caps: Capabilities): void {
  // Detect a usable terminal emulator to host Carbonyl/Browsh
  const newTerm = (() => {
    if (process.env.KITTY_WINDOW_ID) return (cmd: string[]) => ["kitty", "--", ...cmd]
    if (process.env.TERM_PROGRAM === "WezTerm") return (cmd: string[]) => ["wezterm", "start", "--", ...cmd]
    return (cmd: string[]) => ["xterm", "-e", ...cmd]
  })()

  if (caps.carbonyl) {
    Bun.spawn(newTerm(["carbonyl", url]), { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  } else if (caps.browsh) {
    Bun.spawn(newTerm(["browsh", "-startup-url", url]), { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  } else {
    // Fall back to system browser
    const opener = process.platform === "darwin" ? "open" : "xdg-open"
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  }
}

/** Fetch an image URL and run chafa on it; returns ANSI block-art string or null */
export async function renderImageWithChafa(imageUrl: string, width: number): Promise<string | null> {
  try {
    const fullUrl = imageUrl.startsWith("//") ? "https:" + imageUrl : imageUrl
    if (!fullUrl.startsWith("http")) return null

    const res = await fetch(fullUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null

    const buf = await res.arrayBuffer()
    const tmpPath = `/tmp/opensurfer_img_${Date.now()}_${Math.random().toString(36).slice(2)}`
    await Bun.write(tmpPath, buf)

    const proc = Bun.spawn(["chafa", `--size=${Math.min(width, 80)}x24`, "--animate=false", tmpPath], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited

    // Clean up temp file
    Bun.spawn(["rm", "-f", tmpPath], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })

    return output.trim() || null
  } catch {
    return null
  }
}

/** Extract image URLs from HTML, handling lazy-loaded images */
export function extractImages(html: string): Array<{ src: string; alt: string }> {
  const results: Array<{ src: string; alt: string }> = []
  const seen = new Set<string>()
  const re = /<img[^>]+>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const tag = m[0]
    // Try src first, then data-src / data-lazy-src / data-original (lazy loaders)
    const srcMatch =
      tag.match(/\bsrc="(https?[^"]+)"/) ||
      tag.match(/\bdata-src="(https?[^"]+)"/) ||
      tag.match(/\bdata-lazy-src="(https?[^"]+)"/) ||
      tag.match(/\bdata-original="(https?[^"]+)"/)
    const altMatch = tag.match(/\balt="([^"]*)"/)
    const src = srcMatch?.[1]
    if (src && !seen.has(src)) {
      // Skip tiny tracking pixels (1x1, very small)
      const wMatch = tag.match(/\bwidth="(\d+)"/)
      const hMatch = tag.match(/\bheight="(\d+)"/)
      if (wMatch && parseInt(wMatch[1]) < 10) continue
      if (hMatch && parseInt(hMatch[1]) < 10) continue
      seen.add(src)
      results.push({ src, alt: altMatch?.[1] ?? "" })
    }
  }
  return results
}
