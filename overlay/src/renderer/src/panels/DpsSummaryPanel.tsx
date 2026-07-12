import { useState } from 'react'
import type { PanelSize } from '../../../shared/panels'
import type { DpsHistoryEnemy, DpsHistoryEntry, PlayerCosmetics } from '../dps/DpsTracker'
import { useDpsHistory } from '../dps/useDpsHistory'
import type { PlayerDps } from '../dps/types'
import { formatDps } from '../formatDps'
import { Sprite } from '../sprites/Sprite'
import { useSprites } from '../sprites/context'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { GearRow } from '../ui/GearRow'
import { MeterRow } from '../ui/MeterRow'
import { Swatch } from '../ui/Swatch'
import type { PanelContentProps } from './registry'

/** How many master-list rows / detail enemies to show before "show all". */
const DEFAULT_VISIBLE: Record<PanelSize, number> = { sm: 3, md: 5, lg: 8 }

const DUNGEON_ICON_SIZE: Record<PanelSize, number> = { sm: 20, md: 24, lg: 28 }
const ENEMY_ICON_SIZE = 20
const PLAYER_SPRITE_SIZE = 24
const GEAR_SLOT_SIZE = 14

function totalDamage(rows: PlayerDps[]): number {
  return rows.reduce((sum, row) => sum + row.damage, 0)
}

/** A player's frozen class/skin sprite + dyes, or a bordered placeholder when unknown. */
function FrozenCharacterSprite({
  cosmetics,
  size
}: {
  cosmetics: PlayerCosmetics | undefined
  size: number
}): React.JSX.Element {
  const base = cosmetics
    ? cosmetics.skin != null && cosmetics.skin > 0
      ? cosmetics.skin
      : cosmetics.objectType
    : null
  if (base == null) {
    return <Swatch size={size} />
  }
  return (
    <Sprite
      objectType={base}
      size={size}
      clothingDye={cosmetics?.clothingDye}
      accessoryDye={cosmetics?.accessoryDye}
    />
  )
}

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
  const rows = [...topEnemy.players].sort((a, b) => b.damage - a.damage)
  const rank = rows.findIndex((r) => r.objectId === entry.localPlayerId)
  if (rank === -1) return null
  return `You: ${formatDps(rows[rank].damage)} dmg (#${rank + 1})`
}

interface MasterListProps {
  history: DpsHistoryEntry[]
  size: PanelSize
  onSelect: (id: string) => void
}

function MasterList({ history, size, onSelect }: MasterListProps): React.JSX.Element {
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
            className="flex items-center gap-2 rounded-sm px-1 py-1 text-left hover:bg-surface-2"
            onClick={() => onSelect(entry.id)}
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

interface EnemyRowProps {
  enemy: DpsHistoryEnemy
  localPlayerId: number | null
  topDamage: number
  expanded: boolean
  onToggle: () => void
}

function EnemyRow({
  enemy,
  localPlayerId,
  topDamage,
  expanded,
  onToggle
}: EnemyRowProps): React.JSX.Element {
  const rows = [...enemy.players].sort((a, b) => b.damage - a.damage)
  const enemyTotal = totalDamage(rows)
  const fillPct = topDamage > 0 ? (enemyTotal / topDamage) * 100 : 0

  return (
    <div className="rounded-sm bg-surface">
      <MeterRow fillPct={fillPct} className="px-1 py-1" onClick={onToggle}>
        <span className="w-3 shrink-0 text-fg-faint">{expanded ? '▾' : '▸'}</span>
        {enemy.objectType != null && (
          <Sprite objectType={enemy.objectType} size={ENEMY_ICON_SIZE} />
        )}
        <span className="min-w-0 flex-1 truncate text-fg-muted">{enemy.name}</span>
        <span className="shrink-0 font-mono tabular-nums text-fg">{formatDps(enemyTotal)}</span>
      </MeterRow>
      {expanded && (
        <div className="space-y-1 px-1 pb-1.5">
          {rows.map((row) => {
            const cosmetics = enemy.cosmetics.get(row.objectId)
            const isLocal = row.objectId === localPlayerId
            const pct = enemyTotal > 0 ? Math.round((row.damage / enemyTotal) * 100) : 0
            return (
              <MeterRow key={row.objectId} fillPct={0} highlight={isLocal} className="px-1 py-0.5">
                <FrozenCharacterSprite cosmetics={cosmetics} size={PLAYER_SPRITE_SIZE} />
                <GearRow
                  equipment={cosmetics?.equipment}
                  slotSize={GEAR_SLOT_SIZE}
                  ownerObjectId={row.objectId}
                />
                <span className="min-w-0 flex-1 truncate text-fg-muted">{row.name}</span>
                <span className="shrink-0 text-right font-mono tabular-nums">
                  <span className="text-fg">{formatDps(row.damage)}</span>
                  <span className="ml-1 text-2xs text-fg-faint">{pct}%</span>
                  <span className="ml-1 text-2xs text-fg-faint">{formatDps(row.dps)} dps</span>
                </span>
              </MeterRow>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface InstanceDetailProps {
  entry: DpsHistoryEntry
  size: PanelSize
  onBack: () => void
}

function InstanceDetail({ entry, size, onBack }: InstanceDetailProps): React.JSX.Element {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)

  const defaultVisible = DEFAULT_VISIBLE[size]
  const visibleEnemies = showAll ? entry.enemies : entry.enemies.slice(0, defaultVisible)
  const topDamage = totalDamage(entry.enemies[0]?.players ?? [])

  return (
    <div className="flex h-full w-full flex-col gap-1">
      <Button
        variant="ghost"
        size="xs"
        className="flex shrink-0 items-center gap-1 text-left"
        onClick={onBack}
      >
        <span>◂</span>
        <span className="truncate">{entry.instanceName}</span>
      </Button>
      {entry.enemies.length === 0 ? (
        <EmptyState>No damage recorded</EmptyState>
      ) : (
        <div className="flex-1 space-y-1 overflow-y-auto pr-1">
          {visibleEnemies.map((enemy) => (
            <EnemyRow
              key={enemy.id}
              enemy={enemy}
              localPlayerId={entry.localPlayerId}
              topDamage={topDamage}
              expanded={expandedId === enemy.id}
              onToggle={() => setExpandedId((prev) => (prev === enemy.id ? null : enemy.id))}
            />
          ))}
          {entry.enemies.length > defaultVisible && (
            <Button
              variant="ghost"
              size="xs"
              className="w-full py-0.5 text-center"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Show less' : `Show all (${entry.enemies.length})`}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function DpsSummaryPanel({ size }: PanelContentProps): React.JSX.Element {
  const history = useDpsHistory()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = selectedId ? (history.find((e) => e.id === selectedId) ?? null) : null

  if (selected) {
    return <InstanceDetail entry={selected} size={size} onBack={() => setSelectedId(null)} />
  }

  return <MasterList history={history} size={size} onSelect={setSelectedId} />
}

export default DpsSummaryPanel
