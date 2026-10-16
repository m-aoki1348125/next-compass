import { describe, expect, test } from 'claude-code/testing'

import {
  alignTo,
  fitToSquare,
  layoutTexts,
  mdsLayout,
  nearestTo,
  similarityMatrix,
  spreadPick,
  toDirections,
  tokensOf,
} from '../hooks/similarity'
import type { Point } from '../hooks/similarity'

const at = <T>(xs: readonly T[], i: number): T => {
  const x = xs[i]
  if (x === undefined) throw new Error(`no element at ${i}`)
  return x
}
const closeTo = (a: number, b: number, digits: number): void => {
  expect(Math.abs(a - b)).toBeLessThan(0.5 * 10 ** -digits)
}
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
const maxAbs = (ps: readonly Point[]): number => Math.max(...ps.map(p => Math.max(Math.abs(p.x), Math.abs(p.y))))
const minPairwise = (ps: readonly Point[]): number =>
  Math.min(...ps.flatMap((a, i) => ps.slice(i + 1).map(b => dist(a, b))))
const rotate = (p: Point, t: number): Point => ({
  x: p.x * Math.cos(t) - p.y * Math.sin(t),
  y: p.x * Math.sin(t) + p.y * Math.cos(t),
})

const JA = [
  'エクスポートのテストを追加して',
  'エクスポートのテストを直して',
  '大きなデータで速度を測って',
  'CSV出力をエクスポートに追加して',
  'READMEにエクスポートの使い方を書いて',
  'エラー処理を見直して',
  '変更をコミットして',
  'ログ出力を整理して',
]

describe('tokensOf', () => {
  test('Japanese text yields character bigrams only', () => {
    expect(tokensOf('テスト追加')).toEqual(['テス', 'スト', 'ト追', '追加'])
  })

  test('English yields lowercased words plus bigrams, ignoring whitespace', () => {
    const tokens = tokensOf('Add  CSV')
    expect(tokens.slice(0, 2)).toEqual(['add', 'csv'])
    expect(tokens.slice(2)).toEqual(['ad', 'dd', 'dc', 'cs', 'sv'])
    expect(tokens.some(t => /\s/.test(t))).toBe(false)
  })

  test('is deterministic', () => {
    expect(tokensOf('Add CSV output to the export')).toEqual(tokensOf('Add CSV output to the export'))
  })
})

describe('similarityMatrix', () => {
  const texts = ['エクスポートのテストを追加して', 'エクスポートのテストを直して', '大きなデータで速度を測って']
  const m = similarityMatrix(texts)

  test('diagonal is 1 and matrix is symmetric', () => {
    m.forEach((row, i) => {
      expect(row[i]).toBe(1)
      row.forEach((v, j) => closeTo(v, at(at(m, j), i), 12))
    })
  })

  test('identical texts score 1; disjoint texts score 0', () => {
    closeTo(at(at(similarityMatrix(['abc def', 'abc def']), 0), 1), 1, 12)
    expect(at(at(similarityMatrix(['あいう', 'xyz']), 0), 1)).toBe(0)
  })

  test('related instructions are more similar than unrelated ones', () => {
    expect(at(at(m, 0), 1)).toBeGreaterThan(at(at(m, 0), 2))
  })
})

describe('mdsLayout', () => {
  const sim = [
    [1, 0.9, 0.1],
    [0.9, 1, 0.1],
    [0.1, 0.1, 1],
  ]

  test('keeps similar points close and dissimilar ones apart', () => {
    const ps = mdsLayout(sim)
    const [a, b, c] = [at(ps, 0), at(ps, 1), at(ps, 2)]
    expect(dist(a, b)).toBeLessThan(dist(a, c))
    expect(dist(a, b)).toBeLessThan(dist(b, c))
  })

  test('output is centered at the origin', () => {
    const ps = mdsLayout(sim)
    closeTo(ps.reduce((s, p) => s + p.x, 0) / ps.length, 0, 9)
    closeTo(ps.reduce((s, p) => s + p.y, 0) / ps.length, 0, 9)
  })

  test('edge cases n = 0, 1, 2', () => {
    expect(mdsLayout([])).toEqual([])
    expect(mdsLayout([[1]])).toEqual([{ x: 0, y: 0 }])
    const two = mdsLayout([
      [1, 0.2],
      [0.2, 1],
    ])
    expect(two.length).toBe(2)
    two.forEach(p => expect(Math.abs(p.y)).toBeLessThan(1e-9))
    closeTo(dist(at(two, 0), at(two, 1)), 0.8, 6)
  })

  test('is deterministic', () => {
    const m = similarityMatrix(JA)
    expect(mdsLayout(m)).toEqual(mdsLayout(m))
  })
})

describe('alignTo', () => {
  const reference: Point[] = [
    { x: 1, y: 0.2 },
    { x: -0.5, y: 0.7 },
    { x: -0.3, y: -0.6 },
    { x: -0.2, y: -0.3 },
  ]

  test('recovers a reference that was rotated by 90° and reflected', () => {
    const moved = reference.map(p => rotate({ x: p.x, y: -p.y }, Math.PI / 2))
    const pairs = reference.map((_, i) => ({ from: i, to: i }))
    const aligned = alignTo(moved, reference, pairs)
    aligned.forEach((p, i) => expect(dist(p, at(reference, i))).toBeLessThan(1e-6))
  })

  test('fewer than 2 pairs leaves points unchanged', () => {
    const moved = reference.map(p => rotate(p, 1))
    expect(alignTo(moved, reference, [{ from: 0, to: 0 }])).toEqual(moved)
    expect(alignTo(moved, reference, [])).toEqual(moved)
  })
})

describe('fitToSquare', () => {
  test('largest |coordinate| equals the limit', () => {
    const ps = [{ x: 0.1, y: -2 }, { x: 1, y: 0.5 }]
    closeTo(maxAbs(fitToSquare(ps)), 0.85, 12)
    closeTo(maxAbs(fitToSquare(ps, 0.5)), 0.5, 12)
  })

  test('all-zero points stay zero', () => {
    expect(fitToSquare([{ x: 0, y: 0 }, { x: 0, y: 0 }])).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }])
  })
})

describe('layoutTexts', () => {
  test('8 Japanese instructions give 8 distinct points fitted to 0.85', () => {
    const ps = layoutTexts(JA)
    expect(ps.length).toBe(8)
    expect(minPairwise(ps)).toBeGreaterThan(1e-3)
    closeTo(maxAbs(ps), 0.85, 9)
  })

  test('aligns to previous positions of shared texts', () => {
    const base = layoutTexts(JA)
    const kept = [0, 2, 3, 5, 7]
    const previous = new Map<string, Point>(kept.map(i => [at(JA, i), rotate(at(base, i), 1.2)]))
    const sumTo = (ps: readonly Point[]): number =>
      kept.reduce((s, i) => s + dist(at(ps, i), previous.get(at(JA, i)) ?? { x: 0, y: 0 }), 0)
    const aligned = layoutTexts(JA, previous)
    expect(sumTo(aligned)).toBeLessThan(sumTo(layoutTexts(JA)))
    expect(sumTo(aligned)).toBeLessThan(0.5)
  })
})

describe('spreadPick', () => {
  const ps: Point[] = [
    { x: 0, y: 0 },
    { x: 0.05, y: 0 },
    { x: 0, y: 0.05 },
    { x: 0.05, y: 0.05 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: -1 },
    { x: -1, y: -1 },
  ]

  test('picks are more spread than the naive first four', () => {
    const picks = spreadPick(ps, 4)
    expect(picks.length).toBe(4)
    expect(new Set(picks).size).toBe(4)
    expect(minPairwise(picks.map(i => at(ps, i)))).toBeGreaterThan(minPairwise(ps.slice(0, 4)))
    expect(minPairwise(picks.map(i => at(ps, i)))).toBeGreaterThanOrEqual(1.4)
  })

  test('seed is respected and the result is deterministic', () => {
    expect(spreadPick(ps, 3, 1)[0]).toBe(1)
    expect(spreadPick(ps, 4)).toEqual(spreadPick(ps, 4))
  })

  test('count larger than n returns all indices', () => {
    expect(spreadPick(ps.slice(0, 3), 5)).toEqual([0, 1, 2])
  })
})

describe('toDirections', () => {
  test('shuffled cardinal points come back as [up, right, down, left]', () => {
    const ps: Point[] = [
      { x: -1, y: 0.1 }, // left
      { x: 0.1, y: -1 }, // down
      { x: 0.05, y: 1 }, // up
      { x: 1, y: -0.1 }, // right
    ]
    expect(toDirections(ps, [0, 1, 2, 3])).toEqual([2, 3, 1, 0])
  })

  test('fewer than 4 picks are returned unchanged', () => {
    const ps: Point[] = [{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 }]
    expect(toDirections(ps, [2, 0, 1])).toEqual([2, 0, 1])
  })
})

describe('nearestTo', () => {
  test('finds the obviously nearest text', () => {
    const texts = ['Add CSV output to the export', 'Fix the login bug', 'Write release notes']
    expect(nearestTo(texts, 'login is broken, fix it')).toBe(1)
    expect(nearestTo(JA, 'エクスポートのテストを追加したい')).toBe(0)
  })

  test('returns -1 for no texts', () => {
    expect(nearestTo([], 'anything')).toBe(-1)
  })
})
