/**
 * Effect library of the CAS1 VM: script objects (sprites, GAN animations, poly meshes), cameras,
 * tweens and the renderer. A port of scrRegisterEffectFuncs' handlers, scrObjUpdateTweens and
 * scrObjRenderAll; see docs/formats/effects.md for the rules this follows.
 */
import { parseGan, isMarker, type Gan } from '../formats/gan'
import { gbpToImage, parseGbp } from '../formats/gbp'
import { ganSheet } from '../formats/gan'
import type { OneArchive } from '../formats/one'
import type { RgbaImage } from '../formats/palette'
import { type VagClip } from '../formats/vag'
import { SePlayer } from '../audio/sePlayer'
import type { BlendMode, GlRenderer, Vertex } from './gl'
import { ScriptError, Vm, type StackRef } from './vm'

export const VIRTUAL_W = 640
export const VIRTUAL_H = 448
const OBJECTS = 384
const HIDDEN = 0x7fffffff

// ---------------------------------------------------------------------------------------------
// math

type V3 = [number, number, number]

/** Sprites and meshes: Z first, then Y, then X (mtxRotZYX). */
function rotZYX(p: V3, rx: number, ry: number, rz: number): V3 {
  let [x, y, z] = p
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

// ---------------------------------------------------------------------------------------------
// cameras

export interface Camera {
  eye: V3
  rot: V3
  focal: number
  /** 0 = 3D, 1 = 2D sorted, 2 = 2D back, 4 = 2D front. */
  mode: number
}

function defaultCamera(index: number): Camera {
  if (index <= 3) return { eye: [320, 224, -768], rot: [0, 0, 0], focal: 768, mode: 0 }
  const mode = index === 4 ? 1 : index === 5 ? 2 : 4
  return { eye: [320, 224, -32768], rot: [0, 0, 0], focal: 32768, mode }
}

/** Camera 0 outlives an effect in the game: scripts save and restore it. Start from the boot state. */
function project(cam: Camera, p: V3): { x: number; y: number; z: number } {
  let q: V3 = [p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]]
  // q = Mᵀ(P − eye) with M = Rz·Ry·Rx: undo Z, then Y, then X.
  const [rx, ry, rz] = cam.rot
  if (rz) {
    const c = Math.cos(-rz), s = Math.sin(-rz)
    q = [q[0] * c - q[1] * s, q[0] * s + q[1] * c, q[2]]
  }
  if (ry) {
    const c = Math.cos(-ry), s = Math.sin(-ry)
    q = [q[2] * s + q[0] * c, q[1], q[2] * c - q[0] * s]
  }
  if (rx) {
    const c = Math.cos(-rx), s = Math.sin(-rx)
    q = [q[0], q[1] * c - q[2] * s, q[1] * s + q[2] * c]
  }
  return { x: 320 + (cam.focal * q[0]) / q[2], y: 224 + (cam.focal * q[1]) / q[2], z: q[2] }
}

/**
 * GE depth / 65535 by camera mode: 3D draws get 65535 / view depth (mtxPerspectiveGe), 2D-front
 * 0xFFFF, 2D-back 0, 2D-sorted 0x7FFF − depth (effects draw with depth 0).
 */
export function geDepth(cam: Camera, qz: number): number {
  if (cam.mode === 0) return Math.min(1, Math.max(0, 1 / qz))
  if (cam.mode === 4) return 1
  if (cam.mode === 2) return 0
  return 0x7fff / 65535
}

// ---------------------------------------------------------------------------------------------
// objects

interface Sprite {
  img: RgbaImage
  u0: number
  v0: number
  u1: number
  v1: number
  pivot: [number, number]
  offset: V3
  blend: number
  /** Camera whose projection the sprite uses (its "render context"). */
  cam: number
}

interface Anm {
  gans: Gan[]
  current: number
  time: number
  sheets: Map<string, RgbaImage>
  blend: number | null
  cam: number
}

interface Poly {
  pattern: number
  src: number
  a: number
  b: number
  h: number
  spread: number
  spin: number
}

interface Obj {
  visible: boolean
  type: -1 | 1 | 2 | 4
  cloneKind: number
  pos: V3
  rot: V3
  scale: [number, number]
  rgba: [number, number, number, number]
  /** Colour last pushed to the sprite (pushed before the colour tween steps). */
  pushed: [number, number, number, number]
  posTarget: V3
  posStart: V3
  posStep: V3
  posFrames: number
  posTime: number
  posSpeed: number
  rotTarget: V3
  rotStart: V3
  rotStep: V3
  rotFrames: number
  rotTime: number
  rotSpeed: number
  scaleTarget: [number, number]
  scaleStart: [number, number]
  scaleStep: [number, number]
  scaleFrames: number
  scaleTime: number
  scaleSpeed: number
  rgbaTarget: [number, number, number, number]
  rgbaStep: number
  shadow: number
  camera: number
  coordMode: number
  tweenFlags: number
  paused: boolean
  sprite?: Sprite
  anm?: Anm
  poly?: Poly
}

function newObj(): Obj {
  return {
    visible: false,
    type: -1,
    cloneKind: 0,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    scale: [1, 1],
    rgba: [128, 128, 128, 128],
    pushed: [128, 128, 128, 128],
    posTarget: [0, 0, 0],
    posStart: [0, 0, 0],
    posStep: [0, 0, 0],
    posFrames: 0,
    posTime: 0,
    posSpeed: 0,
    rotTarget: [0, 0, 0],
    rotStart: [0, 0, 0],
    rotStep: [0, 0, 0],
    rotFrames: 0,
    rotTime: 0,
    rotSpeed: 0,
    scaleTarget: [1, 1],
    scaleStart: [0, 0],
    scaleStep: [0, 0],
    scaleFrames: 1,
    scaleTime: 0,
    scaleSpeed: 0,
    rgbaTarget: [128, 128, 128, 128],
    rgbaStep: 0,
    shadow: 0,
    camera: 0,
    coordMode: 0,
    tweenFlags: 0,
    paused: false,
  }
}

function cloneObj(o: Obj): Obj {
  const c: Obj = structuredClone({ ...o, sprite: undefined, anm: undefined, poly: undefined })
  if (o.sprite) c.sprite = { ...o.sprite, pivot: [...o.sprite.pivot], offset: [...o.sprite.offset] }
  if (o.anm) c.anm = { ...o.anm, gans: [...o.anm.gans] }
  return c
}

// ---------------------------------------------------------------------------------------------
// poly meshes (polySystemInit): triangles relative to their centroid

interface Tri {
  rel: [V3, V3, V3]
  uv: [[number, number], [number, number], [number, number]]
  c: V3
}

const TOWER_SIDES = [32, 16, 8, 6, 5, 4, 3]
const meshCache = new Map<number, Tri[]>()
const rad = (d: number) => (d * Math.PI) / 180

function mesh(pattern: number): Tri[] {
  let m = meshCache.get(pattern)
  if (m) return m
  m = []
  const push = (vs: V3[], uvs: [number, number][], c: V3) =>
    m!.push({ rel: vs.map((v) => [v[0] - c[0], v[1] - c[1], v[2] - c[2]]) as Tri['rel'], uv: uvs as Tri['uv'], c })
  if (pattern === 0) {
    const P = (lon: number, lat: number): V3 => [Math.cos(rad(lon)) * Math.cos(rad(lat)), Math.sin(rad(lat)), Math.sin(rad(lon)) * Math.cos(rad(lat))]
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 16; j++) {
        const lat0 = i * 22.5 - 90, lat1 = (i + 1) * 22.5 - 90, lon0 = j * 22.5, lon1 = (j + 1) * 22.5
        const p00 = P(lon0, lat0), p01 = P(lon0, lat1), p10 = P(lon1, lat0), p11 = P(lon1, lat1)
        const t00: [number, number] = [j / 16, i / 8], t01: [number, number] = [j / 16, (i + 1) / 8]
        const t10: [number, number] = [(j + 1) / 16, i / 8], t11: [number, number] = [(j + 1) / 16, (i + 1) / 8]
        const mean = (a: V3, b: V3, c: V3): V3 => [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
        if (i !== 0) push([p00, p01, p10], [t00, t01, t10], mean(p00, p01, p10))
        if (i !== 7) push([p01, p10, p11], [t01, t10, t11], mean(p01, p10, p11))
      }
    }
  } else {
    const n = TOWER_SIDES[(pattern - 1) % TOWER_SIDES.length]
    for (let k = 0; k < n; k++) {
      const a0 = rad((k * 360) / n), a1 = rad(((k + 1) * 360) / n)
      const T0: V3 = [Math.cos(a0), 0, Math.sin(a0)], B0: V3 = [Math.cos(a0), -1, Math.sin(a0)]
      const T1: V3 = [Math.cos(a1), 0, Math.sin(a1)], B1: V3 = [Math.cos(a1), -1, Math.sin(a1)]
      const c: V3 = [(B0[0] + T1[0]) / 2, (B0[1] + T1[1]) / 2, (B0[2] + T1[2]) / 2]
      push([T0, B0, T1], [[k / n, 1], [k / n, 0], [(k + 1) / n, 1]], c)
      push([B0, T1, B1], [[k / n, 0], [(k + 1) / n, 1], [(k + 1) / n, 0]], c)
    }
  }
  meshCache.set(pattern, m)
  return m
}

/** g_shardSpinAxes: random per triangle at boot, (rand() % 10) degrees per axis. Seeded here. */
const SPIN_AXES: V3[] = (() => {
  let s = 12345
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16) % 10
  return Array.from({ length: 256 }, () => [rad(r()), rad(r()), rad(r())] as V3)
})()

const wrapPi = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI))


// ---------------------------------------------------------------------------------------------
// colour (spriteSetColor: RGBA4444 vertex colour, 128 = 1.0, values above 128 wrap)

export type Rgba = [number, number, number, number]

export function vertexColor(r: number, g: number, b: number, a: number): Rgba {
  const rgb = (c: number) => ((((Math.trunc(c) * 255) >> 11) & 0xf) * 17) / 255
  const al = (((((Math.trunc(a) * 255) >> 7) & 0xf0) >> 4) * 17) / 255
  return [rgb(r), rgb(g), rgb(b), al]
}

/** GAN part alpha by blend byte (ganDrawFrame). */
export const GAN_BASE_ALPHA: Record<number, number> = { 0: 0x40, 1: 0x7f, 2: 0, 3: 0x20 }

// ---------------------------------------------------------------------------------------------
// scene

export interface SceneOptions {
  /** 0 = the left combatant attacks (battleSetupCombatantFacing), 1 = the right one. */
  attackerSide: 0 | 1
  seClips?: VagClip[]
  audio?: AudioContext | null
  /** Where the SE voices go (Play mode: the SE bus of the AudioManager); default the context's destination. */
  seOut?: AudioNode
  /** Truncate positions to whole pixels like the PSP. */
  snap: boolean
  /** Map board hooks (effects started by mapBoardScene): g_mapCamPos and g_mapCurUnit. */
  map?: MapEffectHooks
}

/** What the map's script functions read and write (0x385 map_get_cam_pos, 0x388 / 0x389 the current unit). */
export interface MapEffectHooks {
  camPos(): [number, number, number]
  placeCurUnit(): void
  removeCurUnit(): void
  /** 0x384 result_get_winner: g_resultWinnerSide and charaIdToIndex(g_resultLoserCharaId). */
  result?(): [number, number]
}

export interface ObjectInfo {
  index: number
  type: string
  visible: boolean
  camera: number
  pos: V3
  rgba: number[]
  tweens: number
}

export class EffectScene {
  readonly objs: Obj[] = Array.from({ length: OBJECTS }, newObj)
  readonly cams: Camera[] = Array.from({ length: 8 }, (_, i) => defaultCamera(i))
  readonly vm: Vm
  frame = 0
  error: string | null = null
  sounds: string[] = []
  private started = false
  /** The 20 SAS voices of sndPlaySe (null while there is no audio or no se.dat). */
  private se: SePlayer | null = null
  private textures = new Map<Uint8Array, RgbaImage | Gan>()

  private archive: OneArchive
  private opts: SceneOptions

  constructor(archive: OneArchive, data: Uint8Array, opts: SceneOptions) {
    this.archive = archive
    this.opts = opts
    this.vm = new Vm(data, (id, vm) => this.call(id, vm))
  }

  get finished() {
    return this.started && !this.vm.running
  }

  /** One 60 Hz frame (effectRunFrame): scripts, then colour push, tweens and animations. */
  step() {
    if (this.error || this.finished) return
    try {
      if (!this.started) {
        this.started = true
        this.vm.start()
      } else this.vm.execFrame()
    } catch (e) {
      this.error = e instanceof ScriptError ? e.message : String(e)
      return
    }
    this.updateTweens()
    this.frame++
  }

  /** se_stop_all (sndStopAllSe): key-off on every voice. */
  stopSound() {
    this.se?.stopAll()
  }

  setAudio(ac: AudioContext | null) {
    if (!ac) this.stopSound()
    if (ac !== this.opts.audio) {
      this.se?.dispose()
      this.se = null
    }
    this.opts.audio = ac
  }

  /** Screen position of a world point (virtual 640×448), or null behind the camera. */
  projectWorld(cam: Camera, p: V3) {
    const q = project(cam, p)
    return q.z > 0 ? q : null
  }

  // ---- assets ----

  private asset(entry: number, member: number): Uint8Array {
    const e = this.archive.entries.find((x) => x.id === entry)
    const f = member < 1 ? e?.files[0] : e?.files.find((x) => x.subId === member)
    if (!f) throw new ScriptError(`${this.archive.name} ${entry}/${member} not found`)
    return f.data
  }

  private image(data: Uint8Array): RgbaImage {
    let t = this.textures.get(data)
    if (!t) this.textures.set(data, (t = gbpToImage(parseGbp(data))))
    return t as RgbaImage
  }

  private gan(data: Uint8Array): Gan {
    let t = this.textures.get(data)
    if (!t) this.textures.set(data, (t = parseGan(data)))
    return t as Gan
  }

  // ---- built-ins ----

  private obj(i: number): Obj {
    const o = this.objs[i]
    if (!o) throw new ScriptError(`object ${i} out of range`)
    return o
  }

  private toWorld(o: Obj, x: number, d: number, h: number): V3 {
    return o.coordMode === 0 ? [x, -h, -d] : [x, d, h]
  }

  private fromWorld(o: Obj, p: V3): V3 {
    return o.coordMode === 0 ? [p[0], -p[2], -p[1]] : [p[0], p[1], p[2]]
  }

  private call(id: number, vm: Vm): number | undefined {
    const n = () => vm.popNum()
    const out = () => vm.pop()
    const ok = (v = 0) => {
      vm.pushInt(v)
      return 0
    }
    switch (id) {
      case 0x181: {
        const h = n(), d = n(), x = n(), c = n()
        this.cams[c].eye = [x, -h, -d]
        return ok()
      }
      case 0x182: {
        const h = out(), d = out(), x = out(), c = n()
        const e = this.cams[c].eye
        vm.store(x, Math.trunc(e[0]))
        vm.store(d, Math.trunc(-e[2]))
        vm.store(h, Math.trunc(-e[1]))
        return ok()
      }
      case 0x184: {
        const rz = n(), ry = n(), rx = n(), c = n()
        this.cams[c].rot = [rx, ry, rz]
        return ok()
      }
      case 0x186:
      case 0x187: {
        n() // flags: VRAM upload mode, irrelevant here
        const member = n(), entry = n(), archive = n(), oi = n()
        if (archive !== 7) throw new ScriptError(`archive ${archive} is not effect.one`)
        const o = this.obj(oi)
        const data = this.asset(entry, member)
        if (id === 0x186) {
          if (o.type !== -1) throw new ScriptError(`object ${oi} is not empty`)
          // Effect 1051 loads an empty member: the sprite then has no size and draws nothing.
          const img = data.length ? this.image(data) : { width: 1, height: 1, rgba: new Uint8ClampedArray(4) }
          const w = data.length ? img.width : 0, h = data.length ? img.height : 0
          o.sprite = { img, u0: 0, v0: 0, u1: w, v1: h, pivot: [0, 0], offset: [0, 0, 0], blend: 0, cam: 0 }
          o.type = 1
        } else {
          if (o.type !== 2) {
            if (o.type !== -1) throw new ScriptError(`object ${oi} is not empty`)
            // Part sprites keep the default 2D-sorted context until obj_set_camera.
            o.anm = { gans: [], current: -1, time: 0, sheets: new Map(), blend: null, cam: 4 }
            o.type = 2
          }
          o.anm!.gans.push(this.gan(data))
        }
        o.cloneKind = 0
        o.coordMode = this.cams[0].mode
        return ok()
      }
      case 0x188:
        n()
        return ok(0) // loads complete instantly
      case 0x191: {
        const op = n(), oi = n()
        const apply = (o: Obj) => {
          if (op === 0) {
            if (o.type === -1) return false
            o.visible = true
            if (o.anm) o.anm.time = 0
          } else if (op === 1) o.visible = false
          else if (op === 2) o.paused = true
          else if (op === 3) o.paused = false
          return true
        }
        if (oi < 0) {
          for (const o of this.objs) if (!apply(o)) return ok(-1)
          return ok()
        }
        return ok(apply(this.obj(oi)) ? 0 : -1)
      }
      case 0x194: {
        const si = n(), di = n()
        if (this.obj(di).type !== -1) throw new ScriptError(`clone target ${di} is not empty`)
        const src = this.obj(si)
        if (src.type === 1 || src.type === 2) {
          const c = cloneObj(src)
          c.cloneKind = src.type === 1 ? 1 : 2
          this.objs[di] = c
        }
        return ok()
      }
      case 0x195: {
        const oi = n()
        if (this.obj(oi).type === -1) throw new ScriptError(`freeing empty object ${oi}`)
        this.objs[oi] = newObj()
        return ok(this.objCount())
      }
      case 0x196: {
        const c = n(), o = this.obj(n())
        o.camera = c
        o.coordMode = this.cams[c]?.mode ?? 0
        if (o.sprite) o.sprite.cam = c
        if (o.anm) o.anm.cam = c
        return ok()
      }
      case 0x19a:
      case 0x19d: {
        const h = n(), d = n(), x = n(), o = this.obj(n())
        const p = this.toWorld(o, x, d, h)
        o.pos = id === 0x19d ? p : [o.pos[0] + p[0], o.pos[1] + p[1], o.pos[2] + p[2]]
        o.tweenFlags &= ~1
        return ok()
      }
      case 0x19b:
      case 0x19f: {
        const rz = n(), ry = n(), rx = n(), o = this.obj(n())
        o.rot = id === 0x19f ? [rx, ry, rz] : [o.rot[0] + rx, o.rot[1] + ry, o.rot[2] + rz]
        o.tweenFlags &= ~4
        return ok()
      }
      case 0x19e: {
        const sy = n(), sx = n(), o = this.obj(n())
        o.scale = [sx, sy]
        o.tweenFlags &= ~8
        return ok()
      }
      case 0x1a0: {
        const v = n(), param = n(), o = this.obj(n())
        if (param === 0) o.shadow = v
        return ok()
      }
      case 0x1a1: {
        const a = n(), b = n(), g = n(), r = n(), oi = n()
        const set = (o: Obj) => {
          ;[r, g, b, a].forEach((v, i) => {
            if (v >= 0) o.rgba[i] = v
          })
          o.pushed = [...o.rgba]
        }
        if (oi < 0) {
          this.objs.forEach(set)
          this.objs[OBJECTS - 1].tweenFlags &= ~2 // the game only clears the last slot
        } else {
          const o = this.obj(oi)
          set(o)
          o.tweenFlags &= ~2
        }
        return ok()
      }
      case 0x1a2: {
        const mode = n(), o = this.obj(n())
        if (o.sprite) o.sprite.blend = mode
        if (o.anm) o.anm.blend = mode
        return ok()
      }
      case 0x1a4:
      case 0x1a7: {
        const speed = n(), h = n(), d = n(), x = n(), o = this.obj(n())
        if (id === 0x1a7 && speed < 0) return ok(-1)
        const p = this.toWorld(o, x, d, h)
        const target: V3 = id === 0x1a7 ? p : [o.pos[0] + p[0], o.pos[1] + p[1], o.pos[2] + p[2]]
        const v = speed / 60
        const delta: V3 = [target[0] - o.pos[0], target[1] - o.pos[1], target[2] - o.pos[2]]
        const frames = Math.hypot(...delta) / v
        o.posTarget = target
        o.posStart = [...o.pos]
        o.posStep = delta.map((c) => (frames ? c / frames : 0)) as V3
        o.posFrames = frames
        o.posTime = 0
        o.posSpeed = v
        o.tweenFlags |= 1
        return ok()
      }
      case 0x1a8: {
        const speed = n(), sy = n(), sx = n(), o = this.obj(n())
        if (speed < 0) return ok(-1)
        const v = speed / 60
        const delta: [number, number] = [sx - o.scale[0], sy - o.scale[1]]
        const frames = Math.hypot(...delta) / v
        o.scaleTarget = [sx, sy]
        o.scaleStart = [...o.scale]
        o.scaleStep = delta.map((c) => (frames ? c / frames : 0)) as [number, number]
        o.scaleFrames = frames
        o.scaleTime = 0
        o.scaleSpeed = v
        o.tweenFlags |= 8
        return ok()
      }
      case 0x1a9: {
        const speed = n(), rz = n(), ry = n(), rx = n(), o = this.obj(n())
        if (speed < 0) return ok(-1)
        const v = speed / 60
        const delta: V3 = [rx - o.rot[0], ry - o.rot[1], rz - o.rot[2]]
        const frames = Math.hypot(...delta) / v
        o.rotTarget = [rx, ry, rz]
        o.rotStart = [...o.rot]
        o.rotStep = delta.map((c) => (frames ? c / frames : 0)) as V3
        o.rotFrames = frames
        o.rotTime = 0
        o.rotSpeed = v
        o.tweenFlags |= 4
        return ok()
      }
      case 0x1ab: {
        const speed = n(), a = n(), b = n(), g = n(), r = n(), o = this.obj(n())
        if (speed < 0) return ok(-1)
        o.rgbaTarget = [r, g, b, a].map((v, i) => (v >= 0 ? v : Math.trunc(o.rgba[i]))) as Rgba
        o.rgbaStep = speed / 60
        o.tweenFlags |= 2
        return ok()
      }
      case 0x1ac: {
        const oi = n()
        return ok(oi < 0 ? 0 : this.obj(oi).tweenFlags)
      }
      case 0x1b1: {
        const h = out(), d = out(), x = out(), o = this.obj(n())
        const p = this.fromWorld(o, o.pos)
        vm.store(x, Math.trunc(p[0]))
        vm.store(d, Math.trunc(p[1]))
        vm.store(h, Math.trunc(p[2]))
        return ok()
      }
      case 0x1b2: {
        const sy = out(), sx = out(), o = this.obj(n())
        vm.store(sx, Math.trunc(o.scale[0])) // truncated in the game too
        vm.store(sy, Math.trunc(o.scale[1]))
        return ok()
      }
      case 0x1b5: {
        const refs: StackRef[] = [out(), out(), out(), out()].reverse()
        const o = this.obj(n())
        refs.forEach((e, i) => vm.store(e, Math.trunc(o.rgba[i])))
        return ok()
      }
      case 0x1b8: {
        const flags = n(), o = this.obj(n())
        const s = o.sprite
        if (s) {
          const w = s.u1 - s.u0, h = s.v1 - s.v0
          let px = (w / 2) | 0, py = (h / 2) | 0
          if (!(flags & 0x10)) {
            if (flags & 1) py = 0
            if (flags & 2) py = h
            if (flags & 8) px = 0
            if (flags & 4) px = w
          }
          s.pivot = [px, py]
        }
        return ok()
      }
      case 0x1b9: {
        const py = n(), px = n(), o = this.obj(n())
        if (o.sprite) o.sprite.pivot = [px, py]
        return ok()
      }
      case 0x1ba: {
        const v1 = n(), u1 = n(), v0 = n(), u0 = n(), o = this.obj(n())
        if (o.sprite) Object.assign(o.sprite, { u0, v0, u1, v1, pivot: [0, 0] })
        return ok()
      }
      case 0x1bb: {
        const o = this.obj(n())
        if (o.sprite) o.sprite.offset = [-o.sprite.pivot[0], -o.sprite.pivot[1], 0]
        return ok()
      }
      case 0x1c0: {
        const src = n(), pattern = n(), oi = n()
        const o = this.obj(oi)
        if (o.type !== -1) throw new ScriptError(`object ${oi} is not empty`)
        o.poly = { pattern, src, a: 1, b: 1, h: 1, spread: 1, spin: 0 }
        o.type = 4
        return ok()
      }
      case 0x1c1: {
        const spin = n(), spread = n(), h = n(), b = n(), a = n(), o = this.obj(n())
        if (o.poly) Object.assign(o.poly, { a, b, h, spread, spin })
        return ok()
      }
      case 0x1c2: {
        const anim = (n() << 24) >> 24, o = this.obj(n())
        if (o.anm && anim !== o.anm.current) {
          o.anm.current = anim
          o.anm.time = 0
        }
        return ok()
      }
      case 0x1c4: {
        const what = n(), o = this.obj(n())
        if (!o.anm) return ok(0)
        if (what === 3) return ok(o.anm.gans.length)
        const g = o.anm.gans[o.anm.current]
        if (!g) return ok(0)
        if (what === 0) return ok(stepAt(g, o.anm.time) === g.steps.length - 1 ? 1 : 0)
        if (what === 1) return ok(totalTicks(g))
        if (what === 2) return ok(g.steps.length)
        return ok(0)
      }
      case 0x1c7: {
        const stepNo = n(), o = this.obj(n())
        const g = o.anm?.gans[o.anm.current]
        if (g && g.steps.length) {
          const s = ((stepNo % g.steps.length) + g.steps.length) % g.steps.length
          let t = 0
          for (let i = 0; i < s; i++) t += ticks(g.steps[i].duration)
          o.anm!.time = t
        }
        return ok()
      }
      case 0x14c: {
        n()
        this.playSe(n())
        return ok()
      }
      case 0x14d:
        n()
        this.se?.stopVoice1() // the game always keys off voice 1
        return ok()
      case 0x154:
        n()
        vm.pop()
        return ok()
      case 0x157:
        this.stopSound()
        return ok()
      case 0x322:
        vm.store(out(), (this.opts.attackerSide + 1) & 1)
        return ok()
      case 0x323: {
        const z = out(), y = out(), x = out(), side = n()
        const p = sidePos(side, this.opts.attackerSide)
        vm.store(x, p[0])
        vm.store(y, p[1])
        vm.store(z, p[2])
        return ok()
      }
      case 0x384: {
        const loser = out(), winner = out()
        const r = this.opts.map?.result?.() ?? [0, 1]
        vm.store(winner, r[0])
        vm.store(loser, r[1])
        return ok()
      }
      case 0x386: {
        const rz = out(), ry = out(), rx = out()
        vm.store(rx, -65) // g_mapCamRot, set by mapSetupCameraMatrix
        vm.store(ry, 0)
        vm.store(rz, -30)
        return ok()
      }
      case 0x385: {
        const z = out(), y = out(), x = out()
        const p = this.opts.map?.camPos() ?? [0, 0, 0]
        vm.store(x, Math.trunc(p[0]))
        vm.store(y, Math.trunc(p[1]))
        vm.store(z, Math.trunc(p[2]))
        return ok()
      }
      case 0x387:
        n()
        return ok()
      case 0x388:
        this.opts.map?.placeCurUnit()
        return ok()
      case 0x389:
        this.opts.map?.removeCurUnit()
        return ok()
    }
    return undefined
  }

  private objCount() {
    let c = OBJECTS
    while (c > 0 && this.objs[c - 1].type === -1) c--
    return c
  }

  // ---- sound ----

  /** se_play (sndPlaySe): the clip through the SAS voice model (src/audio/sas.ts), next of 20 voices. */
  private playSe(id: number) {
    const clip = this.opts.seClips?.[id - 1]
    this.sounds.push(`frame ${this.frame}: se ${id}${clip ? '' : ' (se.dat not loaded)'}`)
    const ac = this.opts.audio
    if (!this.opts.seClips || !ac) return
    if (!this.se) this.se = new SePlayer(ac, this.opts.seClips, this.opts.seOut ?? ac.destination)
    this.se.play(id)
  }

  // ---- scrObjUpdateTweens ----

  private updateTweens() {
    const count = this.objCount()
    for (let i = 0; i < count; i++) this.objs[i].pushed = [...this.objs[i].rgba]
    for (let i = 0; i < count; i++) {
      const o = this.objs[i]
      if (o.paused || o.type === -1) continue
      if (o.tweenFlags & 1 && o.posSpeed !== 0) {
        o.posTime++
        if (o.posTime > o.posFrames) {
          o.pos = [...o.posTarget]
          o.posSpeed = 0
          o.tweenFlags &= ~1
        } else o.pos = o.posStart.map((s, k) => s + o.posTime * o.posStep[k]) as V3
      }
      if (o.tweenFlags & 8 && o.scaleSpeed !== 0) {
        o.scaleTime++
        if (o.scaleTime > o.scaleFrames) {
          o.scale = [...o.scaleTarget]
          o.scaleSpeed = 0
          o.tweenFlags &= ~8
        } else o.scale = o.scaleStart.map((s, k) => s + o.scaleTime * o.scaleStep[k]) as [number, number]
      }
      if (o.tweenFlags & 4 && o.rotSpeed !== 0) {
        o.rotTime++
        if (o.rotTime > o.rotFrames) {
          o.rot = [...o.rotTarget]
          o.rotSpeed = 0
          o.tweenFlags &= ~4
        } else o.rot = o.rotStart.map((s, k) => s + o.rotTime * o.rotStep[k]) as V3
      }
      if (o.tweenFlags & 2) {
        let changed = false
        for (let ch = 0; ch < 4; ch++) {
          const c = Math.trunc(o.rgba[ch]), T = o.rgbaTarget[ch], s = o.rgbaStep
          if (c < T) {
            o.rgba[ch] = s < T - c ? o.rgba[ch] + s : T
            changed = true
          } else if (c > T) {
            o.rgba[ch] = s < c - T ? o.rgba[ch] - s : T
            changed = true
          }
        }
        if (!changed) o.tweenFlags &= ~2
      }
      if (o.anm) {
        const g = o.anm.gans[o.anm.current]
        if (g) o.anm.time = (o.anm.time + 1) % Math.max(1, totalTicks(g))
      }
    }
  }

  // ---- scrObjRenderAll ----

  /** scrObjRenderAll for camera passes 0 and 6 (the only two any scene draws). */
  render(gl: GlRenderer, passes: number[] = [0, 6]) {
    for (const pass of passes) {
      const list: { o: Obj; key: number; i: number }[] = []
      this.objs.forEach((o, i) => {
        if (!o.visible || o.type === -1 || o.camera !== pass) return
        const key = o.coordMode === 2 ? 32768 : o.coordMode === 4 || o.type === 4 ? -32768 : o.pos[2]
        list.push({ o, key, i })
      })
      list.sort((a, b) => b.key - a.key || a.i - b.i)
      for (const { o } of list) {
        const wp: V3 = this.opts.snap ? [Math.trunc(o.pos[0]), Math.trunc(o.pos[1]), Math.trunc(o.pos[2])] : o.pos
        if (o.type === 1) this.drawSprite(gl, o, wp)
        else if (o.type === 2) this.drawAnm(gl, o, wp)
        else if (o.type === 4) this.drawPoly(gl, o, wp)
      }
    }
  }

  private quad(gl: GlRenderer, cam: Camera, img: RgbaImage, corners: V3[], uv: number[], color: Rgba, blend: BlendMode) {
    const pts = corners.map((c) => project(cam, c))
    if (cam.mode === 0 && pts.some((p) => !(p.z > 0) || Math.abs(p.x) >= 10000 || Math.abs(p.y) >= 10000)) return
    const u0 = uv[0] / img.width, v0 = uv[1] / img.height, u1 = uv[2] / img.width, v1 = uv[3] / img.height
    const V = (k: number, u: number, v: number): Vertex => ({ x: pts[k].x, y: pts[k].y, w: pts[k].z, d: geDepth(cam, pts[k].z), u, v })
    const tl = V(0, u0, v0), tr = V(1, u1, v0), bl = V(2, u0, v1), br = V(3, u1, v1)
    gl.triangles(gl.texture(img), blend, [tl, tr, bl, tr, br, bl], color)
  }

  private drawSprite(gl: GlRenderer, o: Obj, wp: V3) {
    const s = o.sprite!
    const w = s.u1 - s.u0, h = s.v1 - s.v0
    const snap = this.opts.snap ? Math.trunc : (v: number) => v
    const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([cx, cy]) => {
      const c = rotZYX([(cx - s.pivot[0]) * o.scale[0], (cy - s.pivot[1]) * o.scale[1], 0], o.rot[0], o.rot[1], o.rot[2])
      const base = [s.pivot[0], s.pivot[1], 0]
      return [0, 1, 2].map((k) => snap(base[k] + s.offset[k] + snap(c[k])) + wp[k]) as V3
    })
    const col = vertexColor(...o.pushed)
    this.quad(gl, this.cams[s.cam] ?? this.cams[0], s.img, corners, [s.u0, s.v0, s.u1, s.v1], col, s.blend & 1 ? 'add' : 'alpha')
  }

  private sheet(a: Anm, g: Gan, gi: number, image: number, clut: number): RgbaImage {
    const key = `${gi}:${image}:${clut}`
    let img = a.sheets.get(key)
    if (!img) a.sheets.set(key, (img = ganSheet(g, image, g.palettes[clut])))
    return img
  }

  private drawAnm(gl: GlRenderer, o: Obj, wp: V3) {
    const a = o.anm!
    const g = a.gans[a.current]
    if (!g || !g.steps.length) return
    const step = g.steps[stepAt(g, a.time)]
    const parts = g.frames[step.frame] ?? []
    const cam = this.cams[a.cam] ?? this.cams[0]
    const [R, G, B, A] = o.pushed.map((c) => Math.trunc(c) & 0xff)
    const drawPart = (i: number, blendByte: number, clut: number, origin: V3, rot: V3) => {
      const p = parts[i]
      const alpha = (((A * (GAN_BASE_ALPHA[blendByte] ?? 0x7f)) >> 6) & 0xff) >> 1
      const col = vertexColor(R, G, B, alpha)
      if (col[3] <= 0) return
      const pw = p.w / 2, ph = p.h / 2
      const zPart = cam.mode === 0 ? -i : 0
      const corners = [[-pw, -ph], [pw, -ph], [-pw, ph], [pw, ph]].map(([cx, cy]) => {
        let x = cx, y = cy
        if (p.flags & 8) {
          x *= p.scaleX
          y *= p.scaleY
        }
        if (p.flags & 4) {
          const t = (p.angle * Math.PI) / 180
          ;[x, y] = [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)]
        }
        const lx = (p.dx - 128 + pw + x) * o.scale[0]
        const ly = (p.dy - 128 + ph + y) * o.scale[1]
        const v = rotZYX([lx, ly, zPart], rot[0], rot[1], rot[2])
        return [v[0] + origin[0], v[1] + origin[1], v[2] + origin[2]] as V3
      })
      const img = this.sheet(a, g, a.current, p.image, clut)
      this.quad(gl, cam, img, corners, [p.sx, p.sy, p.sx + p.w, p.sy + p.h], col, blendByte & 1 ? 'add' : 'alpha')
    }
    const byteOf = (i: number) => {
      const p = parts[i]
      return a.blend !== null ? a.blend : p.flags & 1 ? (p.flags >> 4) & 3 : 0x10
    }
    const visible = (i: number) => parts[i].w > 0 && parts[i].h > 0 && !isMarker(parts[i])
    // Ground shadow: non-additive parts with image 0's silhouette palette, laid flat.
    if (o.shadow !== HIDDEN) {
      const origin: V3 = [wp[0], -1, wp[2] + wp[1] + o.shadow]
      for (let i = 0; i < parts.length; i++) if (visible(i) && !(byteOf(i) & 1)) drawPart(i, 0x10, 15, origin, [Math.PI / 2, o.rot[1], o.rot[2]])
    }
    for (let i = 0; i < parts.length; i++) if (visible(i)) drawPart(i, byteOf(i), parts[i].clut, wp, o.rot)
  }

  private drawPoly(gl: GlRenderer, o: Obj, wp: V3) {
    const p = o.poly!
    const src = this.objs[p.src]
    const s = src?.sprite
    if (!s) return
    const cam = this.cams[s.cam] ?? this.cams[0]
    const col = vertexColor(...src.pushed)
    const blend: BlendMode = [1, 3].includes(s.blend & 0xf) ? 'add' : 'alpha'
    const verts: Vertex[] = []
    mesh(p.pattern).forEach((tri, t) => {
      const ax = SPIN_AXES[t & 255]
      const spin: V3 = [wrapPi(p.spin * ax[0]), wrapPi(p.spin * ax[1]), wrapPi(p.spin * ax[2])]
      const pts = tri.rel.map((rel, i) => {
        let v = rotZYX(rel, spin[0], spin[1], spin[2])
        if (p.pattern === 0) v = [p.a * (v[0] + p.spread * tri.c[0]), p.h * (v[1] + p.spread * tri.c[1]), p.a * (v[2] + p.spread * tri.c[2])]
        else {
          const sc = (t & 1 ? [p.b, p.a, p.b] : [p.a, p.b, p.a])[i]
          v = [sc * (v[0] + p.spread * tri.c[0]), p.h * (v[1] + tri.c[1]), sc * (v[2] + p.spread * tri.c[2])]
        }
        v = rotZYX(v, o.rot[0], o.rot[1], o.rot[2])
        return project(cam, [v[0] + wp[0], v[1] + wp[1], v[2] + wp[2]])
      })
      if (pts.some((q) => !(q.z > 0))) return
      pts.forEach((q, i) => {
        const [tu, tv] = tri.uv[i]
        verts.push({ x: q.x, y: q.y, w: q.z, d: geDepth(cam, q.z), u: (s.u0 + (s.u1 - s.u0) * tu) / s.img.width, v: (s.v0 + (s.v1 - s.v0) * tv) / s.img.height })
      })
    })
    gl.triangles(gl.texture(s.img), blend, verts, col)
  }

  /** Live objects, for the UI. */
  objectList(): ObjectInfo[] {
    const types: Record<number, string> = { 1: 'sprite', 2: 'anim', 4: 'poly' }
    return this.objs.flatMap((o, i) =>
      o.type === -1 ? [] : [{ index: i, type: types[o.type], visible: o.visible, camera: o.camera, pos: this.fromWorld(o, o.pos), rgba: o.rgba, tweens: o.tweenFlags }],
    )
  }
}

// ---------------------------------------------------------------------------------------------
// GAN timing: 1 tick per frame, looping; a 255 duration holds

export const ticks = (d: number) => (d === 255 ? 0x10000000 : d)

export function totalTicks(g: Gan): number {
  let t = 0
  for (const s of g.steps) t += ticks(s.duration)
  return t
}

export function stepAt(g: Gan, time: number): number {
  let t = 0
  for (let i = 0; i < g.steps.length; i++) {
    t += ticks(g.steps[i].duration)
    if (time < t) return i
  }
  return Math.max(0, g.steps.length - 1)
}

/** battleSetupCombatantFacing at the two attack angles. */
function sidePos(side: number, attacker: number): V3 {
  if (attacker === 0) return side === 0 ? [-40, 32, 0] : [40, -16, 16]
  return side === 0 ? [-40, -16, 16] : [40, 32, 0]
}
