import type { ClientModule, ClientSurface, RenderElement } from 'claude-code'

import type { CompassChoice } from '../types'
import { colorOf, lighten, weightsAt } from './compass'
import { fitRows, mapCell } from './field'
import type { Run } from './field'

/** `labels`: the four directions' names, drawn beside their choices on the map. */
export type MapProps = {
  items: CompassChoice[]
  labels: string[]
  isBusy: boolean
  /** A pointer the plugin moves (the demo), drawn and read as the cursor; null when none. */
  ghost: { x: number; y: number } | null
}

export type Cell = { col: number; row: number }

/** `frame`: the field's clock, so the territories keep breathing while the map waits. */
export type MapState = { cursor: Cell | null; hover: Cell | null; frame: number }

/** The keyboard cursor: where it was put, else the middle of the grid as laid out now. */
export const cursorOf = (state: MapState, columns: number, rows: number): Cell => state.cursor ?? center(columns, rows)

const FRAME_MS = 250
const SPEED = 0.05

type Glyph = { char: string; color: string; bg?: string; bold?: boolean }

type Painted = Glyph & { bg: string }

/** Rows under the grid: the blend bar and the nearest candidate's text. */
const CAPTION_ROWS = 2
const BAR_WIDTH = 16

const gridRows = (surface: ClientSurface<MapState>): number => Math.max(1, surface.rows - CAPTION_ROWS)

export const toPoint = (cell: Cell, columns: number, rows: number) => ({
  x: ((cell.col + 0.5) / Math.max(1, columns)) * 2 - 1,
  y: 1 - ((cell.row + 0.5) / Math.max(1, rows)) * 2,
})

export const toCell = (x: number, y: number, columns: number, rows: number): Cell => ({
  col: Math.min(columns - 1, Math.max(0, Math.floor(((x + 1) / 2) * columns))),
  row: Math.min(rows - 1, Math.max(0, Math.floor(((1 - y) / 2) * rows))),
})

export const sameCell = (a: Cell | null, b: Cell | null): boolean =>
  a !== null && b !== null && a.col === b.col && a.row === b.row

export const center = (columns: number, rows: number): Cell => ({
  col: Math.floor(columns / 2),
  row: Math.floor(rows / 2),
})

const keyOf = (col: number, row: number): string => `${col},${row}`

/**
 * The chip of a primary, one glyph per cell: its number on its own color,
 * then its direction's name written over the field, as the flux writes words.
 */
const chipGlyphs = (index: number, label: string, color: string): Glyph[] => [
  ...Array.from(` ${index + 1} `).map(char => ({ char, color: '#111111', bg: color, bold: true })),
  ...Array.from(label.length > 0 ? `${label} ` : '').map(char => ({ char, color: lighten(color, 0.5), bold: true })),
]

/** Cells a glyph takes: two for a wide (CJK, fullwidth) character. */
const widthOf = (char: string): number => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1)

/** Cells the number part of a chip (" N ") takes. */
const CHIP_HEAD = 3

/**
 * A direction's name cut to the cells left beside the chip's number, its
 * trailing space included: whole if it fits, else ended with "…", else none.
 */
const fitLabel = (label: string, room: number): string => {
  const chars = Array.from(label)
  const cells = chars.reduce((n, c) => n + widthOf(c), 0)
  if (cells + 1 <= room) return label
  if (room < 3) return ''
  const kept = chars.reduce<{ text: string; cells: number }>(
    (acc, c) => (acc.cells + widthOf(c) <= room - 2 ? { text: acc.text + c, cells: acc.cells + widthOf(c) } : acc),
    { text: '', cells: 0 },
  )
  return kept.text.length > 0 ? `${kept.text}…` : ''
}

export type Grid = Record<string, Glyph>

/** The cells a chip starting at `start` on `row` takes, in order, one per cell it covers. */
const chipCells = (widths: readonly number[], start: number, row: number): string[] =>
  widths.flatMap((w, i) => {
    const col = start + widths.slice(0, i).reduce((a, b) => a + b, 0)
    return Array.from({ length: w }, (_, k) => keyOf(col + k, row))
  })

/** Rows to try for a chip, nearest first: its own, then one and two away. */
const ROW_TRIES = [0, -1, 1, -2, 2] as const

/** Lays a primary's chip at its point, moved up or down a row or two if another chip is there. */
const placeChip = (grid: Grid, props: MapProps, index: number, columns: number, rows: number): Grid => {
  const item = props.items[index]
  if (item === undefined) return grid
  const cell = toCell(item.x, item.y, columns, rows)
  const label = fitLabel(props.labels[index] ?? '', columns - CHIP_HEAD)
  const chip = chipGlyphs(index, label, colorOf(props.items, index))
  const widths = chip.map(g => widthOf(g.char))
  const total = widths.reduce((a, b) => a + b, 0)
  const start = Math.max(0, Math.min(cell.col - 1, columns - total))
  const row =
    ROW_TRIES.map(d => cell.row + d)
      .filter(r => r >= 0 && r < rows)
      .find(r => chipCells(widths, start, r).every(k => grid[k] === undefined)) ?? cell.row
  const cells = chipCells(widths, start, row)
  const covered = Object.fromEntries(cells.map(k => [k, { char: '', color: '' }]))
  const heads = chip.map((g, i) => [chipCells(widths.slice(0, i + 1), start, row).slice(-widths[i]!)[0]!, g] as const)
  return { ...grid, ...covered, ...Object.fromEntries(heads) }
}

/** Cells around `cell` in growing rings, nearest first, out to `reach` (columns count double). */
const around = (cell: Cell, reach: number): Cell[] =>
  Array.from({ length: reach + 1 }, (_, r) => r).flatMap(r =>
    Array.from({ length: 2 * r + 1 }, (_, i) => i - r).flatMap(dy =>
      Array.from({ length: 4 * r + 1 }, (_, j) => j - 2 * r)
        .filter(dx => Math.max(Math.abs(dy), Math.ceil(Math.abs(dx) / 2)) === r)
        .map(dx => ({ col: cell.col + dx, row: cell.row + dy })),
    ),
  )

/** Lays an extra's ◆ at its point, or the nearest free cell with a free cell either side. */
const placeExtra = (grid: Grid, props: MapProps, index: number, columns: number, rows: number): Grid => {
  const item = props.items[index]
  if (item === undefined) return grid
  const isFree = (c: Cell) =>
    c.col >= 0 && c.row >= 0 && c.col < columns && c.row < rows &&
    [-1, 0, 1].every(d => grid[keyOf(c.col + d, c.row)] === undefined)
  const spot = around(toCell(item.x, item.y, columns, rows), 4).find(isFree)
  if (spot === undefined) return grid
  const glyph = { char: '✦', color: lighten(colorOf(props.items, index), 0.45), bold: true }
  return { ...grid, [keyOf(spot.col, spot.row)]: glyph }
}

/**
 * The glyphs the items put on the grid, keyed "col,row": the four chips
 * first, then each extra on its own cell, never touching a chip or another
 * extra. A cell a wide glyph covers holds an empty glyph, so nothing lands there.
 */
export const placeItems = (props: MapProps, columns: number, rows: number): Grid => {
  const chips = props.items
    .flatMap((item, i) => (item.isPrimary ? [i] : []))
    .reduce<Grid>((grid, i) => placeChip(grid, props, i, columns, rows), {})
  return props.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.isPrimary)
    .reduce((grid, { index }) => placeExtra(grid, props, index, columns, rows), chips)
}

export const MOVES: Record<string, Cell> = {
  up: { col: 0, row: -1 },
  down: { col: 0, row: 1 },
  left: { col: -2, row: 0 },
  right: { col: 2, row: 0 },
}

const listen = (surface: ClientSurface<MapState>): void => {
  const current = (): MapState =>
    surface.state ?? { cursor: null, hover: null, frame: 0 }
  surface.setState(current())
  surface.every(FRAME_MS, () => {
    const state = current()
    surface.setState({ ...state, frame: state.frame + 1 })
  })
  surface.onPointer(e => {
    const cell = { col: e.x, row: e.y }
    const inside = e.x >= 0 && e.y >= 0 && e.x < surface.columns && e.y < gridRows(surface)
    const state = current()
    if (e.type === 'leave' || !inside) {
      return state.hover === null ? undefined : surface.setState({ ...state, hover: null })
    }
    if (e.type === 'move' && !sameCell(state.hover, cell)) {
      return surface.setState({ ...state, hover: cell })
    }
    if (e.type === 'down' && e.button === 'left') {
      surface.setState({ ...state, cursor: cell, hover: cell })
      const p = toPoint(cell, surface.columns, gridRows(surface))
      surface.post({ kind: 'pick', x: p.x, y: p.y, fill: e.shift === true })
    }
  })
  surface.onKey(e => {
    const state = current()
    const move = MOVES[e.key]
    if (move !== undefined) {
      const step = e.shift ? 3 : 1
      const from = cursorOf(state, surface.columns, gridRows(surface))
      const cursor = {
        col: Math.min(surface.columns - 1, Math.max(0, from.col + move.col * step)),
        row: Math.min(gridRows(surface) - 1, Math.max(0, from.row + move.row * step)),
      }
      return surface.setState({ ...state, cursor })
    }
    if (e.key === 'return') {
      const p = toPoint(cursorOf(state, surface.columns, gridRows(surface)), surface.columns, gridRows(surface))
      return surface.post({ kind: 'pick', x: p.x, y: p.y, fill: e.shift === true })
    }
    if (/^[1-4]$/.test(e.key)) {
      surface.post({ kind: 'choose', index: Number(e.key) - 1, fill: e.shift === true })
    }
  })
}

/** A cell of the map: the field beneath, and over it a chip, an extra, the cursor or the pointer. */
export const paint = (cell: Cell, ground: { text: string; color: string; bg: string }, placed: Grid, state: MapState): Painted => {
  const { bg } = ground
  const item = placed[keyOf(cell.col, cell.row)]
  if (item !== undefined && item.char === '') return { char: '', color: '', bg }
  if (sameCell(state.cursor, cell) && (item === undefined || widthOf(item.char) === 1)) {
    return { char: '◎', color: '#111111', bg: '#ffffff', bold: true }
  }
  if (sameCell(state.hover, cell)) {
    return { char: item?.char ?? '+', color: '#ffffff', bg: lighten(item?.bg ?? bg, 0.3), bold: true }
  }
  if (item !== undefined) return { ...item, bg: item.bg ?? bg }
  return { char: ground.text, color: ground.color, bg }
}

/** One grid row's cells; the cell a wide glyph covers is dropped. `fitRows` makes the runs. */
const drawRow = (row: number, props: MapProps, state: MapState, placed: Grid, columns: number, rows: number): Run[] => {
  const t = state.frame * SPEED
  const painted = Array.from({ length: columns }, (_, col) => {
    const cell = { col, row }
    const p = toPoint(cell, columns, rows)
    return paint(cell, mapCell(p.x, p.y, t, props.items), placed, state)
  })
  return painted
    .filter(g => g.char !== '')
    .map(g => ({ text: g.char, color: g.color, bg: g.bg, bold: g.bold === true }))
}

/** The blend under the hover or cursor: a bar of the top three colors, their shares, the nearest text. */
export const caption = (props: MapProps, state: MapState, columns: number, rows: number) => {
  const p = toPoint(state.hover ?? cursorOf(state, columns, rows), columns, rows)
  const top = weightsAt(p, props.items).slice(0, 3)
  const total = top.reduce((sum, w) => sum + w.weight, 0)
  const barWidth = Math.min(BAR_WIDTH, Math.max(6, columns - 26))
  const bar = top.map(w => ({
    width: Math.round((w.weight / Math.max(total, 1e-9)) * barWidth),
    color: colorOf(props.items, w.index),
  }))
  const label = (index: number) => (props.items[index]?.isPrimary ? `${index + 1}` : '✦')
  const shares = top.map(w => ({
    text: `${label(w.index)} ${Math.round(w.weight * 100)}%`,
    color: lighten(colorOf(props.items, w.index), 0.2),
  }))
  const first = top[0]
  return {
    bar,
    shares,
    text: first === undefined ? '' : (props.items[first.index]?.text ?? ''),
    color: first === undefined ? '#ffffff' : lighten(colorOf(props.items, first.index), 0.2),
  }
}

const isChoice = (v: unknown): v is CompassChoice => {
  const o = (v ?? {}) as Record<string, unknown>
  return typeof o.text === 'string' && typeof o.x === 'number' && typeof o.y === 'number' && typeof o.isPrimary === 'boolean'
}

/**
 * The props as they came, read defensively: an instance can be handed props
 * of an older shape across a hot reload, and a throw would unmount it.
 */
const isPoint = (v: unknown): v is { x: number; y: number } => {
  const o = (v ?? {}) as Record<string, unknown>
  return typeof o.x === 'number' && typeof o.y === 'number'
}

const readProps = (raw: unknown): MapProps => {
  const obj = (raw ?? {}) as Record<string, unknown>
  return {
    items: Array.isArray(obj.items) ? obj.items.filter(isChoice) : [],
    labels: Array.isArray(obj.labels) ? obj.labels.map(l => (typeof l === 'string' ? l : '')) : [],
    isBusy: obj.isBusy === true,
    ghost: isPoint(obj.ghost) ? obj.ghost : null,
  }
}

const CompassMap: ClientModule<MapProps, MapState> = (raw, surface): RenderElement => {
  const props = readProps(raw)
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    listen(surface)
  }
  const rows = gridRows(surface)
  const { columns } = surface
  const stored = surface.state ?? { cursor: null, hover: null, frame: 0 }
  const ghost = props.ghost === null ? null : toCell(props.ghost.x, props.ghost.y, columns, rows)
  const state = ghost === null ? { ...stored, cursor: cursorOf(stored, columns, rows) } : { ...stored, cursor: ghost, hover: null }
  if (columns < 12 || rows < 5 || props.items.length === 0) {
    return <Text dimColor>{props.isBusy ? '候補を考えています…' : '候補はまだありません。'}</Text>
  }
  const placed = placeItems(props, columns, rows)
  const lines = fitRows(Array.from({ length: rows }, (_, row) => drawRow(row, props, state, placed, columns, rows)))
  const cap = caption(props, state, columns, rows)

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
      <Text wrap="truncate-end">
        {cap.bar.map(seg => (
          <Text backgroundColor={seg.color}>{' '.repeat(seg.width)}</Text>
        ))}
        <Text> </Text>
        {cap.shares.map((s, i) => (
          <Text color={s.color} bold>
            {i > 0 ? ' · ' : ''}
            {s.text}
          </Text>
        ))}
      </Text>
      <Text wrap="truncate-end">
        <Text color={cap.color} bold>
          {'▶ '}
        </Text>
        {cap.text}
      </Text>
    </Box>
  )
}

export default CompassMap
