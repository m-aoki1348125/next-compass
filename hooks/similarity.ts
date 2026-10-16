// Local, deterministic similarity space for short instructions (Japanese and/or English).
// Pure module: no engine imports.

export type Point = { x: number; y: number }

type Vector = ReadonlyMap<string, number>
type Matrix = readonly (readonly number[])[]

const POWER_ITERATIONS = 300
const EIGEN_EPS = 1e-9
const DEFAULT_LIMIT = 0.85

const DIRECTION_ANGLES = [Math.PI / 2, 0, -Math.PI / 2, Math.PI] as const
const ORIGIN: Point = { x: 0, y: 0 }

/** Number at index i, 0 when out of range. */
const num = (v: readonly number[], i: number): number => v[i] ?? 0

/** Point at index i, the origin when out of range. */
const pt = (ps: readonly Point[], i: number): Point => ps[i] ?? ORIGIN

/** English function words: shared by most instructions, they say nothing about what one is about. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'it', 'is', 'be', 'this', 'that', 'by', 'at', 'from', 'as', 'into', 'up', 'its', 'then', 'so',
])

/** Character bigrams of one run of text; a lone character is a token of its own. */
const bigramsOf = (run: string): string[] => {
  const chars = Array.from(run)
  if (chars.length === 1) return chars
  return chars.slice(1).map((c, i) => `${chars[i] ?? ''}${c}`)
}

/**
 * Tokens of a text: Latin words and numbers (lowercased, function words
 * dropped), and character bigrams over each run of other scripts (Japanese,
 * symbols). Bigrams never cross a Latin word, so "the parser" and "parser.ts"
 * share only what they mean to share.
 */
export const tokensOf = (text: string): string[] => {
  const lower = text.toLowerCase()
  const words = (lower.match(/[a-z0-9]+/g) ?? []).filter(w => !STOPWORDS.has(w))
  // A lone ASCII punctuation mark (the dot of "parser.ts", a comma) is a separator, not a token.
  const runs = (lower.match(/[^\sa-z0-9]+/g) ?? []).filter(run => !/^[!-\/:-@[-`{-~]$/.test(run))
  return [...words, ...runs.flatMap(bigramsOf)]
}

/** Term counts of a token list. */
const countsOf = (tokens: readonly string[]): Map<string, number> =>
  tokens.reduce((acc, t) => acc.set(t, (acc.get(t) ?? 0) + 1), new Map<string, number>())

/** Smoothed IDF per token over the given token lists. */
const idfOf = (docs: readonly (readonly string[])[]): Map<string, number> => {
  const df = docs.reduce((acc, doc) => {
    new Set(doc).forEach(t => acc.set(t, (acc.get(t) ?? 0) + 1))
    return acc
  }, new Map<string, number>())
  const n = docs.length
  return new Map([...df].map(([t, d]) => [t, Math.log((n + 1) / (d + 1)) + 1]))
}

/** TF-IDF vector of one token list; tokens unknown to `idf` get the df=0 weight. */
const tfidfOf = (tokens: readonly string[], idf: ReadonlyMap<string, number>, n: number): Vector => {
  const unseen = Math.log(n + 1) + 1
  return new Map([...countsOf(tokens)].map(([t, c]) => [t, c * (idf.get(t) ?? unseen)]))
}

const norm = (v: Vector): number => Math.sqrt([...v.values()].reduce((s, w) => s + w * w, 0))

/** Cosine of two sparse vectors; 0 when either is empty. */
const cosine = (a: Vector, b: Vector): number => {
  const na = norm(a)
  const nb = norm(b)
  if (na === 0 || nb === 0) return 0
  const dot = [...a].reduce((s, [t, w]) => s + w * (b.get(t) ?? 0), 0)
  return Math.min(1, Math.max(0, dot / (na * nb)))
}

/** TF-IDF vectors of texts plus the IDF table they were built with. */
const vectorize = (texts: readonly string[]): { vectors: Vector[]; idf: Map<string, number> } => {
  const docs = texts.map(tokensOf)
  const idf = idfOf(docs)
  return { vectors: docs.map(d => tfidfOf(d, idf, texts.length)), idf }
}

/** Cosine similarity matrix (n×n, symmetric, 1 on the diagonal) of texts under TF-IDF over `tokensOf`. */
export const similarityMatrix = (texts: readonly string[]): number[][] => {
  const { vectors } = vectorize(texts)
  return vectors.map((a, i) => vectors.map((b, j) => (i === j ? 1 : j < i ? cosine(b, a) : cosine(a, b))))
}

const matVec = (m: Matrix, v: readonly number[]): number[] =>
  m.map(row => row.reduce((s, x, j) => s + x * num(v, j), 0))

const dotOf = (a: readonly number[], b: readonly number[]): number => a.reduce((s, x, i) => s + x * num(b, i), 0)

const centerVec = (v: readonly number[]): number[] => {
  const mean = v.reduce((s, x) => s + x, 0) / Math.max(1, v.length)
  return v.map(x => x - mean)
}

const unit = (v: readonly number[]): number[] => {
  const len = Math.sqrt(dotOf(v, v))
  return len === 0 ? v.map(() => 0) : v.map(x => x / len)
}

/** Double-centered matrix B = -1/2 J D² J for d = 1 - sim. */
const doubleCenter = (sim: Matrix): number[][] => {
  const d2 = sim.map(row => row.map(s => (1 - s) ** 2))
  const n = d2.length
  const rowMean = d2.map(row => row.reduce((s, x) => s + x, 0) / n)
  const all = rowMean.reduce((s, x) => s + x, 0) / n
  return d2.map((row, i) => row.map((x, j) => -0.5 * (x - num(rowMean, i) - num(rowMean, j) + all)))
}

/** Fixed, non-constant start vector so the iteration is deterministic. */
const startVector = (n: number): number[] => unit(centerVec(Array.from({ length: n }, (_, i) => Math.sin(i + 1) + (i + 1) / n)))

/** Flips sign so the largest-magnitude component is positive (ties: lower index). */
const fixSign = (v: readonly number[]): number[] => {
  const pivot = v.reduce((best, x, i) => (Math.abs(x) > Math.abs(num(v, best)) + 1e-12 ? i : best), 0)
  return num(v, pivot) < 0 ? v.map(x => -x) : [...v]
}

/** Top eigenpair of symmetric `m` (restricted to centered vectors) by shifted power iteration. */
const topEigen = (m: Matrix): { value: number; vector: number[] } => {
  const shift = Math.max(0, ...m.map(row => row.reduce((s, x) => s + Math.abs(x), 0)))
  const step = (v: readonly number[]): number[] =>
    unit(centerVec(matVec(m, v).map((x, i) => x + shift * num(v, i))))
  const vector = fixSign(Array.from({ length: POWER_ITERATIONS }).reduce<number[]>(v => step(v), startVector(m.length)))
  return { value: dotOf(vector, matVec(m, vector)), vector }
}

/** Removes an eigenpair from `m`: m - λ v vᵀ. */
const deflate = (m: Matrix, value: number, v: readonly number[]): number[][] =>
  m.map((row, i) => row.map((x, j) => x - value * num(v, i) * num(v, j)))

/** Centroid of points; origin for none. */
const centerOf = (points: readonly Point[]): Point => {
  const n = Math.max(1, points.length)
  return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n }
}

const centerPoints = (points: readonly Point[]): Point[] => {
  const c = centerOf(points)
  return points.map(p => ({ x: p.x - c.x, y: p.y - c.y }))
}

/** Classical (Torgerson) MDS to 2D from d = 1 - sim; deterministic power iteration with deflation. */
export const mdsLayout = (sim: Matrix): Point[] => {
  const n = sim.length
  if (n === 0) return []
  if (n === 1) return [{ x: 0, y: 0 }]
  const b = doubleCenter(sim)
  const first = topEigen(b)
  if (first.value <= EIGEN_EPS) return sim.map(() => ({ x: 0, y: 0 }))
  const second = topEigen(deflate(b, first.value, first.vector))
  const sx = Math.sqrt(first.value)
  const sy = second.value > EIGEN_EPS ? Math.sqrt(second.value) : 0
  return centerPoints(first.vector.map((x, i) => ({ x: x * sx, y: num(second.vector, i) * sy })))
}

const rotate = (p: Point, theta: number): Point => ({
  x: p.x * Math.cos(theta) - p.y * Math.sin(theta),
  y: p.x * Math.sin(theta) + p.y * Math.cos(theta),
})

const flipY = (p: Point): Point => ({ x: p.x, y: -p.y })

/** Best rotation angle taking `from` onto `to` and how well it fits (larger is better). */
const bestRotation = (from: readonly Point[], to: readonly Point[]): { theta: number; score: number } => {
  const c = from.reduce((s, p, i) => s + p.x * pt(to, i).x + p.y * pt(to, i).y, 0)
  const s = from.reduce((acc, p, i) => acc + p.x * pt(to, i).y - p.y * pt(to, i).x, 0)
  return { theta: Math.atan2(s, c), score: Math.hypot(c, s) }
}

/** Orthogonal Procrustes (rotation or reflection, no scaling) aligning points to reference over the index pairs. */
export const alignTo = (
  points: readonly Point[],
  reference: readonly Point[],
  pairs: readonly { from: number; to: number }[],
): Point[] => {
  const valid = pairs.filter(
    p => p.from >= 0 && p.from < points.length && p.to >= 0 && p.to < reference.length,
  )
  if (valid.length < 2) return points.map(p => ({ ...p }))
  const from = valid.map(p => pt(points, p.from))
  const to = valid.map(p => pt(reference, p.to))
  const rot = bestRotation(from, to)
  const ref = bestRotation(from.map(flipY), to)
  return ref.score > rot.score + 1e-12
    ? points.map(p => rotate(flipY(p), ref.theta))
    : points.map(p => rotate(p, rot.theta))
}

/** Scales points uniformly so the largest |coordinate| equals `limit` (default 0.85); all-zero points stay. */
export const fitToSquare = (points: readonly Point[], limit: number = DEFAULT_LIMIT): Point[] => {
  const max = points.reduce((m, p) => Math.max(m, Math.abs(p.x), Math.abs(p.y)), 0)
  if (max === 0) return points.map(p => ({ ...p }))
  const k = limit / max
  return points.map(p => ({ x: p.x * k, y: p.y * k }))
}

/** Lays texts out in 2D: similarity → MDS → aligned to `previous` by shared texts → fitToSquare. */
export const layoutTexts = (texts: readonly string[], previous: ReadonlyMap<string, Point> = new Map()): Point[] => {
  const points = mdsLayout(similarityMatrix(texts))
  const shared = texts.flatMap((t, i) => {
    const p = previous.get(t)
    return p ? [{ index: i, point: p }] : []
  })
  const reference = shared.map(s => s.point)
  const pairs = shared.map((s, j) => ({ from: s.index, to: j }))
  return separate(fitToSquare(alignTo(points, reference, pairs)), MIN_GAP, DEFAULT_LIMIT)
}

/** How far apart two laid-out spots are kept: texts alike to nothing else would otherwise share one point. */
export const MIN_GAP = 0.15

const clampTo = (p: Point, limit: number): Point => ({ x: Math.max(-limit, Math.min(limit, p.x)), y: Math.max(-limit, Math.min(limit, p.y)) })

/** Eight directions, the one away from the centre first, so a nudge prefers outward but can go anywhere. */
const directionsFrom = (p: Point): Point[] => {
  const base = Math.hypot(p.x, p.y) < 1e-6 ? Math.PI / 4 : Math.atan2(p.y, p.x)
  return Array.from({ length: 8 }, (_, k) => ({ x: Math.cos(base + (k * Math.PI) / 4), y: Math.sin(base + (k * Math.PI) / 4) }))
}

/** `p` moved off the `taken` spots: growing rings around it, outward first, until it stands `gap` apart; `p` itself if none does. */
export const nudgeOff = (p: Point, taken: readonly Point[], gap: number, limit: number): Point => {
  const crowded = (q: Point) => taken.some(t => Math.hypot(t.x - q.x, t.y - q.y) < gap)
  if (!crowded(p)) return p
  const dirs = directionsFrom(p)
  const tries = Array.from({ length: 12 }, (_, k) => k + 1).flatMap(k => dirs.map(d => clampTo({ x: p.x + d.x * gap * k * 0.8, y: p.y + d.y * gap * k * 0.8 }, limit)))
  return tries.find(q => !crowded(q)) ?? p
}

/** The points in order, each nudged off the ones before it, so no two share a spot. Deterministic. */
export const separate = (points: readonly Point[], gap: number, limit: number): Point[] =>
  points.reduce<Point[]>((done, p) => [...done, nudgeOff(p, done, gap, limit)], [])

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Index maximizing `score` among candidates not yet picked; ties broken by lower index. */
const argmaxUnpicked = (n: number, picked: readonly number[], score: (i: number) => number): number =>
  Array.from({ length: n }, (_, i) => i)
    .filter(i => !picked.includes(i))
    .reduce((best, i) => (best < 0 || score(i) > score(best) ? i : best), -1)

/** Farthest-point selection of `count` indices; seeded by `seed` or the point farthest from the centroid. */
export const spreadPick = (points: readonly Point[], count: number, seed?: number): number[] => {
  const n = points.length
  if (count <= 0) return []
  if (n <= count) return points.map((_, i) => i)
  const center = centerOf(points)
  const first =
    seed !== undefined && Number.isInteger(seed) && seed >= 0 && seed < n
      ? seed
      : argmaxUnpicked(n, [], i => dist(pt(points, i), center))
  return Array.from({ length: count - 1 }).reduce<number[]>(
    picks => [...picks, argmaxUnpicked(n, picks, i => Math.min(...picks.map(j => dist(pt(points, i), pt(points, j)))))],
    [first],
  )
}

/** All permutations of [0..n-1] in lexicographic order. */
const permutations = (n: number): number[][] => {
  const go = (rest: readonly number[]): number[][] =>
    rest.length === 0 ? [[]] : rest.flatMap(x => go(rest.filter(y => y !== x)).map(p => [x, ...p]))
  return go(Array.from({ length: n }, (_, i) => i))
}

const angularDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % (2 * Math.PI)
  return d > Math.PI ? 2 * Math.PI - d : d
}

/** Assigns 4 picked indices to [up, right, down, left] by angle around their centroid. */
export const toDirections = (points: readonly Point[], picked: readonly number[]): number[] => {
  if (picked.length < 4) return [...picked]
  const four = picked.slice(0, 4)
  const center = centerOf(four.map(i => pt(points, i)))
  const angles = four.map(i => Math.atan2(pt(points, i).y - center.y, pt(points, i).x - center.x))
  const cost = (perm: readonly number[]): number =>
    perm.reduce((s, k, dir) => s + angularDistance(num(angles, k), DIRECTION_ANGLES[dir] ?? 0), 0)
  const best = permutations(4).reduce((b, p) => (cost(p) < cost(b) - 1e-12 ? p : b))
  return best.map(k => num(four, k))
}

/** Index of the text most similar to `query` under the texts' TF-IDF space; -1 for no texts. */
export const nearestTo = (texts: readonly string[], query: string): number => {
  if (texts.length === 0) return -1
  const { vectors, idf } = vectorize(texts)
  const q = tfidfOf(tokensOf(query), idf, texts.length)
  const scores = vectors.map(v => cosine(q, v))
  const best = scores.reduce((b, s, i) => (s > num(scores, b) ? i : b), 0)
  return num(scores, best) > 0 ? best : -1
}
