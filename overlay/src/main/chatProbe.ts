import { app, shell } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { ChatProbeBuffer, type ChatProbeResult, type ChatProbeStatus } from '../shared/chatProbe'
import type { PacketEnvelope } from '../shared/ipc'

/**
 * Electron-facing wrapper around `shared/chatProbe.ts`'s buffer: armed/
 * disarmed from the Status panel over IPC, fed from `onBatch` (a no-op while
 * disarmed), and written out as plain NDJSON on stop. See the CHAT_PROBE_TYPES
 * doc comment for why this exists and why it must stay separate from the
 * capture ring / session recorder.
 *
 * The output is deliberately NOT gzipped (unlike session recordings): it's a
 * handful of envelopes meant to be opened in a text editor on the same
 * machine to read the field values off, not attached anywhere.
 */

let buffer: ChatProbeBuffer | null = null

export function chatProbeStatus(): ChatProbeStatus {
  return { active: buffer !== null, captured: buffer?.size ?? 0 }
}

/** Arms the probe (no-op if already armed - keeps whatever it captured so far). */
export function startChatProbe(): ChatProbeStatus {
  if (!buffer) {
    buffer = new ChatProbeBuffer()
    console.log(
      '[chat-probe] armed - retaining chat/party envelopes (local only, not part of any capture)'
    )
  }
  return chatProbeStatus()
}

/** Feeds a batch to the probe. No-op while disarmed - safe to call unconditionally from onBatch. */
export function pushChatProbeBatch(packets: PacketEnvelope[]): void {
  buffer?.push(packets)
}

/**
 * Disarms the probe and writes what it captured to
 * `userData/diagnostics/chat-probe-<timestamp>.ndjson`, revealing the file in
 * the OS file manager (same affordance as the bug-report dump). Writes no
 * file when nothing was captured.
 */
export async function stopChatProbe(): Promise<ChatProbeResult> {
  const current = buffer
  buffer = null
  const entries = current?.drain() ?? []
  if (entries.length === 0) {
    console.log('[chat-probe] disarmed - nothing captured')
    return { file: null, captured: 0 }
  }

  const dir = join(app.getPath('userData'), 'diagnostics')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `chat-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`)
  await writeFile(file, entries.map((env) => JSON.stringify(env)).join('\n') + '\n')
  shell.showItemInFolder(file)
  console.log(`[chat-probe] disarmed - wrote ${entries.length} envelopes -> ${file}`)
  return { file, captured: entries.length }
}
