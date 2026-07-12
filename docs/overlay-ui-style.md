# Overlay UI style — tokens, primitives, conventions

How the overlay renderer keeps its UI visually consistent, especially as new
panels are added (often by the build agent). Three mechanisms, in order of
force: **semantic design tokens** (Tailwind v4 `@theme`), a small set of
**shared `ui/` primitives**, and the **written conventions** below, which the
PR review agent is expected to flag violations of. For the panel system
itself (frames, registry, sizing) see `overlay-renderer.md`.

Everything here lives under `overlay/src/renderer/src/`; token definitions in
`overlay/src/renderer/src/assets/main.css`, primitives in
`overlay/src/renderer/src/ui/`.

## 1. Design tokens (`assets/main.css`)

The project uses Tailwind v4, so theme configuration is a CSS `@theme` block,
not a JS config file. The tokens are the **only** place raw color and size
values live; component code uses the generated utilities.

### Text emphasis — three levels, no ad-hoc opacities

| Token | Utility | Use for |
| --- | --- | --- |
| `--color-fg` (white) | `text-fg` | primary content: names, values, headings |
| `--color-fg-muted` (75% white) | `text-fg-muted` | secondary: labels, row text, title-bar text |
| `--color-fg-faint` (45% white) | `text-fg-faint` | hints, empty states, timestamps, ghost buttons |

Before tokens the codebase had drifted to **eight** distinct `text-white/NN`
opacities; these three levels replace all of them. Do not reintroduce
`text-white/NN` — if none of the three levels fits, the design should change,
not the token count.

### Structure

| Token | Use for |
| --- | --- |
| `--color-edge` | all borders: panel frames, swatches, inputs |
| `--color-surface` | resting fills: title bars, swatches, enemy-row backgrounds |
| `--color-surface-2` | raised fills: buttons, meter bars, inputs, row hover |
| `--color-surface-3` | hover/focus state of a `surface-2` element |
| `--color-panel` | the translucent black panel/toast backdrop over the game |
| `--color-scrim` | the full-screen dim shown in interactive mode |
| `--color-shell` / `--color-field` | solid window background / input background (ConfigWindow only) |

### Accent roles

| Token | Meaning | Examples |
| --- | --- | --- |
| `--color-accent` | local player, info, primary action | self-row ring/fill, `#rank`/"you" badges, Save button |
| `--color-success` | positive state | connected dot, pinned pin, update available |
| `--color-warn` | attention state | connecting dot, restart-needed, warn logs |
| `--color-danger` | error state | disconnected dot, error logs |

Opacity modifiers on accent tokens are fine where the old design used softened
shades (`text-accent/70`, `ring-accent/70`, `bg-accent/25`).

**Rule: raw Tailwind palette classes (`emerald-500`, `sky-600`, `white/40`,
`neutral-900`, …) are allowed only inside `src/renderer/src/ui/`.** Everywhere
else uses semantic tokens. This is greppable:

```bash
grep -rn "white/\|black/\|text-\[\|emerald-\|sky-\|amber-\|red-\|neutral-" \
  --include="*.tsx" overlay/src/renderer/src | grep -v "/ui/"
```

### Typography

- **Families.** `--font-sans` / `--font-mono` are pinned explicitly in
  `@theme` (currently to the Tailwind defaults). Changing the overlay's font
  is a one-line edit there.
- **The type scale is `text-2xs` (10px, a custom token) / `text-xs` /
  `text-sm` / `text-base`** — nothing else, and **arbitrary sizes
  (`text-[10px]`, `text-[9px]`, …) are banned**. `2xs` is for badges,
  micro-buttons, and secondary figures; `base` only for the featured numeric
  value in a `StatRow`.
- **Weights**: `font-medium` and `font-semibold` only.
- **Base typography is set in exactly two places** and nowhere else:
  `PanelFrame`'s content wrapper (`text-sm text-fg` — every panel body
  inherits it) and `ConfigWindow`'s root. Panel components must **not**
  re-declare `text-sm`/`text-fg` on their roots.
- **Numeric readouts** (damage, DPS, counters, memory) are
  `font-mono tabular-nums` so constantly-updating digits don't jitter or
  reflow. `StatRow` and the damage figures in the DPS panels already do this.

## 2. The `ui/` primitives

One component per file in `overlay/src/renderer/src/ui/`, named exports. These
exist because each pattern had 3–9 hand-rolled copies that had already drifted
apart; new code must use them instead of re-rolling the markup.

| Primitive | Use for | Key props |
| --- | --- | --- |
| `EmptyState` | the muted "nothing to show yet" line every panel needs | `children` |
| `Swatch` | bordered placeholder box for an unknown sprite / empty slot | `size` (px), `className?` |
| `GearRow` | a player's 4 equipment-slot icons (placeholder swatches for empty slots) | `equipment` (nullable), `slotSize` (px; `<= 0` renders nothing) |
| `MeterRow` | list row with a proportional damage-bar fill behind its content | `fillPct` (0–100, clamped), `highlight?` (local player: accent ring + tinted fill), `onClick?` (renders a `<button>`), `className?` |
| `Button` | every button | `variant`: `subtle` (default) \| `ghost` \| `primary` \| `success` \| `warn`; `size`: `xs` \| `sm` (default) \| `md`; `active?` (ghost toggles, e.g. the pin); plus native button props |
| `StatRow` | label-left / mono-tabular-value-right line | `label`, `children`, `className?` |

Conventions for the primitives themselves:

- `className` on a primitive is for **layout only** (margins, `shrink-0`,
  `w-full`, dividers) — never colors or font sizes; those are the primitive's
  own business.
- `MeterRow`'s fill markup (absolute fill div under a `relative z-10` content
  wrapper, clipped by `overflow-hidden`) is deliberately non-obvious — that's
  why it's a primitive. Don't rebuild it inline.
- Filled `Button` shades (`bg-sky-600 hover:bg-sky-500`, …) are the one place
  raw palette classes are expected; they stay inside `ui/Button.tsx`.

## 3. Conventions that stay conventions (not components)

- **Per-size scale tables**: `const FOO_SIZE: Record<PanelSize, number> =
  { sm: …, md: …, lg: … }` at the top of the panel file, indexed by the `size`
  prop. Every panel does this; keep doing it — it's clear and type-safe, and
  wrapping it would hide the numbers that most need eyeballing.
- **Progressive disclosure by size**: gate optional lines on
  `size !== 'sm'` (and rarely `size === 'lg'`), as `StatusPanel` does; at `sm`
  a panel shows only its headline content.
- **Sprites and placeholders**: unresolved visuals must render a stable
  `Swatch`, never nothing (`CharacterSprite` and `GearRow` already guarantee
  this) — a blank gap reads as a bug on an overlay.

## 4. Enforcement

- This doc is normative: the PR review agent should treat raw palette classes
  outside `ui/`, arbitrary `text-[…]` sizes, re-rolled copies of a primitive's
  markup, or a panel re-declaring base typography as findings.
- The grep in §1 is the quick mechanical check for the color rule.
- Optional future hardening (not yet in place): `prettier-plugin-tailwindcss`
  for canonical class ordering, and a CI grep tripwire for the §1 rule.
