import type { PanelSize } from '../../../shared/panels'
import type { DpsHistoryEntry } from '../dps/DpsTracker'
import { useDpsDetailSelection } from '../dps/dpsDetailContext'
import { useDpsHistory } from '../dps/useDpsHistory'
import type { PlayerDps } from '../dps/types'
import { formatDps } from '../formatDps'
import { Sprite } from '../sprites/Sprite'
import { useSprites } from '../sprites/context'
import { EmptyState } from '../ui/EmptyState'
import { Swatch } from '../ui/Swatch'
import { usePanelSpawn } from './panelSpawn'
import type { PanelContentProps } from './registry'

/** The detail panel is a single reused instance, re-targeted on each row click (see docs/overlay-renderer.md). */
const DPS_DETAIL_PANEL_ID = 'dpsDetail'

const DUNGEON_ICON_SIZE: Record<PanelSize, number> = { sm: 20, md: 24, lg: 28 }

/** Instance icon: dungeon-icon map -> the instance's main-boss sprite (top damage-absorber) -> generic placeholder. */
function InstanceIcon({
  entry,
  size
}: {
  entry: DpsHistoryEntry
  size: number
}): React.JSX.Element {
  const { dungeonIcon } = useSprites()
  const spriteId = dungeonIcon(entry.instanceName) ?? entry.enemies[0]?.objectType ?? null
  if (spriteId == null) {
    return <Swatch size={size} />
  }
  return <Sprite objectType={spriteId} size={size} />
}

/** "You: 42.3k dmg (#2)" headline for a master-list row, from the instance's top enemy - omitted if the local player didn't fight it. */
function localHeadline(entry: DpsHistoryEntry): string | null {
  const topEnemy = entry.enemies[0]
  if (!topEnemy || entry.localPlayerId == null) return null
  const rows: PlayerDps[] = [...topEnemy.players].sort((a, b) => b.damage - a.damage)
  const rank = rows.findIndex((r) => r.objectId === entry.localPlayerId)
  if (rank === -1) return null
  return `You: ${formatDps(rows[rank].damage)} dmg (#${rank + 1})`
}

interface MasterListProps {
  history: DpsHistoryEntry[]
  size: PanelSize
  selectedId: string | null
  onSelect: (entry: DpsHistoryEntry) => void
}

function MasterList({ history, size, selectedId, onSelect }: MasterListProps): React.JSX.Element {
  if (history.length === 0) {
    return <EmptyState>No instances logged yet this session</EmptyState>
  }
  const iconSize = DUNGEON_ICON_SIZE[size]
  return (
    <div className="flex h-full w-full flex-col gap-1 overflow-y-auto pr-1">
      {history.map((entry) => {
        const headline = localHeadline(entry)
        return (
          <button
            key={entry.id}
            className={`flex items-center gap-2 rounded-sm px-1 py-1 text-left hover:bg-surface-2 ${
              entry.id === selectedId ? 'bg-surface-2' : ''
            }`}
            onClick={() => onSelect(entry)}
          >
            <InstanceIcon entry={entry} size={iconSize} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs font-semibold">{entry.instanceName}</span>
              {headline && <span className="truncate text-2xs text-accent/70">{headline}</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}

/**
 * A master list of past instances; clicking a row opens its per-enemy/
 * per-player breakdown in a separate, larger `dpsDetail` panel (issue #194)
 * rather than swapping this panel's own small content - see
 * `docs/overlay-renderer.md`'s "Programmatic panel spawn/close" section.
 */
function DpsSummaryPanel({ size }: PanelContentProps): React.JSX.Element {
  const history = useDpsHistory()
  const { selected, select } = useDpsDetailSelection()
  const { openPanel, isOpen } = usePanelSpawn()

  const handleSelect = (entry: DpsHistoryEntry): void => {
    select(entry)
    openPanel(DPS_DETAIL_PANEL_ID, 'dpsDetail', 'lg')
  }

  // Gated on isOpen(), not just `selected`, so the highlight tracks the
  // detail panel's actual open/closed state - see docs/overlay-renderer.md's
  // "Programmatic panel spawn/close".
  return (
    <MasterList
      history={history}
      size={size}
      selectedId={isOpen(DPS_DETAIL_PANEL_ID) ? (selected?.id ?? null) : null}
      onSelect={handleSelect}
    />
  )
}

export default DpsSummaryPanel
