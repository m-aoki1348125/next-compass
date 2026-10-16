import type { CompassChoice } from '../types'
import { colorOf, lighten, sharesAt } from './compass'

/**
 * The map's layout helpers, shared by the space: where items sit in cells, the chips
 * and extras laid without overlap, the cell painter and the caption.
 * `labels`: the four directions' names, drawn beside their choices on the map.
 */
export type MapProps = {
  items: CompassChoice[]
  labels: string[]
}

export type Cell = { col: number; row: number }

/** `frame`: the field's clock, so the territories keep breathing while the map waits. */
export type MapState = { cursor: Cell | null; hover: Cell | null; frame: number }

/** The keyboard cursor: where it was put, else the middle of the grid as laid out now. */
export const cursorOf = (state: MapState, columns: number, rows: number): Cell => state.cursor ?? center(columns, rows)

type Glyph = { char: string; color: string; bg?: string; bold?: boolean }

type Painted = Glyph & { bg: string }

const BAR_WIDTH = 16

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
const widthOf = (char: string): number => (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1)

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

/** A cell of the map: the field beneath, and over it a chip, an extra, the cursor or the pointer. */
export const paint = (cell: Cell, ground: { text: string; color: string; bg: string }, placed: Grid, state: MapState): Painted => {
  const { bg } = ground
  const item = placed[keyOf(cell.col, cell.row)]
  if (item !== undefined && item.char === '') return { char: '', color: '', bg }
  // The cursor over a candidate keeps the candidate's glyph, in the cursor's colors: nothing on the map is hidden by it.
  if (sameCell(state.cursor, cell) && (item === undefined || widthOf(item.char) === 1)) {
    return { char: item?.char ?? '◎', color: '#111111', bg: '#ffffff', bold: true }
  }
  if (sameCell(state.hover, cell)) {
    return { char: item?.char ?? '+', color: '#ffffff', bg: lighten(item?.bg ?? bg, 0.3), bold: true }
  }
  if (item !== undefined) return { ...item, bg: item.bg ?? bg }
  return { char: ground.text, color: ground.color, bg }
}

/** The blend under the hover or cursor: a bar of the top colors, the shares the blend will use, the nearest text. */
export const caption = (props: MapProps, state: MapState, columns: number, rows: number) => {
  const p = toPoint(state.hover ?? cursorOf(state, columns, rows), columns, rows)
  const top = sharesAt(p, props.items)
  const barWidth = Math.min(BAR_WIDTH, Math.max(6, columns - 26))
  const bar = top.map(w => ({
    width: Math.round(w.weight * barWidth),
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
