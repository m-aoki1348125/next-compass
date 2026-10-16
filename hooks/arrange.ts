import type { CompassAxes, CompassChoice, CompassSet } from '../types'
import { PRIMARY_COUNT } from './compass'
import type { ParsedSet, Picked } from './compass'
import { layoutTexts, nearestTo, nudgeOff, similarityMatrix, spreadPick, toDirections } from './similarity'
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

/** Two spots closer than this (map units) read as one; a newcomer is nudged off. */
const CROWDED = 0.15
/** The centre is the keyboard cursor's resting cell: no candidate is put on it. */
const CENTRE: Point = { x: 0, y: 0 }
const LIMIT = 0.85

const clampTo = (p: Point): Point => ({ x: Math.max(-LIMIT, Math.min(LIMIT, p.x)), y: Math.max(-LIMIT, Math.min(LIMIT, p.y)) })

/**
 * Spots for texts joining a map whose candidates stay where they are: each
 * newcomer sits at the mean of the placed spots weighted by its similarity to
 * them (the nearest in meaning weigh most), nudged off any spot taken. A
 * text alike to nothing placed goes to the centre, nudged out the same way.
 */
export const placeAmong = (placed: readonly { text: string; spot: Point }[], texts: readonly string[]): Point[] => {
  if (placed.length === 0) return layoutTexts(texts)
  const sim = similarityMatrix([...placed.map(p => p.text), ...texts])
  return texts.reduce<Point[]>((done, _text, k) => {
    const row = sim[placed.length + k] ?? []
    const weights = placed.map((_, j) => (row[j] ?? 0) ** 2)
    const total = weights.reduce((a, b) => a + b, 0)
    const mean =
      total <= 1e-9
        ? { x: 0, y: 0 }
        : placed.reduce((acc, p, j) => ({ x: acc.x + p.spot.x * ((weights[j] ?? 0) / total), y: acc.y + p.spot.y * ((weights[j] ?? 0) / total) }), { x: 0, y: 0 })
    return [...done, nudgeOff(clampTo(mean), [CENTRE, ...placed.map(p => p.spot), ...done], CROWDED, LIMIT)]
  }, [])
}

const placedOf = (set: CompassSet) => set.items.map(i => ({ text: i.text, spot: { x: i.x, y: i.y } }))

/** The set with more extras laid in; what it had stays exactly where it was, the newcomers sit among them. */
export const addExtras = (set: CompassSet, extras: readonly string[]): CompassSet => {
  const own = new Set(set.items.map(i => i.text))
  const fresh = extras.filter((t, i, all) => !own.has(t) && all.indexOf(t) === i)
  if (fresh.length === 0) return set
  const points = placeAmong(placedOf(set), fresh)
  const items = [...set.items, ...fresh.map((text, k): CompassChoice => ({ text, ...at(points, k), isPrimary: false }))]
  return { ...set, items }
}

/**
 * The four re-picked for Claude's final answer, on the map as it stands: a
 * text already on it keeps its spot, a new one joins among the others, the
 * directions follow the spots, and every other candidate becomes an extra.
 * Nothing the person was looking at moves.
 */
export const repick = (set: CompassSet, parsed: ParsedSet, others: readonly string[]): ParsedSet => {
  const four = parsed.items.map(i => i.text)
  const names = [parsed.axes.up, parsed.axes.right, parsed.axes.down, parsed.axes.left]
  const known = new Map(set.items.map(i => [i.text, { x: i.x, y: i.y }]))
  const rest = [...set.items.map(i => i.text), ...others].filter((t, i, all) => !four.includes(t) && all.indexOf(t) === i)
  const texts = [...four, ...rest]
  const fresh = texts.filter(t => !known.has(t))
  const placedFresh = placeAmong(placedOf(set), fresh)
  const spotOf = (t: string): Point => known.get(t) ?? at(placedFresh, fresh.indexOf(t))
  const points = texts.map(spotOf)
  const order = toDirections(points, four.map((_, i) => i))
  const primaries = order.map((i): CompassChoice => ({ text: four[i] ?? '', ...at(points, i), isPrimary: true }))
  const extras = rest.map((text, k): CompassChoice => ({ text, ...at(points, four.length + k), isPrimary: false }))
  return { axes: axesFor(names, order), items: [...primaries, ...extras] }
}
