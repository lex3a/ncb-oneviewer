/**
 * PSP pad input for Play mode: keyboard and Gamepad API → PSP button bits, then a port of the game's
 * padUpdate (0x08884D74) for the held / pressed / repeat words that padGetHeld / padGetPressed /
 * padGetRepeat return. See docs/formats/play-mode.md#input.
 */

/** PSP_CTRL_* bits (the game's masks). */
export const PAD = {
  SELECT: 0x1,
  START: 0x8,
  UP: 0x10,
  RIGHT: 0x20,
  DOWN: 0x40,
  LEFT: 0x80,
  L: 0x100,
  R: 0x200,
  TRIANGLE: 0x1000,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
  SQUARE: 0x8000,
  /** Not a PSP button: a left click on the screen (viewer convenience; advances dialogue like ✕). */
  POINTER: 0x40000000,
  /** Not a PSP button: the Backspace key (viewer convenience; name entry reads it as □ Delete). */
  BACKSPACE: 0x20000000,
  /** Not a PSP button: a middle click on the screen (viewer convenience; skips dialogue like START). */
  POINTER_MIDDLE: 0x10000000,
  /** Not a PSP button: set together with ○ by a right click, so a scene can read the right click as another button. */
  POINTER_RIGHT: 0x08000000,
} as const

export const PAD_DPAD = PAD.UP | PAD.RIGHT | PAD.DOWN | PAD.LEFT

/**
 * Keyboard mapping by KeyboardEvent.code (layout independent), consistent with the viewer's views:
 * arrows = D-pad, X / Enter = ✕, O / Esc = ○, T = △, S = □, Q / E = L / R, P / Space = START, Tab = SELECT.
 */
export const KEY_MAP: Record<string, number> = {
  ArrowUp: PAD.UP,
  ArrowDown: PAD.DOWN,
  ArrowLeft: PAD.LEFT,
  ArrowRight: PAD.RIGHT,
  KeyX: PAD.CROSS,
  Enter: PAD.CROSS,
  NumpadEnter: PAD.CROSS,
  KeyO: PAD.CIRCLE,
  Escape: PAD.CIRCLE,
  KeyT: PAD.TRIANGLE,
  KeyS: PAD.SQUARE,
  KeyQ: PAD.L,
  KeyE: PAD.R,
  KeyP: PAD.START,
  Space: PAD.START,
  Tab: PAD.SELECT,
  Backspace: PAD.BACKSPACE,
}

/** Gamepad API "standard" mapping: button index → PSP bit (A = ✕, B = ○, X = □, Y = △ like the PSP layout). */
export const GAMEPAD_MAP: Record<number, number> = {
  0: PAD.CROSS,
  1: PAD.CIRCLE,
  2: PAD.SQUARE,
  3: PAD.TRIANGLE,
  4: PAD.L,
  5: PAD.R,
  6: PAD.L,
  7: PAD.R,
  8: PAD.SELECT,
  9: PAD.START,
  12: PAD.UP,
  13: PAD.DOWN,
  14: PAD.LEFT,
  15: PAD.RIGHT,
}

/** padUpdate maps the analog stick to the D-pad beyond 0x40 / 0xC0 (of 0..255, centre 0x80): ±0.5 here. */
const STICK = 0.5

export class PadInput {
  /** padGetHeld: buttons down this frame. */
  held = 0
  /** padGetPressed: buttons that went down this frame (held & ~previous). */
  pressed = 0
  /** padGetRepeat: the held word on the first frame and then every `delay` frames (16, 15, … down to 4). */
  repeat = 0
  /** Previous held word (pad state +0x54). */
  private prev = 0
  /** Repeat countdown and the next delay (pad state +0x00 / +0x04). */
  private timer = 0
  private delay = 0
  private keys = new Set<string>()
  /** Keys that went down since the last sample: a tap shorter than a frame still counts for one frame. */
  private latched = 0
  /** Bits forced by the debug overlay or automated tests (held while set). */
  virtual = 0
  /** Bits pressed for exactly one frame (tests: `tap`). */
  private taps: number[] = []
  /** Gamepad in use (for the debug overlay). */
  gamepad = ''
  /** Mouse position in the game's 640×448 virtual space (-1 when outside the screen). Viewer convenience. */
  pointerX = -1
  pointerY = -1
  /** The mouse moved over the screen since the last frame (for hover selection). */
  pointerMoved = false
  private movedLatch = false

  /** Keyboard listeners on `target`; returns the detach function. `onOther` sees the unmapped keys. */
  attach(target: Window, onOther?: (e: KeyboardEvent) => void): () => void {
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const bit = KEY_MAP[e.code]
      if (bit === undefined) {
        onOther?.(e)
        return
      }
      // inputs and selects of the toolbar keep their keys
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      e.preventDefault()
      this.keys.add(e.code)
      this.latched |= bit
    }
    const up = (e: KeyboardEvent) => {
      if (KEY_MAP[e.code] === undefined) return
      e.preventDefault()
      this.keys.delete(e.code)
    }
    const blur = () => this.keys.clear()
    target.addEventListener('keydown', down)
    target.addEventListener('keyup', up)
    target.addEventListener('blur', blur)
    return () => {
      target.removeEventListener('keydown', down)
      target.removeEventListener('keyup', up)
      target.removeEventListener('blur', blur)
      this.keys.clear()
    }
  }

  /** Mouse moved to (x, y) in virtual 640×448 coordinates; null when it left the screen. */
  point(x: number | null, y = -1) {
    this.pointerX = x ?? -1
    this.pointerY = x === null ? -1 : y
    if (x !== null) this.movedLatch = true
  }

  /** A left click on the screen at (x, y) virtual: PAD.POINTER for one frame. */
  click(x?: number, y?: number) {
    if (x !== undefined && y !== undefined) this.point(x, y)
    this.latched |= PAD.POINTER
  }

  /** A right click on the screen: ○ for one frame (viewer convenience). */
  rightClick() {
    this.latched |= PAD.CIRCLE | PAD.POINTER_RIGHT
  }

  private wheelAcc = 0

  /** The mouse wheel over the screen (viewer convenience): ↑ / ↓ for one frame per notch (100 px, or a line / page event). */
  wheel(deltaY: number, deltaMode = 0) {
    if (deltaMode !== 0) deltaY = Math.sign(deltaY) * 100
    if (Math.sign(deltaY) !== Math.sign(this.wheelAcc)) this.wheelAcc = 0
    this.wheelAcc += deltaY
    if (Math.abs(this.wheelAcc) < 50) return
    this.latched |= this.wheelAcc > 0 ? PAD.DOWN : PAD.UP
    this.wheelAcc = 0
  }

  /** A middle click on the screen: PAD.POINTER_MIDDLE for one frame. */
  middleClick() {
    this.latched |= PAD.POINTER_MIDDLE
  }

  /** The pointer is inside the virtual rect x0 ≤ x < x1, y0 ≤ y < y1. */
  pointerIn(x0: number, y0: number, x1: number, y1: number): boolean {
    return this.pointerX >= x0 && this.pointerX < x1 && this.pointerY >= y0 && this.pointerY < y1
  }

  /** Press `bits` for one frame (automation / debug). */
  tap(bits: number) {
    this.taps.push(bits)
  }

  /** The raw button word: keyboard | first connected gamepad | virtual bits. */
  private sample(): number {
    let b = this.virtual | this.latched
    this.latched = 0
    for (const k of this.keys) b |= KEY_MAP[k] ?? 0
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
    this.gamepad = ''
    for (const gp of pads) {
      if (!gp || !gp.connected) continue
      this.gamepad = gp.id
      gp.buttons.forEach((btn, i) => {
        if (btn.pressed) b |= GAMEPAD_MAP[i] ?? 0
      })
      const [x = 0, y = 0] = gp.axes
      if (x > STICK) b |= PAD.RIGHT
      if (x < -STICK) b |= PAD.LEFT
      if (y > STICK) b |= PAD.DOWN
      if (y < -STICK) b |= PAD.UP
      break
    }
    const tap = this.taps.shift()
    if (tap) b |= tap
    return b
  }

  /**
   * padUpdate: sample, pressed = held & ~prev; the repeat timer restarts (1 frame, then 16) whenever
   * no button stays held from the last frame; when it runs out, repeat = held and the next delay is
   * one frame shorter, down to 4. So a held D-pad repeats after 16, 15, 14 … frames, then every 4.
   */
  update() {
    this.pointerMoved = this.movedLatch
    this.movedLatch = false
    const held = this.sample()
    this.held = held
    this.pressed = held & ~this.prev
    if ((held & this.prev) === 0) {
      this.timer = 1
      this.delay = 0x10
    }
    this.timer--
    if (this.timer < 1) {
      this.repeat = held
      this.timer = this.delay
      this.delay--
      if (this.delay < 4) this.delay = 4
    } else this.repeat = 0
    this.prev = held
  }

  /** Writes the repeat countdown and next delay (winUpdateInput's wrap-around sets 0x10 / 8). */
  setRepeat(timer: number, delay: number) {
    this.timer = timer
    this.delay = delay
  }

  reset() {
    this.keys.clear()
    this.latched = 0
    this.held = this.pressed = this.repeat = this.prev = 0
    this.timer = this.delay = 0
  }
}

export function padNames(bits: number): string {
  const n: string[] = []
  const names: [number, string][] = [
    [PAD.UP, '↑'],
    [PAD.DOWN, '↓'],
    [PAD.LEFT, '←'],
    [PAD.RIGHT, '→'],
    [PAD.CROSS, '✕'],
    [PAD.CIRCLE, '○'],
    [PAD.TRIANGLE, '△'],
    [PAD.SQUARE, '□'],
    [PAD.L, 'L'],
    [PAD.R, 'R'],
    [PAD.START, 'START'],
    [PAD.SELECT, 'SELECT'],
  ]
  for (const [b, s] of names) if (bits & b) n.push(s)
  return n.join(' ')
}
