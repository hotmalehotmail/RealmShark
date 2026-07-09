import { app, net } from 'electron'
import { spawn } from 'child_process'
import { createWriteStream } from 'fs'
import { join } from 'path'
import type { UpdateInfo } from '../shared/ipc'

/**
 * Lightweight self-updater. Polls the GitHub releases of the fork for a newer
 * overlay prerelease (tagged `overlay-test-vX.Y`), and can download that
 * release's NSIS installer and launch it. This deliberately avoids
 * electron-updater: our releases are unsigned prereleases with custom tags and
 * no `latest.yml`/publish pipeline, which electron-updater doesn't fit without
 * reworking the release process. See docs / the release notes for the tradeoff
 * (no cryptographic verification of the download - HTTPS + size check only).
 */

const REPO = 'hotmalehotmail/RealmShark'
const TAG_PREFIX = 'overlay-test-v'
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h - well under GitHub's unauth rate limit
const INITIAL_DELAY_MS = 10_000 // don't block startup

let cached: UpdateInfo | null = null

interface GithubAsset {
  name: string
  size: number
  browser_download_url: string
}
interface GithubRelease {
  tag_name: string
  body?: string
  draft?: boolean
  assets?: GithubAsset[]
}

/** Parse the numeric version out of an `overlay-test-vX.Y[.Z]` tag; null if it doesn't match. */
function parseTagVersion(tag: string): number[] | null {
  if (!tag.startsWith(TAG_PREFIX)) return null
  const parts = tag
    .slice(TAG_PREFIX.length)
    .split('.')
    .map((p) => parseInt(p, 10))
  if (parts.length === 0 || parts.some((n) => !Number.isInteger(n))) return null
  return parts
}

/** Element-wise numeric compare; missing trailing parts count as 0 (0.9 == 0.9.0). */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** GET a GitHub API path via Electron net (follows redirects, respects proxy). Null on any failure. */
function githubJson(path: string): Promise<unknown> {
  return new Promise((resolve) => {
    const request = net.request({ url: `https://api.github.com${path}`, method: 'GET' })
    request.setHeader('User-Agent', 'RealmShark-Overlay')
    request.setHeader('Accept', 'application/vnd.github+json')
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        resolve(null)
        return
      }
      let body = ''
      response.on('data', (chunk) => (body += chunk.toString()))
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
      response.on('error', () => resolve(null))
    })
    request.on('error', () => resolve(null))
    request.end()
  })
}

/**
 * Query GitHub for the highest overlay release; return it if newer than the
 * running version, else null. Prereleases are included (our releases are all
 * prereleases, so /releases/latest is useless). Fails quietly to null.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const releases = await githubJson(`/repos/${REPO}/releases?per_page=15`)
  if (!Array.isArray(releases)) return null

  const current = app
    .getVersion()
    .split('.')
    .map((p) => parseInt(p, 10) || 0)
  let best: { version: number[]; release: GithubRelease } | null = null
  for (const rel of releases as GithubRelease[]) {
    if (rel.draft) continue
    const v = parseTagVersion(rel.tag_name)
    if (!v) continue
    if (!best || compareVersions(v, best.version) > 0) best = { version: v, release: rel }
  }
  if (!best || compareVersions(best.version, current) <= 0) {
    cached = null
    return null
  }

  const asset = (best.release.assets ?? []).find((a) => /-setup\.exe$/i.test(a.name))
  if (!asset) return null
  cached = {
    version: best.version.join('.'),
    tag: best.release.tag_name,
    notes: best.release.body ?? '',
    downloadUrl: asset.browser_download_url,
    size: asset.size
  }
  return cached
}

export function getCachedUpdate(): UpdateInfo | null {
  return cached
}

/** Download the installer to a temp file, reporting progress. Resolves to the file path. */
export function downloadInstaller(
  info: UpdateInfo,
  onProgress: (received: number, total: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const dest = join(app.getPath('temp'), `RealmShark-Overlay-${info.version}-setup.exe`)
    const file = createWriteStream(dest)
    const request = net.request({ url: info.downloadUrl, method: 'GET' })
    request.setHeader('User-Agent', 'RealmShark-Overlay')
    let received = 0
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        file.close()
        reject(new Error(`download failed: HTTP ${response.statusCode}`))
        return
      }
      const total =
        info.size || parseInt(String(response.headers['content-length'] ?? '0'), 10) || 0
      response.on('data', (chunk) => {
        received += chunk.length
        file.write(chunk)
        onProgress(received, total)
      })
      response.on('end', () => {
        file.end(() => {
          if (info.size && received !== info.size) {
            reject(new Error(`download incomplete (${received}/${info.size})`))
          } else {
            resolve(dest)
          }
        })
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Launch the downloaded installer (detached, so it outlives us) and quit. The
 * NSIS one-click installer closes/replaces the app in place and relaunches it
 * (runAfterFinish). Quitting via app.quit() runs `will-quit` -> stopBridge(),
 * force-killing the bundled bridge's java.exe so the installer can overwrite
 * `resources/bridge.jar`, and releasing the single-instance lock.
 */
export function installAndRestart(exePath: string): void {
  spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}

/**
 * Start background polling: one check ~10s after launch, then every 6h. Calls
 * onUpdate with a newer release when found. No-op in dev (unpackaged), where
 * the version won't correspond to a release.
 */
export function startUpdatePolling(onUpdate: (info: UpdateInfo) => void): void {
  if (!app.isPackaged) return
  const run = async (): Promise<void> => {
    const info = await checkForUpdate()
    if (info) onUpdate(info)
  }
  setTimeout(() => void run(), INITIAL_DELAY_MS)
  setInterval(() => void run(), POLL_INTERVAL_MS)
}
