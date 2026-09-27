/**
 * Story event player: a port of msgEventUpdate (0x08849E74) and msgEventDraw (0x0884AAFC). Plays one
 * script of g_apMsgEventTables with its windows, faces, backgrounds, CGs and goc.dat voices. See
 * docs/formats/story.md.
 */
import { SAS_RATE, WAVE_FADE_SAMPLES } from '../audio/sas'
import type { GameDb, StoryRecord, StoryScript } from '../formats/gamedb'
import { gbpToImage, parseGbp } from '../formats/gbp'
import type { OneArchive } from '../formats/one'
import type { RgbaImage } from '../formats/palette'
import { decodeVag, type VagClip } from '../formats/vag'
import type { GlRenderer, Vertex } from './gl'
import { loadWinSkins, readWinTables, typingDone, WindowPainter, type DuelWindow } from './windows'

export interface StoryOptions {
  archives: OneArchive[]
  db: GameDb
  font: Uint8Array | null
  voices?: VagClip[] | null
  audio?: AudioContext | null
  /** Where the voices go (Play mode: the voice bus of the AudioManager); default the context's destination. */
  voiceOut?: AudioNode
  /** Advance speaker lines by themselves, this many frames after text and voice are done. */
  autoDelay: number | null
}

interface Win extends DuelWindow {
  tx: number
  ty: number
  closing: boolean
}

/** Window slots of g_msgEventCtx: 0/1 text, 2 narrator, 4/6 name plates, 5/7 face panels. */
const TEXT = [0, 1], NAME = [4, 6], FACE = [5, 7], NARRATOR = 2
const VOICE_LOCK = 30
const BG_W = 640, BG_H = 448
/**
 * GE depth of the background, CG and windows: msgEventDrawBg / msgEventDrawCg call spriteDraw with z 0
 * and the windows use depth 0 too, i.e. GE z 0x7FFF for all of them. Hosts with the GE depth test on
 * (GEQUAL, e.g. the map board after its gfxClearDepth) then let the windows pass over the picture;
 * with a different depth for the picture the windows would vanish behind it.
 */
const Z = 0x7fff / 65535

export class StoryPlayer {
  readonly script: StoryScript
  frame = 0
  index = 0
  finished = false
  /** Lines shown so far, for the transcript. */
  shown: number[] = []
  bgm: string | null = null
  private opts: StoryOptions
  private painter: WindowPainter
  private wins: (Win | null)[] = Array(8).fill(null)
  private order: number[] = []
  private first = true
  private timer = 0
  private autoCnt = 0
  private holdCnt = 0
  private readyFor = 0
  private pressed = false
  private bg = { slots: [] as number[], cur: 0, alpha: 0, scroll: null as null | { y: number; target: number; t: number } }
  private cg = { slots: [] as number[], cur: 0, alpha: 0 }
  private voiceEnd = 0
  private voiceLock = 0
  private voiceNode: AudioBufferSourceNode | null = null
  private voiceGain: GainNode | null = null
  private images = new Map<string, RgbaImage | null>()

  constructor(script: StoryScript, opts: StoryOptions) {
    this.script = script
    this.opts = opts
    this.painter = new WindowPainter({ skins: loadWinSkins((a, e, m) => this.image(a, e, m)), font: opts.font, tables: readWinTables(opts.db) })
  }

  private image(archive: string, entry: number, member: number): RgbaImage | null {
    const key = `${archive}:${entry}:${member}`
    if (this.images.has(key)) return this.images.get(key)!
    const a = this.opts.archives.find((x) => x.name.toLowerCase() === archive)
    const f = a?.entries.find((e) => e.id === entry)?.files.find((x) => x.subId === member)
    const img = f?.data.length ? gbpToImage(parseGbp(f.data)) : null
    this.images.set(key, img)
    return img
  }

  get record(): StoryRecord | undefined {
    return this.script.records[this.index]
  }

  setAudio(ac: AudioContext | null) {
    if (!ac) this.stopVoice()
    this.opts.audio = ac
  }

  /** ✕: finish typing, stop a playing voice (after its 30-frame lock), or go to the next line. */
  press() {
    this.pressed = true
  }

  /** START: jump to the end of the script (the next cmd 21 or 8). */
  skip() {
    const i = this.script.records.findIndex((r, k) => k > this.index && (r.cmd === 21 || r.cmd === 8))
    this.stopVoice()
    this.index = i < 0 ? this.script.records.length : i
    this.first = true
  }

  // ---- voice ----

  private playVoice(id: number) {
    this.stopVoice()
    const clip = this.opts.voices?.[id - 1]
    this.voiceLock = this.frame + VOICE_LOCK
    if (!clip) return
    const s = decodeVag(clip.data).samples
    this.voiceEnd = this.frame + Math.ceil((s.length / clip.rate) * 60)
    const ac = this.opts.audio
    if (!ac) return
    const buf = ac.createBuffer(1, Math.max(1, s.length), clip.rate)
    const ch = buf.getChannelData(0)
    for (let i = 0; i < s.length; i++) ch[i] = s[i] / 32768
    const node = ac.createBufferSource()
    node.buffer = buf
    // libwave channel 0 at sceWavePlay volume 0x7F (unity), no resampling (the clips are 44.1 kHz)
    const gain = ac.createGain()
    node.connect(gain).connect(this.opts.voiceOut ?? ac.destination)
    node.start()
    this.voiceNode = node
    this.voiceGain = gain
  }

  /** sndStopVoice → sceWaveStop: libwave fades the channel out over 0x70 samples, then stops it. */
  stopVoice() {
    const node = this.voiceNode
    const gain = this.voiceGain
    if (node && gain) {
      const ac = gain.context
      const t = ac.currentTime
      const fade = WAVE_FADE_SAMPLES / SAS_RATE
      gain.gain.setValueAtTime(1, t)
      gain.gain.linearRampToValueAtTime(0, t + fade)
      try {
        node.stop(t + fade)
      } catch {
        // already stopped
      }
    }
    this.voiceNode = null
    this.voiceGain = null
    this.voiceEnd = Math.min(this.voiceEnd, this.frame)
  }

  // ---- windows ----

  private open(slot: number, w: Win) {
    this.wins[slot] = w
    this.order = [...this.order.filter((s) => s !== slot), slot]
  }

  private close(slots: number[]) {
    for (const s of slots) if (this.wins[s]) this.wins[s]!.closing = true
    return slots.every((s) => !this.wins[s])
  }

  /** msgEventShowText / msgEventOpenWindows. */
  private showText(r: StoryRecord) {
    const voiceLead = r.voice ? 1 : 0
    const turn = this.script.trigger === 'turnStart'
    if (r.arg === 0) {
      const w = this.wins[NARRATOR]
      const base = { codes: r.codes, opened: this.frame, glyph: 22, typeDelay: 4, typeLead: voiceLead }
      if (w && !w.closing) Object.assign(w, base)
      else this.open(NARRATOR, { x: 0, y: 318, w: 640, h: 130, tx: 0, ty: 318, style: 1, textX: 100, alpha: 128, closing: false, ...base })
    } else {
      const s = r.side ? 1 : 0
      const face = this.image('chara.one', r.arg, Math.max(1, r.arg2))
      const t = this.wins[TEXT[s]]
      if (!t || t.closing) {
        const name = this.opts.db.byId.get(r.arg)?.nameCodes ?? []
        // [start x, start y, target x, target y] per window (modes 0–8; turn events use side 0 only).
        const g = turn
          ? { text: [224, 324, 160, 342], name: [224, 274, 160, 288], face: [-64, 288, 0, 288] }
          : s === 0
            ? { text: [232, 18, 168, 82], name: [232, -32, 168, 32], face: [-56, 32, 8, 32] }
            : { text: [-56, 370, 8, 306], name: [217, 320, 281, 256], face: [536, 256, 472, 256] }
        const mk = (p: number[], w: number, h: number, extra: Partial<Win>): Win => ({ x: p[0], y: p[1], tx: p[2], ty: p[3], w, h, codes: [], opened: this.frame, closing: false, glyph: 22, ...extra })
        this.open(TEXT[s], mk(g.text, 464, 110, { alpha: 128, codes: r.codes, typeDelay: 4, typeLead: voiceLead }))
        this.open(NAME[s], mk(g.name, 191, 50, { alpha: 0, codes: name }))
        this.open(FACE[s], mk(g.face, 160, 160, { alpha: 0, chamfer: 16, face, faceOpened: this.frame }))
      } else {
        Object.assign(t, { codes: r.codes, opened: this.frame, typeDelay: 4, typeLead: voiceLead })
        const f = this.wins[FACE[s]]
        if (f) f.face = face
        this.order = [...this.order.filter((x) => x !== TEXT[s]), TEXT[s]]
      }
    }
    if (r.voice) this.playVoice(r.voice)
    else this.voiceLock = this.frame
    this.shown.push(this.index)
  }

  private textWin(r: StoryRecord): Win | null {
    return r.arg === 0 ? this.wins[NARRATOR] : this.wins[TEXT[r.side ? 1 : 0]]
  }

  // ---- frame ----

  /** One 60 Hz frame: the current command, then window motion, fades and the background scroll. */
  step() {
    if (this.finished) return
    const r = this.record
    let done = false
    if (!r) {
      done = this.endScript()
    } else {
      const first = this.first
      this.first = false
      switch (r.cmd) {
        case 0: {
          if (first) this.showText(r)
          const w = this.textWin(r)
          const ready = !w || (typingDone(w) <= this.frame && this.frame >= this.voiceEnd)
          if (this.timer > 0) done = ready && ++this.autoCnt >= this.timer
          else {
            if (this.pressed && w) {
              if (typingDone(w) > this.frame) Object.assign(w, { typeDelay: 0, opened: this.frame })
              else if (this.frame < this.voiceEnd) {
                if (this.frame >= this.voiceLock) this.stopVoice()
              } else done = true
            }
            if (ready) this.readyFor++
            else this.readyFor = 0
            if (this.opts.autoDelay !== null && this.readyFor >= this.opts.autoDelay) done = true
            if (w) w.arrow = ready
          }
          if (done) {
            this.stopVoice()
            if (w) w.arrow = false
          }
          break
        }
        case 2:
          done = this.close(r.arg === 0 ? [NARRATOR] : [TEXT[r.side ? 1 : 0], NAME[r.side ? 1 : 0], FACE[r.side ? 1 : 0]])
          break
        case 3:
          if (this.bg.slots.includes(r.arg)) this.bg.cur = r.arg
          if (this.pressed) {
            if (this.bg.alpha < 128) this.bg.alpha = 128
            else done = true
          } else if (this.bg.alpha < 128) this.bg.alpha++
          else done = ++this.holdCnt > 60
          break
        case 4:
          this.bg.alpha = this.pressed ? 0 : Math.max(0, this.bg.alpha - 2)
          if (this.bg.alpha === 0) {
            this.bg.cur = 0
            done = true
          }
          break
        case 6:
          this.cg.alpha = this.pressed ? 0 : Math.max(0, this.cg.alpha - 2)
          if (this.cg.alpha === 0) {
            this.cg.cur = 0
            done = true
          }
          break
        case 7:
          done = this.close([0, 1, 2, 4, 5, 6, 7])
          break
        case 8:
          done = this.endScript()
          break
        case 12:
          if (r.arg > 0 && this.cg.slots.length < 4) this.cg.slots.push(r.arg)
          done = true
          break
        case 14:
          if (r.arg > 0 && this.bg.slots.length < 4) this.bg.slots.push(r.arg)
          done = true
          break
        case 16:
          this.bg = { slots: [], cur: 0, alpha: 0, scroll: null }
          this.cg = { slots: [], cur: 0, alpha: 0 }
          done = true
          break
        case 17:
          this.bg.scroll = { y: 0, target: -(this.bg.slots.length - 1) * 272, t: 0 }
          done = true
          break
        case 18:
          this.timer = r.arg
          done = true
          break
        case 20:
          if (first) {
            this.cg.cur = this.cg.slots.includes(r.arg) ? r.arg : 0
            this.cg.alpha = 0
          }
          if (this.pressed) {
            if (this.cg.alpha < 128) this.cg.alpha = 128
            else done = true
          } else if (this.cg.alpha < 128) this.cg.alpha++
          else done = ++this.holdCnt > 60
          break
        case 21:
          done = this.frame >= this.voiceLock
          if (done) this.stopVoice()
          break
        case 22:
          this.bgm = `BGM_${String(r.arg + 1).padStart(2, '0')}.at3`
          done = true
          break
        case 23:
          this.bgm = null
          done = true
          break
        default:
          done = true
      }
    }
    this.pressed = false
    if (done && !this.finished) {
      this.index++
      this.first = true
      this.autoCnt = this.holdCnt = this.readyFor = 0
    }
    this.updateWindows()
    const sc = this.bg.scroll
    if (sc && ++sc.t % 7 === 0 && sc.y > sc.target) sc.y--
    this.frame++
  }

  /** cmd 8: close everything, then free the pictures and stop the voice. */
  private endScript(): boolean {
    if (!this.close([0, 1, 2, 4, 5, 6, 7])) return false
    this.stopVoice()
    this.finished = true
    return true
  }

  /** winApproachPos (/8), alpha +8, closing −10, and the dimming of the side that is not speaking. */
  private updateWindows() {
    const front = [...this.order].reverse().find((s) => s === TEXT[0] || s === TEXT[1])
    this.wins.forEach((w, slot) => {
      if (!w) return
      if (w.closing) {
        w.alpha = (w.alpha ?? 128) - 10
        if (w.alpha < 0) {
          this.wins[slot] = null
          this.order = this.order.filter((s) => s !== slot)
        }
        return
      }
      w.x -= (w.x - w.tx) / 8
      w.y -= (w.y - w.ty) / 8
      w.alpha = Math.min(128, (w.alpha ?? 128) + 8)
      if (TEXT.includes(slot)) {
        const b = w.bright ?? 128
        w.bright = slot === front ? Math.min(128, b + 8) : Math.max(0x38, b - 8)
      }
    })
    for (const s of [0, 1]) {
      const t = this.wins[TEXT[s]]
      for (const slot of [NAME[s], FACE[s]]) {
        const w = this.wins[slot]
        if (w && t) w.bright = t.bright
      }
    }
  }

  // ---- drawing ----

  /** msgEventDraw: background, CG, then the windows (`part` draws only one of the two layers, for hosts with windows of their own). */
  render(gl: GlRenderer, part: 'all' | 'back' | 'windows' = 'all') {
    if (part === 'windows') {
      for (const s of this.order) {
        const w = this.wins[s]
        if (w) this.painter.draw(gl, w, this.frame)
      }
      return
    }
    const full = (img: RgbaImage, y: number, a: number) => {
      const V = (x: number, yy: number, u: number, v: number): Vertex => ({ x, y: yy, w: 1, d: Z, u, v })
      gl.triangles(gl.texture(img), 'alpha', [V(0, y, 0, 0), V(BG_W, y, 1, 0), V(0, y + BG_H, 0, 1), V(BG_W, y, 1, 0), V(BG_W, y + BG_H, 1, 1), V(0, y + BG_H, 0, 1)], [1, 1, 1, a])
    }
    const alpha = (a: number) => ((((Math.max(0, Math.min(128, a)) * 255) >> 7) >> 4) * 17) / 255
    // Every frame starts black (guClear); the prologue, the result-screen events and the stage clear draw
    // nothing else underneath, stage-start and turn events draw the map board (not reproduced here).
    // Background (chara.one 2000): native 480×272 at (0,0); scroll mode stacks the loaded slots.
    if (this.bg.cur && this.bg.alpha > 0) {
      const a = alpha(this.bg.alpha)
      const sc = this.bg.scroll
      const start = Math.max(0, this.bg.slots.indexOf(this.bg.cur))
      const list = sc ? this.bg.slots.slice(start) : [this.bg.cur]
      list.forEach((m, k) => {
        const img = this.image('chara.one', 2000, m)
        if (img) full(img, ((sc?.y ?? 0) + k * 272) * (BG_H / 272), a)
      })
    }
    // CG (chara.one 3000): native, centred at (240, 136).
    if (this.cg.cur && this.cg.alpha > 0) {
      const img = this.image('chara.one', 3000, this.cg.cur)
      if (img) {
        const w = (img.width * 640) / 480, h = (img.height * 448) / 272
        const x0 = 320 - w / 2, y0 = 224 - h / 2
        const V = (x: number, y: number, u: number, v: number): Vertex => ({ x, y, w: 1, d: Z, u, v })
        gl.triangles(gl.texture(img), 'alpha', [V(x0, y0, 0, 0), V(x0 + w, y0, 1, 0), V(x0, y0 + h, 0, 1), V(x0 + w, y0, 1, 0), V(x0 + w, y0 + h, 1, 1), V(x0, y0 + h, 0, 1)], [1, 1, 1, alpha(this.cg.alpha)])
      }
    }
    if (part === 'back') return
    for (const s of this.order) {
      const w = this.wins[s]
      if (w) this.painter.draw(gl, w, this.frame)
    }
  }
}

/** Human-readable name of a script. */
export function storyTitle(s: StoryScript, db: GameDb): string {
  const name = (id: number) => db.byId.get(id)?.name ?? `#${id}`
  const stage = (n: number) => {
    const m = db.maps.find((x) => x.stage === n)
    return `stage ${n}${m ? ` · vs ${name(m.opponent)}` : n === 18 ? ` · vs ${name(1021)}` : ''}`
  }
  switch (s.trigger) {
    case 'prologue':
      return 'Prologue'
    case 'stageStart':
      return `Before the battle, ${stage(s.key)}`
    case 'afterWin':
      return `After a win, ${stage(s.key)}`
    case 'afterLoss':
      return `After a loss, ${stage(s.key)}`
    case 'stageClear':
      return `Stage clear, ${stage(s.key)}${s.key === 16 ? ' (unreachable)' : ''}`
    case 'turnStart':
      return `${name(s.dominator ?? 0)}'s turn, round ${s.key}`
  }
}
