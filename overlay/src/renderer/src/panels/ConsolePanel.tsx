import { useEffect, useRef, useState } from 'react'
import { clearLogEntries, getLogEntries, subscribeLogEntries, type LogEntry } from '../consoleLog'
import type { PanelContentProps } from './registry'

const LEVEL_STYLES: Record<LogEntry['level'], string> = {
  log: 'text-white/70',
  info: 'text-sky-300',
  warn: 'text-amber-300',
  error: 'text-red-400'
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return d.toTimeString().slice(0, 8)
}

function ConsolePanel({ size }: PanelContentProps): React.JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>(getLogEntries)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  useEffect(() => subscribeLogEntries(setEntries), [])

  useEffect(() => {
    const el = scrollRef.current
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight
  }, [entries])

  return (
    <div className="flex h-full w-full flex-col text-xs">
      <div className="mb-1 flex shrink-0 items-center justify-between">
        <span className="text-white/40">{entries.length} lines</span>
        <button
          className="rounded px-1 text-[10px] uppercase text-white/40 hover:text-white/80"
          onClick={() => clearLogEntries()}
        >
          clear
        </button>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto font-mono"
        onScroll={(e) => {
          const el = e.currentTarget
          autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16
        }}
      >
        {entries.length === 0 && <div className="text-white/30">no logs yet</div>}
        {entries.map((entry) => (
          <div
            key={entry.id}
            className={`whitespace-pre-wrap break-words ${LEVEL_STYLES[entry.level]}`}
          >
            {size !== 'sm' && <span className="text-white/30">{formatTime(entry.time)} </span>}
            {entry.message}
          </div>
        ))}
      </div>
    </div>
  )
}

export default ConsolePanel
