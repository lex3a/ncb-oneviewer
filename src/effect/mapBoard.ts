/**
 * The map board as mapBoardScene (0x0884CDD4) draws it: the billboarded area background and scenery,
 * the square tiles, range marks, cursor, unit tokens with shadows and markers, cell decorations, seize
 * walls, the cursor hand, the status HUD and the unit hover panel; and the drawing parts of its state
 * machine: the command ring, straight-leg moves with move lines, move preview, the walking GAN and
 * seizing, the hand panel and deployment, the turn banner and report, all map windows (WindowPainter).
 * See docs/formats/map-board.md.
 *
 * Every board sprite goes through the map camera g_mapCamera (a copy of the 2D-sorted context, focal
 * 32768, render mode 1): spriteUpdateVertices builds the four corners (pivot + offset + trunc(R·S·
 * (corner − pivot)), R = Rx·Ry·Rz), spriteDraw2D / spriteDrawBoundTex add (x, y), project each corner
 * with the camera's view-projection matrix and a perspective divide, round to an integer GE coordinate
 * and truncate x·480/640, y·272/448 (spriteDraw2DRounded: ·0.75, ·0.60714287, +0.5). The quad is sent in
 * through mode, so the texture is mapped affinely on screen. Every draw carries GE depth
 * 0x7FFF − 0x7FFF = 0 (HUD 0x7FFF, text 0xFFFF), so the GEQUAL depth test always passes and the frame is
 * pure painter's order; the renderer therefore draws with the depth test off.
 */
import { glyphPixels, sjisToGlyph } from '../formats/font'
import { ganSheet, isMarker, type Gan } from '../formats/gan'
import { asciiToSjis, type GameDb, type MapBoard } from '../formats/gamedb'
import type { RgbaImage } from '../formats/palette'
import type { BlendMode, GlRenderer, Vertex } from './gl'
import { fontCodes, FONT_NEWLINE, readCardScreenTables, tabAt, type CardScreenTables } from './cardScreen'
import { layoutText, readWinTables, WF_CENTER_X, WF_CENTER_Y, WF_MENU, WF_SCROLLBAR, WIN_CURSOR_COLORS, WindowPainter, type DuelWindow, type WinTables } from './windows'
import { A, blankPlayer, cardType, CT_BASE, CT_CHARA, CT_SPELL, CT_UNIT, MapGame, type Player, type RAbility, type RCard, type Unit } from './mapRules'
import { gameRng } from './gameRand'
import type { EffectScene, MapEffectHooks } from './scene'
import type { StoryPlayer } from './story'
import type { StoryScript, StoryTrigger } from '../formats/gamedb'
import { MapFlows, sprintf, PAD_CIRCLE, PAD_CROSS, PAD_POINTER, PAD_POINTER_MIDDLE, PAD_POINTER_RIGHT, PAD_DOWN, PAD_L, PAD_LEFT, PAD_R, PAD_RIGHT, PAD_SQUARE, PAD_START, PAD_TRIANGLE, PAD_UP, S, sj, type FlowHost, type WinRef } from './mapFlows'
import { MapAi, type AiHost } from './mapAi'
import { textButtonZones, windowOrigin } from './buttonZones'
import { readExtrasTables, RulesHelpScene } from './extras'
import type { UnitContext } from './duel'

export const SCREEN_W = 480
export const SCREEN_H = 272

// ---------------------------------------------------------------------------------------------
// tables read from BOOT.BIN

const ADDR = {
  /** g_mapCellDecoTable: [18 layouts][16] × 0x24. */
  cellDeco: 0x088dd2a8,
  /** g_mapDecoLayouts: [18 layouts][8] × 0xB0 (scenery around the board). */
  decoLayouts: 0x088dfb28,
  /** g_mapDecoScale (float 1.06). */
  decoScale: 0x088dcf50,
  /** g_mapBgPosVariant0 / 1: s16 (x, y) per area 1..10. */
  bgPos0: 0x088dd258,
  bgPos1: 0x088dd280,
  /** g_mapBgCounts: u8 at [area·2]. */
  bgCounts: 0x088e5e26,
  /** g_mapDecoSpriteCounts: u8 at [area]. */
  decoCounts: 0x088e5e3b,
  /** Zoom byte used by mapSetupCameraMatrix (initial 100). */
  zoom: 0x088dd257,
  /** mapCmdMenuUpdate: char *labels[9] ("Move", "Card", … "Standby"), indexed by command bit. */
  cmdNames: 0x088b86e8,
  /** mapCmdMenuDrawRing: s32 u[12] and v[12] of the 64×64 icons in etc.one 110/1, by command bit. */
  ringU: 0x088b870c,
  ringV: 0x088b873c,
  /** uiDrawDigitBound cell table (g_uiDigitBoundCells): style 0 u0,v0, style 1 u0,v0, then w,h per style. */
  digitBound: 0x088b9f88,
  /** uiDrawPointerHand frames: u8 u[6], u8 v[6]. */
  handFrames: 0x088b8664,
  // Texts passed to winOpenMessage / winPrintAt.
  /** "Ending turn. ＠ｎIs it all right? " (mapBoardScene state 9000, command 4). */
  txtEndTurn: 0x088dd1e4,
  /** "＠ｂ０Accept ＠ｂ３Cancel " */
  txtAcceptCancel: 0x088dd048,
  /** handSelectUpdate help lines: "＠ｂ０Accept ", "＠ｂ１Card details ", "＠ｂ２Check board ", "＠ｂ３End ". */
  txtHandAccept: 0x088e6048,
  txtHandDetails: 0x088e6058,
  txtHandBoard: 0x088e6080,
  txtHandEnd: 0x088e60a4,
  /** turnReportShow: "＠ｂ２Change view ", "Unit name", "HP". */
  txtReportHelp: 0x088b9ff0,
  txtReportUnit: 0x088ba004,
  txtReportHp: 0x088ba010,
  /** handSelectUpdate state 9000: "Ending card usage. ＠ｎIs it all right? " and "＠ｂ０Accept ＠ｂ３Cancel ". */
  txtEndCard: 0x088e6140,
  txtAcceptCancel2: 0x088e6124,
  /** mapFormatAreaName: char *names[10] (area 1..10). */
  areaNames: 0x088b9f2c,
  /** uiDrawDigit cell table: style 0 u0, v0, style 1 u0, v0, then w, h per style, then the default RGBA. */
  digitCells: 0x088b9f94,
}

/** Texts that are string literals in the code (inline in the instruction stream, not a table). */
const TXT = {
  moveTarget: 'Please specify the movement target. ',
  selectCard: 'Please select the card to use. ',
  noCards: 'There are no cards that can be selected. ',
  deploy: 'Please select the location to deploy. ',
  noDeploy: 'You cannot deploy any more units. ',
  deployCount: 'Number of allowed deployment: %d ',
  deployOk: 'Is it all right to deploy? ',
  noTarget: 'No target ',
}

/** One g_mapCellDecoTable entry: a decoration standing on a square, drawn in the unit pass. */
export interface CellDeco {
  sprite: number
  cellX: number
  cellY: number
  dx: number
  dy: number
  sx: number
  sy: number
  rect: [number, number, number, number]
}

/** One g_mapDecoLayouts record: an animated piece of scenery placed in the background plane. */
export interface Scenery {
  area: number
  /** Animation slot (frame counter index). */
  slot: number
  frames: number
  /** +4: −1 for scenery; a value ≥ 0 stops the list (never present in the data). */
  cell: number
  x: number
  y: number
  sx: number
  sy: number
  blend: number
  delay: number
  /** Per frame: sprite index into the area's decoration sprites and rect u, v, w, h. */
  frameSprite: number[]
  frameRect: [number, number, number, number][]
}

export interface MapBoardTables {
  cellDeco: CellDeco[][]
  scenery: Scenery[][]
  decoScale: number
  /** [variant][area] → background origin (x, y). */
  bgPos: [number, number][][]
  bgCounts: number[]
  decoCounts: number[]
  zoomInit: number
  card: CardScreenTables
  win: WinTables
  /** Command labels by bit (0 Move, 1 Card, 2 End turn, 3 Help, 4 To title, 5 Temp save, 6 Skills, 7 Attack, 8 Standby). */
  cmdNames: Uint8Array[]
  /** Ring icon (u, v) by command bit. */
  ringRects: [number, number][]
  /** uiDrawDigitBound cells: style 0 / 1 → u0, v0, w, h. */
  digitBound: [number, number, number, number][]
  handFrames: { u: number[]; v: number[] }
  text: Record<'endTurn' | 'acceptCancel' | 'endCard' | 'acceptCancel2' | 'handAccept' | 'handDetails' | 'handBoard' | 'handEnd' | 'reportHelp' | 'reportUnit' | 'reportHp', Uint8Array>
  /** mapFormatAreaName strings by area 1..10. */
  areaNames: Uint8Array[]
  /** uiDrawDigit cells: style 0 / 1 → u0, v0, w, h. */
  digitCells: [number, number, number, number][]
}

export function readMapBoardTables(db: GameDb): MapBoardTables {
  const bytes = (a: number, n: number) => {
    const b = db.raw.bytes(a, n)
    return new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  const cellDeco: CellDeco[][] = []
  for (let l = 0; l < 18; l++) {
    const list: CellDeco[] = []
    for (let k = 0; k < 16; k++) {
      const d = bytes(ADDR.cellDeco + l * 0x240 + k * 0x24, 0x24)
      if (d.byteLength < 0x24 || d.getUint8(0) === 0) break
      list.push({
        sprite: d.getUint8(2),
        cellX: d.getInt32(4, true),
        cellY: d.getInt32(8, true),
        dx: d.getInt32(0xc, true),
        dy: d.getInt32(0x10, true),
        sx: d.getFloat32(0x14, true),
        sy: d.getFloat32(0x18, true),
        rect: [d.getUint16(0x1c, true), d.getUint16(0x1e, true), d.getUint16(0x20, true), d.getUint16(0x22, true)],
      })
    }
    cellDeco.push(list)
  }
  const scenery: Scenery[][] = []
  for (let l = 0; l < 18; l++) {
    const list: Scenery[] = []
    for (let k = 0; k < 8; k++) {
      const d = bytes(ADDR.decoLayouts + l * 0x580 + k * 0xb0, 0xb0)
      if (d.byteLength < 0xb0 || d.getUint8(0) === 0) break
      const frames = d.getUint8(2)
      const frameSprite: number[] = []
      const frameRect: [number, number, number, number][] = []
      for (let f = 0; f < 16; f++) {
        frameSprite.push(d.getUint8(0x1e + f))
        const o = 0x2e + f * 8
        frameRect.push([d.getUint16(o, true), d.getUint16(o + 2, true), d.getUint16(o + 4, true), d.getUint16(o + 6, true)])
      }
      list.push({
        area: d.getUint8(0),
        slot: d.getUint8(1),
        frames,
        cell: d.getInt32(4, true),
        x: d.getInt32(0xc, true),
        y: d.getInt32(0x10, true),
        sx: d.getFloat32(0x14, true),
        sy: d.getFloat32(0x18, true),
        blend: d.getUint8(0x1c),
        delay: d.getUint8(0x1d),
        frameSprite,
        frameRect,
      })
    }
    scenery.push(list)
  }
  const pos = (a: number) => {
    const d = bytes(a, 40)
    const out: [number, number][] = [[0, 0]]
    for (let i = 0; i < 10; i++) out.push(d.byteLength >= 40 ? [d.getInt16(i * 4, true), d.getInt16(i * 4 + 2, true)] : [0, 0])
    return out
  }
  const cstr = (a: number) => {
    const b = db.raw.bytes(a, 160)
    const end = b.indexOf(0)
    return b.slice(0, end < 0 ? b.length : end)
  }
  const u32 = (a: number) => {
    const d = bytes(a, 4)
    return d.byteLength === 4 ? d.getUint32(0, true) : 0
  }
  const s32 = (a: number) => u32(a) | 0
  const db2 = db.raw.bytes(ADDR.digitBound, 8)
  const hf = db.raw.bytes(ADDR.handFrames, 14)
  const bc = db.raw.bytes(ADDR.bgCounts, 22)
  const dc = db.raw.bytes(ADDR.decoCounts, 11)
  const sc = bytes(ADDR.decoScale, 4)
  return {
    cellDeco,
    scenery,
    decoScale: sc.byteLength === 4 ? sc.getFloat32(0, true) : 1.06,
    bgPos: [pos(ADDR.bgPos0), pos(ADDR.bgPos1)],
    bgCounts: Array.from({ length: 11 }, (_, a) => bc[a * 2] ?? 0),
    decoCounts: Array.from({ length: 11 }, (_, a) => (a ? dc[a] ?? 0 : 0)),
    zoomInit: db.raw.bytes(ADDR.zoom, 1)[0] ?? 100,
    card: readCardScreenTables(db),
    win: readWinTables(db),
    cmdNames: Array.from({ length: 9 }, (_, i) => cstr(u32(ADDR.cmdNames + i * 4))),
    ringRects: Array.from({ length: 9 }, (_, i): [number, number] => [s32(ADDR.ringU + i * 4), s32(ADDR.ringV + i * 4)]),
    digitBound: [
      [db2[0] ?? 0, db2[1] ?? 40, db2[4] ?? 18, db2[5] ?? 24],
      [db2[2] ?? 0, db2[3] ?? 0, db2[6] ?? 24, db2[7] ?? 32],
    ],
    handFrames: { u: Array.from(hf.subarray(0, 6)), v: Array.from(hf.subarray(8, 14)) },
    areaNames: Array.from({ length: 11 }, (_, a) => (a ? cstr(u32(ADDR.areaNames + (a - 1) * 4)) : new Uint8Array(0))),
    digitCells: (() => {
      const d = db.raw.bytes(ADDR.digitCells, 8)
      return [
        [d[0] ?? 0, d[1] ?? 40, d[4] ?? 18, d[5] ?? 24],
        [d[2] ?? 0, d[3] ?? 0, d[6] ?? 24, d[7] ?? 32],
      ] as [number, number, number, number][]
    })(),
    text: {
      endTurn: cstr(ADDR.txtEndTurn),
      acceptCancel: cstr(ADDR.txtAcceptCancel),
      endCard: cstr(ADDR.txtEndCard),
      acceptCancel2: cstr(ADDR.txtAcceptCancel2),
      handAccept: cstr(ADDR.txtHandAccept),
      handDetails: cstr(ADDR.txtHandDetails),
      handBoard: cstr(ADDR.txtHandBoard),
      handEnd: cstr(ADDR.txtHandEnd),
      reportHelp: cstr(ADDR.txtReportHelp),
      reportUnit: cstr(ADDR.txtReportUnit),
      reportHp: cstr(ADDR.txtReportHp),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// cameras and sprites

type V3 = [number, number, number]

/** A render context of mode 1 (2D sorted): eye, rotation (M = Rz·Ry·Rx), focal and zoom. */
interface Cam {
  eye: V3
  rot: V3
  focal: number
  zoom: number
}

/** g_camDefault2DSorted: eye (320, 224, −32768), focal 32768, no rotation: screen = world at z = 0. */
const CAM_2D: Cam = { eye: [320, 224, -32768], rot: [0, 0, 0], focal: 32768, zoom: 1 }

/** sceVfpuViewScreenMatrix · sceVfpuCameraMatrix: q = Mᵀ(P − eye), virtual = (320, 224) + f·zoom·q.xy / q.z. */
function project(cam: Cam, p: V3): [number, number] {
  let x = p[0] - cam.eye[0], y = p[1] - cam.eye[1], z = p[2] - cam.eye[2]
  const [rx, ry, rz] = cam.rot
  if (rz) {
    const c = Math.cos(rz), s = Math.sin(rz)
    ;[x, y] = [x * c + y * s, -x * s + y * c]
  }
  if (ry) {
    const c = Math.cos(ry), s = Math.sin(ry)
    ;[x, z] = [x * c - z * s, x * s + z * c]
  }
  if (rx) {
    const c = Math.cos(rx), s = Math.sin(rx)
    ;[y, z] = [y * c + z * s, -y * s + z * c]
  }
  const f = cam.focal * cam.zoom
  return [320 + (f * x) / z, 224 + (f * y) / z]
}

/** sceVfpuMatrix4Rot as spriteUpdateVertices uses it: Z first, then Y, then X (R = Rx·Ry·Rz). */
function rotZYX(x: number, y: number, z: number, rx: number, ry: number, rz: number): V3 {
  if (rz) {
    const c = Math.cos(rz), s = Math.sin(rz)
    ;[x, y] = [x * c - y * s, x * s + y * c]
  }
  if (ry) {
    const c = Math.cos(ry), s = Math.sin(ry)
    ;[z, x] = [z * c - x * s, z * s + x * c]
  }
  if (rx) {
    const c = Math.cos(rx), s = Math.sin(rx)
    ;[y, z] = [y * c - z * s, y * s + z * c]
  }
  return [x, y, z]
}

const PI_F = 3.1415927
const wrapAngle = (a: number) => {
  while (a >= PI_F) a -= 6.2831855
  while (a < -PI_F) a += 6.2831855
  return a
}

/** spriteSetColor nibble: ((c·255) >> 11) & 15 for r/g/b, ((a·255) >> 7) >> 4 & 15 for alpha. */
const nib = (c: number) => ((Math.trunc(c) * 255) >> 11) & 0xf
const nibA = (a: number) => (((Math.trunc(a) * 255) >> 7) >> 4) & 0xf

/** The subset of the game's Sprite (0x204 bytes) that the map draw code touches. */
class Spr {
  img: RgbaImage | null
  /** sprite->width / height: the GBP size. */
  w: number
  h: number
  u = [0, 0, 0, 0]
  v = [0, 0, 0, 0]
  rectW = 0
  rectH = 0
  cx = [0, 0, 0, 0]
  cy = [0, 0, 0, 0]
  cz = [0, 0, 0, 0]
  pivot: V3 = [0, 0, 0]
  offset: V3 = [0, 0, 0]
  rot: V3 = [0, 0, 0]
  /** spriteSetWorldRotation (+0x1D0 world): applied after pivot + offset, before the draw position. */
  wrot: V3 = [0, 0, 0]
  sx = 1
  sy = 1
  /** Bit 1 rotation, 2 world rotation, 4 scale, 0x80 vertex colour. */
  flags = 0
  blend = 0
  col = [15, 15, 15, 15]
  cam: Cam = CAM_2D
  private verts: V3[] | null = null

  constructor(img: RgbaImage | null) {
    this.img = img
    this.w = img?.width ?? 0
    this.h = img?.height ?? 0
    // spriteLoadBuffer: spriteSetSrcRect(0, 0, w, h)
    this.srcRect(0, 0, this.w, this.h, true)
  }

  srcRect(u0: number, v0: number, u1: number, v1: number, force = false) {
    if (!force && this.u[0] === u0 && this.v[0] === v0 && this.u[3] === u1 && this.v[3] === v1) return
    this.u = [u0, u1, u0, u1]
    this.v = [v0, v0, v1, v1]
    this.rectW = u1 - u0
    this.rectH = v1 - v0
    const [ox, oy, oz] = this.offset
    this.cx = [ox, ox + this.rectW, ox, ox + this.rectW]
    this.cy = [oy, oy, oy + this.rectH, oy + this.rectH]
    this.cz = [oz, oz, oz, oz]
    this.pivot = [0, 0, 0]
    this.verts = null
  }

  setPivot(px: number, py: number) {
    if (this.pivot[0] === px && this.pivot[1] === py) return
    for (let i = 0; i < 4; i++) {
      this.cx[i] += this.pivot[0] - px
      this.cy[i] += this.pivot[1] - py
    }
    this.pivot = [px, py, this.pivot[2]]
    this.verts = null
  }

  /** spriteSetAnchor: 0x10 centre; else 1 top, 2 bottom, 8 left, 4 right (default centre). */
  anchor(a: number) {
    let px = Math.trunc(this.rectW / 2), py = Math.trunc(this.rectH / 2)
    if (!(a & 0x10)) {
      if (a & 1) py = 0
      if (a & 2) py = this.rectH
      if (a & 8) px = 0
      if (a & 4) px = this.rectW
    }
    this.setPivot(px, py)
  }

  pos(x: number, y: number, z: number) {
    if (this.offset[0] === x && this.offset[1] === y && this.offset[2] === z) return
    this.offset = [x, y, z]
    this.verts = null
  }

  resetOffset() {
    this.pos(-this.pivot[0], -this.pivot[1], -this.pivot[2])
  }

  setRot(rx: number, ry: number, rz: number) {
    rx = wrapAngle(rx)
    ry = wrapAngle(ry)
    rz = wrapAngle(rz)
    if (this.rot[0] === rx && this.rot[1] === ry && this.rot[2] === rz) return
    this.rot = [rx, ry, rz]
    this.flags = rx === 0 && ry === 0 && rz === 0 ? this.flags & ~1 : this.flags | 1
    this.verts = null
  }

  /** spriteSetWorldRotation: flag 2; spriteUpdateVertices then rotates pivot + offset + R·S·corner as floats and truncates. */
  setWorldRot(rx: number, ry: number, rz: number) {
    rx = wrapAngle(rx)
    ry = wrapAngle(ry)
    rz = wrapAngle(rz)
    if (this.wrot[0] === rx && this.wrot[1] === ry && this.wrot[2] === rz) return
    this.wrot = [rx, ry, rz]
    this.flags = rx === 0 && ry === 0 && rz === 0 ? this.flags & ~2 : this.flags | 2
    this.verts = null
  }

  setScale(sx: number, sy: number) {
    if (this.sx === sx && this.sy === sy) return
    this.sx = sx
    this.sy = sy
    this.flags = sx === 1 && sy === 1 ? this.flags & ~4 : this.flags | 4
    this.verts = null
  }

  setColor(r: number, g: number, b: number, a: number) {
    if (r >= 0) this.col[0] = nib(r)
    if (g >= 0) this.col[1] = nib(g)
    if (b >= 0) this.col[2] = nib(b)
    if (a >= 0) this.col[3] = nibA(a)
    this.flags |= 0x80
    if (r === 0x80 && g === 0x80 && b === 0x80 && a === 0x80) this.flags &= ~0x80
  }

  /** spriteUpdateVertices (0x08880E60), without the post-scale (flag 8), which the map never sets. */
  vertices(): V3[] {
    if (this.verts) return this.verts
    const out: V3[] = []
    for (let i = 0; i < 4; i++) {
      let x = this.cx[i], y = this.cy[i], z = this.cz[i]
      if (this.flags & 4) {
        x *= this.sx
        y *= this.sy
      }
      if (this.flags & 1) [x, y, z] = rotZYX(x, y, z, this.rot[0], this.rot[1], this.rot[2])
      if (this.flags & 2) {
        const w = rotZYX(this.pivot[0] + this.offset[0] + x, this.pivot[1] + this.offset[1] + y, this.pivot[2] + this.offset[2] + z, this.wrot[0], this.wrot[1], this.wrot[2])
        out.push([Math.trunc(w[0]), Math.trunc(w[1]), Math.trunc(w[2])])
      } else out.push([this.pivot[0] + this.offset[0] + Math.trunc(x), this.pivot[1] + this.offset[1] + Math.trunc(y), this.pivot[2] + this.offset[2] + Math.trunc(z)])
    }
    this.verts = out
    return out
  }

  color(): [number, number, number, number] {
    if (!(this.flags & 0x80)) return [1, 1, 1, 1]
    return [this.col[0] / 15, this.col[1] / 15, this.col[2] / 15, this.col[3] / 15]
  }
}

// ---------------------------------------------------------------------------------------------
// scene

export interface MapBoardAssets {
  /** map.one area·1000 + variant·100 + i. */
  background: (RgbaImage | null)[]
  /** map.one 1 / area·100 + k (g_mapDecoSprites). */
  deco: (RgbaImage | null)[]
  /** etc.one 100 / 1..3: tiles, cursor, seize wall. */
  tiles: RgbaImage | null
  cursor: RgbaImage | null
  wall: RgbaImage | null
  /** etc.one 110 / 3..7: status panel, hover banner, Dominator flag, shadow, "E" (acted) marker. */
  status: RgbaImage | null
  banner: RgbaImage | null
  flag: RgbaImage | null
  shadow: RgbaImage | null
  acted: RgbaImage | null
  /** etc.one 2/1 digits, 2/2 pointer hand, 1/11 attribute icons. */
  digits: RgbaImage | null
  hand: RgbaImage | null
  icons: RgbaImage | null
  font: Uint8Array | null
  /** card.one 10010 / card id: board tokens. */
  token: (cardId: number) => RgbaImage | null
  /** unit.one card id / 1 (48×50; cardLoadUnitImage mode 1, size 0): hover-panel picture. */
  picture: (cardId: number) => RgbaImage | null
  /** etc.one 110/1: command-ring icons (Sprite_08A1BF80). */
  ring?: RgbaImage | null
  /** etc.one 110/2: hand-panel labels (Sprite_08A1C290). */
  handLabels?: RgbaImage | null
  /** card.one 10001 / card id (80×100, cardPicLoadRef size 1); id 0 → member 1000 (the card back). */
  cardPic?: (cardId: number) => RgbaImage | null
  /** unit.one card id / 12 and / 13: the walking animations (mapLoadUnitBoardAnim). */
  walk?: (cardId: number) => [Gan | null, Gan | null]
  /** The 15 window skins (loadWinSkins). */
  winSkins?: (RgbaImage | null)[]
  /** unit.one card id / 3 (cardLoadUnitImage size 2): the picture of a newly drawn card. */
  drawPicture?: (cardId: number) => RgbaImage | null
  /** effectStart: the effect.one script 1000 + id as an effect scene with the map's script hooks. */
  effect?: (id: number, hooks: MapEffectHooks) => EffectScene | null
  /** msgEventStart: a story event player for a script of g_apMsgEventTables. */
  story?: (script: StoryScript) => StoryPlayer | null
  /** chara.one 100 / character 1..11 (result portraits) and 100 / 1000 (result sheet). */
  portrait?: (index: number) => RgbaImage | null
  resultSheet?: RgbaImage | null
  /** etc.one 2/3: New / Get badges (Sprite_089b51e8). */
  badge?: RgbaImage | null
}

/** MapUnit as the board uses it (src/effect/mapRules.ts). */
export type MapUnitState = Unit
/** DuelPlayer as the hand panel uses it. */
export type HandPlayer = Player

export type RangeOverlay = 'none' | 'summon' | 'forbidden' | 'range'

export interface MapBoardOptions {
  statusHud: boolean
  hoverPanel: boolean
  cursorMarker: boolean
  /** DAT_089B5A27 (SELECT in modes 1/2): 0 none, 1 AP, 2 HP, 3 DF over the tokens. */
  statOverlay: number
  overlay: RangeOverlay
  /** g_mapBoardState 0x1E: the command menu is open on a unit (camera zooms in). */
  menuZoom: boolean
}

export { PAD_UP, PAD_RIGHT, PAD_DOWN, PAD_LEFT, PAD_CIRCLE, PAD_SELECT, PAD_START, PAD_TRIANGLE, PAD_CROSS, PAD_SQUARE, PAD_L, PAD_R } from './mapFlows'

/** g_mapBoardState values the viewer runs (mapBoardScene). */
export const STATE = {
  banner: 10,
  turnStart: 0xb,
  hand: 0x10,
  free: 0x14,
  menu: 0x1e,
  dispatch: 0x28,
  moveTarget: 1000,
  walk: 0x3f2,
  moveDone: 0x44c,
  undo: 0x4b0,
  deploySetup: 0xbc2,
  deployPick: 0xc1c,
  deployConfirm: 0xc26,
  deploy: 0xc30,
  cpu: 0x13,
  attack: 2000,
  attackConfirm: 0x7da,
  battleStart: 0x834,
  battlePrep: 0x83e,
  duel: 0x898,
  battleAfter: 0x8a2,
  battleSkip: 0x8fc,
  deaths: 0xb54,
  skill: 4000,
  toTitle: 5000,
  toTitleConfirm: 0x1392,
  tempSave: 6000,
  help: 7000,
  spell: 0xc80,
  actionEnd: 9000,
  afterAction: 0x238c,
  discard: 0x26ac,
  discardPick: 0x26b6,
  turnEnd: 0x26c0,
  win0: 10000,
  win1: 11000,
  draw: 0x2cec,
  init: 1,
  areaName: 2,
  areaWait: 3,
  conditions: 5,
  conditionsWait: 6,
  startPick: 7,
  startConfirm: 8,
  startPlace: 9,
  exit: 12000,
} as const

/** g_camDefault3D with eye (128, 256, −640) and no rotation: g_mapHudCam3D, used only by the command ring. */
const CAM_HUD3D: Cam = { eye: [128, 256, -640], rot: [0, 0, 0], focal: 768, zoom: 1 }

const ROT_BILLBOARD: V3 = [-1.134464, 0.5235988, -0.20943952]
const ROT_BILLBOARD_UNIT: V3 = [-1.1344638, 0.5235987, -0.20943947]

type Quad = { x: number; y: number }[]

export class MapBoardScene {
  readonly board: MapBoard
  readonly layout: number
  private db: GameDb
  private t: MapBoardTables
  private a: MapBoardAssets
  /** The game state behind the board (map state block, MapUnit and DuelPlayer records). */
  game: MapGame
  /** The step machines between commands (turn start, deaths, abilities, spells, battles, summons). */
  flows: MapFlows
  /** The CPU (aiMapTurnUpdate) and which players it controls (DuelPlayer.controller ≥ 2). */
  ai: MapAi
  opts: MapBoardOptions = { statusHud: true, hoverPanel: true, cursorMarker: true, statOverlay: 0, overlay: 'none', menuZoom: false }
  /** Pressed pad bits (held). */
  pad = 0
  /** g_mapCursorX / Y in world units (square × 64 while at rest); shared with the game state. */
  cursor: { x: number; y: number }
  private stepX = 0
  private stepY = 0
  private zoomK: number
  /** g_mapCamera: board draws use last frame's matrix (mapSetupCameraMatrix runs after them). */
  private cam: Cam
  private pulse = 0
  private pulseDir = 2
  private blinkOn = 0
  private animCounter3 = 0
  private decoCounter = new Array(16).fill(0)
  private decoFrame = new Array(16).fill(0)
  /** +0x24540: 1 growing, 2 shrinking, 0 idle; and g_mapSeizeFxAnim. */
  seizeState: Uint8Array
  private seizeAnim = new Uint8Array(1600)
  handPlayer = 0
  get turnPlayer() {
    return this.game.turnPlayer
  }
  set turnPlayer(v: number) {
    this.game.turnPlayer = v
  }
  playerNames: string[] = ['Player', 'CPU']
  frameNo = 0
  /** Viewer: how many times New game restarted this scene with the same seed. */
  restarts = 0
  /** Screen quads of the squares in the last rendered frame (viewer: click → cell). */
  cellQuads = new Map<number, Quad>()

  private gl: GlRenderer | null = null
  private sprTiles: Spr
  private sprCursor: Spr
  private sprWall: Spr
  private sprBg: Spr[]
  private sprDeco: Spr[]
  private sprStatus: Spr
  private sprBanner: Spr
  private sprFlag: Spr
  private sprShadow: Spr
  private sprActed: Spr
  private sprDigits: Spr
  private sprHand: Spr
  private sprIcons: Spr
  private tokens = new Map<number, Spr>()
  private pictures = new Map<number, Spr>()
  private glyphs = new Map<number, RgbaImage>()
  private sprRing: Spr
  private sprLabels: Spr
  private sprNum: Spr
  private sprPointer: Spr
  private cardPics = new Map<number, Spr>()
  private painter: WindowPainter | null = null
  /** rulesHelpScene while the Help command (7000) runs. */
  private rulesHelp: RulesHelpScene | null = null

  // ---- game state (mapBoardScene globals) ----
  /** g_mapBoardState. */
  state: number = STATE.free
  /** Pad bits pressed this frame (padGetPressed); cleared after every frame. */
  pressed = 0
  /** Play mode's mouse (viewer convenience): position in virtual 640×448 units (-1 outside) and whether it moved this frame. */
  pointer = { x: -1, y: -1, moved: false }
  /** The help label under the mouse (drawn with the menu cursor's bar). */
  private helpHover: { key: string; x0: number; y0: number; x1: number; y1: number } | null = null
  /**
   * Mouse (ours): the camera's focus. The game's camera always sits on the cursor (mapSetupCameraMatrix(cursor)),
   * so a cursor the mouse moves would scroll the board under a still pointer. While the mouse drives the cursor
   * the focus stays put (edge scrolling only near the screen edges); otherwise it is the cursor, as in the game
   * (after mouse use it eases back to it).
   */
  private camFocus: { x: number; y: number } | null = null
  private mouseCam = false
  private camEase = false
  private mouseSet = { x: -1, y: -1 }
  /** cursorUpdate ran this frame (a free-cursor state). */
  private cursorCalled = false
  /** A left click on a square: ✕ on the next frame, once the cursor rests there. */
  private mouseCross = false
  /** Unit sprites of the last drawn board (alpha-tested mouse hits, later draws on top). */
  private unitHits: { cell: [number, number]; pts: [number, number][]; img: RgbaImage; u: number[]; v: number[] }[] = []
  /** Command-ring icons of the last drawn ring (list index, angle, screen quad) and the mouse's target icon. */
  private ringHits: { k: number; j: number; pts: [number, number][] }[] = []
  private ringTarget = -1
  private ringClick = false
  private ringUnder = -1
  /** g_mapActiveUnit (also drawn a second time as the "lifted" unit by mapDrawAllUnits). */
  active: MapUnitState | null = null
  /** g_mapCommand, g_mapActionFlags, g_mapReturnState. */
  command = 0
  actionFlags = 0
  private returnState = 0
  /** g_mapMovePoints, g_mapMoveSteps (nibble stack for undo), DAT_089B5A0C (squares this leg), g_mapMoveSegCount, g_mapMovePath. */
  private movePoints = 0
  private moveSteps = 0
  private stepCount = 0
  private segCount = 0
  private path: number[] = []
  /** g_mapDrawFlags 0x40 (move preview / range shown). */
  previewOn = false
  /** g_mapMovePreview / g_mapRangeGrid / the conquest words live in the game state. */
  private get preview() {
    return this.game.preview
  }
  private get marks() {
    return this.game.marks
  }
  get conquest() {
    return this.game.conquest
  }
  /** g_mapCmdMenu: item count, bits, selected, shown, angle (degrees). */
  private cmd = { count: 0, bits: 0, sel: 0, shown: 0, angle: 0 }
  /** DAT_08A1BDE4: draw the command ring this frame. */
  private ringOn = false
  /** DAT_08A1BDA0: the camera zooms toward 2.6. */
  private zoomIn = false
  /** DuelPlayer records. */
  get players(): HandPlayer[] {
    return this.game.players
  }
  /** g_handSelState. */
  private handState = 0
  /** Turn banner counter (g_mapMoveSegCount reused by state 10). */
  private bannerCount = 0
  /** Viewer: show the sample Healing Spring report at turn start when no field effect produced a report. */
  turnReport = false
  /** The attacker and target of the battle being prepared (g_duelAttackerUnit / g_duelTargetUnit). */
  duelAttacker: Unit | null = null
  duelTarget: Unit | null = null
  /** Set while the duel scene should run (state 0x898); the view runs it and calls battleResult. */
  battleRequest: { attacker: Unit; target: Unit } | null = null
  /** DAT_08a1bd8c: the card screen of a unit is open (Triangle in mapCursorUpdate); g_mapInfoUnit. */
  infoOpen = false
  infoUnit: Unit | null = null
  /** cardInfoUpdate globals: g_cardInfoCardId, g_cardInfoState, g_cardInfoTab, g_cardInfoAttachCursor, g_cardInfoMode. */
  private ci = { id: 0, state: 0, tab: 0, cursor: -1, mode: 0 }
  /** g_mapBoardActive: the board is drawn (off during the duel and after the result screen). */
  boardActive = true
  /** A newly drawn card sliding in (Sprite_08A42C98 at (160, y)) and the flip angle (DAT_08A42EB0). */
  private drawnPic: Spr | null = null
  private drawnY = 0
  private flipAngle = 0
  /** The running effect scene, the one loading, g_effectState (0 idle, 1 effectWaitLoadAndStart, 2 effectRunFrame, 3 effectFinish). */
  private fx: EffectScene | null = null
  private fxPending: EffectScene | null = null
  private fxState = 0
  /** The id of the last effect started (viewer readout). */
  fxId = 0
  /** g_mapCurUnit (unitSummonUpdate, mapProcessDeaths). */
  curUnit: Unit | null = null
  /** Result of the game (10000 / 11000 / 0x2CEC), −1 after To title. */
  result = 0
  /** The scene the result screen returned (duelResultScreenUpdate: 300, 0x834 after a story win, 0x32 in versus); 0 after To title / temp save (g_mapExitScene 0). */
  resultExit = 0
  /** g_playerProfile fields the result screen rolls against and writes (Play mode passes the real profile; the viewer an empty one). */
  profile: ResultProfile = emptyResultProfile()
  /** g_mapStageNo (the battle counters and special cards; 18 for Arth's stage, whose board is stage 17's). */
  stageNo: number
  /**
   * Play mode: saveDataScene(SAVE_CONTINUE) for the Temp save command (state 6000), called every
   * frame; returns 0 busy, 1 done (the board exits with g_mapExitScene 0), 2 cancelled (back to the
   * command menu). Unset (viewer): a note is shown instead.
   */
  tempSave?: () => number
  /** DuelPlayer 2 and 3: unused by the board, but playerResetDeck shuffles them in modes 1 / 2 and the continue file holds them. */
  sparePlayers: Player[] = [blankPlayer(2), blankPlayer(3)]
  /** g_mapFirstTurn: 0 on a new board, 1 once round 1 starts (written, only read back by the continue file). */
  firstTurn = 0
  /** The story event (msgEventStart / msgEventUpdate / msgEventDraw). */
  private story: StoryPlayer | null = null
  /** DAT_089b5a04: last unit the L / R jump picked, per player. */
  private lastPick = [0, 0]
  /** sndPlaySeUi log (viewer: shown in the status line). */
  lastSe = 0
  /** Viewer: plays the sndPlaySeUi calls (src/audio/sePlayer.ts), unset = silent. */
  onSound?: (id: number) => void
  /** uiAnimCounter mode 2 counter (pointer hand, six frames of four vblanks). */
  private c2 = 0
  /** g_mapUnitWalkAnm (null = not loaded). */
  private walk: WalkAnim | null = null
  private wins: MapWin[] = []
  private enc = new Map<string, Uint8Array>()

  constructor(db: GameDb, tables: MapBoardTables, assets: MapBoardAssets, board: MapBoard, stage = board.stage) {
    this.db = db
    this.t = tables
    this.a = assets
    this.board = board
    // g_mapLayoutId / g_mapStageNo: the board's stage, or 18 on stage 17's board (Arth)
    this.layout = stage
    this.stageNo = stage
    this.zoomK = tables.zoomInit
    this.sprTiles = new Spr(assets.tiles)
    this.sprCursor = new Spr(assets.cursor)
    this.sprWall = new Spr(assets.wall)
    this.sprStatus = new Spr(assets.status)
    this.sprBanner = new Spr(assets.banner)
    this.sprFlag = new Spr(assets.flag)
    this.sprShadow = new Spr(assets.shadow)
    this.sprActed = new Spr(assets.acted)
    this.sprDigits = new Spr(assets.digits)
    this.sprHand = new Spr(assets.hand)
    this.sprIcons = new Spr(assets.icons)
    this.sprRing = new Spr(assets.ring ?? null)
    this.sprRing.cam = CAM_HUD3D
    this.sprLabels = new Spr(assets.handLabels ?? null)
    this.sprNum = new Spr(assets.digits)
    this.sprPointer = new Spr(assets.hand)
    if (assets.winSkins) this.painter = new WindowPainter({ skins: assets.winSkins, font: assets.font, tables: tables.win })
    this.cam = this.makeCam()
    // mapBoardScene state 1: loaded background pieces are billboarded, scale g_mapDecoScale·2·1.5.
    this.sprBg = assets.background.map((img) => {
      const s = new Spr(img)
      s.cam = this.cam
      s.setRot(...ROT_BILLBOARD)
      const k = Math.fround(Math.fround(tables.decoScale * 2) * 1.5)
      s.setScale(k, k)
      return s
    })
    this.sprDeco = assets.deco.map((img) => new Spr(img))
    const card = (id: number): RCard | undefined => db.byId.get(id)
    const ability = (id: number): RAbility | undefined => db.abilities.get(id)
    this.game = new MapGame(board.width, board.height, board.land, board.goal, card, ability)
    this.game.onSe = (id) => {
      this.lastSe = id
      this.onSound?.(id)
    }
    this.cursor = this.game.cursor
    this.seizeState = this.game.seizeMark
    this.flows = new MapFlows(this.flowHost())
    this.ai = new MapAi(this.aiHost())
  }

  // ---- game state helpers ----

  get width() {
    return this.board.width
  }
  get height() {
    return this.board.height
  }
  /** g_mapLandAttr (changed by the Summon Earth… cards and abilities). */
  land(x: number, y: number) {
    return x < 0 || y < 0 || x >= 40 || y >= 40 ? -1 : this.game.land[y * 40 + x]
  }
  /** Every placed unit (state > 0). */
  get units(): MapUnitState[] {
    return this.game.allUnits()
  }
  /** The unit whose g_mapGrid word is on (x, y) (a moving unit is lifted off the grid). */
  unitAt(x: number, y: number) {
    return this.game.unitAt(x, y) ?? undefined
  }
  /** Cell word (unitPlaceOnGrid): card | slot << 16 | (team + 1) << 24 | (player + 1) << 28. */
  private cellWord(x: number, y: number) {
    return x < 0 || y < 0 || x >= 40 || y >= 40 ? 0 : this.game.grid[y * 40 + x]
  }
  /** g_mapCellFlags: the conquest word (pending and owned bits). */
  private cellFlags(x: number, y: number) {
    return this.game.conquest[y * 40 + x]
  }

  /** g_mapRangeGrid: the state machine's marks when it has any, else the viewer overlay. */
  private rangeGrid(): Uint8Array {
    if (this.marks.some((v) => v !== 0)) return this.marks
    const g = new Uint8Array(1600)
    const W = this.width, H = this.height
    const diamond = (cx: number, cy: number, r: number, v: number) => {
      for (let y = cy - r; y <= cy + r; y++)
        for (let x = cx - r; x <= cx + r; x++)
          if (x >= 0 && y >= 0 && x < W && y < H && Math.abs(x - cx) + Math.abs(y - cy) <= r) g[y * 40 + x] = v
    }
    if (this.opts.overlay === 'forbidden') {
      // State 7/8/9 (versus start choice): mapFillDiamond(first Dominator, 5, 1).
      const [sx, sy] = this.board.starts[0]
      diamond(sx, sy, 5, 1)
    } else if (this.opts.overlay === 'range') {
      const u = this.unitAt(this.cursor.x >> 6, this.cursor.y >> 6)
      const card = u && this.db.byId.get(u.cardId)
      if (u && card) diamond(u.cellX, u.cellY, card.range, u.cardId < 3000 ? 0x20 : 0x40)
    } else if (this.opts.overlay === 'summon') {
      // mapMarkSummonCells / mapCanDeployAt for the turn player (attribute of the card under the hand cursor)
      const p = this.players[this.turnPlayer]
      const cid = p ? (p.deck[p.hand[p.cursor >> 5]] ?? 0) : 0
      const attr = cardType(cid) === CT_UNIT ? (this.db.byId.get(cid)?.attribute ?? 0) : 0
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (this.land(x, y) !== -1 && this.game.canDeployAt(this.turnPlayer, attr, x, y)) g[y * 40 + x] = 0x80
    }
    return g
  }

  private makeCam(): Cam {
    return { eye: [0, 0, -0x8000], rot: [0, 0, 0], focal: 32768, zoom: 2 }
  }

  /** mapSetupCameraMatrix(g_mapCamera, cursorX, cursorY, 0). */
  private setupCamera() {
    const c = this.cam
    const f = this.cameraFocus()
    c.eye = [f.x - 0x8926, f.y - 0xeda5, -0x8000]
    c.rot = [(-65 * PI_F) / 180, 0, (-30 * PI_F) / 180]
    const dir = this.opts.menuZoom || this.zoomIn ? 1 : 0
    if (dir > 0 && this.zoomK < 0xa0) this.zoomK += 5
    if (dir < 0 && this.zoomK > 0x32) this.zoomK -= 5
    if (dir === 0) {
      if (this.zoomK > 100) this.zoomK -= 5
      if (this.zoomK < 100) this.zoomK += 5
    }
    c.zoom = Math.fround(this.zoomK / 100 + 1)
  }

  /** mapCursorReset + a start position: the cursor on player 0's start square. */
  placeCursor(x: number, y: number) {
    this.cursor.x = x * 64
    this.cursor.y = y * 64
    this.stepX = this.stepY = 0
  }

  /** mapCursorUpdate (0x0882EB0C): 8 px per frame (10 with Circle held), blocked by missing squares. Returns 1 when the cursor is at rest. */
  private cursorUpdate(): boolean {
    this.blinkOn = 1
    this.cursorCalled = true
    if (this.infoOpen) return false
    if (this.mousePick()) return false
    const maxX = this.width * 64 - 64, maxY = this.height * 64 - 64
    const c = this.cursor
    let speed = 8
    if ((c.x & 0x3f) === 0) this.stepX = 0
    if ((c.y & 0x3f) === 0) this.stepY = 0
    if (this.stepX === 0 && this.stepY === 0) {
      if (this.pad & PAD_CIRCLE) speed = 10
      if (this.pad & PAD_LEFT) this.stepX = c.x < 1 ? 0 : -speed
      else if (this.pad & PAD_RIGHT) this.stepX = maxX <= c.x ? 0 : speed
      if (this.pad & PAD_UP) this.stepY = c.y < 1 ? 0 : -speed
      else if (this.pad & PAD_DOWN) this.stepY = maxY <= c.y ? 0 : speed
    }
    this.cycleUnits()
    const blocked = (x: number, y: number) => this.land(x >> 6, y >> 6) < 0
    for (let i = 0; i < speed; i++) {
      if ((c.y & 0x3f) === 0) {
        if (this.stepX !== 0) {
          let nx = c.x
          if (this.stepX > 0) {
            if (maxX < c.x + 1) this.stepX = 0
            nx = c.x + 0x40
          }
          if (this.stepX < 0) {
            if (c.x - 1 < 0) this.stepX = 0
            nx = c.x - 1
          }
          if (this.stepX !== 0 && blocked(nx, c.y)) this.stepX = 0
        }
        if (this.stepX > 0) c.x++
        if (this.stepX < 0) c.x--
      }
      if ((c.x & 0x3f) === 0) {
        let ny = c.y
        if (this.stepY > 0) {
          if (maxY < c.y + 1) this.stepY = 0
          ny = c.y + 0x40
        }
        if (this.stepY < 0) {
          if (c.y - 1 < 0) this.stepY = 0
          ny = c.y - 1
        }
        if (this.stepY !== 0 && blocked(c.x, ny)) this.stepY = 0
        if (this.stepY > 0) c.y++
        if (this.stepY < 0) c.y--
      }
      if ((c.x & 0x3f) === 0 && (c.y & 0x3f) === 0) break
    }
    if (this.stepX !== 0 || this.stepY !== 0) return false
    // Triangle on a unit opens its card screen (mapInfoLoadAttachmentImages, DAT_08a1bd8c = 1)
    const w = this.game.getCell(c.x >> 6, c.y >> 6)
    if (w > 0 && this.pressed & PAD_TRIANGLE) {
      this.infoUnit = this.game.unitOfWord(w)
      this.infoOpen = true
      this.game.onSe(8)
      return false
    }
    return true
  }

  /** Viewer: start the seize-wall effect on a square (mapSeizeCell sets the marker to 1). */
  seize(x: number, y: number) {
    this.seizeState[y * 40 + x] = 1
  }

  // ---- effects (effectStart 0x0888EF48 / effectIsBusy / effectRunFrame) ----

  /**
   * effectStart(id): queues effect.one entry 1000 + id only while no effect is loading or running (a
   * second start is ignored). The idle state picks the load up at the effect point of the same frame
   * (effectStateIdle 0x0888F008), the next frame runs the init pass and arms entry 15, the frame after
   * runs its first script frame.
   */
  effectStart(id: number) {
    if (this.fxState !== 0 || this.fxPending) return
    this.fxId = id
    const sc = this.a.effect?.(id, this.fxHooks())
    if (sc) this.fxPending = sc
  }
  /** effectIsBusy: −1 while g_effectState is not the idle state. */
  effectBusy() {
    return this.fxState !== 0 || this.fxPending !== null
  }
  /** (*g_effectState)() at the end of the frame. */
  private effectFrame() {
    if (this.fxState === 0) {
      if (this.fxPending) this.fxState = 1
    } else if (this.fxState === 1) {
      this.fx = this.fxPending
      this.fxPending = null
      this.fxState = 2
    } else if (this.fxState === 2) {
      const f = this.fx
      if (f) f.step()
      if (!f || f.finished || f.error) this.fxState = 3
    } else this.fxState = 0
  }
  private fxHooks(): MapEffectHooks {
    return {
      camPos: () => [...this.cam.eye] as [number, number, number],
      placeCurUnit: () => {
        const u = this.curUnit
        if (!u) return
        this.game.grid[(u.posY >> 6) * 40 + (u.posX >> 6)] = (u.cardId | ((u.slot & 0xff) << 16) | ((u.player + 1) << 28) | (((u.team + 1) & 0xf) << 24)) >>> 0
        u.scalePct = 0
        u.state = 1
      },
      removeCurUnit: () => {
        const u = this.curUnit
        if (!u) return
        this.game.grid[(u.posY >> 6) * 40 + (u.posX >> 6)] = 0
        u.scalePct = 100
        u.state = 4
      },
      result: () => [this.res.winner, charaIndex(this.res.loserId)],
    }
  }

  // ---- card info (cardInfoUpdate 0x08821714) ----

  /**
   * cardInfoUpdate(cardId, mode): 0 start, 1 load, 2 tabs (Left / Right; Cross on the attachment tab →
   * 3, the 2×3 cursor), Circle → 4 closes (−1 on the next call). Mode 1 map unit (tabs 0xB), 2 hand /
   * reward card (9), 3 card list (0xD). Returns 0 while loading, 1 open, −1 closed.
   */
  cardInfoUpdate(cardId: number, mode: number): number {
    const g = this.game
    const ci = this.ci
    const P = this.pressed
    let allowed = 1
    if (mode === 3) allowed = cardId < 2000 ? 0xd : 5
    else if (mode === 2) allowed = cardId < 2000 ? 9 : 1
    else if (mode === 1 && cardId < 2000) allowed = 0xb
    if (cardId !== ci.id) {
      ci.state = 0
      ci.id = cardId
    }
    if (ci.state === 4) {
      ci.tab = 0
      ci.mode = 0
      ci.id = 0
      ci.cursor = -1
      ci.state = 0
      return -1
    }
    if (ci.state === 3) {
      if (P & PAD_CIRCLE) {
        ci.cursor = -1
        g.onSe(9)
        ci.state = 2
      } else {
        let moved = true
        if (P & (PAD_UP | PAD_DOWN)) ci.cursor = ci.cursor < 3 ? ci.cursor + 3 : ci.cursor - 3
        else if (P & PAD_LEFT) ci.cursor = ci.cursor === 0 ? 2 : ci.cursor === 3 ? 5 : ci.cursor - 1
        else if (P & PAD_RIGHT) ci.cursor = ci.cursor === 2 ? 0 : ci.cursor === 5 ? 3 : ci.cursor + 1
        else moved = false
        if (moved) g.onSe(1)
      }
      return 1
    }
    if (ci.state === 2) {
      if (ci.tab === 0) ci.tab = 1
      if (P & PAD_CIRCLE) {
        g.onSe(9)
        ci.state = 4
        return 1
      }
      if (ci.tab === 2 && P & PAD_CROSS) {
        ci.cursor = 0
        g.onSe(7)
        ci.state = 3
        return 1
      }
      // mouse (Play mode, ours): a click on a tab selects it (tabAt works in 480×272 screen units)
      if (P & PAD_POINTER && this.pointer.x >= 0) {
        const t = tabAt(this.t.card, cardId, mode, this.pointer.x * 0.75, (this.pointer.y * 272) / 448)
        if (t && t & allowed && t !== ci.tab) {
          ci.tab = t
          g.onSe(1)
          return 1
        }
      }
      const dir = P & PAD_LEFT ? -1 : P & PAD_RIGHT ? 1 : 0
      if (allowed !== 1 && dir) g.onSe(1)
      if (dir < 0) {
        do {
          ci.tab >>= 1
          if (ci.tab === 0) ci.tab = 8
        } while (!(ci.tab & allowed))
      } else {
        if (dir > 0) ci.tab = (ci.tab << 1) & 0xff
        while (!(ci.tab & allowed)) {
          const b = (ci.tab << 1) & 0xff
          ci.tab = b < 0x10 ? b : 1
        }
      }
      return 1
    }
    if (ci.state === 1) {
      if (ci.tab === 0) ci.tab = 1
      ci.cursor = -1
      ci.state = 2
      return 0
    }
    ci.mode = mode
    ci.cursor = -1
    ci.state = 1
    return 0
  }
  /** What the view draws over the frame while g_cardInfoTab ≠ 0: the card screen (cardInfoDrawUnit / DrawCard). */
  cardInfoView(): { cardId: number; mode: number; tab: number; cursor: number; unit: Unit | null } | null {
    if (!this.ci.tab || !this.ci.id) return null
    return { cardId: this.ci.id, mode: this.ci.mode, tab: this.ci.tab, cursor: this.ci.cursor, unit: this.ci.mode === 2 && this.state >= 10000 ? null : this.infoUnit }
  }

  /**
   * mapCursorCycleUnits(2) (0x0882E7D8 area): on a whole square, R jumps to the next unit of the turn
   * player, L to the next of the other player (only units of that team that have not finished, in
   * row order from the last pick or the unit under the cursor).
   */
  private cycleUnits() {
    const g = this.game
    const c = this.cursor
    if (c.x & 0x3f || c.y & 0x3f) return
    const tp = this.turnPlayer
    let pl: number
    if (this.pressed & PAD_R) pl = tp
    else if (this.pressed & PAD_L) pl = (tp + 1) & 1
    else return
    if (!(g.units[pl][0].state > 0)) return
    const w = g.getCell(c.x >> 6, c.y >> 6)
    let who: number, slot: number
    if (w < 1) {
      const last = this.lastPick[tp]
      who = (last >> 8) & 1
      slot = last & 0xff
      if (slot > 0x1e) slot = 0
      const u = g.units[who][slot]
      if (u.state < 1 || u.posX !== c.x || u.posY !== c.y) {
        who = (pl + 1) & 1
        slot = 0x1e
      }
    } else {
      slot = (w >>> 16) & 0xff
      who = (w >>> 28) - 1
      if (slot === 0xff) slot = 0
    }
    this.lastPick[tp] = ((who << 8) + slot) & 0xffff
    let found = false
    for (;;) {
      slot++
      if (slot > 0x1e) {
        who = (who + 1) & 1
        slot = 0
      }
      const u = g.units[who][slot]
      found = u.state > 0
      if (u.team !== pl || u.actFlags & 8) found = false
      if (found || this.lastPick[tp] === (who << 8) + slot) break
    }
    if (found) {
      const u = g.units[who][slot]
      if (c.x !== u.posX || c.y !== u.posY) g.onSe(1)
      this.lastPick[tp] = (who << 8) + slot
      c.x = u.posX
      c.y = u.posY
    }
  }

  // ---- list and menu windows (winOpenList / winOpenMenu / winUpdateInput) ----

  /** winOpenList (0x08870C00): style 7, cursor bar at (10, 8) w − 20, visibleRows = clamp((h − 10) / lineH, 1, n); rows re-laid out from scrollTop. */
  private openList(key: string, x: number, y: number, w: number, h: number, items: Uint8Array[], glyph: number, flags: number): MapWin {
    this.closeWin(key)
    let rows = Math.trunc((Math.trunc(h) - 10) / glyph)
    if (rows < 1) rows = 1
    if (items.length < rows) rows = items.length
    const win: DuelWindow = { x, y, w, h, codes: [], glyph, opened: this.frameNo, style: 7, chamfer: 5, flags: WF_MENU | (flags & WF_SCROLLBAR), alpha: 0x80, menu: { row: 0, offX: 10, offY: 8, cursorW: Math.trunc(w) - 20, color: WIN_CURSOR_COLORS[0], itemCount: items.length, visibleRows: rows, scrollTop: 0 } }
    const mw: MapWin = { key, win, prints: [], list: { items, cursor: 0, frame: this.frameNo, noInput: true } }
    this.wins.push(mw)
    this.relayoutList(mw)
    return mw
  }
  /** winOpenMenu (0x0887088C): list mode 2, one row per ＠ｎ line, h = rows · lineH + 14, w = (maxCol + 1) · advance. */
  private openMenu(key: string, x: number, y: number, glyph: number, text: Uint8Array): MapWin {
    this.closeWin(key)
    const lay = layoutText(text, { glyph, tables: this.t.win })
    const lines = text.reduce((n, _b, i) => n + (text[i] === 0x81 && text[i + 1] === 0x97 && text[i + 2] === 0x82 && text[i + 3] === 0x8e ? 1 : 0), 0) + 1
    const adv = ((glyph + 1) & 0xff) >> 1
    const w = (lay.maxCol + 1) * adv
    const h = lines * glyph + 14
    const win: DuelWindow = { x, y, w, h, codes: [], glyph, opened: this.frameNo, style: 7, chamfer: 5, flags: WF_MENU, alpha: 0x80, menu: { row: 0, offX: 10, offY: 8, cursorW: Math.trunc(w) - 20, color: WIN_CURSOR_COLORS[0], itemCount: lines, visibleRows: lines, scrollTop: 0 } }
    const mw: MapWin = { key, win, prints: [{ x: 0, y: 0, glyph, text, at: this.frameNo - 1 }], list: { items: [], cursor: 0, frame: this.frameNo, noInput: true } }
    this.wins.push(mw)
    return mw
  }
  private relayoutList(mw: MapWin) {
    const l = mw.list, m = mw.win.menu
    if (!l || !m || !l.items.length) return
    mw.prints = []
    for (let i = 0; i < (m.visibleRows ?? 1); i++) {
      const t = l.items[(m.scrollTop ?? 0) + i]
      if (t) mw.prints.push({ x: 0, y: i * (mw.win.glyph ?? 20), glyph: mw.win.glyph ?? 20, text: t, at: this.frameNo - 1 })
    }
  }
  /** winUpdateInput (0x0886F9A8): Up / Down (held Square pages), wrap-around on a press at the ends. */
  private listInput(key: string) {
    const mw = this.win(key)
    const l = mw?.list, m = mw?.win.menu
    if (!mw || !l || !m || l.noInput) return
    const P = this.pressed
    const n = m.itemCount ?? 1, vis = m.visibleRows ?? 1
    let row = m.row, top = m.scrollTop ?? 0
    if (this.pad & PAD_DOWN || P & PAD_DOWN) {
      if (P & PAD_DOWN && l.cursor === n - 1) {
        row = 0
        top = 0
      } else if (P & PAD_DOWN) {
        if (!(this.pad & PAD_SQUARE)) {
          if (row < vis - 1) row++
          else if (top < n - vis) top++
        } else if (top < n - vis) top = Math.min(n - vis, top + vis)
        else if (row < vis - 1) row++
      }
    } else if (this.pad & PAD_UP || P & PAD_UP) {
      if (P & PAD_UP && l.cursor === 0) {
        row = vis - 1
        top = n - vis
      } else if (P & PAD_UP) {
        if (!(this.pad & PAD_SQUARE)) {
          if (row < 1) {
            if (top !== 0) top--
          } else row--
        } else if (top === 0) {
          if (row > 0) row--
        } else top = Math.max(0, top - vis)
      }
    }
    row = this.listMouse(mw, row, top)
    m.row = row
    if (top !== m.scrollTop) {
      m.scrollTop = top
      this.relayoutList(mw)
    }
    if (l.cursor !== top + row) {
      this.game.onSe(1)
      m.movedAt = this.frameNo
      l.cursor = top + row
    }
  }

  // ---- story events (msgEventStart / msgEventUpdate / msgEventDraw) ----

  /** msgEventStart(ctx, key, a, b, mode): modes 1 stage start, 3 / 4 after a win / loss (key = stage), 9 turn start (key = round, dominator). */
  eventStart(trigger: StoryTrigger, key: number, dominator = 0) {
    const sc = this.db.stories.find((x) => x.trigger === trigger && x.key === key && (trigger !== 'turnStart' || x.dominator === dominator))
    this.story = sc ? (this.a.story?.(sc) ?? null) : null
  }
  /** msgEventUpdate: 1 when the script ended (at once without one). */
  eventUpdate(): number {
    const st = this.story
    if (!st) return 1
    if (this.pressed & (PAD_CROSS | PAD_POINTER)) st.press()
    if (this.pressed & (PAD_START | PAD_POINTER_MIDDLE)) st.skip()
    st.step()
    if (st.finished) {
      this.story = null
      return 1
    }
    return 0
  }

  // ---- result screen (duelResultScreenUpdate 0x08833094 / duelResultScreenDraw) ----

  /** DAT_089b6094 (state), g_resultWinnerSide, g_resultLoserCharaId, DAT_089b5a48 (banner %), DAT_089b5a38 (portrait x), DAT_089b5a4a (reward cursor), DAT_089b5a4c (rewards shown), DAT_089b605c, g_resultDrawFlags, g_rewardCards / g_rewardCardAnim. */
  res = { state: 0, winner: 0, loserId: 0, scale: 200, x: -0x200, cursor: 0, shown: 0, cnt: 0, flags: 0, rewards: [] as number[], anim: new Array(10).fill(0) }
  private resSpr: { portrait: Spr[]; sheet: Spr | null; badge: Spr | null; banner: Spr | null } | null = null

  /**
   * duelResultScreenUpdate(side): 0 effect 0x36 (0x1D without a winner) → 1 portraits and the reward
   * roll (story / free battle) → 2 → 3 the banner shrinks 200 → 100 % → 4 the portraits slide in → 5
   * stats → 7/8 the reward cards turn over (Triangle: card details, state 9) → 0xB/0xC the after-win /
   * after-loss event (story) → 0xF "Clear" → 0x10 exit. Versus (mode 0) shows "Back to title" (state
   * 10). Returns the exit scene (nonzero) when done.
   */
  private resultUpdate(side: number): number {
    const g = this.game, r = this.res
    const P = this.pressed
    let exit = 0
    switch (r.state) {
      case 0:
        r.loserId = side >= 0 ? g.units[(side + 1) & 1][0].cardId : 0
        r.winner = side
        this.effectStart(side < 0 ? 0x1d : 0x36)
        r.state = 1
        break
      case 1:
        if (this.effectBusy()) break
        this.resSpr = {
          portrait: [0, 1].map((q) => new Spr(this.a.portrait?.(charaIndex(g.units[q][0].cardId)) ?? null)),
          sheet: new Spr(this.a.resultSheet ?? null),
          badge: new Spr(this.a.badge ?? null),
          banner: new Spr(this.a.banner),
        }
        r.scale = 200
        r.cursor = 0
        r.shown = 0
        r.winner = side
        r.rewards = []
        r.anim = new Array(10).fill(0)
        if (g.gameMode !== 0) this.rollRewards(g.units[0][0].cardId === 1001 ? g.units[1][0].cardId : g.units[0][0].cardId)
        r.x = -0x200
        r.flags = 0
        r.state = 2
        break
      case 2:
        r.flags = 1
        r.state = 3
        break
      case 3:
        r.flags |= 2
        r.scale -= 4
        if (r.scale < 0x65) {
          r.scale = 100
          r.state = 4
        }
        break
      case 4:
        r.flags |= 4
        for (let i = 0; i < 10; i++) {
          r.x++
          if (r.x > -0x81) {
            r.state = 5
            break
          }
        }
        break
      case 5:
        r.flags |= 8
        r.state = g.gameMode === 0 ? 10 : g.gameMode === 1 ? 0xb : 0xc
        break
      case 7:
        if (r.shown < r.rewards.length) {
          if (P & PAD_CROSS) {
            r.cnt = 0
            r.shown = r.rewards.length + 1
          } else if (++r.cnt > 0x10) {
            r.cnt = 0
            r.shown++
          }
        } else if ((r.anim[r.rewards.length - 1] ?? 180) < 0xb4) {
          if (P & PAD_CROSS) r.anim.fill(0xb4)
        } else {
          this.closeWin('help')
          const hw = this.openMessage('help', 8, 0, sj('＠ｂ１Card details ＠ｎ＠ｂ０End '), 0x12, 0x3000)
          hw.win.y = 448 - hw.win.h - 16
          r.state = 8
        }
        break
      case 8: {
        let moved = false
        const has = (i: number) => (r.rewards[i] ?? 0) !== 0
        if (P & PAD_LEFT) {
          do r.cursor = r.cursor === 0 ? 4 : r.cursor === 5 ? 9 : r.cursor - 1
          while (!has(r.cursor))
          moved = true
        } else if (P & PAD_RIGHT) {
          do r.cursor = r.cursor === 4 ? 0 : r.cursor === 9 ? 5 : r.cursor + 1
          while (!has(r.cursor))
          moved = true
        }
        if (P & (PAD_UP | PAD_DOWN) && has(5)) {
          if (r.cursor < 5) {
            if (has(r.cursor + 5)) r.cursor += 5
          } else r.cursor -= 5
          moved = true
        }
        if (moved) g.onSe(1)
        else if (P & PAD_TRIANGLE) {
          this.closeAll()
          g.onSe(8)
          r.state = 9
        } else if (P & PAD_CROSS) {
          this.closeAll()
          r.state = g.gameMode === 1 ? 0xb : 0xc
        }
        break
      }
      case 9: {
        const k = this.cardInfoUpdate(r.rewards[r.cursor] & 0xffff, 2)
        if (k === -1) r.state = 7
        else if (k !== 0) {
          const d = P & PAD_R ? 1 : P & PAD_L ? -1 : 0
          if (d) {
            do {
              if (d > 0 && r.cursor >= 9) r.cursor = 0
              else if (d < 0 && r.cursor === 0) r.cursor = 9
              else r.cursor += d
            } while (r.cursor !== 0 && !(r.rewards[r.cursor] ?? 0))
            g.onSe(5)
          }
        }
        break
      }
      case 10: {
        if (!this.win('menu')) {
          const m = this.openMessage('menu', 0, 336, this.cstr(0x088b9ad4), 0x16, 0x3000)
          m.win.x = side < 0 ? 320 - m.win.w / 2 : 608 - m.win.w
          m.win.y = 448 - m.win.h - 32
        }
        if (P & PAD_CIRCLE) exit = 0x32
        break
      }
      case 0xb:
      case 0xc:
        r.flags = 0x2f
        if (r.shown < r.rewards.length) {
          this.closeAll()
          r.state = 7
        } else if (side === 0) {
          if (g.gameMode === 1) this.eventStart('afterWin', this.layout)
          r.state = 0xd
        } else {
          if (g.gameMode === 1) this.eventStart('afterLoss', this.layout)
          r.state = 0xe
        }
        break
      case 0xd:
      case 0xe: {
        const first = r.flags & 1
        r.flags |= 0x40
        if (!first && this.eventUpdate() !== 0) {
          r.flags = 0x80
          r.state = 0xf
        }
        break
      }
      case 0xf:
        if (side === 0) {
          if (!this.win('msg')) {
            const name = this.t.areaNames[this.board.area] ?? new Uint8Array(0)
            const f = this.openFrame('msg', 320, 224, 0, 0, 16, 10, 0xc000)
            const w14 = (name.length >> 1) * 23
            f.win.h = 76
            f.win.w = w14 + 30
            this.printAt(f, 0, 0, 0x16, name)
            this.printAt(f, Math.trunc(w14 - 69), 0x17, 0x16, sj('Clear '))
          }
          if (P & (PAD_CROSS | PAD_CIRCLE | PAD_POINTER)) {
            this.closeWin('msg')
            g.onSe(7)
            r.state = 0x10
          }
        } else r.state = 0x10
        if (r.state === 0x10) {
          // the reward copies are added as the state becomes 0x10 (same frame)
          const prof = this.profile
          for (const w of r.rewards) {
            const i = this.cardIdToIndex(w & 0xffff)
            if (prof.cardCount[i] < 10) {
              prof.cardCount[i]++
              prof.cardNewFlags[i] |= w >>> 28
            }
          }
        }
        break
      case 0x10:
        exit = this.resultApplyCounters(side)
        break
    }
    if (exit) {
      this.closeAll()
      r.flags = 0
      r.state = 0
    }
    return exit
  }

  /**
   * duelRollRewardCards(opponent) (0x08832A94), against `this.profile` (the viewer passes an empty
   * collection). Transcribed step by step, quirks included:
   * - cardNewFlags[1..206] are cleared (index 0 is not);
   * - 5 + r % 6 cards after a win of player 0, 3 without a winner, 1 + r % 3 after a loss;
   * - card index i (1..206) = cardIndexToId(i) scores ((r & 0xFFFF) + 1) % 100 + 1 times base ×
   *   mult[(opponent − 1002) & 0xFF] of drop-table row i, and is inserted into a list ended by id 0:
   *   the walk swaps the carried entry into every slot whose score is lower than the NEW score, so a
   *   zero-score first card leaves an empty (id 0) hole at index 0 that can end a later walk early;
   * - the slots take the list from the top, skipping cards owned 10 times, and stop at the first
   *   score 0 (flags 3 = first copy, 1 = copy); empty slots are refilled from the top without flags;
   * - with 5 or more slots, s = max(0, 30 − round) + conquests / 5 + Dominator HP + 2 × Soul of the
   *   winner gives 1 / 2 / 3 rare picks (s ≥ 40 / 60 / 80): walking up from list index 205, each group
   *   of 20 nonzero scores keeps its first card, overwritten by every later card owned fewer than 10
   *   times; pick k replaces slot count − 1 − k.
   */
  private rollRewards(opponent: number) {
    const g = this.game, r = this.res, prof = this.profile
    for (let i = 1; i < 207; i++) prof.cardNewFlags[i] = 0
    const n = r.winner === 0 ? ((g.rng.next() & 0xffff) % 6) + 5 : r.winner < 0 ? 3 : ((g.rng.next() & 0xffff) % 3) + 1
    // local_1a0 (ids) / local_340 (scores): 208 entries, 207 cleared (entry 207 is never reached)
    const ids = new Int16Array(208), scores = new Uint16Array(208)
    const col = (opponent - 0x3ea) & 0xff
    for (let i = 1; i < 0xcf; i++) {
      const row = this.db.rewards[i - 1]
      const newScore = (((((g.rng.next() & 0xffff) + 1) % 100) + 1) * (row?.base ?? 0) * (row?.mult[col] ?? 0)) & 0xffff
      let carriedScore = newScore
      let carriedId = this.cardIndexToId(i)
      let k = 0
      let cur = scores[0]
      let store = true
      for (;;) {
        if (cur < newScore) {
          scores[k] = carriedScore
          const t = ids[k]
          ids[k] = carriedId
          carriedScore = cur
          carriedId = t
        }
        k++
        if (ids[k] === 0) break
        if (k > 0xce) {
          store = false
          break
        }
        cur = scores[k]
      }
      if (store) {
        scores[k] = carriedScore
        ids[k] = carriedId
      }
    }
    const slots = new Array<number>(n).fill(0)
    const count = (id: number) => prof.cardCount[this.cardIdToIndex(id)] ?? 0
    // the slots from the top of the list, skipping maxed cards, until a score of 0
    let p = 0
    for (let i = 0; i < n; ) {
      let v: number
      if (scores[p] === 0) v = slots[i]
      else {
        const c = count(ids[p])
        if (c < 10) slots[i] = (ids[p] | ((c === 0 ? 3 : 1) << 28)) >>> 0
        v = slots[i]
        p++
        if (v === 0) continue
      }
      if (v === 0) break
      i++
    }
    // empty slots: the list again from the top, no flags
    for (let i = 0, q = 0; i < n; i++) if (slots[i] === 0) slots[i] = ids[q++]
    if (n > 4) {
      const w = r.winner
      const s = Math.max(0, 30 - g.round) + (g.conquestCount[w] > 0 ? Math.trunc(g.conquestCount[w] / 5) : 0) + g.units[w][0].hp + g.players[w].soul * 2
      if (s > 0x27) {
        const rare = s < 0x50 ? (s < 0x3c ? 1 : 2) : 3
        const picks = [0, 0, 0]
        let grp = 0, seen = 0, base = 0
        for (let k = 0xcd; k >= 0; k--) {
          if (scores[k] !== 0) {
            const id = ids[k]
            if (picks[grp] === 0 || count(id) < 10) picks[grp] = id
            seen++
          }
          if (base + 20 <= seen) {
            grp++
            base += 20
          }
          if (grp > 2) break
        }
        for (let k = 0; k < rare; k++) slots[n - (k + 1)] = (picks[k] | ((count(picks[k]) === 0 ? 3 : 1) << 28)) >>> 0
      }
    }
    r.rewards = slots
  }

  /** cardIdToIndex: the collection index 1..206 of a card, 0 for characters and unknown ids. */
  private cardIdToIndex(id: number): number {
    const no = this.db.byId.get(id)?.no ?? 0
    return no >= 1 && no <= 206 ? no : 0
  }

  private indexIds: number[] | null = null
  /** cardIndexToId. */
  private cardIndexToId(i: number): number {
    if (!this.indexIds) {
      const a = new Array<number>(207).fill(0)
      for (const c of this.db.cards) if (c.type !== 'chara' && c.no >= 1 && c.no <= 206 && !a[c.no]) a[c.no] = c.id
      this.indexIds = a
    }
    return this.indexIds[i] ?? 0
  }

  /**
   * charaGetLadderIndex(id): walks g_charaLadderOrder from index 0 (an index above 18 reads entry 0)
   * and keeps the LAST index holding the id, stopping at the next 1001 after index 0.
   */
  private charaGetLadderIndex(id: number): number {
    const L = this.db.ladder
    let res = 0
    for (let k = 0; k < 64; k++) {
      const v = L[k > 0x12 ? 0 : k] ?? L[0]
      if (v === id) res = k
      if (k > 0 && v === 0x3e9) break
    }
    return res
  }

  /**
   * duelResultScreenUpdate state 0x10 on the profile (story and free battle only): the battle
   * counters of g_mapStageNo (stage 18 counts as 17; battles saturate at 0xFFFF and a win only counts
   * when the battle did), the counters of player 1's Dominator (charaGetLadderIndex), and the special
   * cards (story wins on stages 14 / 11 / 10 / 7: 2613 / 2615 / 2617 / 2616; free wins: 2612 with
   * 2615–2617 owned and Σ charaWins over 1002–1021 ≥ 50, 2614 after beating 1020), each only while not
   * owned. Returns the exit scene: 0x834 after a story-mode win, else 300.
   */
  private resultApplyCounters(side: number): number {
    const g = this.game, prof = this.profile
    let exit = 300
    const mode = g.gameMode
    if (mode !== 2 && mode !== 1) return exit
    let st = this.stageNo
    if (st === 0x12) st = 0x11
    const b = prof.mapBattles[st - 1] ?? 0
    if (b < 0xffff) {
      prof.mapBattles[st - 1] = b + 1
      if (side === 0) prof.mapWins[st - 1]++
    }
    const li = this.charaGetLadderIndex(g.units[1][0].cardId)
    const cb = prof.charaBattles[li]
    if (cb < 0xffff) {
      prof.charaBattles[li] = cb + 1
      if (side === 0) prof.charaWins[li]++
    }
    const idx = (id: number) => this.cardIdToIndex(id)
    let special = 0
    if (mode === 1) {
      if (side === 0) {
        if (this.stageNo === 0xe) special = idx(0xa35)
        else if (this.stageNo === 0xb) special = idx(0xa37)
        else if (this.stageNo === 10) special = idx(0xa39)
        else if (this.stageNo === 7) special = idx(0xa38)
        exit = 0x834
      }
    } else if (side === 0) {
      const c = prof.cardCount
      if (c[idx(0xa34)] === 0 && c[idx(0xa39)] !== 0 && c[idx(0xa38)] !== 0 && c[idx(0xa37)] !== 0) {
        let sum = 0
        for (let k = 1; k < 0x15; k++) {
          sum += prof.charaWins[this.charaGetLadderIndex(k + 0x3e9)]
          if (sum > 0x31) {
            special = idx(0xa34)
            break
          }
        }
      }
      if (g.units[1][0].cardId === 0x3fc && c[idx(0xa36)] === 0) special = idx(0xa36)
    }
    if (special > 0 && prof.cardCount[special] === 0) {
      prof.cardCount[special] = 1
      prof.cardNewFlags[special] |= 3
    }
    return exit
  }

  /** duelResultScreenDraw: returns true while the result screen replaces the board's HUD and windows. */
  private resultDraw(gl: GlRenderer | null): boolean {
    const r = this.res
    if (r.flags === 0) return false
    const sp = this.resSpr
    if (r.flags & 1) this.prim(0, 0, 0x280, 0x1c0, [[0x10, 0x10, 0x10, 0x60], [0x10, 0x10, 0x10, 0x60], [0x10, 0x10, 0x10, 0x60], [0x10, 0x10, 0x10, 0x60]])
    if (r.flags & 4 && sp) {
      for (let i = 0; i < 2; i++) {
        const s = sp.portrait[r.winner >= 0 ? r.winner : i]
        if (s?.img) {
          s.cam = CAM_2D
          s.setColor(0x80, 0x80, 0x80, 0x80)
          this.draw(s, i === 0 ? r.x : 0x80 - r.x, 0)
        }
        if (r.winner >= 0) break
      }
    }
    const sheet = sp?.sheet
    if (r.flags & 2 && sheet?.img) {
      sheet.cam = CAM_2D
      if (r.winner < 0) sheet.srcRect(0, 0x98, 0x100, 0xe0)
      else sheet.srcRect(0, 0, 0x100, 0x48)
      sheet.anchor(0x10)
      sheet.setScale(r.scale / 100, r.scale / 100)
      this.draw(sheet, r.winner < 0 ? 0xc0 : 0x130, 0x18)
      sheet.setScale(1, 1)
    }
    const digits = (v: number, right: number, y: number) => {
      let x = right, div = 1
      while (!(v < div)) {
        x -= 0x12
        this.uiDigit(Math.trunc(v / div) % 10, x, y)
        div *= 10
        v = div * Math.trunc(v / div)
      }
    }
    const piece = (u0: number, v0: number, u1: number, v1: number, x: number, y: number) => {
      if (!sheet?.img) return
      sheet.srcRect(u0, v0, u1, v1)
      this.draw(sheet, x, y)
    }
    const banner = sp?.banner
    const plate = (team: number, x: number, y: number, name: Uint8Array) => {
      if (banner?.img) {
        banner.cam = CAM_2D
        banner.setScale(1, 1)
        if (team === 0) banner.srcRect(0, 0x22, 0xd8, 0x44)
        else banner.srcRect(0, 0, 0xd8, 0x22)
        this.draw(banner, x, y)
      }
      if (!this.ci.tab) this.textScaled(name, x + 0x18, y + 10, 0x13, 0x16, 0)
    }
    const g = this.game
    const nameOf = (q: number) => this.db.raw.cardStrings.get(g.units[q][0].cardId)?.name ?? new Uint8Array(0)
    if (r.flags & 8) {
      if (r.winner < 0) {
        piece(0, 0x48, 0xe0, 0x6c, 0xd0, 0x68)
        digits(g.round, 0x1ac, 0x66)
        for (let i = 0; i < 2; i++) {
          const x = i === 0 ? 0x30 : 0x170
          plate(i, x, 0xe0, nameOf(i))
          piece(0, 0x6c, 0xe0, 0x90, x, 0x108)
          digits(g.conquestCount[i], x + 0xdc, 0x10a)
        }
      } else {
        plate(r.winner, 0x140, 0x68, nameOf(r.winner))
        piece(0, 0x48, 0xe0, 0x90, 0x140, 0x8e)
        digits(g.round, 0x21c, 0x8c)
        digits(g.conquestCount[r.winner], 0x21c, 0xb4)
      }
    }
    if (r.flags & 0x20) {
      let x = r.winner < 0 ? 0x140 - ((r.rewards.length * 0x52) >> 1) : 0xdc
      let y = r.winner < 0 ? 0x14c : 0xe0
      for (let i = 0; i < r.rewards.length && i < r.shown; i++) {
        if (i === 5) {
          x = 0xdc
          y += 0x69
        }
        const id = r.rewards[i] & 0xffff
        if (r.anim[i] < 0xb4) {
          if (r.shown >= r.rewards.length && (i === 0 || r.anim[i - 1] > 0x2d)) r.anim[i] += 3
          const a = r.anim[i]
          if (a < 0x5a) this.cardPicRotated(0, x, y, a)
          else this.cardPicRotated(id, x, y, a + 0xb4)
        } else {
          this.cardPic(id, x, y, false)
          if ((r.rewards[i] >>> 28) & 2) this.newBadge(x + 8, y + 0x44)
          if (r.cursor === i) this.pointerHand(x + 0x20, y)
        }
        x += 0x52
      }
    }
    if (!(r.flags & 0x40)) this.drawWindows()
    else if (!(r.flags & 1)) {
      if (this.story) this.drawStory()
    }
    else r.flags = 0x40
    void gl
    return true
  }
  /** uiDrawDigit(1, 1, d, x, y, 0, style 0, 0x80808080): etc.one 2/1 cell, anchor 8 (left, vertically centred). */
  private uiDigit(d: number, x: number, y: number) {
    const s = this.sprNum
    if (!s.img) return
    const [u0, v0, w, h] = this.t.digitCells[0]
    s.cam = CAM_2D
    s.setScale(1, 1)
    s.setRot(0, 0, 0)
    s.srcRect(u0 + d * w, v0, u0 + d * w + w, v0 + h)
    s.anchor(8)
    s.setColor(0x80, 0x80, 0x80, 0x80)
    this.draw(s, x, y)
  }
  /** uiDrawNewBadge(x, y, 0, 100, 100, 0): etc.one 2/3 row 0, centre pivot, scale (100 + uiAnimCounter(1)) / 100. */
  private newBadge(x: number, y: number) {
    const b = this.resSpr?.badge
    if (!b?.img) return
    b.cam = CAM_2D
    b.srcRect(0, 0, 0x40, 0x18)
    b.anchor(0x10)
    const k = (100 + this.badgePulse()) / 100
    b.setScale(k, k)
    this.draw(b, x, y)
  }
  /** uiAnimCounter(1): 0..21 bouncing (advanced once per frame by uiAnimCounter(0)). */
  private badgeCnt = 0
  private badgeDir = 1
  private badgePulse() {
    return this.badgeCnt
  }
  private tickBadge() {
    this.badgeCnt += this.badgeDir
    if (this.badgeCnt > 20) this.badgeDir = -1
    if (this.badgeCnt < 0) this.badgeDir = 1
  }
  /** msgEventDraw: the event's background and CG, then every window (menuWinUpdateAll): the board's, then the event's. */
  private drawStory() {
    const gl = this.gl
    if (gl && this.story) this.story.render(scaledGl(gl), 'back')
    this.drawWindows()
    if (gl && this.story) this.story.render(scaledGl(gl), 'windows')
  }

  // ---- drawing primitives ----

  private emit(spr: Spr, pts: [number, number][]) {
    const gl = this.gl
    const img = spr.img
    if (!gl || !img || spr.rectW === 0 || spr.rectH === 0) return
    const col = spr.color()
    const V = (i: number): Vertex => ({ x: pts[i][0], y: pts[i][1], w: 1, u: spr.u[i] / img.width, v: spr.v[i] / img.height })
    const blend: BlendMode = spr.blend & 1 ? 'add' : 'alpha'
    gl.triangles(gl.texture(img), blend, [V(0), V(1), V(2), V(2), V(1), V(3)], col)
  }

  /** spriteDraw2D / spriteDrawBoundTex: round the projected GE coordinate, then x·480/640, y·272/448 truncated. */
  private draw(spr: Spr, x: number, y: number): [number, number][] {
    const pts = spr.vertices().map((v): [number, number] => {
      const [vx, vy] = project(spr.cam, [v[0] + x, v[1] + y, v[2]])
      const X = Math.round(vx + 1728) - 1728, Y = Math.round(vy + 1824) - 1824
      return [Math.trunc((X * 480) / 640), Math.trunc((Y * 272) / 448)]
    })
    this.emit(spr, pts)
    return pts
  }

  /** spriteDraw2DRounded: (virtual)·0.75 and ·0.60714287, + 0.5, truncated. */
  private drawRounded(spr: Spr, x: number, y: number) {
    const pts = spr.vertices().map((v): [number, number] => {
      const [vx, vy] = project(spr.cam, [v[0] + x, v[1] + y, v[2]])
      return [Math.trunc(vx * 0.75 + 0.5), Math.trunc(vy * 0.60714287 + 0.5)]
    })
    this.emit(spr, pts)
  }

  /** prim2DDraw of a rect (prim2DSetRectSize): vertex colours TL, TR, BL, BR as RGBA 0..255 / 0..0x80. */
  private prim(x: number, y: number, w: number, h: number, cols: [number, number, number, number][]) {
    const gl = this.gl
    if (!gl) return
    const px = (v: number) => Math.trunc(v * 0.75), py = (v: number) => Math.trunc(v * 0.60714287)
    const c = (i: number): [number, number, number, number] => {
      const [r, g, b, a] = cols[i] ?? cols[0]
      return [((r >> 4) & 15) / 15, ((g >> 4) & 15) / 15, ((b >> 4) & 15) / 15, nibA(a) / 15]
    }
    const V = (i: number, vx: number, vy: number): Vertex => ({ x: px(x + vx), y: py(y + vy), w: 1, u: 0, v: 0, c: c(i) })
    const q = [V(0, 0, 0), V(1, w, 0), V(2, 0, h), V(3, w, h)]
    gl.triangles(null, 'alpha', [q[0], q[1], q[2], q[2], q[1], q[3]], [1, 1, 1, 1])
  }

  /** A gothic16 glyph: ink alpha 0x80, 8-neighbour outline alpha 0x20, tinted with font palette `pal`. */
  private glyph(code: number, pal: number): RgbaImage | null {
    const font = this.a.font
    if (!font) return null
    const idx = sjisToGlyph(code)
    const key = idx * 16 + (pal & 15)
    let img = this.glyphs.get(key)
    if (!img) {
      const [r, g, b] = this.t.card.fontPalettes[pal & 15] ?? [255, 255, 255]
      const px = glyphPixels(font, idx, true)
      const rgba = new Uint8ClampedArray(16 * 16 * 4)
      for (let i = 0; i < 256; i++) if (px[i]) rgba.set([r, g, b, px[i] === 1 ? 255 : 63], i * 4)
      img = { width: 16, height: 16, rgba }
      this.glyphs.set(key, img)
    }
    return img
  }

  private glyphQuad(code: number, pal: number, x0: number, y0: number, x1: number, y1: number) {
    const gl = this.gl
    const g = this.glyph(code, pal)
    if (!gl || !g || x1 === x0 || y1 === y0) return
    const V = (x: number, y: number, u: number, v: number): Vertex => ({ x, y, w: 1, u, v })
    gl.triangles(gl.texture(g), 'alpha', [V(x0, y0, 0, 0), V(x1, y0, 1, 0), V(x0, y1, 0, 1), V(x0, y1, 0, 1), V(x1, y0, 1, 0), V(x1, y1, 1, 1)], [1, 1, 1, 1])
  }

  /** fullfontSetText + fullfontDraw at scale 1: 16×16 glyphs, 16 apart, ASCII turned full-width. */
  private fullfont(text: string, x: number, y: number, pal: number) {
    const toX = (v: number) => Math.trunc((v * 480) / 640), toY = (v: number) => Math.trunc((v * 272) / 448)
    let cx = x
    for (const ch of text) {
      const code = asciiToSjis(ch.charCodeAt(0))
      if (code !== 0x8140) this.glyphQuad(code, pal, toX(cx), toY(y), toX(cx + 16), toY(y + 16))
      cx += 16
    }
  }

  /** fontDrawTextScaled(text, x, y, 0, size, line, pal): see cardScreen.ts. */
  private textScaled(raw: Uint8Array, x: number, y: number, size: number, line: number, pal: number) {
    const toX = (v: number) => Math.trunc((v * 480) / 640), toY = (v: number) => Math.trunc((v * 272) / 448)
    const scX = Math.fround((size / 18) * 0.8), scY = Math.fround(line / 18)
    const adv = Math.trunc(scX * 16 - 5)
    const hx = Math.trunc(8 * scX), hy = Math.trunc(8 * scY)
    let cx = x, cy = y
    for (const code of fontCodes(raw)) {
      if (code === FONT_NEWLINE) {
        cx = x
        cy += line & 0xff
        continue
      }
      if (code !== 0x8140) this.glyphQuad(code, pal, toX(cx + 8 - hx), toY(cy + 8 - hy), toX(cx + 8 + hx), toY(cy + 8 + hy))
      cx += adv
    }
  }

  // ---- board passes ----

  /** mapDrawTerrain (0x088514C4). */
  private drawTerrain(range: Uint8Array) {
    const area = this.board.area, variant = this.board.variant
    const [bx, by] = this.t.bgPos[variant ? 1 : 0][area] ?? [0, 0]
    const ccx = this.cursor.x >> 6, ccy = this.cursor.y >> 6
    let off = 0
    const step = area === 8 ? 0x140 : area === 9 || area === 10 ? 0x110 : area === 1 ? 0x168 : 0x160
    const count = this.t.bgCounts[area] ?? 0
    for (let i = 0; i < count; i++) {
      if (i === 0) off = 0
      let show = true
      if (area === 10) show = !(i === 2 && ccx < 10)
      else if (area === 9) show = !(i === 2 && ccx < 8 && ccy > 5)
      else if (area === 8) show = (i !== 0 || ccx < 0x15) && !(i === 2 && ccx < 0x15)
      const s = this.sprBg[i]
      if (show && s?.img) {
        s.setPivot(-off, 0)
        this.drawRounded(s, off - 0x420 + bx, by - 0x132)
      }
      off += step
    }
    this.drawScenery(bx, by)

    const W = this.width, H = this.height
    const t = this.sprTiles
    t.cam = this.cam
    t.pos(0, 0, 0)
    t.anchor(0x10)
    t.setRot(0, 0, 0)
    t.srcRect(0x80, 0xc0, 0xc0, 0x100)
    const pulse = this.pulse
    this.cellQuads.clear()
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (this.land(x, y) < 0) continue
        const flags = this.cellFlags(x, y)
        let r = 0x80, g = 0x80, b = 0x80, a = 0x40
        if (flags & 0xff00) {
          r = g = b = 0x40
          a = 0x60
          if (flags & 0x100) b = 0x80
          else if (flags & 0x200) r = 0x80
          else if (flags & 0x400) g = 0x80
          else if (flags & 0x800) {
            /* team 3: grey */
          } else if (flags & 0x1000) b = 0x80
          else if (flags & 0x2000) r = 0x80
          else if (flags & 0x4000) g = 0x80
        }
        t.setColor(r, g, b, a)
        const q = this.draw(t, x * 64, y * 64)
        this.cellQuads.set(y * 40 + x, [q[0], q[1], q[3], q[2]].map(([px, py]) => ({ x: px, y: py })))
        if (x === ccx && y === ccy && this.cellWord(x, y) !== 0) {
          t.blend = 1
          t.setColor(r, g, b, pulse > 0x7f ? 0x80 : pulse)
          this.draw(t, x * 64, y * 64)
          t.blend = 0
        }
      }
    }
    t.setColor(0x80, 0x80, 0x80, 0x80)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const l = this.land(x, y)
        if (l > 0) {
          t.srcRect((l - 1) * 0x40, 0, l << 6, 0x40)
          this.draw(t, x * 64, y * 64)
        }
      }
    t.srcRect(0xc0, 0xc0, 0x100, 0x100)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (this.land(x, y) >= 0) this.draw(t, x * 64, y * 64)
    t.blend = 1
    t.setColor(0x80, 0x80, 0x80, pulse >> 1)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (this.land(x, y) >= 0) this.draw(t, x * 64, y * 64)
    // move preview: additive white squares, alpha pulse/2, where g_mapMovePreview ≠ 0 (g_mapDrawFlags 0x40)
    t.srcRect(0x80, 0xc0, 0xc0, 0x100)
    t.blend = 1
    t.setColor(0x80, 0x80, 0x80, pulse >> 1)
    if (this.previewOn) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (this.preview[y * 40 + x]) this.draw(t, x * 64, y * 64)
    t.blend = 0
    t.setColor(0x80, 0x80, 0x80, 0x80)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const m = range[y * 40 + x], l = this.land(x, y), hi = m & 0xf0
        const here = x === ccx && y === ccy
        const pulseOver = () => {
          t.blend = 1
          t.setColor(0x80, 0x80, 0x80, pulse >> 1)
          this.draw(t, x * 64, y * 64)
          t.blend = 0
          t.setColor(0x80, 0x80, 0x80, 0x80)
        }
        if (hi === 0x10) {
          if (this.cellWord(x, y) === 0) {
            const lo = m & 0xf
            if (lo === 0) t.srcRect(0x40, 0x40, 0x80, 0x80)
            else t.srcRect(0, 0x40, 0x40, 0x80)
            t.anchor(0x10)
            const hp = 1.570796
            if (lo === 1) t.setRot(0, 0, -hp)
            else if (lo === 2) t.setRot(0, 0, hp)
            else if (lo === 3) t.setRot(0, 0, 0)
            else if (lo === 4) t.setRot(0, 0, 3.141592)
            this.draw(t, x * 64, y * 64)
            t.setRot(0, 0, 0)
          }
        } else if (hi === 0x20) {
          if (l >= 0) {
            const w = this.cellWord(x, y)
            if (this.turnPlayer + 1 === (w & 0xfffffff) >>> 24 || w === 0) t.srcRect(0x40, 0x80, 0x80, 0xc4)
            else t.srcRect(0, 0x80, 0x40, 0xc4)
            this.draw(t, x * 64, y * 64)
            if (here && w !== 0 && (w & 0xf) !== this.turnPlayer + 1) pulseOver()
          }
        } else if (hi === 0x40) {
          if (l >= 0) {
            t.srcRect(0, 0xc4, 0x40, 0x100)
            this.draw(t, x * 64, y * 64)
          }
        } else if (!(m & 0x80)) {
          if (m === 1 && l >= 0) {
            t.srcRect(0, 0x80, 0x40, 0xc0)
            this.draw(t, x * 64, y * 64)
          }
        } else {
          t.srcRect(0, 0xc4, 0x40, 0x100)
          this.draw(t, x * 64, y * 64)
          if (here) pulseOver()
        }
      }
    }
    const cur = this.sprCursor
    cur.cam = this.cam
    cur.anchor(0x10)
    this.draw(cur, this.cursor.x, this.cursor.y)
  }

  /** mapDrawDecorations(−1, −1) (0x088526F8): the layout's scenery records of this area, animated. */
  private drawScenery(bx: number, by: number) {
    const list = this.t.scenery[this.layout - 1]
    if (!list || this.board.area >= 11) return
    for (const e of list) {
      if (e.area !== this.board.area) continue
      if (e.cell >= 0) break
      const slot = e.slot
      this.decoCounter[slot]++
      const delay = Math.max(0, Math.min(0xff, e.delay))
      if (delay < this.decoCounter[slot]) {
        this.decoCounter[slot] = 0
        this.decoFrame[slot]++
      }
      if (e.frames <= this.decoFrame[slot]) this.decoFrame[slot] = 0
      const f = this.decoFrame[slot]
      const x = e.x, y = e.y
      const [u, v, w, h] = e.frameRect[f]
      const s = this.sprDeco[e.frameSprite[f]]
      if (!s) continue
      s.cam = this.cam
      s.setRot(...ROT_BILLBOARD)
      s.srcRect(u, v, u + w, v + h)
      s.setPivot(-x, -y)
      s.setScale(Math.fround(this.t.decoScale * e.sx), Math.fround(this.t.decoScale * e.sy))
      s.blend = e.blend
      this.drawRounded(s, x + bx - 0x400, y + by - 0x140)
    }
  }

  /**
   * mapDrawSeizeFx (0x088596CC): additive walls on the four edges of the square, height = anim (max
   * 0x20). spriteSetAnchor(0x10) comes before spriteSetSrcRect, which resets the pivot to the top-left
   * corner, so each wall turns about its corner and lies on a square edge.
   */
  private drawSeize(x: number, y: number) {
    const i = y * 40 + x
    if (this.seizeState[i] === 1) this.seizeAnim[i] = (this.seizeAnim[i] + 2) & 0xff
    else this.seizeAnim[i] = (this.seizeAnim[i] - 2) & 0xff
    let v = this.seizeAnim[i]
    const s = this.sprWall
    if (v === 0) this.seizeState[i] = 0
    else {
      if (v > 0x27) this.seizeState[i] = 2
      if (v > 0x20) v = 0x20
      s.cam = this.cam
      s.pos(0, 0, 0)
      s.anchor(0x10)
      s.setColor(this.handPlayer === 1 ? 0x80 : 0, 0, this.handPlayer === 0 ? 0x80 : 0, 0x80)
      s.srcRect(0, 0, 0x40, v)
      s.blend = 1
      const hp = 1.5707964
      const X = x * 64, Y = y * 64
      s.setRot(0, hp, hp)
      for (let k = 0; k < 4; k++) this.draw(s, X, Y)
      this.draw(s, X + 0x40, Y)
      this.draw(s, X + 0x40, Y)
      s.setRot(hp, 0, 0)
      this.draw(s, X, Y)
      this.draw(s, X, Y)
      this.draw(s, X, Y + 0x40)
      this.draw(s, X, Y + 0x40)
    }
    s.srcRect(0, 0, 0x40, 0x40)
    s.setScale(1, 1)
    s.setRot(0, 0, 0)
    s.setColor(0x80, 0x80, 0x80, 0x80)
    s.blend = 0
  }

  private token(cardId: number): Spr {
    // cardGetTokenSprite: rematch Dominators 1012..1021 use 1002..1011.
    const id = cardId > 1011 && cardId < 2000 ? cardId - 10 : cardId
    let s = this.tokens.get(id)
    if (!s) {
      s = new Spr(this.a.token(id))
      this.tokens.set(id, s)
    }
    return s
  }

  /**
   * mapDrawUnit (0x0883156C). The token goes to the square (sqX, sqY) passed by mapDrawAllUnits, with
   * the half picked by `facing` (grid units always pass 0, the lifted unit its own facing); shadow,
   * cursor highlight, flag, "E" and digits follow the unit's own position; state 2 draws the walking
   * GAN instead of the token. Returns true when the cursor is exactly on the unit.
   */
  private drawUnit(u: MapUnitState, sqX: number, sqY: number, facingParam: number): boolean {
    const card = this.db.byId.get(u.cardId)
    const sx = Math.fround(u.scalePct / 100)
    const facing = u.cardId < 2000 ? facingParam & 0xf : 0
    const yawDeg = facing & 1 ? -0x96 : 0x1e
    const spr = this.token(u.cardId)
    const posX = u.posX ?? u.cellX * 64, posY = u.posY ?? u.cellY * 64
    let half = 0x20, ox: number, oy = 0
    if (u.cardId < 0xbb9) {
      const W = spr.w, H = spr.h
      half = W >> 1
      if ((facingParam & 0xf) < 2) spr.srcRect(0, 0, half, H)
      else spr.srcRect(half, 0, half << 1, H)
      ox = 0x22 - (W >> 2)
      oy = 0x24 - H
    } else {
      if (u.player === 0) spr.setColor(0x60, 0x60, 0x8f, 0x80)
      else if (u.player === 1) spr.setColor(0x8f, 0x60, 0x60, 0x80)
      ox = 0x10
    }
    if (u.state >= 1 && u.state <= 4 && sx > 0) {
      const sh = this.sprShadow
      sh.cam = this.cam
      sh.anchor(0x10)
      sh.resetOffset()
      const k = half < 0x40 ? sx : Math.fround(sx * 1.5)
      sh.setScale(k, k)
      this.draw(sh, posX + 0x20, posY + 0x20)
    }
    if (u.state !== 6 && u.state !== 5) {
      if (u.state === 2) this.drawWalk(u, posX, posY)
      else if (u.scalePct > 0) {
        spr.cam = this.cam
        spr.anchor(2)
        spr.setRot(-1.5707963, Math.fround((3.1415926 * yawDeg) / 180), 0)
        spr.setScale(sx, sx)
        spr.blend = 0
        if (u.actFlags & 8) spr.setColor(0x40, 0x40, 0x40, 0x80)
        else spr.setColor(0x80, 0x80, 0x80, 0x80)
        const pts = this.draw(spr, ox + sqX * 64, oy + sqY * 64)
        if (spr.img) this.unitHits.push({ cell: [sqX, sqY], pts, img: spr.img, u: [...spr.u], v: [...spr.v] })
      }
    }
    let onCursor = false
    if (this.cursor.x === posX && this.cursor.y === posY) {
      onCursor = true
      if (u.state !== 2 && this.blinkOn) {
        spr.blend = 1
        spr.setColor(0x80, 0x80, 0x80, this.pulse > 0x7f ? 0x80 : this.pulse)
        this.draw(spr, posX + ox, posY + oy)
      }
      spr.setScale(1, 1)
    }
    if (u.slot === 0) {
      const f = 7 - (this.animCounter3 >> 3)
      const fl = this.sprFlag
      fl.cam = this.cam
      if (u.player === 0) fl.srcRect(f << 5, 0, (f + 1) * 0x20, 0x20)
      else fl.srcRect(f << 5, 0x20, (f + 1) * 0x20, 0x40)
      fl.anchor(2)
      fl.setRot(...ROT_BILLBOARD_UNIT)
      fl.setScale(sx, sx)
      this.draw(fl, posX + ox - 0x40, posY + oy - 0x60)
      fl.setScale(1, 1)
    }
    if (u.actFlags & 8) {
      const e = this.sprActed
      e.cam = this.cam
      e.anchor(2)
      e.setRot(...ROT_BILLBOARD_UNIT)
      e.setScale(sx, sx)
      this.draw(e, posX + ox - 0x40, posY + oy - 0x60)
      e.setScale(1, 1)
    }
    const ov = this.opts.statOverlay
    if (ov && card) {
      const d = this.sprDigits
      d.cam = this.cam
      d.setScale(1, 1)
      d.setRot(...ROT_BILLBOARD_UNIT)
      const st = this.stats(u)
      let value = ov === 1 ? st.ap : ov === 2 ? st.hp : st.df
      let div = 10, dx = 0
      for (;;) {
        let dgt = Math.trunc(value / div)
        d.srcRect(dgt * 0x12, 0x28, (dgt + 1) * 0x12, 0x40)
        if (div < 10) dgt = 1
        if (dgt > 0) {
          d.setPivot(-dx, 0)
          this.draw(d, posX + dx - 0x40, posY - 0x60)
        }
        dx += 0x12
        if (div < 10) break
        value %= div
        div = Math.trunc(div / 10)
      }
    }
    return onCursor
  }

  /** The stats the hover panel and the digits show: effective AP / DF (unitRecalcStats) and HP. */
  stats(u: MapUnitState) {
    if (u.cardId < 2000) this.game.recalc(u)
    return { ap: u.effAp, hp: u.hp, df: u.effDf }
  }

  /** mapDrawCellDecoration (0x08852534), walked in draw order with a running index. */
  private cellDecoIdx = 0
  private drawCellDeco(x: number, y: number): boolean {
    if (x === 0 && y === 0) this.cellDecoIdx = 0
    if (this.layout < 1 || this.cellDecoIdx >= 16) return false
    const e = this.t.cellDeco[this.layout - 1]?.[this.cellDecoIdx]
    if (!e) return false
    if (e.cellX !== x || e.cellY !== y) return true
    const s = this.sprDeco[e.sprite]
    if (s) {
      s.cam = this.cam
      s.setRot(...ROT_BILLBOARD)
      s.srcRect(e.rect[0], e.rect[1], e.rect[2], e.rect[3])
      s.setScale(Math.fround(this.t.decoScale * e.sx), Math.fround(this.t.decoScale * e.sy))
      this.drawRounded(s, x * 0x40 + e.dx, y * 0x40 + e.dy)
    }
    this.cellDecoIdx++
    return true
  }

  /**
   * mapDrawAllUnits (0x08831DB4): pulse, then per square: seize walls, the unit on the grid (facing 0;
   * state 1 grows the display scale +10 per frame up to 100, state 4 shrinks it and ends in state 6),
   * the lifted g_mapActiveUnit when its position is in this square (with its own facing), the cell
   * decoration.
   */
  private drawAllUnits(): MapUnitState | null {
    if (this.pulse > 0x87) this.pulseDir = -2
    if (this.pulse < 1) this.pulseDir = 2
    this.pulse = this.blinkOn === 0 ? 0 : this.pulse + this.pulseDir
    let hover: MapUnitState | null = null
    let decoMore = true
    const act = this.active
    let lifted = act && act.state > 0 ? act.state : 0
    const ax = act ? (act.posX ?? act.cellX * 64) >> 6 : -1, ay = act ? (act.posY ?? act.cellY * 64) >> 6 : -1
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.seizeState[y * 40 + x] !== 0) this.drawSeize(x, y)
        const u = this.unitAt(x, y)
        if (u) {
          if (u.state === 4) {
            if (u.scalePct < 1) u.state = 6
            else u.scalePct -= 10
          } else if (u.state === 1 && u.scalePct < 100) u.scalePct += 10
          if (this.drawUnit(u, x, y, 0)) hover = u
        }
        if (act && lifted > 0 && x === ax && y === ay) {
          if (lifted === 2) lifted = 0
          if (this.drawUnit(act, x, y, act.facing ?? 0)) hover = act
        }
        if (decoMore) decoMore = this.drawCellDeco(x, y)
      }
    }
    return hover
  }

  // ---- 2D passes ----

  /** mapDrawCursorMarker (0x0882F180): the pointer hand (etc 2/2, 48×32), rotated into the scene. */
  private drawCursorMarker() {
    const h = this.sprHand
    if (!h.img) return
    h.cam = this.cam
    h.srcRect(0, 0, 0x30, 0x20)
    h.anchor(2)
    h.setRot(-1.570796, 0.5235987, 1.570796)
    this.draw(h, this.cursor.x - 0x70, this.cursor.y - 0xc0)
  }

  /**
   * Mouse (Play mode, ours), called by mapCursorUpdate, so every state with the free cursor has it (the free
   * cursor, move / attack targets, deploy and start squares, check board, the flows' square picks): pointing
   * at a square (or a unit's sprite) puts the cursor there, a left click also presses ✕ on the next frame
   * (the frame's own code already read the pad and the cursor). Only between steps, never onto a missing
   * square, never through an open window. Returns true when the mouse moved the cursor or clicked this
   * frame (mapCursorUpdate then reports "moving").
   */
  private mousePick(): boolean {
    const mp = this.pointer
    const click = (this.pressed & PAD_POINTER) !== 0
    if (mp.x < 0 || (!mp.moved && !click)) return false
    const c = this.cursor
    if (c.x & 0x3f || c.y & 0x3f || this.stepX || this.stepY) return false
    if (this.pointerOverWindow()) return false
    const cell = this.pickCell(mp.x, mp.y)
    if (!cell || this.land(cell[0], cell[1]) < 0) return false
    const x = cell[0] * 64, y = cell[1] * 64
    const moved = c.x !== x || c.y !== y
    // the focus stays where the camera is now
    if (!this.camFocus) this.camFocus = { x: c.x, y: c.y }
    c.x = x
    c.y = y
    this.mouseCam = true
    this.camEase = false
    this.mouseSet = { x, y }
    if (click) {
      this.pressed &= ~PAD_POINTER
      this.mouseCross = true
    }
    return moved || click
  }

  /** The pointer is over an open window, the status HUD or a hand panel of the board (no board picks there). */
  private pointerOverWindow(): boolean {
    const { x, y } = this.pointer
    if (this.game.drawFlags & 8 && this.opts.statusHud && x >= 0x178 && y < 0x86) return true
    for (const p of this.players) if (p?.visible && y >= p.panelY - 0x10 && x >= p.panelX - 0x10) return true
    for (const mw of this.wins) {
      const w = mw.win
      if ((w.alpha ?? 0x80) <= 0) continue
      const [left, top] = windowOrigin(w)
      if (x >= left && x < left + w.w && y >= top && y < top + w.h) return true
    }
    return false
  }

  /** The square under virtual point (vx, vy): a unit's sprite (alpha-tested, topmost first), else the ground quad. */
  private pickCell(vx: number, vy: number): [number, number] | null {
    const x = vx * 0.75, y = (vy * 272) / 448
    for (let i = this.unitHits.length - 1; i >= 0; i--) {
      const h = this.unitHits[i]
      const [p0, p1, p2, p3] = h.pts
      if (!inQuad([p0, p1, p3, p2].map(([px, py]) => ({ x: px, y: py })), x, y)) continue
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], bx = p2[0] - p0[0], by = p2[1] - p0[1]
      const det = ax * by - ay * bx
      if (!det) continue
      const dx = x - p0[0], dy = y - p0[1]
      const s = (dx * by - dy * bx) / det, t = (ax * dy - ay * dx) / det
      const u = Math.floor(h.u[0] + s * (h.u[1] - h.u[0])), v = Math.floor(h.v[0] + t * (h.v[2] - h.v[0]))
      if (u < 0 || v < 0 || u >= h.img.width || v >= h.img.height) continue
      if (h.img.rgba[(v * h.img.width + u) * 4 + 3] > 0x20) return h.cell
    }
    return this.cellAt(x, y)
  }

  /**
   * The camera's focus for mapSetupCameraMatrix: the cursor (the game), or while the mouse drives the cursor
   * the focus of the moment, moved toward the cursor only while its square is near the screen edges; after
   * that it eases back to the cursor.
   */
  private cameraFocus(): { x: number; y: number } {
    const c = this.cursor
    if (this.mouseCam && (c.x !== this.mouseSet.x || c.y !== this.mouseSet.y || !this.cursorCalled)) {
      this.mouseCam = false
      this.camEase = true
    }
    const f = this.camFocus
    if (!f || (!this.mouseCam && !this.camEase)) {
      this.camFocus = null
      return c
    }
    if (this.mouseCam) {
      // edge scrolling: the cursor square's centre, seen through the current camera (virtual 640×448)
      const [sx, sy] = project(this.cam, [c.x + 32, c.y + 32, 0])
      // (the status HUD covers the top right)
      if (sx < 96 || sx > 544 || sy < 80 || sy > 368 || (sx > 340 && sy < 170)) {
        const step = (d: number) => (d === 0 ? 0 : Math.sign(d) * Math.max(2, Math.min(Math.abs(d), Math.trunc(Math.abs(d) / 12))))
        f.x += step(c.x - f.x)
        f.y += step(c.y - f.y)
      }
      return f
    }
    const ease = (d: number) => (Math.abs(d) <= 8 ? d : Math.trunc(d / 3))
    f.x += ease(c.x - f.x)
    f.y += ease(c.y - f.y)
    if (f.x === c.x && f.y === c.y) {
      this.camEase = false
      this.camFocus = null
    }
    return f
  }

  /**
   * Mouse (ours) on the command ring: pointing at an icon turns the ring to it one step at a time, as a
   * held ←/→ does (at rest only); a click on an icon turns to it and chooses it like ✕. Returns true when the
   * click chose.
   */
  private ringMouse(atRest: boolean): boolean {
    const c = this.cmd
    const n = c.count
    const mp = this.pointer
    if (this.pad & (PAD_LEFT | PAD_RIGHT)) {
      this.ringTarget = -1
      this.ringClick = false
    }
    if (mp.x >= 0) {
      const x = mp.x * 0.75, y = (mp.y * 272) / 448
      let under = -1, best = 1e9
      for (const h of this.ringHits) {
        const [p0, p1, p2, p3] = h.pts
        if (Math.abs(h.j) < best && inQuad([p0, p1, p3, p2].map(([px, py]) => ({ x: px, y: py })), x, y)) {
          under = h.k
          best = Math.abs(h.j)
        }
      }
      if (this.pressed & PAD_POINTER && under >= 0) {
        this.pressed &= ~PAD_POINTER
        this.ringTarget = under
        this.ringClick = true
      } else if (mp.moved && under >= 0 && under !== this.ringUnder) this.ringTarget = under
      this.ringUnder = under
    }
    const t = this.ringTarget
    if (!atRest || t < 0 || t >= n) return false
    if (t === c.sel) {
      this.ringTarget = -1
      const chose = this.ringClick
      this.ringClick = false
      return chose
    }
    // the shorter way round: Left (sel + 1) or Right (sel − 1)
    const d = (((t - c.sel) % n) + n) % n
    if (d <= n / 2) c.sel++
    else c.sel--
    return false
  }

  /** Mouse (ours): winUpdateInput's rows under the pointer: hovering a row moves the cursor there, a click chooses it like ✕. */
  private listMouse(mw: MapWin, row: number, top: number): number {
    const mp = this.pointer
    const m = mw.win.menu
    const click = (this.pressed & PAD_POINTER) !== 0
    if (!m || mp.x < 0 || (!mp.moved && !click)) return row
    const w = mw.win
    const lineH = w.wide ? (w.glyph ?? 20) + 2 : (w.glyph ?? 20)
    const offX = m.offX ?? 10, offY = m.offY ?? 8
    const cw = m.cursorW ?? Math.trunc(w.w) - 20
    const x0 = w.x + offX - 1, x1 = x0 + ((w.flags ?? 0) & WF_SCROLLBAR ? cw - 16 : cw)
    const r = Math.floor((mp.y - (w.y + offY - 1)) / lineH)
    if (mp.x < x0 || mp.x >= x1 || r < 0 || r >= (m.visibleRows ?? 1) || top + r >= (m.itemCount ?? 1)) return row
    if (click) this.pressed = (this.pressed & ~PAD_POINTER) | PAD_CROSS
    return r
  }

  /** mapDrawStatusHud (0x08859A60). */
  private drawStatusHud() {
    const s = this.sprStatus
    if (!s.img) return
    s.setScale(1.33333, 1.33333)
    this.draw(s, 0x178, 6)
    let y = 0xc
    for (let p = 0; p < 2; p++) {
      if (p > 0) y = 0x46
      if (p === this.turnPlayer) {
        const c: [number, number, number, number] = p === 0 ? [0x10, 0x10, 0xf0, 0x60] : [0xf0, 0x10, 0x10, 0x60]
        const g: [number, number, number, number] = [0x80, 0x80, 0x80, 0x60]
        this.prim(0x180, y + 2, 0xf0, 0xd, [c, g, c, g])
      }
      this.fullfont(this.playerNames[p] ?? '', 0x180, y, 0)
      if (p === this.turnPlayer) {
        const fl = this.sprFlag
        fl.cam = CAM_2D
        const u0 = (7 - (this.animCounter3 >> 3)) << 5
        if (p === 0) fl.srcRect(u0, 0, u0 + 0x20, 0x1a)
        else fl.srcRect(u0, 0x20, u0 + 0x20, 0x3a)
        fl.anchor(2)
        fl.setScale(1, 1)
        fl.setRot(0, 0, 0)
        this.draw(fl, 600, y - 6)
      }
      const pl = this.players[p]
      const pad = (n: number, w: number) => String(n).padStart(w, ' ')
      this.fullfont(pad(pl?.cost ?? 0, 3), 0x1b4, y + 0x13, 0)
      this.fullfont(pad(this.game.conquestCount[p] ?? 0, 3), 0x1f5, y + 0x13, 0xe)
      this.fullfont(pad(pl?.maintenance ?? 0, 3), 0x240, y + 0x13, 0xd)
      y += 0x27
      this.fullfont(pad(pl?.soul ?? 0, 2), 0x1b4, y, 0)
      this.fullfont(pad(pl ? this.game.recountDeck(pl) : 0, 2), 0x208, y, 0)
      this.fullfont(String(pl ? this.game.handCount(pl) : 0), 0x260, y, 0)
    }
  }

  /** mapDrawUnitHoverPanel (0x0881F81C). */
  private drawHoverPanel(u: MapUnitState) {
    const card = this.db.byId.get(u.cardId)
    if (!card) return
    const team: [number, number, number, number] = u.team === 0 ? [0, 0, 0x80, 0x4f] : [0x80, 0, 0, 0x4f]
    this.prim(0x1b0, 0xb3, 0xc0, 0x16, [team, team, team, team])
    const b = this.sprBanner
    if (u.team === 0) b.srcRect(0, 0x22, 0xd8, 0x44)
    else b.srcRect(0, 0, 0xd8, 0x22)
    this.draw(b, 0x1a3, 0xa7)
    const name = this.db.raw.cardStrings.get(card.id)?.name ?? new Uint8Array(0)
    this.textScaled(name, 0x1bb, 0xb1, 0x16, 0x16, 0)
    const dark: [number, number, number, number] = [0x10, 0x10, 0x10, 0x60]
    this.prim(0x1b0, 0xc9, 0xc0, 0x60, [dark, dark, dark, dark])
    let pic = this.pictures.get(card.id)
    if (!pic) {
      pic = new Spr(this.a.picture(card.id))
      this.pictures.set(card.id, pic)
    }
    if (pic.img) {
      pic.setScale(1.6, Math.fround((100 / pic.h) * 0.8))
      this.draw(pic, 0x1ba, 0xcd)
    }
    const st = this.stats(u)
    const sj = (s: string) => {
      // "ＡＰ %d": two full-width letters (Shift-JIS) then ASCII.
      const out: number[] = []
      for (const ch of s) {
        const c = ch.charCodeAt(0)
        if (c >= 0xff21 && c <= 0xff3a) out.push(0x82, 0x60 + (c - 0xff21))
        else out.push(c & 0xff)
      }
      return Uint8Array.from(out)
    }
    const tx = Math.trunc(0x1ba + 72)
    this.textScaled(sj(`ＡＰ ${st.ap}`), tx, 0xcd, 0x16, 0x16, 0)
    this.textScaled(sj(`ＨＰ ${st.hp}`), tx, 0xe1, 0x16, 0x16, 0)
    this.textScaled(sj(`ＤＦ ${st.df}`), tx, 0xf5, 0x16, 0x16, 0)
    const icons = this.sprIcons
    const rects = this.t.card.attrIcons
    const icon = (k: number, x: number) => {
      const r = rects[k]
      if (!r || !icons.img) return
      icons.srcRect(r[0], r[1], r[2], r[3])
      icons.setScale(1, 1)
      this.draw(icons, x, 0x11f)
    }
    let x = 0x1b0
    icon(card.attribute, x)
    // One icon per attribute bit of the attached cards (spell categories 5..12), ascending, up to five;
    // the loop stops at the highest set bit and fills the rest with icon 0.
    let bits = 0
    for (const a of u.attachments) if (a) bits |= 1 << ((this.db.byId.get(a)?.attribute ?? 0) & 0x1f)
    let n = 0
    for (let b = 1; ; b++) {
      const rest = bits >>> b
      if (rest & 1) {
        x += 0x20
        icon(b, x)
        n++
      }
      if (n > 4 || rest === 0 || b > 0x1f) break
    }
    while (n < 5) {
      x += 0x20
      icon(0, x)
      n++
    }
  }

  // ---- walking animation ----

  /**
   * mapDrawUnitWalkAnim (0x08831428): g_mapUnitWalkAnm, anim 0 (/12) for facings 0/1 and anim 1 (/13)
   * for 2/3 (anmSwitch restarts the GAN when it changes), offset (0x20, 0x24), world rotation
   * (−90°, yaw, 0) with yaw 30° (even facing) or 210° → −150° (odd), drawn at the unit's position and
   * ticked once per draw (ganDrawAndTick). Each part is its own sprite: pivot = centre, rotation and
   * scale from the part, position = (dx − 128, dy − 128); the world rotation is applied to the float
   * vertex and truncated (spriteUpdateVertices flag 2), then spriteDraw2D with the map camera.
   */
  private drawWalk(u: MapUnitState, posX: number, posY: number) {
    const a = this.walk
    if (!a || u.cardId < 0) return
    const facing = u.facing ?? 0
    let yaw = facing & 1 ? 0xd2 : 0x1e
    if (yaw > 0xb4) yaw -= 0x168
    a.select(facing < 2 ? 0 : 1)
    const g = a.gans[a.current]
    if (!g || !g.steps.length) return
    const step = g.steps[stepAt(g, a.time)]
    const parts = g.frames[step.frame] ?? []
    const rx = -1.570796, ry = Math.fround((yaw * 3.141592) / 180)
    const X = posX + 0x20, Y = posY + 0x24
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      if (p.image >= g.images.length || p.w <= 0 || p.h <= 0 || isMarker(p)) continue
      const blend = p.flags & 1 ? (p.flags >> 4) & 3 : 0x60
      const base = blend === 3 ? 0x20 : blend === 2 ? 0 : blend === 0 ? 0x40 : 0x7f
      const alpha = (((0xff * base) >> 6) & 0xff) >> 1
      if (nibA(alpha) === 0) continue
      const pw = Math.trunc(p.w / 2), ph = Math.trunc(p.h / 2)
      const ang = p.flags & 4 ? (p.angle * PI_F) / 180 : 0
      const verts = [[0, 0], [p.w, 0], [0, p.h], [p.w, p.h]].map(([cx, cy]): V3 => {
        let x = cx - pw, y = cy - ph
        if (p.flags & 8) {
          x *= p.scaleX
          y *= p.scaleY
        }
        if (ang) [x, y] = [x * Math.cos(ang) - y * Math.sin(ang), x * Math.sin(ang) + y * Math.cos(ang)]
        const w = rotZYX(pw + p.dx - 128 + x, ph + p.dy - 128 + y, 0, rx, ry, 0)
        return [Math.trunc(w[0]), Math.trunc(w[1]), Math.trunc(w[2])]
      })
      const img = a.sheet(p.image, p.clut)
      const pts = this.projectPts(this.cam, verts, X, Y)
      const gl = this.gl
      if (!gl) continue
      const c: [number, number, number, number] = [1, 1, 1, nibA(alpha) / 15]
      const V = (k: number, uu: number, vv: number): Vertex => ({ x: pts[k][0], y: pts[k][1], w: 1, u: uu / img.width, v: vv / img.height })
      const q = [V(0, p.sx, p.sy), V(1, p.sx + p.w, p.sy), V(2, p.sx, p.sy + p.h), V(3, p.sx + p.w, p.sy + p.h)]
      gl.triangles(gl.texture(img), blend & 1 ? 'add' : 'alpha', [q[0], q[1], q[2], q[2], q[1], q[3]], c)
    }
    a.tick()
  }

  /** spriteDraw2D rounding for precomputed vertices. */
  private projectPts(cam: Cam, verts: V3[], x: number, y: number): [number, number][] {
    return verts.map((v): [number, number] => {
      const [vx, vy] = project(cam, [v[0] + x, v[1] + y, v[2]])
      const X = Math.round(vx + 1728) - 1728, Y = Math.round(vy + 1824) - 1824
      return [Math.trunc((X * 480) / 640), Math.trunc((Y * 272) / 448)]
    })
  }

  /** spriteDrawProjected (render mode 0): world = vertex + (x, y, z), sx = (X − 2048 + 320)·480/640 truncated. */
  private drawProjected(spr: Spr, x: number, y: number, z: number): [number, number][] {
    const pts = spr.vertices().map((v): [number, number] => {
      const [vx, vy] = project(spr.cam, [v[0] + x, v[1] + y, v[2] + z])
      return [Math.trunc((vx * 480) / 640), Math.trunc((vy * 272) / 448)]
    })
    this.emit(spr, pts)
    return pts
  }

  // ---- windows (menuWinUpdateAll) ----

  /** ASCII text as game bytes, cached so the window layout cache keeps hitting. */
  private bytesOf(s: string): Uint8Array {
    let b = this.enc.get(s)
    if (!b) {
      b = Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff)
      this.enc.set(s, b)
    }
    return b
  }

  private win(key: string): MapWin | undefined {
    return this.wins.find((w) => w.key === key)
  }

  private closeWin(key: string) {
    this.wins = this.wins.filter((w) => w.key !== key)
  }

  private closeAll() {
    this.wins = []
  }

  /**
   * winOpenMessage(x, y, 0, 0, win, glyph, glyph, text, 0, 0, flags) followed by the callers' usual
   * drawStyle = 10, w += 10, h += 10. Flags 0x1000 / 0x2000 size the window to the text, 0x4000 /
   * 0x8000 centre it; the text is laid out at once (type delay 0) and fades in 4 per frame.
   */
  private openMessage(key: string, x: number, y: number, text: Uint8Array, glyph: number, flags: number, grow = true): MapWin {
    this.closeWin(key)
    const lay = layoutText(text, { glyph, tables: this.t.win })
    const w: DuelWindow = { x, y, w: 0, h: 0, codes: [], text, glyph, opened: this.frameNo, style: 10, chamfer: 5, flags: flags & (WF_CENTER_X | WF_CENTER_Y), alpha: 0x80 }
    if (flags & 0x1000) w.w = lay.autoW
    if (flags & 0x2000) w.h = lay.autoH
    if (grow) {
      w.w += 10
      w.h += 10
    }
    const mw: MapWin = { key, win: w, prints: [] }
    this.wins.push(mw)
    return mw
  }

  /** winOpenFrame(x, y, w, h, chamfer, win, style, flags): a window without text of its own (winPrintAt adds lines). */
  private openFrame(key: string, x: number, y: number, w: number, h: number, chamfer: number, style: number, flags: number): MapWin {
    this.closeWin(key)
    const mw: MapWin = { key, win: { x, y, w, h, codes: [], opened: this.frameNo, style, chamfer, flags: flags & (WF_CENTER_X | WF_CENTER_Y), alpha: 0x80 }, prints: [], autoW: (flags & 0x1000) !== 0 }
    this.wins.push(mw)
    return mw
  }

  /** winPrintAt(win, x, y, glyph, glyph, 0, text): glyph fade step 0x7F; with flag 0x1000, w = max(w, cursorX + 20). */
  private printAt(mw: MapWin, x: number, y: number, glyph: number, text: Uint8Array) {
    mw.prints.push({ x, y, glyph, text, at: this.frameNo })
    if (mw.autoW) mw.win.w = Math.max(mw.win.w, layoutText(text, { glyph, originX: x, tables: this.t.win }).autoW)
  }

  /** winFadeClose(win, step): alpha − step, closed below 0. Returns false once closed. */
  private fadeClose(key: string, step: number): boolean {
    const mw = this.win(key)
    if (!mw) return false
    const a = mw.win.alpha ?? 0x80
    if (a - step < 0) {
      this.closeWin(key)
      return false
    }
    mw.win.alpha = a - step
    return true
  }

  /** menuWinUpdateAll: every window in list order; winPrintAt lines are drawn as the window's own glyphs. */
  private drawWindows() {
    const gl = this.gl, painter = this.painter
    if (!gl || !painter) return
    const sgl = scaledGl(gl)
    for (const mw of this.wins) {
      const w = mw.win
      if (mw.list) mw.list.noInput = false
      painter.draw(sgl, w, this.frameNo)
      const style = w.style ?? 10
      const [ox, oy] = this.t.win.textOffset[style] ?? [0, 0]
      let X = w.x, Y = w.y
      if ((w.flags ?? 0) & WF_CENTER_X) X -= Math.trunc(w.w / 2)
      if ((w.flags ?? 0) & WF_CENTER_Y) Y -= Math.trunc(w.h / 2)
      const hv = this.helpHover
      if (hv && hv.key === mw.key) {
        // ours: the hovered help label gets the cursor bar; the window's own text is drawn again on top (prints follow anyway)
        painter.drawCursorBar(sgl, hv.x0, hv.y0, hv.x1 - hv.x0, hv.y1 - hv.y0, w.alpha ?? 0x80)
        if (w.text) painter.draw(sgl, { x: X + ox, y: Y + oy, w: 0, h: 0, codes: [], text: w.text, glyph: w.glyph, wide: w.wide, style: 0, fade: 0x7f, opened: w.opened, alpha: w.alpha, bright: w.bright }, this.frameNo)
      }
      if (!mw.prints.length) continue
      for (const p of mw.prints) {
        painter.draw(sgl, { x: X + ox, y: Y + oy + p.y, w: 0, h: 0, codes: [], text: p.text, glyph: p.glyph, textX: p.x, style: 0, fade: 0x7f, opened: p.at - 1, alpha: w.alpha, bright: w.bright }, this.frameNo)
      }
    }
    if (this.rulesHelp && this.state === STATE.help) this.rulesHelp.draw(sgl, painter)
  }

  // ---- command menu ----

  /** mapCmdMenuOpen (0x088321BC). After a move (Standby offered, Move not) the ring starts on Attack, else Skills, else Standby. */
  private cmdOpen(bits: number) {
    const c = this.cmd
    c.sel = c.shown = c.angle = 0
    this.ringTarget = this.ringUnder = -1
    this.ringClick = false
    c.bits = bits
    let n = 0
    for (let b = 0; b < 32; b++) if ((bits >> b) & 1) n++
    c.count = n
    if (!(bits & 1) && bits & 0x100) {
      let i = 0
      for (let b = 0; b < 32; b++) {
        if (bits & 0x80) {
          if (b === 7) break
        } else if (bits & 0x40) {
          if (b === 6) break
        } else if (bits & 0x100 && b === 8) break
        if ((bits >> b) & 1) i++
      }
      if (i > 0 && i !== n) {
        c.sel = c.shown = i
        c.angle = Math.trunc((i * -0x168) / n)
      }
    }
  }

  /**
   * mapCmdMenuUpdate (0x088322EC). At rest: the label window (winOpenFrame(128, 128, 150, 52, 16,
   * style 10), alpha 0, easing to (96, 176) by 1/8 and +8 alpha per frame) shows the selected label at
   * x = 55 − (len/2 · 22)/2; Cross returns the command bit, Circle −1, held Left/Right step the
   * selection. Turning: 20/n one-degree steps per frame until the angle is a multiple of 360/n.
   */
  private cmdUpdate(): number {
    const c = this.cmd
    const n = c.count
    if (n < 1) return -1
    const sel0 = c.sel, shown0 = c.shown
    const list: number[] = []
    let label = this.t.cmdNames[0]
    for (let b = 0; b < 9; b++) {
      if (!((c.bits >> b) & 1)) continue
      if (list.length === c.sel) label = this.t.cmdNames[b]
      list.push(1 << b)
    }
    const mw = this.win('menu')
    if (mw) {
      mw.win.x -= (mw.win.x - 96) / 8
      mw.win.y -= (mw.win.y - 176) / 8
      mw.win.alpha = Math.max(0, Math.min(0x80, (mw.win.alpha ?? 0) + 8))
    }
    const mouseChose = this.ringMouse(sel0 === shown0)
    if (sel0 === shown0) {
      let m = this.win('menu')
      if (!m) {
        m = this.openFrame('menu', 128, 128, 150, 52, 16, 10, 0)
        m.win.alpha = 0
      }
      m.prints = []
      this.printAt(m, Math.trunc(55 - ((label.length >> 1) * 22) / 2), 0, 0x16, label)
      if (this.pressed & PAD_CROSS || mouseChose) {
        this.closeWin('menu')
        return list[c.sel]
      }
      if (this.pressed & PAD_CIRCLE) {
        this.closeWin('menu')
        return -1
      }
      if (this.pad & PAD_LEFT) c.sel++
      else if (this.pad & PAD_RIGHT) c.sel--
      return 0
    }
    if (mw) mw.prints = []
    const steps = Math.trunc(0x14 / n)
    for (let i = 0; i < steps; i++) {
      if (sel0 < shown0) c.angle++
      if (shown0 < sel0) c.angle--
      if (c.angle > 0xb4) c.angle -= 0x168
      if (c.angle < -0xb4) c.angle += 0x168
      if (c.angle % Math.trunc(0x168 / n) === 0) {
        if (c.sel < 0) c.sel = n - 1
        if (c.sel >= n) c.sel = 0
        c.shown = c.sel
        return 0
      }
    }
    return 0
  }

  /**
   * mapCmdMenuDrawRing (0x088326EC): one 64×64 icon of etc.one 110/1 per command bit, through
   * g_mapHudCam3D (perspective, eye (128, 256, −640)). Icon k sits at angle j = angle + (360/n)·k:
   * world rotation Z = j, own rotation Z = −j (stays upright), position (−24, 80), drawn at depth
   * |j|·2.5 (farther icons shrink); the icon at j = 0 is opaque, the others alpha 0x60.
   */
  private drawRing() {
    const s = this.sprRing
    if (!s.img) return
    const c = this.cmd
    let n = 0
    for (let b = 0; b < 9; b++) if ((c.bits >> b) & 1) n++
    if (!n) return
    let k = 0
    this.ringHits = []
    for (let b = 0; b < 9; b++) {
      if (!((c.bits >> b) & 1)) continue
      let j = c.angle + Math.trunc(0x168 / n) * k
      if (j > 0xb4) j -= 0x168
      if (j < -0xb4) j += 0x168
      const [u, v] = this.t.ringRects[b] ?? [0, 0]
      s.srcRect(u, v, u + 0x40, v + 0x40)
      s.anchor(0x10)
      s.setWorldRot(0, 0, Math.fround((j * 3.141592) / 180))
      s.setRot(0, 0, Math.fround((-j * 3.141592) / 180))
      s.pos(-0x18, 0x50, 0)
      s.setColor(0x80, 0x80, 0x80, j === 0 ? 0x80 : 0x60)
      this.ringHits.push({ k, j, pts: this.drawProjected(s, 0, 0, Math.trunc(Math.abs(j) * 2.5)) })
      k++
    }
    s.setColor(0x80, 0x80, 0x80, 0x80)
  }

  // ---- movement ----

  private posOf(u: MapUnitState): [number, number] {
    return [u.posX, u.posY]
  }

  /**
   * unitStepToward (0x088301F8): up to 4 world units per frame along a straight line, setting the
   * facing (down 0, right 1, left 2, up 3); counts the squares crossed. 1 = still walking, 0 =
   * arrived (the count goes onto the g_mapMoveSteps nibble stack), −1 = not in line.
   */
  private stepToward(u: MapUnitState, tx: number, ty: number): number {
    let dx = 0, dy = 0
    for (let it = 0; ; ) {
      const x = u.posX ?? 0, y = u.posY ?? 0
      if (x === tx && y === ty) {
        this.moveSteps = ((this.moveSteps << 4) | this.stepCount) >>> 0
        this.stepCount = 0
        return 0
      }
      if (x !== tx && y !== ty) return -1
      if (x < tx) dx = 1
      if (tx < x) dx = -1
      if (y < ty) dy = 1
      if (ty < y) dy = -1
      if (dy === 1) u.facing = 0
      if (dx === 1) u.facing = 1
      if (dx === -1) u.facing = 2
      if (dy === -1) u.facing = 3
      if (x !== tx) u.posX = x + dx
      if (y !== ty) u.posY = y + dy
      if (((u.posX ?? 0) & 0x3f) === 0 && ((u.posY ?? 0) & 0x3f) === 0) this.stepCount++
      if (++it > 3) return 1
    }
  }

  /** mapLoadUnitBoardAnim: unit.one id /12 and /13 into the shared walking animation. */
  private loadWalk(u: MapUnitState) {
    const g = this.a.walk?.(u.cardId)
    this.walk = g && (g[0] || g[1]) ? new WalkAnim(g) : null
  }

  /** unitSummonUpdate(unit, −1, −1, 0) as the move code uses it: a card already on the board is placed back at once. */
  private placeBack(u: MapUnitState) {
    u.cellX = u.posX >> 6
    u.cellY = u.posY >> 6
    this.game.placeOnGrid(u)
  }

  // ---- hosts for the flows and the CPU ----

  private flowHost(): FlowHost {
    const nameOf = (id: number) => this.db.raw.cardStrings.get(id)?.name ?? new Uint8Array(0)
    const host = {
      game: this.game,
      pressed: 0,
      name: nameOf,
      abilityName: (id) => this.db.raw.abilityStrings.get(id)?.name ?? new Uint8Array(0),
      abilityDesc: (id) => this.db.raw.abilityStrings.get(id)?.description ?? new Uint8Array(0),
      cardText: (id) => this.db.raw.cardStrings.get(id)?.text ?? new Uint8Array(0),
      str: (addr) => this.cstr(addr),
      msg: (key, x, y, text, glyph, flags) => this.openMessage(key, x, y, text, glyph, flags),
      frame: (key, x, y, w, h, chamfer, style, flags) => this.openFrame(key, x, y, w, h, chamfer, style, flags),
      print: (key, x, y, glyph, text) => {
        const mw = this.win(key)
        if (mw) this.printAt(mw, x, y, glyph, text)
      },
      clearPrints: (key) => {
        const mw = this.win(key)
        if (mw) mw.prints = []
      },
      close: (key) => this.closeWin(key),
      closeAll: () => this.closeAll(),
      isOpen: (key) => !!this.win(key),
      win: (key): WinRef | undefined => this.win(key),
      cursorStep: () => {
        const rest = this.cursorUpdate()
        return rest && (this.cursor.x & 0x3f) === 0 && (this.cursor.y & 0x3f) === 0
      },
      effect: (id) => this.effectStart(id),
      effectBusy: () => this.effectBusy(),
      setCurUnit: (u) => (this.curUnit = u),
      isCpu: (p: number) => (this.players[p]?.controller ?? 0) >= 2,
      playerName: (i) => this.bytesOf(this.playerNames[i] ?? ''),
      handSelect: (p, mode) => this.handUpdate(p, mode),
      openList: (key, x, y, w, h, items, glyph, flags) => this.openList(key, x, y, w, h, items, glyph, flags),
      openMenu: (key, x, y, glyph, text) => this.openMenu(key, x, y, glyph, text),
      listInput: (key) => this.listInput(key),
      listCursor: (key) => this.win(key)?.list?.cursor ?? 0,
      eventStart: (trigger, key, dom) => this.eventStart(trigger, key, dom),
      eventUpdate: () => this.eventUpdate(),
    } satisfies FlowHost
    Object.defineProperty(host, 'pressed', { get: () => this.pressed })
    return host
  }

  private aiHost(): AiHost {
    return {
      game: this.game,
      flows: this.flows,
      handSelect: (p, mode) => this.handUpdate(p, mode),
      stepToward: (u, tx, ty) => this.stepToward(u, tx, ty),
      loadWalk: (u) => this.loadWalk(u),
      setActive: (u) => (this.active = u),
    }
  }

  /** A NUL-terminated string of the executable. */
  private cstr(addr: number): Uint8Array {
    const b = this.db.raw.bytes(addr, 256)
    const e = b.indexOf(0)
    return b.slice(0, e < 0 ? b.length : e)
  }

  private isCpu(p = this.turnPlayer) {
    return (this.players[p]?.controller ?? 0) >= 2
  }

  // ---- game setup ----

  /**
   * State 0 of mapBoardScene for the viewer: both players' decks (the Dominator's deck from the deck
   * table), unitInitFromCard for all 31 slots, shuffled draw order, the opening hand of three
   * (playerDrawCard(p, 5), face up), the Dominators on the stage's start squares; optionally `extra`
   * deck units or bases of each side placed around the start square (viewer sample). `decks` (Play
   * mode) replaces the first deck of each Dominator by the given 30 card ids.
   */
  newGame(dominators: [number, number], extra: number, seed = 0, mode = 1, decks?: [number[] | null, number[] | null]) {
    const g = this.game
    gameRng.reset(seed)
    this.resetScene(mode)
    this.firstTurn = 0
    dominators.forEach((id, p) => {
      const pl = g.players[p]
      const deckDef = this.db.decks.find((d) => d.dominator === id) ?? this.db.decks[p]
      // Play mode passes the DuelPlayer decks (the profile's deck slot, dbGetDeckByDominator for the CPU)
      const given = decks?.[p]
      const cards = (given ?? deckDef?.cards ?? []).filter((c) => this.db.byId.get(c)?.type !== 'chara').slice(0, 30)
      pl.deck = [id, ...cards]
      while (pl.deck.length < 31) pl.deck.push(0)
      pl.deckState = new Uint8Array(31)
      for (let s = 1; s < 31; s++) if (!pl.deck[s]) pl.deckState[s] = 8
      pl.hand = [0, 0, 0, 0, 0, 0]
      pl.cost = pl.soul = 0
      pl.flags = 0
      for (let s = 0; s < 31; s++) g.initUnit(g.units[p][s], p, pl.deck[s], s)
      g.shuffle(pl)
    })
    // playerResetDeck runs for all four DuelPlayers in modes 1/2: players 2 and 3 shuffle too (each
    // shuffle burns 30 + 10001 draws of rand()), which moves the sequence on
    this.sparePlayers = [blankPlayer(2), blankPlayer(3)]
    if (mode !== 0) for (const sp of this.sparePlayers) g.shuffle(sp)
    // the Dominators on their start squares (modes 1/2; versus picks them in states 7–9)
    if (mode !== 0) dominators.forEach((_, p) => {
      const d = g.units[p][0]
      const [x, y] = this.board.starts[p]
      d.posX = x * 64
      d.posY = y * 64
      g.players[p].deckState[0] = 2
      g.placeOnGrid(d)
    })
    // viewer sample: deck units / bases placed breadth-first around the start square
    if (extra > 0 && mode !== 0)
      dominators.forEach((_, p) => {
        const pl = g.players[p]
        const slots: number[] = []
        for (let s = 1; s < 31 && slots.length < extra; s++) {
          const c = this.db.byId.get(pl.deck[s])
          if (c && (c.type === 'unit' || c.type === 'base') && !slots.some((k) => pl.deck[k] === c.id)) slots.push(s)
        }
        const [sx, sy] = this.board.starts[p]
        const queue: [number, number][] = [[sx, sy]]
        const seen = new Set([sy * 40 + sx])
        while (queue.length && slots.length) {
          const [x, y] = queue.shift()!
          if (g.getCell(x, y) === 0) {
            const u = g.units[p][slots.shift()!]
            u.posX = x * 64
            u.posY = y * 64
            u.scalePct = 100
            g.placeOnGrid(u)
          }
          for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
            const nx = x + dx, ny = y + dy
            if (!g.inBoard(nx, ny) || seen.has(ny * 40 + nx) || this.land(nx, ny) < 0) continue
            seen.add(ny * 40 + nx)
            queue.push([nx, ny])
          }
        }
      })
    // the opening hand: three cards, face up (deck state 3)
    for (const pl of g.players) {
      for (let k = 0; k < 3; k++) g.drawOne(pl, 5, 3)
      g.recountDeck(pl)
    }
    g.commitConquest()
    g.countDeployed()
    g.updateMaintenance()
    g.recalcAll()
    g.turnPlayer = 0
    g.round = 0
    this.handPlayer = 0
    this.active = g.units[0][0]
    this.lastPick = [0, 0]
    this.state = STATE.init
    this.result = 0
    if (mode !== 0) {
      this.cursor.x = g.units[0][0].posX
      this.cursor.y = g.units[0][0].posY
    } else {
      // the first square with land ≥ 0, row by row
      let found = false
      for (let y = 0; y < this.height && !found; y++)
        for (let x = 0; x < this.width && !found; x++)
          if (this.land(x, y) >= 0) {
            this.cursor.x = x << 6
            this.cursor.y = y << 6
            found = true
          }
    }
  }

  /** The scene part of state 0 shared by a new and a resumed board: windows, effects, story, result screen, flows and AI. */
  private resetScene(mode: number) {
    const g = this.game
    g.gameMode = mode
    g.resetBoard(this.board.land)
    g.drawFlags = 0
    this.boardActive = true
    this.res.state = 0
    this.res.flags = 0
    this.story = null
    this.infoOpen = false
    this.fx = this.fxPending = null
    this.fxState = 0
    this.seizeState = g.seizeMark
    this.closeAll()
    this.walk = null
    this.previewOn = false
    this.drawnPic = null
    this.handState = 0
    this.flows = new MapFlows(this.flowHost())
    this.ai = new MapAi(this.aiHost())
  }

  /**
   * A board restored from the continue file (saveDeserializeContinue, then mapBoardScene state 0 with
   * g_mapRound ≥ 1: no deck reset, no mapInitGrid, the cursor kept): `fill` writes the saved map state
   * block, MapUnits and DuelPlayers into `game` (and the scalars into this scene); state 1 then goes
   * straight to the free cursor (g_mapDrawFlags 0x1F). The random generators are not in the file:
   * they continue from wherever they are.
   */
  resume(mode: number, fill: (g: MapGame, scene: MapBoardScene) => void) {
    this.resetScene(mode)
    fill(this.game, this)
    const g = this.game
    this.seizeState = g.seizeMark
    this.handPlayer = g.turnPlayer
    this.active = g.units[g.turnPlayer]?.[0] ?? null
    this.lastPick = [0, 0]
    this.result = 0
    this.resultExit = 0
    this.state = STATE.init
  }

  /** Viewer: both players' Costs and Soul. */
  setResources(cost: number, soul: number) {
    for (const p of this.players) {
      p.cost = cost
      p.soul = soul
    }
    this.game.markUsable(this.players[this.turnPlayer], 1)
  }
  /** DuelPlayer.controller (0 pad, ≥ 2 CPU). */
  setController(player: number, c: number) {
    const p = this.players[player]
    if (p) p.controller = c
  }

  /** Viewer: put a card of a side on a square (a free deck slot takes the card; right-click removes). */
  placeCard(cardId: number, player: number, x: number, y: number) {
    const g = this.game
    this.removeAt(x, y)
    const pl = g.players[player]
    if (cardType(cardId) === CT_CHARA) {
      const d = g.units[player][0]
      g.lift(d)
      g.removeBaseAura(d)
      pl.deck[0] = cardId
      g.initUnit(d, player, cardId, 0)
      d.posX = x * 64
      d.posY = y * 64
      d.scalePct = 100
      g.placeOnGrid(d)
      return
    }
    let slot = -1
    for (let s = 1; s < 31; s++) if (pl.deckState[s] === 0 || pl.deckState[s] === 8) {
      slot = s
      break
    }
    if (slot < 0) return
    pl.deck[slot] = cardId
    pl.deckState[slot] = 0
    const u = g.units[player][slot]
    g.initUnit(u, player, cardId, slot)
    u.posX = x * 64
    u.posY = y * 64
    u.scalePct = 100
    g.placeOnGrid(u)
    g.updateMaintenance()
    g.recalcAll()
  }
  removeAt(x: number, y: number) {
    const g = this.game
    const u = g.unitAt(x, y)
    if (!u || u.slot === 0) return
    u.hp = 0
    g.destroy(u, false)
    g.recalcAll()
  }

  // ---- hand (handSelectUpdate 0x08854AF8) ----

  /** handMarkUsableCards for the panel. */
  private markUsable(p: HandPlayer, mode: number) {
    this.game.markUsable(p, mode)
  }

  /**
   * handSelectUpdate(player, mode) (0x08854AF8): 1 on the map, 0x400 discard. The panel slides in
   * from x = −480; a newly drawn card (deck state 1 without 2) first plays the draw animation (states
   * 10–0x32: its unit.one /3 picture slides down with "%s has been drawn", then the card flips in the
   * panel); Left/Right pick, Cross takes a usable card, Triangle card details (200), Square checks the
   * board (1000 / 0x44C), Circle asks "Ending card usage." The CPU branch asks aiChooseHandCard /
   * aiChooseDiscard. Returns 1 (card chosen, +0x9C), −1 (cancelled) or 0.
   */
  private handUpdate(p: HandPlayer, mode: number): number {
    const g = this.game
    const T = this.t.text
    const P = this.pressed
    const cpu = p.controller > 1
    switch (this.handState) {
      case 9999:
        p.visible = 0
        this.handState = 0
        return p.selected < 1 ? -1 : 1
      case 0x233c:
        for (let i = 0; i < 0x28; i++) {
          if (p.panelX < -0x27f) {
            this.handState = 9999
            break
          }
          p.panelX--
        }
        return 0
      case 0x2332:
        if (P & PAD_CROSS) {
          g.onSe(7)
          this.handState = 0x233c
        } else if (P & PAD_CIRCLE) {
          g.onSe(9)
          this.handState = 100
        }
        if (this.handState !== 0x2332) this.closeAll()
        return 0
      case 9000: {
        this.closeAll()
        let v = p.controller !== 0 && p.controller !== 1 ? 1 : 0
        if (p.selected > 0) v = 1
        if (mode === 0x400) v = g.handCount(p) < 6 ? 1 : -1
        else if (mode === 0x200 || mode === 0x10) v = 1
        if (v > 0) this.handState = 0x233c
        else if (v < 0) this.handState = 100
        if (this.handState !== 9000) return 0
        const m = this.openMessage('msg', 320, 224, T.endCard, 0x16, 0xf000)
        this.openMessage('help', 320, m.win.y + m.win.h / 2, T.acceptCancel2, 0x14, 0x7000)
        this.handState = 0x2332
        return 0
      }
      case 0x1004: {
        // discard: the card goes to the discard pile
        const i = p.cursor >> 5
        const s = p.hand[i]
        p.hand[i] = 0
        p.deckState[s] |= 8
        g.compactHand(p)
        this.handState = 9000
        return 0
      }
      case 0xfaa:
        if (P & PAD_CROSS) {
          g.onSe(7)
          this.handState = 0x1004
        } else if (P & PAD_CIRCLE) {
          g.onSe(9)
          this.handState = 100
        }
        if (this.handState !== 0xfaa) this.closeAll()
        return 0
      case 4000: {
        this.closeWin('msg')
        const m = this.openMessage('msg', 320, 224, this.cstr(S.discardOk), 0x16, 0xf000)
        this.closeWin('help')
        this.openMessage('help', m.win.x, m.win.y + m.win.h / 2, T.acceptCancel2, 0x12, 0x7000)
        this.handState = 0xfaa
        return 0
      }
      case 0x76c:
        this.handState = 0x122
        return 0
      case 0x44c: {
        // check board: the free cursor with Circle for the move preview / base range, Square returns
        // mouse (Play mode, ours): a right click is □ here (it leaves); the cursor follows the pointer (mousePick)
        let P = this.pressed
        if (P & PAD_POINTER_RIGHT) P = this.pressed = (P & ~(PAD_CIRCLE | PAD_POINTER_RIGHT)) | PAD_SQUARE
        const rest = this.cursorUpdate()
        if (rest && P & PAD_CIRCLE) {
          this.marks.fill(0)
          this.preview.fill(0)
          if (!this.previewOn) {
            const u = this.unitAt(this.cursor.x >> 6, this.cursor.y >> 6)
            if (u) {
              if (cardType(u.cardId) === CT_BASE) g.markAttackRange(u, 0)
              else g.startFlood(u, u.effMove + 1)
              this.previewOn = true
            }
          } else this.previewOn = false
        }
        if (P & PAD_SQUARE) {
          this.marks.fill(0)
          this.preview.fill(0)
          this.previewOn = false
          this.closeWin('msg')
          this.closeWin('help')
          this.handState = 0x76c
        }
        return 0
      }
      case 1000:
        if (p.panelY > 399) {
          this.closeWin('msg')
          const m = this.openMessage('msg', 8, 8, this.bytesOf('Checking board. '), 0x16, 0x3000)
          this.closeWin('help')
          this.openMessage('help', 8, m.win.h + 8, this.cstr(S.returnB2), 0x12, 0x3000)
          this.handState = 0x44c
          return 0
        }
        for (let i = 0; i < 0x10 && p.panelY < 400; i++) p.panelY++
        return 0
      case 0x122:
        for (let i = 0; i < 0x28; i++) {
          if (p.panelY < 0x141) {
            this.handState = 100
            break
          }
          p.panelY--
        }
        return 0
      case 200: {
        // cardInfoUpdate(card, 2): L / R step through the hand; Circle closes (→ 0x122)
        for (let i = 0; i < 0x10 && p.panelY < 400; i++) p.panelY++
        const slot = p.hand[p.cursor >> 5]
        const k = this.cardInfoUpdate(p.deck[slot] ?? 0, 2)
        this.infoUnit = g.units[p.index][slot] ?? null
        if (k === -1) {
          this.handState = 0x122
          return 0
        }
        if (k === 0) return 2
        if (p.hand[1] !== 0) {
          if (P & PAD_R) {
            for (let n = 0; n < 7; n++) {
              p.cursor += 0x20
              if (p.cursor > 0xa0) p.cursor = 0
              if (p.hand[p.cursor >> 5] > 0) break
            }
            if (!(p.hand[p.cursor >> 5] > 0)) p.cursor = 0
            g.onSe(5)
          } else if (P & PAD_L) {
            for (let n = 0; n < 7; n++) {
              p.cursor -= 0x20
              if (p.cursor < 0) p.cursor = 0xa0
              if (p.hand[p.cursor >> 5] > 0) break
            }
            g.onSe(5)
          }
        }
        return 2
      }
      case 3000: {
        // "Check target" (counter modes): the card the turn player is using
        if (p.panelY < 400) {
          for (let i = 0; i < 0x10 && p.panelY < 400; i++) p.panelY++
          return 0
        }
        const q = this.players[(p.index + 1) & 1]
        const slot = q.hand[q.cursor >> 5] ?? 0
        const id = q.deck[slot] ?? 0
        if (!id) {
          this.handState = 100
          return 0
        }
        this.closeAll()
        const c = this.db.byId.get(id)
        const ty = Math.trunc(id / 1000)
        const text = ty === 3 || ty === 2 ? (this.db.raw.cardStrings.get(id)?.text ?? new Uint8Array(0)) : sprintf(this.cstr(S.checkTargetStats), g.units[q.index][slot].baseAp, g.units[q.index][slot].hp, c?.move ?? 0)
        const info = this.openMessage('info', 0, 0, text, 0x12, 0x3000)
        info.win.y = p.panelY - 8 - info.win.h
        const top = this.openMessage('top', 0, 0, this.db.raw.cardStrings.get(id)?.name ?? new Uint8Array(0), 0x14, 0x3000)
        top.win.y = info.win.y - top.win.h
        this.openMessage('help', 0, 8, this.cstr(S.returnB2), 0x12, 0x3000)
        this.handState = 0xc1c
        return 0
      }
      case 0xc1c:
        if (P & (PAD_SQUARE | PAD_CROSS | PAD_CIRCLE)) {
          this.closeAll()
          g.onSe(9)
          this.handState = 0x122
        }
        return 0
      case 0x78:
        this.handState = 9000
        return 0
      case 0x6e:
        p.selected = p.hand[p.cursor >> 5]
        this.handState = mode === 0x400 ? 4000 : 0x78
        return 0
      case 0x5a:
        this.handState = 100
        return 0
      case 0x50:
        for (let i = 0; i < 0x28; i++) {
          if (p.panelY < 0x141) {
            if (p.panelX > 0xf) {
              this.handState = 100
              return 0
            }
            p.panelX++
          } else p.panelY--
        }
        return 0
      case 0x32:
        if (!this.fadeClose('msg', 8)) this.handState = 1
        return 0
      case 0x16:
        this.fadeClose('msg', 8)
        for (let i = 0; i < 0x10 && this.drawnY < 0x1e0; i++) this.drawnY++
        if (this.drawnY < 0x1e0 || p.visible !== 1) return 0
        this.drawnPic = null
        this.handState = 0x32
        return 0
      case 0x15:
        if (this.isCpu() || P & (PAD_CROSS | PAD_CIRCLE | PAD_POINTER)) {
          this.handState = 0x16
          p.visible = 0x30
        }
        return 0
      case 0x14: {
        for (let i = 0; i < 0x10 && this.drawnY <= 7; i++) this.drawnY++
        if (p.panelX > 0xf && p.panelY < 0x141) {
          if (this.drawnY >= 8) this.handState = 0x15
          return 0
        }
        for (let i = 0; i < 0x28; i++) {
          if (p.panelY < 0x141) {
            if (p.panelX > 0xf) return 0
            p.panelX++
          } else p.panelY--
        }
        return 0
      }
      case 10: {
        const i = p.hand.findIndex((d) => d > 0 && p.deckState[d] & 1 && !(p.deckState[d] & 2))
        const cid = i >= 0 ? p.deck[p.hand[i]] : 0
        g.onSe(3)
        this.openMessage('msg', 320, 224, sprintf(this.cstr(S.handDrawn), this.db.raw.cardStrings.get(cid)?.name ?? new Uint8Array(0)), 0x16, 0xf000)
        p.visible = 1
        g.compactHand(p)
        this.handState = 0x14
        return 0
      }
      case 0:
        p.cursor = 0
        p.usable = [0, 0, 0, 0, 0, 0]
        p.panelX = -0x1e0
        p.panelY = 0x140
        this.markUsable(p, mode)
        if (mode !== 0x400) {
          p.visible = 0
          this.handState = 1
        } else {
          p.visible = 1
          this.handState = 0x50
        }
        return 0
      case 1: {
        const i = p.hand.findIndex((d) => d > 0 && p.deckState[d] & 1 && !(p.deckState[d] & 2))
        if (i >= 0) {
          const cid = p.deck[p.hand[i]]
          this.drawnPic = new Spr(this.a.drawPicture?.(cid) ?? null)
          this.drawnY = -150
          this.flipAngle = 0
          this.handState = 10
          return 0
        }
        p.visible = 1
        this.handState = 0x50
        return 0
      }
      case 100:
        break
      default:
        return 0
    }
    // state 100: select
    let count = 0, usable = 0
    for (let i = 0; i < 6; i++)
      if (p.hand[i] > 0) {
        count++
        if (p.usable[i] === 1) usable++
      }
    if (!cpu) {
      if (!this.win('tc')) {
        const text = usable < 1 ? this.bytesOf(TXT.noCards) : mode === 0x400 ? this.cstr(S.discard) : mode === 0x200 ? this.bytesOf('Please select the card to swap. ') : this.bytesOf(TXT.selectCard)
        this.openMessage('tc', 0, 8, text, 0x16, 0x3000)
      }
      const tc = this.win('tc')!
      let help = this.win('help')
      if (!help) {
        help = this.openFrame('help', 0, 0, 180, 0, 8, 10, 0x1000)
        help.win.x = tc.win.x
        help.win.y = tc.win.y + tc.win.h
      }
      help.prints = []
      const slot = p.cursor >> 5
      let n = 0
      if (p.usable[slot & 7] === 1) {
        this.printAt(help, 0, 0, 0x12, T.handAccept)
        n = 1
      }
      if (p.usable[slot & 7] !== 0) this.printAt(help, 0, n++ * 0x13, 0x12, T.handDetails)
      if (mode === 0x40 || mode === 0x20) this.printAt(help, 0, n++ * 0x13, 0x12, this.cstr(S.checkTarget))
      else this.printAt(help, 0, n++ * 0x13, 0x12, T.handBoard)
      if (mode === 0x200) this.printAt(help, 0, n++ * 0x13, 0x12, this.cstr(S.returnB3b))
      else if (mode !== 0x400) this.printAt(help, 0, n++ * 0x13, 0x12, T.handEnd)
      help.win.h = n * 19 + 30
    }
    const slot = p.cursor >> 5
    if (p.hand[slot] === 0) {
      this.closeWin('top')
      p.selected = 0
    } else {
      let top = this.win('top')
      if (!top) top = this.openFrame('top', 0, 0, 0, 41, 8, 7, 0)
      top.prints = []
      const name = this.db.raw.cardStrings.get(p.deck[p.hand[slot]])?.name ?? new Uint8Array(0)
      this.printAt(top, 0, 0, 0x14, name)
      top.win.y = p.panelY - 8 - top.win.h
      top.win.w = (name.length >> 1) * 21 + 20
      p.selected = 0
    }
    if (cpu) {
      if (mode & 0x20 || mode & 0x40) {
        // the CPU answers with the first usable counter card
        const i = p.usable.findIndex((u) => u === 1)
        if (i < 0) {
          this.handState = 9000
          g.onSe(9)
          return 0
        }
        p.cursor = i << 5
        this.handState = 0x6e
        g.onSe(7)
        return 0
      }
      if (mode & 0x400) {
        const k = this.ai.chooseDiscard(p)
        if (k === 0) return 0
        p.cursor = (k - 1) * 0x20
        this.closeAll()
        g.onSe(7)
        this.handState = 0x1004
        return 0
      }
      const k = this.ai.chooseHandCard(p)
      if (k < 0) {
        this.handState = 9000
        g.onSe(9)
      }
      if (k > 0) {
        this.handState = 0x6e
        g.onSe(7)
      }
      if (this.handState !== 100) this.closeWin('tc')
      return 0
    }
    // mouse (ours): the pointer over a card in the panel moves the cursor to it; a click on it works as ✕
    // (cards at panelX + 0x54·i, from panelY + 0x10 to the bottom of the screen, 0x50 wide)
    const mp = this.pointer
    const click = (P & PAD_POINTER) !== 0
    if (!cpu && mp.y >= p.panelY + 0x10 && mp.x >= p.panelX && (mp.moved || click)) {
      const i = Math.floor((mp.x - p.panelX) / 0x54)
      if (i >= 0 && i < 6 && mp.x - p.panelX - i * 0x54 < 0x50 && p.hand[i] > 0) {
        if (i !== p.cursor >> 5) {
          p.cursor = i << 5
          g.onSe(1)
          if (!click) return 0
        }
        if (click) this.pressed |= PAD_CROSS
      }
    }
    const P2 = this.pressed
    let dir = 0
    if (P2 & PAD_RIGHT) dir = 1
    else if (P2 & PAD_LEFT) dir = -1
    if (count >= 2 && dir) {
      for (let guard = 0; guard < 8; guard++) {
        p.cursor += dir * 0x20
        if (p.cursor >> 5 >= 6) p.cursor = 0
        if (p.cursor < 0) p.cursor = 0xa0
        if (p.hand[p.cursor >> 5] > 0) break
      }
      g.onSe(1)
      return 0
    }
    const u = p.usable[(p.cursor >> 5) & 7]
    if (P2 & PAD_CROSS) {
      if (u === 1) {
        g.onSe(7)
        this.handState = 0x6e
      } else g.onSe(10)
    } else if (P & PAD_TRIANGLE) {
      if (u === 0) g.onSe(10)
      else {
        g.onSe(8)
        this.handState = 200
      }
    } else if (P & PAD_SQUARE) {
      g.onSe(8)
      this.handState = mode === 0x40 || mode === 0x20 ? 3000 : 1000
    } else if (P & PAD_CIRCLE) {
      if (mode === 0x400) g.onSe(10)
      else {
        g.onSe(9)
        this.handState = 9000
      }
    }
    if (this.handState !== 100) this.closeAll()
    return 0
  }

  /**
   * handPanelDraw (0x08856A74): Prim2D 640×140 at (x − 16, y − 8) in the player's colour (alpha 0x60),
   * the four label pieces of etc.one 110/2 at scale 1.3333, cost / soul / maintenance of the card
   * under the cursor (red when it cannot be used), cards left in the deck and "30", then six card
   * pictures 0x54 apart (the selected one 8 px higher) and the pointer hand on the selected card.
   */
  private drawHandPanel(p: HandPlayer) {
    if (!p.visible) return
    const pic = this.drawnPic
    if (pic?.img) {
      // Sprite_08A42C98 (the drawn card's unit.one /3 picture) at (160, y), before the panel
      pic.cam = CAM_2D
      pic.setScale(1, 1)
      pic.setRot(0, 0, 0)
      pic.setColor(0x80, 0x80, 0x80, 0x80)
      this.draw(pic, 0xa0, this.drawnY)
    }
    const X = p.panelX, Y = p.panelY
    const team: [number, number, number, number] = p.index === 0 ? [0x10, 0x10, 0x40, 0x60] : [0x40, 0x10, 0x10, 0x60]
    this.prim(X - 0x10, Y - 8, 0x280, 0x8c, [team, team, team, team])
    let sel = -1, cost = 0, soul = 0, maint = 0
    let red = false
    if (p.cursor >= 0) {
      const slot = p.cursor >> 5
      const di = p.hand[slot] ?? 0
      sel = di < 1 ? -1 : slot
      const st = p.deckState[di]
      if (st & 1 && !(st & 2)) sel = -1
      const card = this.db.byId.get(p.deck[di])
      cost = card?.cost ?? 0
      soul = card?.soul ?? 0
      maint = card?.maintenance ?? 0
      if (p.usable[slot & 7] !== 1) red = true
    }
    const L = this.sprLabels
    if (L.img) {
      L.cam = CAM_2D
      L.setScale(1.3333, 1.3333)
      const y = Y - 6
      L.srcRect(0, 0, 0x62, 0x15)
      this.draw(L, X, y)
      L.srcRect(0, 0x15, 0x62, 0x2a)
      this.draw(L, X + 0x92, y)
      L.srcRect(0, 0x2a, 0x78, 0x3f)
      this.draw(L, X + 0x123, y)
      L.srcRect(0, 0x3f, 0x76, 0xa0)
      this.draw(L, X + 0x1cb, y)
    }
    const col: [number, number, number, number] = red ? [0x80, 0x10, 0x10, 0x80] : [0x80, 0x80, 0x80, 0x80]
    const number = (v: number, x0: number, x100: number) => {
      let x = x0
      if (Math.trunc(v / 100) > 0) {
        x = x100
        this.digitBound(Math.trunc(v / 100), x, Y - 4, 0, col)
      }
      const t = Math.trunc((v % 100) / 10)
      if (t > 0) {
        x += 0x12
        this.digitBound(t, x, Y - 4, 0, col)
      }
      this.digitBound((v % 100) % 10, x + 0x12, Y - 4, 0, col)
    }
    if (sel >= 0) {
      number(cost, X + 0x2f, X + 0x41)
      number(soul, X + 0xc1, X + 0xd3)
      number(maint, X + 0x170, X + 0x182)
    }
    let left = 0
    for (let i = 0; i < 31; i++) if (p.deckState[i] === 0) left++
    const grey: [number, number, number, number] = [0x80, 0x80, 0x80, 0x80]
    let xd = X + 0x1fb
    if (left > 9) {
      xd = X + 0x213
      this.digitBound(Math.trunc(left / 10), xd, Y + 0x18, 1, grey)
    }
    this.digitBound(left % 10, xd + 0x18, Y + 0x18, 1, grey)
    this.digitBound(3, X + 0x230, Y + 0x4e, 1, grey)
    this.digitBound(0, X + 0x248, Y + 0x4e, 1, grey)
    let x = X
    let flipSlot = 0
    for (let i = 0; i < 6; i++) {
      const di = p.hand[i]
      let id = 0
      let y = Y + 0x18
      if (di > 0) {
        id = p.deck[di]
        if (sel === i) y = Y + 0x10
      }
      const ds = di > 0 ? (p.deckState[di] ?? 0) : (p.deckState[0] ?? 0)
      if (!(ds & 2) && ds & 1) {
        // a card being revealed: the back turns to 90°, then the face from 270° to 360° (3° per frame)
        if (this.flipAngle < 0x5a) this.cardPicRotated(0, x, y, this.flipAngle)
        else this.cardPicRotated(id, x, y, this.flipAngle + 0xb4)
        id = 0
        flipSlot = i
      } else {
        const u = p.usable[i]
        if (u === 2) this.cardPic(id, x, y, true)
        else if (u === 1) this.cardPic(id, x, y, false)
        else if (u === 0) this.cardPic(0, x, y, true)
      }
      if (i === sel && id > 0) this.pointerHand(x + 0x20, y)
      x += 0x54
    }
    if (p.visible & 0x20) {
      for (let k = 0; k < 3; k++) {
        if (++this.flipAngle > 0xb4) {
          this.flipAngle = 0
          p.deckState[p.hand[flipSlot]] |= 2
          p.visible = 1
          return
        }
      }
    }
  }

  /** uiDrawDigitBound (0x08839508) after uiNumFontBegin(1, 1): etc.one 2/1, style 0 (18×24) or 1 (24×32). */
  private digitBound(d: number, x: number, y: number, style: number, col: [number, number, number, number]) {
    if (d < 0 || d > 12) return
    const [u0, v0, w, h] = this.t.digitBound[style > 1 ? 0 : style]
    const s = this.sprNum
    if (!s.img) return
    s.cam = CAM_2D
    s.setScale(1, 1)
    s.setRot(0, 0, 0)
    const u = u0 + d * w
    s.srcRect(u, v0, u + w, v0 + h)
    s.setColor(col[0], col[1], col[2], col[3])
    this.draw(s, x, y)
  }

  /** cardPicDrawScaled / cardPicDrawDimmed (scale 80 / width, colour 0x40 when dimmed), top-left at (x, y); id 0 = card back. */
  private cardPic(id: number, x: number, y: number, dim: boolean) {
    const key = id >= 1000 && id < 2000 ? 0 : id
    let s = this.cardPics.get(key)
    if (!s) {
      s = new Spr(this.a.cardPic?.(key) ?? null)
      if (!s.img && key) s = new Spr(this.a.cardPic?.(0) ?? null)
      this.cardPics.set(key, s)
    }
    if (!s.img) return
    s.cam = CAM_2D
    s.anchor(9)
    s.resetOffset()
    const w = s.w === 0x30 ? 0x28 : s.w
    const k = Math.fround(80 / w)
    s.setScale(k, k)
    s.setRot(0, 0, 0)
    if (dim) s.setColor(0x40, 0x40, 0x40, 0x80)
    else s.setColor(0x80, 0x80, 0x80, 0x80)
    this.draw(s, x, y)
    s.setScale(1, 1)
  }

  /**
   * cardPicDrawRotated(id, x, y, 0, 0, angle, 0, 1): the card picture turned about its vertical centre
   * line by `angle` degrees (Y rotation through the 2D camera, so it narrows to cos(angle)).
   */
  private cardPicRotated(id: number, x: number, y: number, angle: number) {
    const key = id >= 1000 && id < 2000 ? 0 : id
    let s = this.cardPics.get(key)
    if (!s) {
      s = new Spr(this.a.cardPic?.(key) ?? null)
      if (!s.img && key) s = new Spr(this.a.cardPic?.(0) ?? null)
      this.cardPics.set(key, s)
    }
    if (!s.img) return
    const w = s.w === 0x30 ? 0x28 : s.w
    const k = Math.fround(80 / w)
    s.cam = CAM_2D
    s.anchor(0x10)
    s.resetOffset()
    s.setScale(k, k)
    s.setRot(0, (angle * 3.1415927) / 180, 0)
    s.setColor(0x80, 0x80, 0x80, 0x80)
    this.draw(s, x + Math.trunc((s.w * k) / 2), y + Math.trunc((s.h * k) / 2))
    s.setRot(0, 0, 0)
    s.setScale(1, 1)
  }

  /** uiDrawPointerHand(x, y, 0, 0, 0, 135°, 2D): etc.one 2/2, frame uiAnimCounter(2), centre anchor. */
  private pointerHand(x: number, y: number) {
    const s = this.sprPointer
    if (!s.img) return
    const f = this.c2 >> 2
    const u = this.t.handFrames.u[f] ?? 0, v = this.t.handFrames.v[f] ?? 0
    s.cam = CAM_2D
    s.srcRect(u, v, u + 0x30, v + 0x20)
    s.anchor(0x10)
    s.setRot(0, 0, (0x87 * 3.1415927) / 180)
    this.draw(s, x, y)
  }

  // ---- state machine ----

  /** Viewer: open the turn player's hand (state 0x10, as after the turn start). */
  openHand() {
    this.closeAll()
    this.handState = 0
    this.state = this.isCpu() ? STATE.cpu : STATE.hand
  }

  /** Viewer: start the turn of the current turn player (state 10: the "%s' s turn" banner). */
  startTurn() {
    this.closeAll()
    this.state = STATE.banner
  }

  /** The view reports the duel's outcome (the HP of both combatants); the board goes on at 0x8A2. */
  battleResult(attackerHp: number, targetHp: number) {
    const a = this.duelAttacker, t = this.duelTarget
    if (a) a.hp = Math.max(0, attackerHp)
    if (t) t.hp = Math.max(0, targetHp)
    this.battleRequest = null
    this.state = STATE.battleAfter
  }

  /** The unitRecalcStats inputs of a combatant for the duel scene (so its AP / DF match the board). */
  duelContext(u: Unit): UnitContext {
    const g = this.game
    const x = u.posX >> 6, y = u.posY >> 6
    const l = this.land(x, y)
    let sa = 0, sd = 0
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const w = this.cellWord(x + dx, y + dy)
      const v = w ? g.unitOfWord(w) : null
      if (!v || MapGame.teamOf(w) !== u.team + 1) continue
      if (g.countAbility(v, A.supportAttack)) sa++
      if (g.cardAbility(v, A.supportDefense)) sd++
    }
    return {
      hp: u.hp,
      land: u.attribute > 0 && l === u.attribute,
      attachments: u.attachments.filter((a) => a !== 0),
      bases: {
        watchtower: g.countBaseAuras(x, y, ~(1 << u.team) & 0xf, 3001),
        shrine: g.countBaseAuras(x, y, 0xf, 3003),
        statue: g.countBaseAuras(x, y, 1 << u.team, 3008),
        fortress: g.countBaseAuras(x, y, 1 << u.team, 3010),
      },
      supportAttack: sa,
      supportDefense: sd,
      copies: g.allUnits().filter((v) => v.cardId === u.cardId).length,
      breath: ((this.players[u.team]?.flags ?? 0) & 0x40) !== 0,
      boost: (u.status & 1) !== 0,
    }
  }

  /** The command-ring bits for the unit or square under the cursor (mapBoardScene state 0x14). */
  private unitMenuBits(u: MapUnitState): number {
    const f = u.actFlags
    if (f & 8) return 0
    let bits = 8
    let moveOk: number
    if (!(this.actionFlags & 1)) {
      if (!(f & 1)) {
        bits = 9
        moveOk = 1
      } else moveOk = 0
    } else moveOk = bits & 1
    if (!moveOk) bits |= 0x100
    if (!(f & 4)) bits |= 0x80
    if (!(f & 2)) bits |= 0x40
    return bits
  }

  /** The part of mapBoardScene's state machine the viewer runs (one call per frame, before the camera). */
  private update() {
    const g = this.game
    const P = this.pressed
    const cx = this.cursor.x, cy = this.cursor.y
    const whole = (cx & 0x3f) === 0 && (cy & 0x3f) === 0
    const u = this.active
    const tp = this.turnPlayer
    const pl = this.players[tp]
    switch (this.state) {
      case STATE.free: {
        this.zoomIn = false
        if (this.isCpu()) {
          this.state = STATE.cpu
          return
        }
        const rest = this.cursorUpdate()
        if (!rest || !whole) return
        const w = this.cellWord(cx >> 6, cy >> 6)
        const cell = this.unitAt(cx >> 6, cy >> 6)
        if (P & PAD_CROSS) {
          this.marks.fill(0)
          this.preview.fill(0)
          if (this.previewOn && tp + 1 !== MapGame.teamOf(w)) {
            this.previewOn = false
            g.onSe(9)
            return
          }
          this.actionFlags = 0
          this.segCount = 0
          this.returnState = 0
          let bits = 0
          if ((w & 0xffff) === 0) {
            bits = 0x3e
            g.onSe(7)
            this.state = STATE.menu
          } else if (cardType(w & 0xffff) === CT_BASE && cell) {
            g.markAttackRange(cell, 0)
            this.previewOn = true
            g.onSe(9)
            return
          } else if (cell && MapGame.teamOf(w) === tp + 1 && (w & 0xffff) < 2000) {
            this.active = cell
            bits = this.unitMenuBits(cell)
            if (bits) {
              g.onSe(7)
              this.state = STATE.menu
            } else if (this.previewOn) g.onSe(9)
          }
          if (bits & ~2) this.cmdOpen(bits & ~2)
          this.previewOn = false
        } else if (P & PAD_CIRCLE) {
          this.marks.fill(0)
          this.preview.fill(0)
          if (!this.previewOn) {
            if (cell && cardType(cell.cardId) === CT_BASE) {
              g.markAttackRange(cell, 0)
              this.previewOn = true
            } else if (cell) {
              this.active = cell
              g.startFlood(cell, cell.effMove + 1)
              this.previewOn = true
            }
            g.onSe(9)
          } else {
            this.previewOn = false
            g.onSe(9)
          }
        } else if (P & PAD_START) {
          this.marks.fill(0)
          this.preview.fill(0)
          this.previewOn = false
          this.command = 4
          this.returnState = STATE.free
          this.state = STATE.actionEnd
          g.onSe(7)
        }
        return
      }
      case STATE.menu: {
        if (this.cellWord(cx >> 6, cy >> 6) > 0) this.zoomIn = true
        this.command = 0
        this.ringOn = true
        const r = this.cmdUpdate()
        if (r === 0) return
        if (r === -1) {
          g.onSe(9)
          if (!(this.actionFlags & 1)) {
            this.zoomIn = false
            this.state = STATE.free
          } else if (u) {
            g.undoSeize(this.segCount)
            g.lift(u)
            u.state = 2
            if (this.segCount > 0) {
              this.segCount--
              const e = this.path[this.segCount]
              u.posX = (e >> 8) << 6
              u.posY = (e & 0xff) << 6
            }
            this.actionFlags ^= 1
            this.command = 1
            this.state = STATE.undo
          }
        } else {
          g.onSe(7)
          this.command = r
          this.state = STATE.dispatch
        }
        this.ringOn = this.state === STATE.menu
        return
      }
      case STATE.undo:
        this.movePoints += this.moveSteps & 0xf
        this.moveSteps >>>= 4
        this.state = STATE.dispatch
        return
      case STATE.dispatch: {
        this.returnState = this.command
        const c = this.command
        if (c === 4 || c === 0x100) this.state = STATE.actionEnd
        else if (c === 8) this.state = STATE.help
        else if (c === 0x20) this.state = STATE.tempSave
        else if (c === 0x10) this.state = STATE.toTitle
        else if (c === 0x40 && u) {
          this.flows.abilitySetCurrent(u)
          this.state = STATE.skill
        } else if (c === 2) this.state = STATE.hand
        else if (c === 0x80 && u) {
          g.markAttackRange(u, 0)
          this.state = STATE.attack
        } else if (c === 1 && u) {
          if (this.segCount === 0) {
            g.lift(u)
            this.movePoints = u.effMove & 0xff
            if (g.countBaseAuras(u.posX >> 6, u.posY >> 6, 0xf, 3004) && !g.countAbility(u, A.annulBase)) this.movePoints = 1
            g.startFlood(u, this.movePoints + 1)
          }
          if (u.state !== 2) this.loadWalk(u)
          g.markMoveLines(u, this.movePoints, tp)
          this.state = STATE.moveTarget
        } else this.state = STATE.free
        return
      }
      case STATE.moveTarget: {
        if (!u) return
        u.state = 2
        this.previewOn = true
        if (!this.win('tc')) this.openMessage('tc', 8, 8, this.bytesOf(TXT.moveTarget), 0x16, 0x3000)
        const rest = this.cursorUpdate()
        if (!rest || !whole) return
        const w = this.cellWord(cx >> 6, cy >> 6)
        const [px, py] = this.posOf(u)
        if (P & PAD_CROSS) {
          if (cx === px && cy === py) this.state = STATE.moveDone
          else if (this.segCount < 10) {
            if (w !== 0) {
              g.onSe(10)
              return
            }
            if ((this.marks[(cy >> 6) * 40 + (cx >> 6)] & 0xf0) !== 0x10) return
            g.clearMoveLines()
            this.path[this.segCount++] = (px >> 6) * 0x100 + (py >> 6)
            this.state = STATE.walk
          } else this.state = STATE.moveDone
          this.closeWin('tc')
        } else if (P & PAD_CIRCLE) {
          if (this.segCount < 1) {
            this.placeBack(u)
            g.clearMoveLines()
            this.previewOn = false
            this.walk = null
            this.closeWin('tc')
            this.command = 0
            this.state = STATE.free
          } else {
            g.undoSeize(this.segCount)
            this.segCount--
            const e = this.path[this.segCount]
            u.posX = (e >> 8) << 6
            u.posY = (e & 0xff) << 6
            this.state = STATE.undo
          }
        }
        return
      }
      case STATE.walk: {
        if (!u) return
        this.previewOn = true
        const r = this.stepToward(u, cx, cy)
        g.seizeCell(u, tp, this.segCount)
        if (r === 1) return
        if (r === 0) {
          this.movePoints -= this.moveSteps & 0xf
          // entering a Labyrinth Marsh square spends the remaining points
          if (g.countBaseAuras(u.posX >> 6, u.posY >> 6, 0xf, 3004) && !g.countAbility(u, A.annulBase)) this.movePoints = 0
          this.state = this.movePoints <= 0 || this.segCount >= 10 ? STATE.moveDone : STATE.dispatch
        } else this.state = STATE.dispatch
        return
      }
      case STATE.moveDone: {
        if (!u) return
        u.state = 3
        g.clearMoveLines()
        this.previewOn = false
        this.actionFlags |= 1
        this.state = STATE.menu
        let bits = u.actFlags & 4 ? 0x108 : 0x188
        if (!(u.actFlags & 2)) bits |= 0x40
        this.cmdOpen(bits)
        this.command = 0
        return
      }
      case STATE.attack: {
        // "Please specify the target to attack.": an enemy on a 0x20 mark
        if (!this.win('tc')) this.openMessage('tc', 8, 8, this.bytesOf('Please specify the target to attack. '), 0x16, 0x3000)
        const rest = this.cursorUpdate()
        if (!rest || !whole || !u) return
        const w = g.getCell(cx >> 6, cy >> 6)
        if (P & PAD_CROSS) {
          this.duelAttacker = u
          if (u.posX === cx && u.posY === cy) {
            g.onSe(10)
            return
          }
          if (w < 1 || (this.marks[(cy >> 6) * 40 + (cx >> 6)] & 0xf0) !== 0x20) return
          if (MapGame.teamOf(w) === u.team + 1) {
            g.onSe(10)
            return
          }
          this.duelTarget = g.unitOfWord(w)
          g.onSe(7)
          this.closeWin('tc')
          const m = this.openMessage('tc', 8, 8, this.bytesOf('Commencing attack. '), 0x16, 0x3000)
          this.openMessage('help', 8, m.win.h + 8, this.t.text.acceptCancel, 0x14, 0x3000)
          this.state = STATE.attackConfirm
        } else if (P & PAD_CIRCLE) {
          this.cursor.x = u.posX
          this.cursor.y = u.posY
          this.marks.fill(0)
          this.closeWin('tc')
          g.onSe(9)
          this.state = STATE.menu
          this.ringOn = true
        }
        return
      }
      case STATE.attackConfirm:
        if (P & PAD_CROSS) {
          g.onSe(7)
          this.state = STATE.battleStart
        } else if (P & PAD_CIRCLE) {
          this.closeWin('tc')
          g.onSe(9)
          this.state = STATE.attack
        }
        if (this.state !== STATE.attackConfirm) this.closeWin('help')
        return
      case STATE.battleStart: {
        // 0x834: range marks off, g_mapActionFlags |= 4, the unit back on the grid, then mapBattlePrepUpdate
        this.marks.fill(0)
        this.actionFlags |= 4
        if (this.isCpu()) {
          this.duelAttacker = this.ai.cur
          this.duelTarget = this.ai.attackTarget
        }
        const att = this.duelAttacker
        if (att && att.state > 0 && (att.posX & 0x3f) === 0) this.placeBack(att)
        this.walk = null
        this.closeAll()
        this.state = STATE.battlePrep
        return
      }
      case STATE.battlePrep: {
        const a = this.duelAttacker, t = this.duelTarget
        if (!a || !t) {
          this.state = STATE.actionEnd
          return
        }
        const r = this.flows.battlePrep(a, t)
        if (r < 0) this.state = STATE.battleSkip
        else if (r > 0) {
          this.battleRequest = { attacker: a, target: t }
          this.state = STATE.duel
        }
        return
      }
      case STATE.duel:
        // the view runs the duel scene and calls battleResult
        if (!this.battleRequest) this.state = STATE.battleAfter
        return
      case STATE.battleAfter: {
        const a = this.duelAttacker, t = this.duelTarget
        if (!a || !t || this.flows.battleAfter(a, t)) this.state = STATE.battleSkip
        return
      }
      case STATE.battleSkip:
        this.state = STATE.deaths
        return
      case STATE.deaths:
        if (this.flows.deaths(1)) this.state = STATE.actionEnd
        return
      case STATE.skill: {
        const r = this.flows.ability()
        if (r === -1) {
          if (u) {
            this.cursor.x = u.posX
            this.cursor.y = u.posY
          }
          this.state = STATE.menu
          this.cmdOpen(this.cmd.bits)
        } else if (r === 0x834) {
          // Boost: abilityBoost set g_duelAttackerUnit / g_duelTargetUnit
          this.duelAttacker = this.flows.abUser
          this.duelTarget = this.flows.abTarget
          this.state = STATE.battleStart
        } else if (r === 1) {
          this.actionFlags |= 2
          this.state = STATE.deaths
        }
        return
      }
      case STATE.toTitle: {
        const m = this.openMessage('msg', 320, 224, this.cstr(S.toTitle), 0x16, 0xf000)
        const hl = this.openMessage('help', 320, 224, sj('＠ｂ０Yes ＠ｂ３No '), 0x14, 0x7000)
        hl.win.y = m.win.y + m.win.h / 2
        this.state = STATE.toTitleConfirm
        return
      }
      case STATE.toTitleConfirm:
        if (P & PAD_CROSS) {
          // back to the title screen (scene 0x32): the board ends (state 12000)
          g.onSe(7)
          this.closeAll()
          this.boardActive = false
          this.result = -1
          this.state = STATE.exit
        } else if (P & PAD_CIRCLE) {
          g.onSe(9)
          this.closeAll()
          this.state = STATE.menu
          this.cmdOpen(this.cmd.bits)
        }
        return
      case STATE.help: {
        // rulesHelpScene (0x0884CC90, the "How to play" viewer, docs/formats/extras.md) runs inside the
        // board; when it returns 1: g_mapDrawFlags 0x1F, back to the ring (0x1E).
        const h = (this.rulesHelp ??= new RulesHelpScene(readExtrasTables(this.db), this.t.win, (id) => g.onSe(id)))
        const hp = P | h.pointer(this.pointer.x, this.pointer.y, this.pointer.moved, (P & PAD_POINTER) !== 0)
        h.step({ pressed: hp, repeat: hp, held: this.pad | hp })
        if (h.exited) {
          this.rulesHelp = null
          this.closeAll()
          this.state = STATE.menu
          this.cmdOpen(this.cmd.bits)
        }
        return
      }
      case STATE.tempSave:
        if (this.tempSave) {
          // saveDataScene(SAVEOP_SAVE_CONTINUE): cancel → 0x1E; done → g_mapBoardActive 0, g_mapExitScene 0, exit
          const r = this.tempSave()
          if (r === 2) {
            this.state = STATE.menu
            this.cmdOpen(this.cmd.bits)
          } else if (r === 1) {
            this.boardActive = false
            this.result = -1
            this.resultExit = 0
            this.state = STATE.exit
          }
          return
        }
        // viewer: the PSP save dialog is not run; a note, then back to the ring (0x1E).
        if (!this.win('msg')) this.openMessage('msg', 320, 224, this.bytesOf('Temp save: the PSP save dialog is not run by the viewer. '), 0x16, 0xf000)
        if (P & (PAD_CROSS | PAD_CIRCLE)) {
          this.closeAll()
          this.state = STATE.menu
          this.cmdOpen(this.cmd.bits)
        }
        return
      case STATE.actionEnd: {
        const mask = g.aliveMask()
        if (mask === 1) this.state = STATE.win0
        else if (mask === 2) this.state = STATE.win1
        else if (mask === 0) this.state = STATE.draw
        let ok = 0
        if (this.state < 0x2329 && !this.isCpu()) {
          if (this.command === 4) {
            if (!this.win('tc')) {
              const tc = this.openMessage('tc', 8, 8, this.t.text.endTurn, 0x16, 0x3000)
              this.openMessage('help', 8, tc.win.h + 8, this.t.text.acceptCancel, 0x14, 0x3000)
            }
            if (P & PAD_CROSS) {
              g.onSe(7)
              ok = 1
            } else if (P & PAD_CIRCLE) {
              g.onSe(9)
              ok = -1
              this.state = STATE.free
            }
          } else ok = 1 // Standby: the code compares the state (not the command) with 0x100
        } else ok = 1
        if (ok !== 0) {
          this.closeWin('tc')
          this.closeWin('help')
        }
        if (ok > 0) {
          if (u && (cardType(u.cardId) === CT_UNIT || cardType(u.cardId) === CT_CHARA) && u.state > 0) this.placeBack(u)
          if (u && this.actionFlags & 1) {
            g.attachmentOp(u, 2102, 4)
            g.compactAttachments(u)
          }
          g.commitConquest()
          this.walk = null
          if (this.state === STATE.actionEnd) this.state = STATE.afterAction
        }
        return
      }
      case STATE.afterAction: {
        this.zoomIn = false
        const goal = g.goal
        if (goal !== 0 && g.conquestCount[tp] >= goal) {
          if (!this.win('info')) this.openMessage('info', 320, 224, sprintf(this.cstr(S.conquestWin), g.conquestCount[tp], goal), 0x18, 0xf000)
          if (P & PAD_CROSS) {
            this.closeAll()
            this.state = tp === 0 ? STATE.win0 : STATE.win1
          }
          return
        }
        this.state = STATE.discard
        if (!this.isCpu()) {
          if (this.command !== 4 && this.command !== 2 && u) {
            u.actFlags |= 0xf
            if (g.attachmentOp(u, 2608, 2)) u.actFlags = 0
            if (g.allUnits().some((v) => v.team === tp && v.cardId < 2000 && !(v.actFlags & 8))) this.state = STATE.free
            if (this.state !== STATE.free) {
              this.command = 4
              this.returnState = STATE.free
              this.state = STATE.actionEnd
            }
            this.actionFlags = 0
          }
          if (u) {
            g.compactAttachments(u)
            g.recalc(u)
          }
        } else {
          const c = this.ai.cur
          if (c) {
            c.actFlags |= 0xf
            if (g.attachmentOp(c, 2608, 2)) {
              c.actFlags = 0
              this.state = STATE.cpu
            }
          }
          if (this.ai.unitSlot !== 0) this.state = STATE.cpu
          if (this.state === STATE.cpu) this.ai.unitSlot++
          if (c) {
            g.compactAttachments(c)
            g.recalc(c)
          }
        }
        return
      }
      case STATE.discard:
        this.state = pl && pl.hand.every((d) => d > 0) ? STATE.discardPick : STATE.turnEnd
        this.handState = 0
        return
      case STATE.discardPick: {
        if (!pl) return
        const r = this.handUpdate(pl, 0x400)
        if (r === 1 || r === -1) this.state = STATE.turnEnd
        return
      }
      case STATE.turnEnd: {
        // mapTurnEndUpdate, then the next player whose Dominator is alive; g_mapRound + 1 when player 0 comes round
        this.flows.turnEnd()
        let next = -1
        let q = tp
        for (let k = 0; k < 2; k++) {
          q++
          if (q >= 2) {
            q = 0
            g.round++
          }
          if (g.units[q][0].hp > 0) {
            next = q
            break
          }
        }
        if (next < 0) this.state = STATE.win0
        else {
          this.turnPlayer = next
          this.handPlayer = next
          this.ai.reset()
          this.state = STATE.banner
        }
        return
      }
      case STATE.banner: {
        g.drawFlags = 0x1f
        this.marks.fill(0)
        const dom = g.units[tp][0]
        this.active = dom
        this.cursor.x = dom.posX
        this.cursor.y = dom.posY
        if (!this.win('msg')) {
          const name = this.playerNames[tp] ?? ''
          this.openMessage('msg', 320, 224, this.bytesOf(`${name}' s turn `), 0x18, 0xf000)
          this.bannerCount = 1
        } else if (this.bannerCount < 0x41) {
          if ((this.win('msg')!.win.alpha ?? 0) > 0x7f) this.bannerCount++
          // START or a middle click (Play mode, ours) starts the fade at once
          if (P & (PAD_START | PAD_POINTER_MIDDLE)) this.bannerCount = 0x41
        } else if (!this.fadeClose('msg', 8)) this.bannerCount = 0
        if (this.bannerCount === 0) {
          this.actionFlags = 0
          this.segCount = 0
          this.flows.tsStep = 0
          this.state = STATE.turnStart
        }
        return
      }
      case STATE.turnStart:
        if (this.flows.turnStart()) {
          this.handState = 0
          this.state = this.isCpu() ? STATE.cpu : STATE.hand
          if (g.dominatorDown()) this.state = STATE.actionEnd
        }
        return
      case STATE.cpu: {
        const r = this.ai.update()
        if (this.ai.cur) this.active = this.ai.cur
        if (r !== 0) {
          if (r === 0x834) this.command = 0x80
          else if (r === 9000) this.command = 0x100
          this.state = r
        }
        return
      }
      case STATE.hand: {
        if (!pl) {
          this.state = STATE.free
          return
        }
        const r = this.handUpdate(pl, 1)
        if (r === 1) {
          this.command = 2
          this.returnState = STATE.hand
          this.state = STATE.deploySetup
        } else if (r === -1) this.state = STATE.free
        return
      }
      case STATE.deploySetup: {
        if (!pl || pl.selected < 1 || pl.selected > 0x1f) {
          this.backToReturn()
          return
        }
        const cid = pl.deck[pl.selected]
        this.closeAll()
        if (cardType(cid) === CT_SPELL) {
          this.flows.spState = 0
          this.state = STATE.spell
          return
        }
        const allowed = Math.max(0, 0x10 - g.placedCount[tp])
        const msg = this.openMessage('msg', 8, 8, this.bytesOf(allowed < 1 ? TXT.noDeploy : TXT.deploy), 0x16, 0x3000)
        this.openMessage('tc', 8, msg.win.h + 8, this.bytesOf(TXT.deployCount.replace('%d', String(allowed))), 0x14, 0x3000)
        if (allowed > 0) g.markSummonCells(g.units[tp][pl.selected].attribute)
        this.state = STATE.deployPick
        return
      }
      case STATE.deployPick: {
        if (0x10 - g.placedCount[tp] < 1) {
          if (P & (PAD_CROSS | PAD_CIRCLE | PAD_POINTER)) {
            this.closeAll()
            this.backToReturn()
          }
          return
        }
        const rest = this.cursorUpdate()
        if (!rest || !whole) return
        if (P & PAD_CROSS) {
          if (g.getCell(cx >> 6, cy >> 6) < 1 && pl && g.canDeployAt(tp, this.db.byId.get(pl.deck[pl.selected])?.attribute ?? 0, cx >> 6, cy >> 6)) {
            this.closeWin('tc')
            this.closeWin('msg')
            const msg = this.openMessage('msg', 8, 8, this.bytesOf(TXT.deployOk), 0x16, 0x3000)
            this.closeWin('help')
            this.openMessage('help', msg.win.x, msg.win.y + msg.win.h, this.t.text.acceptCancel, 0x12, 0x3000)
            g.onSe(7)
            this.state = STATE.deployConfirm
          }
        } else if (P & PAD_CIRCLE) {
          g.clearDeployMarks()
          this.closeWin('msg')
          this.closeWin('tc')
          g.onSe(9)
          this.backToReturn()
        }
        return
      }
      case STATE.deployConfirm:
        if (P & PAD_CROSS) {
          this.closeAll()
          g.onSe(7)
          this.state = STATE.deploy
        } else if (P & PAD_CIRCLE) {
          g.onSe(9)
          this.state = STATE.deploySetup
        }
        return
      case STATE.deploy: {
        if (!pl) return
        const unit = g.units[tp][pl.selected]
        const r = this.flows.summon(unit, cx, cy, 0)
        if (r > 0) g.compactHand(pl)
        if (r !== 0) {
          g.clearDeployMarks()
          if (this.returnState !== STATE.hand) this.returnState = STATE.free
          pl.flags &= ~4
          this.backToReturn()
          if (g.dominatorDown()) this.state = STATE.actionEnd
        }
        return
      }
      case STATE.spell: {
        const r = this.flows.spell()
        if (r === -1) this.backToReturn()
        else if (r === 1) {
          this.handState = 0
          this.state = this.isCpu() ? STATE.cpu : STATE.hand
          if (g.dominatorDown()) this.state = STATE.actionEnd
        }
        return
      }
      case STATE.win0:
      case STATE.win1:
      case STATE.draw: {
        this.zoomIn = false
        this.result = this.state
        const exit = this.resultUpdate(this.state === STATE.win0 ? 0 : this.state === STATE.win1 ? 1 : -1)
        if (exit) {
          this.resultExit = exit
          this.state = STATE.exit
          this.boardActive = false
        }
        return
      }
      case STATE.exit:
        return
      case STATE.init: {
        // state 1 (after the loads): the camera sprites, g_mapDrawFlags 3, a new board starts round 1
        g.drawFlags = 3
        if (g.round < 1) {
          g.round++
          this.firstTurn = 1
          if (g.gameMode === 1) this.eventStart('stageStart', this.layout)
          this.boardActive = true
          this.state = STATE.areaName
        } else {
          g.drawFlags = 0x1f
          this.state = STATE.free
        }
        return
      }
      case STATE.areaName:
        this.openMessage('msg', 320, 224, this.t.areaNames[this.board.area] ?? new Uint8Array(0), 0x16, 0xf000)
        this.state = STATE.areaWait
        return
      case STATE.areaWait:
        // the game waits for ✕ / ○; a click, START and a middle click (Play mode, ours) close it too
        if (P & (PAD_CROSS | PAD_CIRCLE | PAD_POINTER | PAD_START | PAD_POINTER_MIDDLE)) {
          this.closeWin('msg')
          this.state = STATE.conditions
        }
        return
      case STATE.conditions: {
        if (this.eventUpdate() !== 1) return
        const l1 = 'Conditions to win ', l2 = "Lower enemy dominator' s HP to 0 "
        let cols = l2.length + 2
        let lines = 2
        const l3 = g.goal ? `Gather ${g.goal} in conquest ` : ''
        if (g.goal) {
          lines = 3
          if (cols < l3.length + 2) cols = l3.length + 2
        }
        const f = this.openFrame('msg', 320, 224, (cols * 23) / 2 + 60, lines * 23 + 60, 0, 4, 0xc000)
        this.printAt(f, 0, 0, 0x16, this.bytesOf(l1))
        this.printAt(f, 0x17, 0x17, 0x16, this.bytesOf(l2))
        if (l3) this.printAt(f, 0x17, 0x2e, 0x16, this.bytesOf(l3))
        if (g.gameMode === 1 && (this.layout === 0xb || this.layout === 1)) {
          this.turnPlayer = (this.turnPlayer + 1) & 1
          this.handPlayer = this.turnPlayer
        }
        this.state = STATE.conditionsWait
        return
      }
      case STATE.conditionsWait:
        // the game waits for ✕; a click, START and a middle click (Play mode, ours) close it too
        if (P & (PAD_CROSS | PAD_POINTER | PAD_START | PAD_POINTER_MIDDLE)) {
          this.closeWin('msg')
          this.state = this.players[0].deckState[0] & 4 ? STATE.banner : STATE.startPick
        }
        return
      case STATE.startPick: {
        // versus: "Please select the initial location of the dominator." (squares within 5 of the first one are marked 1)
        g.drawFlags = 0x1f
        if (!this.win('msg')) this.openMessage('msg', 8, 8, this.cstr(0x088dcfc8), 0x16, 0x3000)
        const rest = this.cursorUpdate()
        if (rest && whole && g.getCell(cx >> 6, cy >> 6) === 0 && P & PAD_CROSS) {
          this.closeWin('msg')
          if (this.marks[(cy >> 6) * 40 + (cx >> 6)] === 1) {
            this.openMessage('msg', 8, 8, this.bytesOf('You cannot select this location. '), 0x16, 0x3000)
            g.onSe(10)
          } else {
            const m = this.openMessage('msg', 8, 8, this.bytesOf('Is this location all right? '), 0x16, 0x3000)
            this.openMessage('help', m.win.x, m.win.y + m.win.h, this.t.text.acceptCancel, 0x12, 0x3000)
            g.onSe(7)
          }
          this.state = STATE.startConfirm
        }
        return
      }
      case STATE.startConfirm:
        if (this.marks[(cy >> 6) * 40 + (cx >> 6)] === 1) {
          if (P & (PAD_CROSS | PAD_CIRCLE)) this.state = STATE.startPick
        } else if (P & PAD_CROSS) {
          g.onSe(7)
          this.state = STATE.startPlace
        } else if (P & PAD_CIRCLE) {
          g.onSe(9)
          this.state = STATE.startPick
        }
        if (this.state !== STATE.startConfirm) {
          this.closeWin('msg')
          this.closeWin('help')
        }
        return
      case STATE.startPlace: {
        const d = g.units[this.handPlayer][0]
        const r = this.flows.summon(d, cx, cy, 0)
        if (r !== 0) {
          this.turnPlayer = tp + 1
          this.handPlayer++
          this.state = STATE.startPick
          if (this.turnPlayer >= 2) {
            this.turnPlayer = 0
            this.handPlayer = 0
            this.marks.fill(0)
            this.state = STATE.banner
          } else {
            const f = g.units[this.turnPlayer - 1][0]
            g.fillDiamond(f.posX >> 6, f.posY >> 6, 5, 1)
          }
        }
        return
      }
    }
  }

  /** state = g_mapReturnState after a deployment or a cancelled spell (0x10: the hand again). */
  private backToReturn() {
    if (this.returnState === STATE.hand) this.openHand()
    else this.state = STATE.free
  }

  // ---- frame ----

  /**
   * One game frame, in mapBoardScene order: board (terrain, units) with last frame's camera, the state
   * machine (cursor, command menu, moves, hand, windows), uiAnimCounter, mapSetupCameraMatrix, cursor
   * marker, status HUD, hover panel, hand panels, command ring, windows. Draws into `gl` when given.
   */
  /**
   * Mouse (Play mode, ours): a click on a help label of an open window ("△ Card details", "□ Check board",
   * "○ End", "✕ Accept ○ Cancel" …) presses that button instead of the click. The topmost window wins.
   */
  private helpClick() {
    this.helpHover = null
    const { x, y } = this.pointer
    if (x < 0) return
    const tables = this.t.win
    let yesNo = false
    for (let k = this.wins.length - 1; k >= 0; k--) {
      const w = this.wins[k].win
      if ((w.alpha ?? 0x80) <= 0) continue
      const [left, top] = windowOrigin(w)
      const [ox, oy] = tables.textOffset[w.style ?? 10] ?? [0, 0]
      const zones = w.text ? textButtonZones(w.text, left + ox, top + oy, w.glyph, w.wide, tables) : []
      for (const p of this.wins[k].prints) zones.push(...textButtonZones(p.text, left + ox, top + oy + p.y, p.glyph, false, tables, p.x))
      const z = zones.find((q) => x >= q.x0 && x < q.x1 && y >= q.y0 && y < q.y1)
      if (z) {
        this.helpHover = { key: this.wins[k].key, ...z }
        if (this.pressed & PAD_POINTER) this.pressed = (this.pressed & ~PAD_POINTER) | z.bit
        return
      }
      if (zones.length === 2 && zones.some((q) => q.bit === PAD_CROSS) && zones.some((q) => q.bit === PAD_CIRCLE)) yesNo = true
    }
    // a yes / no question ("✕ Accept ○ Cancel": End turn, Commencing attack, …) while no free cursor ran last
    // frame: a left click anywhere is ✕ (a right click is already ○)
    if (yesNo && !this.cursorCalled && this.pressed & PAD_POINTER) this.pressed = (this.pressed & ~PAD_POINTER) | PAD_CROSS
  }

  frame(gl: GlRenderer | null) {
    this.helpClick()
    // mouse (ours): a click on a square last frame is ✕ now, while the same cursor state runs again
    if (this.mouseCross) {
      this.mouseCross = false
      if (this.cursorCalled) this.pressed = (this.pressed & ~PAD_POINTER) | PAD_CROSS
    }
    this.cursorCalled = false
    this.unitHits = []
    this.gl = gl
    if (gl) {
      gl.depthTest = false
      gl.begin([0, 0, 0])
    }
    const flags0 = this.game.drawFlags
    let hover: MapUnitState | null = null
    if (this.boardActive) {
      if (flags0 & 1) this.drawTerrain(this.rangeGrid())
      if (flags0 & 2) hover = this.drawAllUnits()
    }
    this.blinkOn = 0
    this.ringOn = false
    const turn = this.turnPlayer
    this.update()
    // uiAnimCounter(0): mode 3 counter 0..63, frame 7 − (c >> 3); mode 2 counter 0..23, frame c >> 2.
    this.animCounter3++
    if (this.animCounter3 >> 3 > 7) this.animCounter3 = 0
    this.c2++
    if (this.c2 >> 2 > 5) this.c2 = 0
    this.tickBadge()
    if (this.boardActive && !this.resultDraw(gl)) {
      if (this.infoOpen && this.infoUnit && this.cardInfoUpdate(this.infoUnit.cardId, 1) === -1) this.infoOpen = false
      this.setupCamera()
      const f = this.game.drawFlags
      if (!this.infoOpen) {
        if (f & 4 && this.opts.cursorMarker) this.drawCursorMarker()
        if (f & 8 && this.opts.statusHud) this.drawStatusHud()
        if (f & 0x10 && this.opts.hoverPanel && hover) this.drawHoverPanel(hover)
      }
      // gfxClearDepth: from here on the GE depth test decides what the effects' camera-0 sprites cover
      if (gl) gl.depthReset(true)
      const hp = this.players[this.handPlayer], other = this.players[(turn + 1) & 1]
      if (this.players[turn]?.visible && hp) this.drawHandPanel(hp)
      if (other?.visible) this.drawHandPanel(other)
      if (this.ringOn) this.drawRing()
      if (this.story) this.drawStory()
      else this.drawWindows()
    }
    this.pressed = 0
    // (*g_effectState)(), then scrObjRenderAll(0) and (6) over everything
    if (this.boardActive) this.effectFrame()
    if (gl && this.fx && this.boardActive) this.fx.render(scaledGl(gl), [0, 6])
    if (gl) gl.end()
    this.gl = null
    this.frameNo++
  }

  /** The square whose last drawn quad contains screen point (x, y) of the 480×272 frame. */
  cellAt(x: number, y: number): [number, number] | null {
    for (const [k, q] of this.cellQuads) if (inQuad(q, x, y)) return [k % 40, Math.floor(k / 40)]
    return null
  }
}

/** Point (x, y) inside the convex quad q (either winding). */
function inQuad(q: Quad, x: number, y: number): boolean {
  let pos = true, neg = true
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
    if (c < 0) pos = false
    if (c > 0) neg = false
  }
  return pos || neg
}

// ---------------------------------------------------------------------------------------------
// helpers

/** A window of the board scene: the painter's window plus winPrintAt lines. */
interface MapWin {
  key: string
  win: DuelWindow
  prints: { x: number; y: number; glyph: number; text: Uint8Array; at: number }[]
  /** Flag 0x1000: printed lines widen the window. */
  autoW?: boolean
  /** winOpenList / winOpenMenu: the rows and Window.cursor; flag 0x100 (no input on the opening frame). */
  list?: { items: Uint8Array[]; cursor: number; frame: number; noInput: boolean }
}

/** The PlayerProfile fields of the result screen (duelRollRewardCards, duelResultScreenUpdate 0xF / 0x10). */
export interface ResultProfile {
  cardCount: Uint8Array
  cardNewFlags: Uint8Array
  mapBattles: Uint32Array
  mapWins: Uint32Array
  charaBattles: Uint32Array
  charaWins: Uint32Array
}

/** An empty collection and zero counters (the viewer's result screen). */
export function emptyResultProfile(): ResultProfile {
  return { cardCount: new Uint8Array(207), cardNewFlags: new Uint8Array(207), mapBattles: new Uint32Array(19), mapWins: new Uint32Array(19), charaBattles: new Uint32Array(19), charaWins: new Uint32Array(19) }
}

/** charaIdToIndex (0x0884A1F0 area): Dominator card id → character 1..11 (rematch ids 1012..1021 share the base index). */
function charaIndex(id: number): number {
  if (id === 1001) return 1
  if (id >= 1002 && id <= 1011) return id - 1000
  if (id >= 1012 && id <= 1021) return id - 1010
  return 1
}

/** WindowPainter works in 640×448 virtual units; the board renderer is 480×272. */
function scaledGl(gl: GlRenderer): GlRenderer {
  const sx = 480 / 640, sy = 272 / 448
  return {
    texture: (img: RgbaImage) => gl.texture(img),
    triangles: (tex: WebGLTexture | null, blend: BlendMode, verts: Vertex[], color: [number, number, number, number]) =>
      gl.triangles(tex, blend, verts.map((v) => ({ ...v, x: v.x * sx, y: v.y * sy })), color),
  } as unknown as GlRenderer
}

/** GAN timing: one tick per draw, looping; a 255 duration holds. */
const ticks = (d: number) => (d === 255 ? 0x10000000 : d)

function stepAt(g: Gan, time: number): number {
  let t = 0
  for (let i = 0; i < g.steps.length; i++) {
    t += ticks(g.steps[i].duration)
    if (time < t) return i
  }
  return Math.max(0, g.steps.length - 1)
}

/** g_mapUnitWalkAnm: an AnmManager with the two walking GANs of the moving unit. */
class WalkAnim {
  readonly gans: (Gan | null)[]
  current = -1
  time = 0
  private sheets = new Map<string, RgbaImage>()

  constructor(gans: (Gan | null)[]) {
    this.gans = gans
  }

  /** anmSwitch: a different animation restarts from tick 0. */
  select(i: number) {
    if (i === this.current) return
    this.current = i
    this.time = 0
  }

  /** ganSetTime(time + 1), wrapping at the total duration. */
  tick() {
    const g = this.gans[this.current]
    if (!g) return
    let total = 0
    for (const st of g.steps) total += ticks(st.duration)
    this.time = total > 0 ? (this.time + 1) % total : 0
  }

  sheet(image: number, clut: number): RgbaImage {
    const key = `${this.current}:${image}:${clut}`
    let img = this.sheets.get(key)
    if (!img) {
      const g = this.gans[this.current]!
      img = ganSheet(g, image, g.palettes[clut])
      this.sheets.set(key, img)
    }
    return img
  }
}
