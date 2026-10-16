import type { CompassAxes, CompassChoice, CompassSet } from '../types'
import { PRIMARY_COUNT } from './compass'
import type { ParsedSet, Picked } from './compass'
import { layoutTexts, nearestTo, spreadPick, toDirections } from './similarity'
import type { Point } from './similarity'

/**
 * From texts to a set: the candidates laid out in the similarity space, the
 * four assigned to the compass directions by where they landed, the extras
 * around them. Pure, so the same texts always give the same map.
 */

export const EMPTY_AXES: CompassAxes = { up: '', right: '', down: '', left: '' }

/** The last map's spots by text, so the next layout keeps shared candidates where they were. */
export const spotsOf = (set: CompassSet | null): Map<string, Point> =>
  new Map((set?.items ?? []).map(i => [i.text, { x: i.x, y: i.y }]))

const at = (points: readonly Point[], i: number): Point => points[i] ?? { x: 0, y: 0 }

/** The axes' names reordered as the four were: `names[k]` belonged to the k-th text in reply order. */
const axesFor = (names: readonly string[], order: readonly number[]): CompassAxes => ({
  up: names[order[0] ?? 0] ?? '',
  right: names[order[1] ?? 1] ?? '',
  down: names[order[2] ?? 2] ?? '',
  left: names[order[3] ?? 3] ?? '',
})

/**
 * A set from four texts the model chose (with its names for them) and the
 * extras: everything laid out together, the four take the directions their
 * spots point to, and each name follows its text.
 */
export const arrangeSet = (
  parsed: ParsedSet,
  extras: readonly string[],
  previous: ReadonlyMap<string, Point>,
): ParsedSet => {
  const four = parsed.items.map(i => i.text)
  const names = [parsed.axes.up, parsed.axes.right, parsed.axes.down, parsed.axes.left]
  const rest = extras.filter((t, i, all) => !four.includes(t) && all.indexOf(t) === i)
  const points = layoutTexts([...four, ...rest], previous)
  const order = toDirections(points, four.map((_, i) => i))
  const primaries = order.map((i): CompassChoice => ({ text: four[i] ?? '', ...at(points, i), isPrimary: true }))
  const others = rest.map((text, k): CompassChoice => ({ text, ...at(points, four.length + k), isPrimary: false }))
  return { axes: axesFor(names, order), items: [...primaries, ...others] }
}

/**
 * The four picked from the pool without a model call: the most spread-out
 * candidates in the similarity space, seeded with the one nearest the goal
 * when there is one. The rest become the map's extras. The fallback shown at
 * once, until the select call picks for Claude's final answer.
 */
export const pickFromPool = (pool: readonly string[], goal: string | null, previous: ReadonlyMap<string, Point>): Picked | null => {
  if (pool.length < PRIMARY_COUNT) return null
  const points = layoutTexts(pool, previous)
  const seed = goal === null ? undefined : nearestTo(pool, goal)
  const picked = spreadPick(points, PRIMARY_COUNT, seed === -1 ? undefined : seed)
  const order = toDirections(points, picked)
  const primaries = order.map((i): CompassChoice => ({ text: pool[i] ?? '', ...at(points, i), isPrimary: true }))
  const others = pool.flatMap((text, i): CompassChoice[] => (order.includes(i) ? [] : [{ text, ...at(points, i), isPrimary: false }]))
  return { parsed: { axes: EMPTY_AXES, items: [...primaries, ...others] }, used: order }
}

/** The set with more extras laid in, the four and the extras it has kept where they were. */
export const addExtras = (set: CompassSet, extras: readonly string[]): CompassSet => {
  const own = new Set(set.items.map(i => i.text))
  const fresh = extras.filter((t, i, all) => !own.has(t) && all.indexOf(t) === i)
  if (fresh.length === 0) return set
  const texts = [...set.items.map(i => i.text), ...fresh]
  const points = layoutTexts(texts, spotsOf(set))
  const items = texts.map((text, i): CompassChoice => ({ text, ...at(points, i), isPrimary: i < set.items.length && (set.items[i]?.isPrimary ?? false) }))
  return { ...set, items }
}
