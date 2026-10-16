import type { CompassChoice } from '../types'
import { PALETTE, PRIMARY_COUNT, lighten } from './compass'

/**
 * The moving field both panes draw: the one the flux shows while Claude
 * works, and the one the map shapes around the four choices once they land,
 * so the second reads as the first settling.
 */

export type Cell = { text: string; color: string; bg: string }

const BASE: readonly [number, number, number] = [18, 19, 28]

const RGB = PALETTE.map(hex => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
})

/** Glyphs from faint to bright, picked by the field's height at a cell. */
const TEXTURE = [' ', ' ', '·', '∙', '•'] as const

const hex = (c: readonly number[]): string =>
  `#${c.map(v => Math.max(0, Math.min(255, Math.round(v / 10) * 10)).toString(16).padStart(2, '0')).join('')}`

/**
 * The field at a point (x, y from -1 to 1) and time: four moving waves. Their
 * sum is the height; the angle of their gradient says which color leads.
 */
export const waves = (x: number, y: number, t: number) => {
  const a = Math.sin(x * 3.1 + t * 0.9)
  const b = Math.sin(y * 4.3 - t * 0.7)
  const c = Math.sin((x + y) * 2.6 + t * 0.5)
  const d = Math.sin(Math.hypot(x - Math.sin(t * 0.3) * 0.5, y - Math.cos(t * 0.4) * 0.5) * 6 - t * 1.3)
  return { height: (a + b + c + d) / 4, angle: Math.atan2(b + d * 0.5, a + c * 0.5) }
}

/** A palette mix (weights over the four colors) laid over the base at a strength. */
const paint = (weights: readonly number[], strength: number): string => {
  const mixed = [0, 1, 2].map(k => weights.reduce((sum, w, i) => sum + w * (RGB[i]?.[k] ?? 0), 0))
  return hex(BASE.map((b, k) => b + ((mixed[k] ?? b) - b) * strength))
}

/** One cell from a mix, a height and an extra brightness. */
const cellOf = (weights: readonly number[], height: number, glow: number): Cell => {
  const bg = paint(weights, Math.min(0.8, 0.16 + (height + 1) * 0.14 + glow))
  const level = Math.max(0, Math.min(TEXTURE.length - 1, Math.floor((height + 1) * 2.5 + glow * 6)))
  return { text: TEXTURE[level] ?? ' ', color: lighten(bg, 0.35), bg }
}

/** The free field: the angle picks two neighboring colors and mixes them. */
export const fluxCell = (x: number, y: number, t: number): Cell => {
  const { height, angle } = waves(x, y, t)
  const turn = ((angle / (Math.PI * 2)) * 4 + 4) % 4
  const i = Math.floor(turn)
  const f = turn - i
  const weights = [0, 1, 2, 3].map(k => (k === i ? 1 - f : k === (i + 1) % 4 ? f : 0))
  return cellOf(weights, height, 0)
}

/**
 * The field shaped by the four choices: each point leans to the colors of the
 * choices nearest it (softly, so territories blend at their edges), the point
 * itself warped by the waves so the borders keep breathing, and brighter
 * close to a choice, so the four read as the peaks of the field.
 */
export const mapCell = (x: number, y: number, t: number, items: readonly CompassChoice[]): Cell => {
  // The picked ones shape the field; with none picked yet (the demo) it is the free flux.
  const primaries = items.filter(i => i.isPrimary).slice(0, PRIMARY_COUNT)
  if (primaries.length === 0) return fluxCell(x, y, t)
  const { height } = waves(x, y, t)
  const wx = x + Math.sin(y * 5 + t * 0.8) * 0.09
  const wy = y + Math.cos(x * 4 - t * 0.6) * 0.09
  const pull = primaries.map(c => 1 / ((c.x - wx) ** 2 + (c.y - wy) ** 2 + 0.03) ** 1.6)
  const total = pull.reduce((a, b) => a + b, 0)
  const weights = pull.map(p => p / total)
  const nearest = Math.min(...primaries.map(c => Math.hypot(c.x - x, c.y - y)))
  const glow = nearest < 0.5 ? (0.5 - nearest) * 0.4 : 0
  return cellOf(weights, height * 0.7, glow)
}

/** Two hex colors mixed, `t` of the way from `a` to `b`. */
export const blend = (a: string, b: string, t: number): string => {
  const ca = parseInt(a.slice(1), 16)
  const cb = parseInt(b.slice(1), 16)
  const ch = (c: number, s: number) => (c >> s) & 255
  return hex([16, 8, 0].map(s => ch(ca, s) + (ch(cb, s) - ch(ca, s)) * Math.max(0, Math.min(1, t))))
}

/** One drawn run: text sharing a color, a background and a weight. */
export type Run = { text: string; color: string; bg: string; bold: boolean }

/**
 * A Client's tree may serialize to at most 100,000 characters or the engine
 * unmounts it. A run costs about this much beside its text.
 */
const RUN_COST = 90
const TREE_BUDGET = 70_000

/** A hex color rounded to `step` per channel, so near colors become one. */
const coarse = (color: string, step: number): string => {
  const n = parseInt(color.slice(1), 16)
  return hex([16, 8, 0].map(s => Math.round(((n >> s) & 255) / step) * step))
}

const toRuns = (cells: readonly Run[]): Run[] =>
  cells.reduce<Run[]>((runs, c) => {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === c.color && last.bg === c.bg && last.bold === c.bold) {
      return [...runs.slice(0, -1), { ...last, text: last.text + c.text }]
    }
    return [...runs, c]
  }, [])

/** A one-character run joins the run before it, taking its colors. */
const absorb = (runs: readonly Run[]): Run[] =>
  runs.reduce<Run[]>((out, r) => {
    const last = out[out.length - 1]
    return last !== undefined && Array.from(r.text).length === 1 && !r.bold && !last.bold
      ? [...out.slice(0, -1), { ...last, text: last.text + r.text }]
      : [...out, r]
  }, [])

const costOf = (rows: readonly Run[][]): number =>
  rows.reduce((sum, row) => sum + row.reduce((s, r) => s + RUN_COST + r.text.length, 20), 0)

/** Coarser and coarser colors until the rows fit the budget; then single cells are absorbed. */
const ROUGHEST = 64
const STEPS = [10, 20, 32, 48, ROUGHEST] as const

/**
 * Turns rows of cells into rows of runs that fit a Client's tree: colors
 * are rounded more coarsely until neighbors merge enough, and as a last
 * resort lone cells join their left neighbor. A big pane stays drawn.
 */
export const fitRows = (rows: readonly (readonly Run[])[], budget = TREE_BUDGET): Run[][] => {
  const attempt = (step: number) =>
    rows.map(cells => toRuns(cells.map(c => ({ ...c, color: coarse(c.color, step), bg: coarse(c.bg, step) }))))
  const fitted = STEPS.map(attempt).find(r => costOf(r) <= budget)
  if (fitted !== undefined) return fitted
  const roughest = attempt(ROUGHEST)
  const once = roughest.map(absorb)
  if (costOf(once) <= budget) return once
  const twice = once.map(absorb)
  if (costOf(twice) <= budget) return twice
  // The last resort, sure to fit a bounded pane: each row one run in its first run's colors.
  return twice.map(row => (row.length === 0 ? row : [{ ...row[0]!, text: row.map(r => r.text).join(''), bold: false }]))
}

/** Cells a character takes on the terminal: two for a wide (CJK, fullwidth) one. */
export const cellWidth = (char: string): number =>
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1

/** The text cut to at most `cells` terminal cells, ending in "…" when cut. */
export const cutToCells = (text: string, cells: number): string => {
  const chars = Array.from(text)
  if (chars.reduce((n, c) => n + cellWidth(c), 0) <= cells) return text
  const kept = chars.reduce<{ out: string; used: number }>(
    (acc, c) => (acc.used + cellWidth(c) <= cells - 1 ? { out: acc.out + c, used: acc.used + cellWidth(c) } : acc),
    { out: '', used: 0 },
  )
  return `${kept.out}…`
}
