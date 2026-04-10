declare global {
  const OPENSURFER_VERSION: string
  const OPENSURFER_CHANNEL: string
}

export const VERSION = typeof OPENSURFER_VERSION === "string" ? OPENSURFER_VERSION : "local"
export const CHANNEL = typeof OPENSURFER_CHANNEL === "string" ? OPENSURFER_CHANNEL : "local"
