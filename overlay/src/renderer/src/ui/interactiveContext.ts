import { createContext, useContext } from 'react'

/**
 * Whether the overlay is in interactive mode (panels draggable, can capture
 * input) - the same value `App`/`PanelCanvas`/`PanelFrame` already thread
 * down as an explicit `interactive` prop, additionally exposed as a context
 * so a component deep inside a panel body (e.g. `Tooltip`) can read it
 * without every intermediate panel component re-declaring the prop. See
 * `Tooltip`'s docstring for why this matters: its portal renders outside
 * `PanelFrame`'s DOM subtree, so it can't just inherit `pointer-events-none`
 * from an ancestor the way everything else inside a panel does.
 */
export const InteractiveContext = createContext<boolean>(false)

export function useInteractive(): boolean {
  return useContext(InteractiveContext)
}
