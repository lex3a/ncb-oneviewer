/**
 * deckEditScene (0x140), cardListScene (0x14A) and rulesHelpScene (400) of Play mode, on the shared
 * profile: the collection is PlayerProfile.cardCount / cardNewFlags, the decks g_playerDecks, the
 * slot PlayerProfile.curDeckSlot. A saved deck is written back into the profile.
 */
import { tabAt, type CardScreenState } from '../../effect/cardScreen'
import { DeckEditorRenderer, DeckEditorSim, MODE_DECK, MODE_LIST, type Collection } from '../../effect/deckEditor'
import { RulesHelpScene } from '../../effect/extras'
import type { Scene, SceneContext } from '../game'
import { GameScene, type GameSceneId } from '../gameScene'
import { PAD } from '../input'
import { NameEntry } from '../nameEntry'
import { decodeName, PLAYER_DOMINATOR } from '../profile'
import type { GameState } from '../state'
import { BGM } from '../state'

function collectionOf(state: GameState): Collection {
  const p = state.profile
  return {
    owned: Array.from(p.cardCount),
    newFlags: Array.from(p.cardNewFlags),
    decks: state.decks.map((d) => ({ name: d.name, dominator: d.cards[0] || PLAYER_DOMINATOR, cards: Array.from(d.cards.subarray(1)) })),
    slot: p.curDeckSlot || state.firstDeckSlot(),
  }
}

function writeBack(state: GameState, col: Collection) {
  col.decks.forEach((d, i) => {
    const deck = state.decks[i]
    if (!deck) return
    if (d.nameRaw) deck.nameRaw = d.nameRaw
    deck.name = d.name
    deck.cards.fill(0)
    const empty = !d.name && !d.cards.some((c) => c > 0)
    deck.cards[0] = empty ? 0 : d.dominator || PLAYER_DOMINATOR
    d.cards.slice(0, 30).forEach((c, k) => (deck.cards[k + 1] = c))
  })
  col.newFlags.forEach((f, i) => {
    if (i < state.profile.cardNewFlags.length) state.profile.cardNewFlags[i] = f
  })
}

export class CollectionScene implements Scene {
  readonly id: GameSceneId
  private mode: number
  private sim: DeckEditorSim | null = null
  private renderer: DeckEditorRenderer | null = null
  /** The name-entry keyboard of a new deck (deckEditScene state 9). */
  private entry: NameEntry | null = null
  private entered: Uint8Array | null = null

  constructor(id: GameSceneId) {
    this.id = id
    this.mode = id === GameScene.DECK_EDIT ? MODE_DECK : MODE_LIST
  }

  init(ctx: SceneContext) {
    const { state, assets, audio } = ctx
    const a = assets
    this.sim = new DeckEditorSim(state.db, a.deckTables, collectionOf(state), this.mode)
    this.sim.externalNameEntry = true
    this.entry = null
    this.renderer = new DeckEditorRenderer(
      {
        // deckEditScene loads etc.one 300/1, cardListScene 300/7
        frame: a.image('etc.one', 300, this.mode === MODE_DECK ? 1 : 7),
        tabs: a.image('etc.one', 300, 5),
        digits: a.image('etc.one', 2, 1),
        hand: a.image('etc.one', 2, 2),
        badge: a.image('etc.one', 2, 3),
        ui: a.image('etc.one', 2, 4),
        cardPic: (id) => a.image('card.one', 10000, id || 1000),
        font: a.font,
        fontPalettes: a.winTables.fontPalettes,
      },
      a.deckTables,
      a.painter,
    )
    audio.playBgm(BGM.camp)
  }

  update(ctx: SceneContext): GameSceneId {
    const sim = this.sim!
    if (sim.state === 9) {
      // DES_NAME_ENTRY: nameEntryUpdate(1) gets the pad; the editor's own windows keep updating
      sim.frame(0, 0)
      const ne = this.entry!
      const r = ne.update(ctx.input.pressed, ctx.input.repeat, ctx.audio, ctx.input)
      if (ne.result) {
        // sprintf(&g_playerDecks[slot].name, "%s", name)
        const b = new Uint8Array(24)
        b.set(ne.result.subarray(0, 23))
        this.entered = b
        ne.result = null
      }
      ne.wins.tick()
      if (r === 1 || r === -1) {
        const b = this.entered
        sim.nameEntered(r === 1 && b ? decodeName(b, 0) : null, b ?? undefined)
        this.entry = null
        this.entered = null
      }
      return this.id
    }
    this.mouse(ctx)
    sim.frame(ctx.input.pressed, ctx.input.repeat)
    if (sim.state === 9 && sim.events.includes('nameEntry')) {
      // nameEntryInit(&g_playerDecks[slot], ""): the keyboard in deck-name mode
      const ne = new NameEntry(ctx.state.db, ctx.assets.winTables)
      ne.mode = 1
      ne.init(new Uint8Array(0))
      this.entry = ne
    }
    for (const id of sim.se) ctx.audio.playSe(id)
    let exit = false
    for (const e of sim.events) {
      if (e === 'saved') writeBack(ctx.state, sim.col)
      if (e === 'exit') exit = true
    }
    if (exit) {
      // the scene's exit keeps the NEW / Get flags the viewer cleared
      writeBack(ctx.state, sim.col)
      return GameScene.CAMP
    }
    return this.id
  }

  /**
   * Mouse (Play mode, ours), before the editor's frame: help labels (hover bar, a click presses the
   * button); on the grids hovering a card moves the cursor there (SE 1) and a click is ✕; the Deck /
   * Album tabs are □, the filter arrows L / R; with the count popup a click is ✕; in the card info a
   * click on a tab selects it. The keyboard of state 9 reads the mouse itself.
   */
  private mouse(ctx: SceneContext) {
    const sim = this.sim!, r = this.renderer!
    const input = ctx.input
    r.hover = null
    const x = input.pointerX, y = input.pointerY
    if (x < 0) return
    const click = (input.pressed & PAD.POINTER) !== 0
    const press = (bit: number) => (input.pressed = (input.pressed & ~PAD.POINTER) | bit)
    const z = r.helpZones(sim).find((q) => x >= q.x0 && x < q.x1 && y >= q.y0 && y < q.y1)
    if (z) {
      r.hover = z
      if (click) press(z.bit)
      return
    }
    const deck = this.mode === MODE_DECK
    const s = sim.state
    if (s === 6 || s === 7) {
      if (click && sim.infoState === 2) {
        const card = sim.shownCard
        const allowed = card < 2000 ? 0xd : 5
        const t = tabAt(ctx.assets.cardScreenTables, card, 3, x * 0.75, (y * 272) / 448)
        if (t & allowed && t !== sim.infoTab) {
          sim.infoTab = t
          ctx.audio.playSe(1)
        }
        input.pressed &= ~PAD.POINTER
      }
      return
    }
    if (deck && (s === 3 || s === 5)) {
      // the count popup: ↑ / ↓ (or the wheel) set the count, a click accepts it
      if (click) press(PAD.CROSS)
      return
    }
    const grid = deck ? s === 2 || s === 4 : s === 4
    if (!grid) return
    if (deck && click) {
      // the Deck / Album tabs (etc.one 300/5 at half size) switch the view like □
      const other = s === 2 ? [0x50, 0x90] : [0x10, 0x50]
      if (x >= other[0] && x < other[1] && y < 0x40) return void press(PAD.SQUARE)
      if (s === 4) {
        // the filter's side arrows (uiDrawSideArrows(0x219, 0x20, 0, 0x50, 3)) and label
        if (y >= 5 && y < 0x3b && x >= 0x1c8 && x < 0x1f5) return void press(PAD.L)
        if (y >= 5 && y < 0x3b && x >= 0x1f5 && x < 0x268) return void press(PAD.R)
      }
    }
    if (!click && !input.pointerMoved) return
    const cell = r.cellAt(sim, x, y)
    if (!cell) return
    if (sim.view === 1) {
      if (cell.row > 6) return
    } else if (deck) {
      if (sim.gridPosToCardNo(cell.col + cell.row * 10, sim.filter) === 0) return
    } else if (cell.col + cell.row * 10 > 0xcd) return
    if (cell.col !== sim.cursorCol || cell.row !== sim.cursorRow) {
      sim.cursorCol = cell.col
      sim.cursorRow = cell.row
      ctx.audio.playSe(1)
    }
    if (click) press(PAD.CROSS)
  }

  draw(ctx: SceneContext) {
    const sim = this.sim!
    const gl = ctx.screen.use('wide')
    // the keyboard's windows over the editor (the same window list in the game: opened last, drawn last)
    const entry = this.entry
    const info = this.renderer!.draw(gl, sim, ctx.state.db, ctx.ui, entry ? (g) => entry.wins.draw(g, ctx.assets.painter) : undefined)
    const card = info ? ctx.state.db.byId.get(info) : undefined
    if (!card) return
    const g = ctx.screen.overlay2d()
    const st: CardScreenState = { card, mode: 3, tab: sim.infoTab, cursor: -1, base: [card.ap, card.hp, card.range, card.move, card.attribute], eff: [0, 0, 0, 0, 0], showDf: false, attachments: [] }
    const cs = ctx.assets.cardScreen(card.id)
    cs.smooth = ctx.screen.smooth
    cs.draw(g, st, ctx.cardClock, false)
  }

  exit() {}

  debug() {
    const s = this.sim
    return s ? `deck editor state ${s.state} · view ${s.view} · cursor ${s.cursorCol},${s.cursorRow} · slot ${s.slot}` : ''
  }
}

/** Scene 400: rulesHelpScene + menuWinUpdateAll; 1 → the title. */
export class RulesHelpPlayScene implements Scene {
  readonly id = GameScene.RULES_HELP
  private help: RulesHelpScene | null = null

  init(ctx: SceneContext) {
    this.help = new RulesHelpScene(ctx.assets.extrasTables, ctx.assets.winTables, (id) => ctx.audio.playSe(id))
  }

  update(ctx: SceneContext): GameSceneId {
    const h = this.help!
    const { input } = ctx
    const extra = h.pointer(input.pointerX, input.pointerY, input.pointerMoved, (input.pressed & PAD.POINTER) !== 0)
    h.step({ pressed: input.pressed | extra, repeat: input.repeat | extra, held: input.held })
    return h.exited ? GameScene.TITLE : this.id
  }

  draw(ctx: SceneContext) {
    const gl = ctx.screen.use('wide')
    gl.depthTest = false
    gl.begin([0, 0, 0])
    this.help!.draw(gl, ctx.assets.painter)
    gl.end()
  }

  exit() {}
}
