/** Clicks on help lines ("✕ Enter □ Delete …") for Play mode scenes; the zones come from effect/buttonZones. */

import { buttonZones } from '../effect/buttonZones'
import type { DuelWindow, WinTables } from '../effect/windows'
import { PAD, type PadInput } from './input'

export { buttonZones, BUTTON_ICON_PAD } from '../effect/buttonZones'

/** The pad bit of the button label under a click on window `w` (0 when none). */
export function clickButtonZone(input: PadInput, w: DuelWindow | undefined, tables: WinTables): number {
  if (!w || !(input.pressed & PAD.POINTER)) return 0
  for (const z of buttonZones(w, tables)) if (input.pointerIn(z.x0, z.y0, z.x1, z.y1)) return z.bit
  return 0
}
