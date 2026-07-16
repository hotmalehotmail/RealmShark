import { useEffect, useState } from 'react'
import type { PanelSize } from '../../../shared/panels'
import type { DpsHistoryEnemy, DpsHistoryEntry, PlayerCosmetics } from '../dps/DpsTracker'
import { useDpsDetailSelection } from '../dps/dpsDetailContext'
import type { PlayerDps } from '../dps/types'
import { formatDps } from '../formatDps'
import { Sprite } from '../sprites/Sprite'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { GearRow } from '../ui/GearRow'
import { MeterRow } from '../ui/MeterRow'
import { Swatch } from '../ui/Swatch'
import type { PanelContentProps } from './registry'

/** How many detail enemies to show before "show all". */
const DEFAULT_VISIBLE: Record<PanelSize, number> = { sm: 3, md: 5, lg: 8 }

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
                  rarity={cosmetics?.equipmentRarity}
                  slotSize={GEAR_SLOT_SIZE}
                  ownerObjectId={row.objectId}
                  enchantSlots={cosmetics?.enchantSlots}
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

interface DpsDetailBodyProps {
  entry: DpsHistoryEntry
  size: PanelSize
}

/**
 * `key={entry.id}`-remounted by `DpsDetailPanel` on every selection change,
 * so `expandedId`/`showAll` reset to a fresh state instead of leaking a
 * previous session's expanded row into the newly-selected one.
 */
function DpsDetailBody({ entry, size }: DpsDetailBodyProps): React.JSX.Element {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)

  const defaultVisible = DEFAULT_VISIBLE[size]
  const visibleEnemies = showAll ? entry.enemies : entry.enemies.slice(0, defaultVisible)
  const topDamage = totalDamage(entry.enemies[0]?.players ?? [])

  return (
    <div className="flex h-full w-full flex-col gap-1">
      <span className="shrink-0 truncate text-xs font-semibold">{entry.instanceName}</span>
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

/**
 * The large, draggable/resizable detail panel `DpsSummaryPanel` opens on row
 * click (issue #194). Reads the currently-selected session from
 * `useDpsDetailSelection()` (written by `DpsSummaryPanel`) rather than
 * receiving it as a prop - `PanelContentProps` is just `{ size }` for every
 * panel body, so cross-panel data flows through this dedicated context
 * instead. Closing is handled generically by `PanelFrame`'s close control
 * (`registry.ts`'s `closable: true` on this panel type), which unmounts this
 * component - so the unmount cleanup below is what actually notices a close
 * and clears the selection, keeping `DpsSummaryPanel`'s row highlight (which
 * reads the same selection) from outliving the detail panel it implies.
 */
function DpsDetailPanel({ size }: PanelContentProps): React.JSX.Element {
  const { selected, clear } = useDpsDetailSelection()

  useEffect(() => () => clear(), [clear])

  if (!selected) {
    return <EmptyState>No session selected</EmptyState>
  }

  return <DpsDetailBody key={selected.id} entry={selected} size={size} />
}

export default DpsDetailPanel
