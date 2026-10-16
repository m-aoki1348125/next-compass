import type { ClientModule, ClientSurface, RenderElement } from 'claude-code'

import type { CompassChoice } from '../types'
import { blend, cutToCells, fitRows, fluxCell, mapCell } from './field'
import type { Cell as FieldCell, Run } from './field'
import { lightsOf, lit, nearLights, rainbow } from './flux'
import { MOVES, caption, center, cursorOf, itemAt, placeItems, paint, sameCell, toCell, toPoint } from './map'
import type { Cell, Grid, MapState } from './map'

/**
 * The one space the pane draws, whatever the moment: the free field while
 * Claude works (gems drifting in it), the same field shaped around the four
 * once they land. One instance, one clock: when the four arrive the field's
 * colors melt into theirs, the gems glide to where the four sit and fade, the
 * extras surface and then the chips, so nothing is torn down in between; a
 * new turn melts the map back into the flux the same way.
 */
export type SpaceProps = {
  /** One gem per recent tool call (palette index by kind of work). */
  gems: number[]
  label: string
  isWorking: boolean
  /** The four (first, `isPrimary`) and the extras; none while Claude works. */
  items: CompassChoice[]
  labels: string[]
  isBusy: boolean
  /** A pointer the plugin moves (the demo); null when none. */
  ghost: { x: number; y: number } | null
  /** The instruction written for a spot, shown under the map until a second pick there sends it. */
  preview: { x: number; y: number; text: string } | null
}

/** `hold`: the four are gone (sent or cleared) and Claude is not working: the last map's colors stay, still, without chips. */
type Mode = 'flux' | 'map' | 'hold'

/**
 * `t` runs on, at a pace by moment (fast while Claude works), so the field
 * never jumps; `from` and `changedAt` say where the melt between the two
 * moments started, so its progress follows from the frame alone.
 */
type SpaceState = {
  frame: number
  t: number
  speed: number
  mode: Mode
  from: number
  changedAt: number
  cursor: Cell | null
  hover: Cell | null
  /** The last map's items and labels, kept so a new turn melts them away rather than dropping them. */
  lastItems: CompassChoice[]
  lastLabels: string[]
}

/** Six frames a second: enough for a field that drifts, and half the drawing of eight. */
const TICK_MS = 160
/** Ticks the melt between the free field and the map takes. */
const MELT_TICKS = 7
const WORK_SPEED = 0.08
/** A settled map is still: its colors mean positions, which do not move. */
const MAP_SPEED = 0
/** Waiting for the person (no turn running, no map yet), the field is still too: it moves only while Claude works. */
const IDLE_SPEED = 0
/** Rows under the grid: the label while Claude works, the blend under the pointer once the four are in. */
const CAPTION_ROWS = 2
/** How far the melt must be before the extras, then the chips and the cursor, show. */
const EXTRAS_AT = 0.3
const CHIPS_AT = 0.6

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

/** How far toward the map the space is now: 0 the free field, 1 the map. */
const meltOf = (s: SpaceState): number => {
  const target = s.mode === 'flux' ? 0 : 1
  return clamp01(s.from + (target - s.from) * clamp01((s.frame - s.changedAt) / MELT_TICKS))
}

const isChoice = (v: unknown): v is CompassChoice => {
  const o = (v ?? {}) as Record<string, unknown>
  return typeof o.text === 'string' && typeof o.x === 'number' && typeof o.y === 'number' && typeof o.isPrimary === 'boolean'
}

/** The props read defensively: an instance can be handed an older shape across a hot reload. */
const readProps = (raw: unknown): SpaceProps => {
  const o = (raw ?? {}) as Record<string, unknown>
  const ghost = (o.ghost ?? null) as Record<string, unknown> | null
  const preview = (o.preview ?? null) as Record<string, unknown> | null
  return {
    gems: Array.isArray(o.gems) ? o.gems.filter((g): g is number => typeof g === 'number') : [],
    label: typeof o.label === 'string' ? o.label : '',
    isWorking: o.isWorking === true,
    items: Array.isArray(o.items) ? o.items.filter(isChoice) : [],
    labels: Array.isArray(o.labels) ? o.labels.map(l => (typeof l === 'string' ? l : '')) : [],
    isBusy: o.isBusy === true,
    ghost: ghost !== null && typeof ghost.x === 'number' && typeof ghost.y === 'number' ? { x: ghost.x, y: ghost.y } : null,
    preview:
      preview !== null && typeof preview.x === 'number' && typeof preview.y === 'number' && typeof preview.text === 'string'
        ? { x: preview.x, y: preview.y, text: preview.text }
        : null,
  }
}

const gridRows = (surface: ClientSurface<SpaceState>): number => Math.max(1, surface.rows - CAPTION_ROWS)

/** Pointer and keys act on the map only, once it has settled enough to show its chips. */
const listen = (surface: ClientSurface<SpaceState>): void => {
  const live = (): SpaceState | null => {
    const s = surface.state
    return s !== undefined && s.mode === 'map' && meltOf(s) >= CHIPS_AT ? s : null
  }
  surface.onPointer(e => {
    const s = live()
    if (s === null) return
    const rows = gridRows(surface)
    const cell = { col: e.x, row: e.y }
    const inside = e.x >= 0 && e.y >= 0 && e.x < surface.columns && e.y < rows
    if (e.type === 'leave' || !inside) return s.hover === null ? undefined : surface.setState({ ...s, hover: null })
    if (e.type === 'move' && !sameCell(s.hover, cell)) return surface.setState({ ...s, hover: cell })
    if (e.type === 'down' && e.button === 'left') {
      surface.setState({ ...s, cursor: cell, hover: cell })
      const p = toPoint(cell, surface.columns, rows)
      surface.post({ kind: 'pick', x: p.x, y: p.y, fill: e.shift === true, previewShownWhole, isOnPreview: sameCell(previewCell, cell), previewText, ...onItemOf(cell) })
    }
  })
  surface.onKey(e => {
    const s = live()
    if (s === null) return
    const rows = gridRows(surface)
    const from = cursorOf(s, surface.columns, rows)
    const move = MOVES[e.key]
    if (move !== undefined) {
      const step = e.shift ? 3 : 1
      const cursor = {
        col: Math.min(surface.columns - 1, Math.max(0, from.col + move.col * step)),
        row: Math.min(rows - 1, Math.max(0, from.row + move.row * step)),
      }
      return surface.setState({ ...s, cursor })
    }
    if (e.key === 'return') {
      const p = toPoint(from, surface.columns, rows)
      return surface.post({ kind: 'pick', x: p.x, y: p.y, fill: e.shift === true, previewShownWhole, isOnPreview: sameCell(previewCell, from), previewText, ...onItemOf(from) })
    }
    if (/^[1-4]$/.test(e.key)) surface.post({ kind: 'choose', index: Number(e.key) - 1, fill: e.shift === true })
  })
}

/** Whether the clock's ticks advance the field: false while the map is still, so nothing is recomputed. */
let isTicking = true

/** The candidates' cells as last drawn, so a pick says which candidate it landed on; empty until the chips show. */
let lastPlaced: Grid = {}
/** The items as last drawn, so a pick names the candidate's text too: an index alone could point at a reordered list. */
let lastItems: readonly CompassChoice[] = []

/** What a pick says about the candidate under it: its index and text as drawn, or nothing. */
const onItemOf = (cell: Cell): { onItem: number; onText: string } | Record<string, never> => {
  const index = itemAt(lastPlaced, cell)
  const text = index === null ? undefined : lastItems[index]?.text
  return index === null || text === undefined ? {} : { onItem: index, onText: text }
}

/** The preview as last drawn (its cell and text), so a pick says whether it landed on it; null when none is shown. */
let previewCell: Cell | null = null
let previewText: string | null = null

/**
 * Whether the last render drew the preview whole: a pick that sends it says so,
 * and a preview the caption had to cut goes to the prompt box instead.
 */
let previewShownWhole = false

/**
 * The clock runs while the field moves (the free field, a melt); a settled map
 * is still, so nothing is computed until a key, a pointer or new props arrive.
 */
const tick = (wants: boolean): void => {
  isTicking = wants
}

const start = (surface: ClientSurface<SpaceState>, mode: Mode, speed: number): void => {
  isTicking = true
  // Mounted straight into the map (no flux before it), the map shows whole at once.
  surface.setState({
    frame: 0,
    t: 0,
    speed,
    mode,
    from: mode === 'flux' ? 0 : 1,
    changedAt: -MELT_TICKS,
    cursor: null,
    hover: null,
    lastItems: [],
    lastLabels: [],
  })
  // Started once, as the surface asks; a still map skips the frame rather than stopping the clock.
  surface.every(TICK_MS, () => {
    const s = surface.state
    if (s !== undefined && isTicking) surface.setState({ ...s, frame: s.frame + 1, t: s.t + s.speed })
  })
  listen(surface)
}

/** The ground at a cell: the free field melting into the map's, by `melt`. */
const groundAt = (x: number, y: number, t: number, items: readonly CompassChoice[], melt: number): FieldCell => {
  const free = fluxCell(x, y, t)
  if (melt <= 0) return free
  const shaped = mapCell(x, y, t, items)
  if (melt >= 1) return shaped
  return {
    text: melt < 0.5 ? free.text : shaped.text,
    color: blend(free.color, shaped.color, melt),
    bg: blend(free.bg, shaped.bg, melt),
  }
}

/** What the map lays over the ground at this point of the melt: nothing, the extras, then everything. */
const shownAt = (placed: Grid, melt: number): Grid => {
  if (melt >= CHIPS_AT) return placed
  if (melt < EXTRAS_AT) return {}
  return Object.fromEntries(Object.entries(placed).filter(([, g]) => g.char === '✦' && g.bg === undefined))
}

type Scene = {
  props: SpaceProps
  view: SpaceState
  melt: number
  columns: number
  rows: number
  /** Whether the map's chips, extras and pointer are laid over the ground (the map); not while holding its colors or in the flux. */
  hasItems: boolean
}

/** Every grid row's cells: ground, then the gems' light, then the map's chips, extras and pointer. */
const drawGrid = ({ props, view, melt, columns, rows, hasItems }: Scene): Run[][] => {
  // Holding the last map's colors (the four are gone), nothing is laid over the ground.
  const placed = hasItems && melt > 0 ? shownAt(placeItems({ ...props }, columns, rows), melt) : {}
  lastPlaced = hasItems && melt >= CHIPS_AT ? placed : {}
  lastItems = props.items
  const targets = props.items.filter(i => i.isPrimary).map(i => toCell(i.x, i.y, columns, rows))
  const lights = melt < 1 ? lightsOf(props.gems, view.t, view.frame, columns, rows, { targets, pull: melt }) : []
  const near = nearLights(lights, columns, rows)
  const ghost = props.ghost === null ? null : toCell(props.ghost.x, props.ghost.y, columns, rows)
  const previewAt = props.preview === null ? null : toCell(props.preview.x, props.preview.y, columns, rows)
  // A cursor moved away from the preview is the pointer again; the preview's spot keeps its mark otherwise.
  // At rest nothing is marked: the pointer appears where the keys or the mouse first put it.
  const own = melt >= CHIPS_AT && hasItems ? view.cursor : null
  const pointer: MapState = {
    cursor: ghost ?? (view.cursor !== null && !sameCell(view.cursor, previewAt) ? own : (previewAt ?? own)),
    hover: ghost === null && melt >= CHIPS_AT ? view.hover : null,
    frame: view.frame,
  }
  return Array.from({ length: rows }, (_, row) => {
    // A terminal cell is about twice as tall as wide: the ground is computed once per pair of columns and shared.
    let pair: Run | null = null
    return Array.from({ length: columns }, (_, col): Run => {
      const cell = { col, row }
      const p = toPoint(cell, columns, rows)
      if (col % 2 === 0 || pair === null) pair = { ...groundAt(p.x, p.y, view.t, props.items, melt), bold: false }
      const ground = pair
      const isMarked =
        placed[`${col},${row}`] !== undefined || sameCell(pointer.cursor, cell) || sameCell(pointer.hover, cell)
      if (!isMarked) {
        const mine = near.get(`${col},${row}`)
        return mine === undefined ? ground : lit(col, row, ground, mine)
      }
      const g = paint(cell, ground, placed, pointer)
      return { text: g.char, color: g.color, bg: g.bg, bold: g.bold === true }
    }).filter(r => r.text !== '')
  })
}

/** A short signature of the items, to notice when the map's content changed. */
const signOf = (items: readonly CompassChoice[]): string => items.map(i => `${i.text}|${i.x}|${i.y}|${i.isPrimary}`).join('\n')

/** The state for this render: a change of moment starts a melt from wherever the last one stood. */
const nextView = (stored: SpaceState, props: SpaceProps, mode: Mode, speed: number): SpaceState => {
  const melting = stored.mode === mode ? { ...stored, speed } : { ...stored, mode, speed, from: meltOf(stored), changedAt: stored.frame }
  return mode === 'map' && signOf(stored.lastItems) !== signOf(props.items)
    ? { ...melting, lastItems: props.items, lastLabels: props.labels }
    : melting
}

const Space: ClientModule<SpaceProps, SpaceState> = (raw, surface): RenderElement => {
  // A throw here would unmount the space for good: draw the label alone instead and go on.
  try {
    return drawSpace(readProps(raw), surface)
  } catch {
    const { Text } = surface.elements
    return <Text dimColor>{readProps(raw).label || ' '}</Text>
  }
}

const drawSpace = (props: SpaceProps, surface: ClientSurface<SpaceState>): RenderElement => {
  const { Box, Text } = surface.elements
  const had = (surface.state?.lastItems.length ?? 0) > 0
  const mode: Mode = props.items.length > 0 ? 'map' : !props.isWorking && had ? 'hold' : 'flux'
  const speed = mode === 'flux' ? (props.isWorking ? WORK_SPEED : IDLE_SPEED) : MAP_SPEED
  if (surface.state === undefined) start(surface, mode, speed)
  const stored: SpaceState = surface.state ?? {
    frame: 0,
    t: 0,
    speed,
    mode,
    from: mode === 'flux' ? 0 : 1,
    changedAt: -MELT_TICKS,
    cursor: null,
    hover: null,
    lastItems: [],
    lastLabels: [],
  }
  // Written once per change (a new moment, a new pace, new items), read from then on.
  const view = nextView(stored, props, mode, speed)
  if (view !== stored && (view.mode !== stored.mode || view.speed !== stored.speed || view.lastItems !== stored.lastItems)) {
    surface.setState(view)
  }
  const melt = meltOf(view)
  // The field moves only while Claude works or a melt is under way; a settled map and an idle wait are still.
  const isStill = melt >= 1 ? mode !== 'flux' : melt <= 0 && mode === 'flux' && !props.isWorking
  tick(!isStill)
  const rows = gridRows(surface)
  const { columns } = surface
  if (columns < 12 || rows < 3) return <Text dimColor>{props.label}</Text>
  // Melting back into the flux, the map still draws the four it last had, fading with the melt.
  const drawn = mode === 'map' ? props : { ...props, items: view.lastItems, labels: view.lastLabels }
  const lines = fitRows(drawGrid({ props: drawn, view, melt, columns, rows, hasItems: mode === 'map' }))
  const isPointed = view.cursor !== null || view.hover !== null
  const cap = melt >= 0.5 && mode === 'map' && isPointed ? caption({ ...props }, { cursor: view.cursor, hover: view.hover, frame: view.frame }, columns, rows) : null
  const focus = props.ghost === null ? null : caption({ ...props }, { cursor: toCell(props.ghost.x, props.ghost.y, columns, rows), hover: null, frame: view.frame }, columns, rows)
  // A written instruction shows whole, over the shares at its spot, until a second pick there sends it.
  const atPreview = props.preview === null ? null : toCell(props.preview.x, props.preview.y, columns, rows)
  const movedAway = view.cursor !== null && !sameCell(view.cursor, atPreview)
  const previewed =
    atPreview === null || mode !== 'map' || movedAway || (view.hover !== null && !sameCell(view.hover, atPreview))
      ? null
      : { ...caption({ ...props }, { cursor: atPreview, hover: null, frame: view.frame }, columns, rows), text: props.preview?.text ?? '' }
  // What the pick may send is only a preview drawn now, whole: "▶ " takes two cells before the text.
  previewCell = previewed === null ? null : atPreview
  previewText = previewed === null ? null : (props.preview?.text ?? null)
  previewShownWhole = previewed !== null && props.preview !== null && cutToCells(props.preview.text, columns - 2) === props.preview.text
  const shown = focus ?? previewed ?? cap

  return (
    <Box flexDirection="column">
      {lines.map(runs => (
        <Text>
          {runs.map(r => (
            <Text color={r.color} backgroundColor={r.bg} {...(r.bold ? { bold: true } : {})}>
              {r.text}
            </Text>
          ))}
        </Text>
      ))}
      {shown === null ? (
        props.isWorking ? (
          <Text wrap="truncate-end">
            {rainbow(props.label, view.frame).map(c => (
              <Text color={c.color} {...(c.bold ? { bold: true } : {})}>
                {c.char}
              </Text>
            ))}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {props.label}
          </Text>
        )
      ) : (
        <Text wrap="truncate-end">
          {shown.bar.map(seg => (
            <Text backgroundColor={seg.color}>{' '.repeat(seg.width)}</Text>
          ))}
          <Text> </Text>
          {shown.shares.map((s, i) => (
            <Text color={s.color} bold>
              {i > 0 ? ' · ' : ''}
              {s.text}
            </Text>
          ))}
        </Text>
      )}
      {/* No Fragment inside a Text: the terminal reads it as a Box in an inline element and refuses the tree. */}
      <Text wrap="truncate-end">
        {shown === null
          ? ' '
          : [
              <Text color={shown.color} bold>
                {'▶ '}
              </Text>,
              shown.text,
            ]}
      </Text>
    </Box>
  )
}

export default Space

// `center` is re-exported for tests that need the grid's middle without the map module.
export { center }
