/**
 * Mouse support for help lines (Play mode convenience, not in the game): text such as
 * "＠ｂ０Enter ＠ｂ２Delete ＠ｂ１Return ＠ｂ１１Accept ＠ｎ＠ｂ７Move cursor left …" is split into one
 * zone per ＠ｂ button icon, from the icon to the next icon on the same line (or the line's last
 * glyph), so a click on "□ Delete" can press □.
 */

import { layoutText, WF_CENTER_X, WF_CENTER_Y, type DuelWindow, type WinTables } from './windows'

/** ＠ｂN icon ids (etc.one button icons, skin 7) → PSP pad bits. */
export const BUTTON_ICON_PAD: Record<number, number> = {
  0: 0x4000, // ✕
  1: 0x1000, // △
  2: 0x8000, // □
  3: 0x2000, // ○
  7: 0x100, // L
  9: 0x200, // R
  11: 0x8, // START
}

export interface ButtonZone {
  x0: number
  y0: number
  x1: number
  y1: number
  bit: number
}

/** Zones of `text` laid out with its first glyph cell at (left, top), in the same units. */
export function textButtonZones(text: Uint8Array, left: number, top: number, glyph: number | undefined, wide: boolean | undefined, tables: WinTables, originX = 0): ButtonZone[] {
  const lay = layoutText(text, { glyph, tables, wide, originX })
  const g = glyph ?? 20
  const adv = wide ? g + 1 : (g + 1) >> 1
  const line = wide ? g + 2 : g
  const zones: ButtonZone[] = []
  const lines = new Map<number, typeof lay.glyphs>()
  for (const q of lay.glyphs) {
    if (q.k !== 'text' && q.k !== 'icon') continue
    const row = Math.round(q.y / line)
    const l = lines.get(row) ?? []
    l.push(q)
    lines.set(row, l)
  }
  for (const [row, gs] of lines) {
    gs.sort((a, b) => a.x - b.x)
    const end = Math.max(...gs.map((q) => q.x)) + adv
    for (let i = 0; i < gs.length; i++) {
      const q = gs[i]
      if (q.k !== 'icon' || q.skin !== 7) continue
      const bit = BUTTON_ICON_PAD[q.id]
      if (!bit) continue
      const next = gs.slice(i + 1).find((n) => n.k === 'icon' && n.skin === 7)
      zones.push({ x0: left + q.x, x1: left + (next ? next.x : end), y0: top + row * line, y1: top + (row + 1) * line, bit })
    }
  }
  return zones
}

/** Top-left of window `w` as drawn ((x, y) is the centre with the centring flags). */
export function windowOrigin(w: DuelWindow): [number, number] {
  const f = w.flags ?? 0
  return [f & WF_CENTER_X ? w.x - Math.trunc(w.w / 2) : w.x, f & WF_CENTER_Y ? w.y - Math.trunc(w.h / 2) : w.y]
}

/** The button zones of window `w`'s own text, in virtual 640×448 coordinates. */
export function buttonZones(w: DuelWindow, tables: WinTables): ButtonZone[] {
  if (!w.text) return []
  const [left, top] = windowOrigin(w)
  const [ox, oy] = tables.textOffset[w.style ?? 10] ?? [15, 15]
  return textButtonZones(w.text, left + ox, top + oy, w.glyph, w.wide, tables)
}
