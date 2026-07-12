import { useEffect, useMemo, useRef, useState } from 'react'
import { clearLogEntries, getLogEntries, subscribeLogEntries, type LogEntry } from '../consoleLog'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import type { PanelContentProps } from './registry'

const LEVEL_STYLES: Record<LogEntry['level'], string> = {
  log: 'text-fg-muted',
  info: 'text-accent',
  warn: 'text-warn',
  error: 'text-danger'
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return d.toTimeString().slice(0, 8)
}

/** Split a line around case-insensitive matches of `term`, wrapping matches in <mark>. */
function highlight(message: string, term: string): React.ReactNode {
  if (!term) return message
  const lower = message.toLowerCase()
  const needle = term.toLowerCase()
  const parts: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i < message.length) {
    const idx = lower.indexOf(needle, i)
    if (idx === -1) {
      parts.push(message.slice(i))
      break
    }
    if (idx > i) parts.push(message.slice(i, idx))
    parts.push(
      <mark key={key++} className="rounded-sm bg-warn/40 text-inherit">
        {message.slice(idx, idx + term.length)}
      </mark>
    )
    i = idx + term.length
  }
  return parts
}

function ConsolePanel({ size }: PanelContentProps): React.JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>(getLogEntries)
  const [search, setSearch] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const autoScrollRef = useRef(true)

  useEffect(() => subscribeLogEntries(setEntries), [])

  // Ctrl/Cmd+F focuses the search box (Esc clears it). The overlay window is
  // non-focusable while click-through, so this only fires when the HUD is active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setSearch('')
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filtered = useMemo(() => {
    if (!search) return entries
    const needle = search.toLowerCase()
    return entries.filter((e) => e.message.toLowerCase().includes(needle))
  }, [entries, search])

  useEffect(() => {
    const el = scrollRef.current
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight
  }, [filtered])

  return (
    <div className="flex h-full w-full flex-col text-xs">
      <div className="mb-1 flex shrink-0 items-center gap-1">
        <input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search… (Ctrl+F)"
          className="min-w-0 flex-1 rounded bg-surface-2 px-1.5 py-0.5 text-fg placeholder:text-fg-faint focus:bg-surface-3 focus:outline-none"
        />
        <span className="shrink-0 tabular-nums text-fg-faint">
          {search ? `${filtered.length}/${entries.length}` : entries.length}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 uppercase"
          onClick={() => clearLogEntries()}
        >
          clear
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto font-mono"
        onScroll={(e) => {
          const el = e.currentTarget
          autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16
        }}
      >
        {filtered.length === 0 && <EmptyState>{search ? 'no matches' : 'no logs yet'}</EmptyState>}
        {filtered.map((entry) => (
          <div
            key={entry.id}
            className={`whitespace-pre-wrap break-words ${LEVEL_STYLES[entry.level]}`}
          >
            {size !== 'sm' && <span className="text-fg-faint">{formatTime(entry.time)} </span>}
            {highlight(entry.message, search)}
          </div>
        ))}
      </div>
    </div>
  )
}

export default ConsolePanel
