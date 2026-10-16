import { describe, expect, test } from 'claude-code/testing'

import { addExtras, arrangeSet, pickFromPool, placeAmong } from '../hooks/arrange'
import { cleanText, parseBlend, parseChoices, parseExtras, parseSelect, summarizeMessages } from '../hooks/compass'
import { layoutTexts, nearestTo, similarityMatrix, tokensOf } from '../hooks/similarity'
import type { CompassSet } from '../types'
import { compass, mountPane, pickAt, stand } from './state-helpers'

/**
 * Inputs at the edge: empty strings, whitespace, symbols only, and replies or
 * conversations that mix Japanese and English in one line. Nothing throws,
 * nothing empty is kept, and what is kept is kept whole.
 */

const SET = (parsed: NonNullable<ReturnType<typeof parseChoices>>): CompassSet => ({
  id: 1,
  ...arrangeSet(parsed, [], new Map()),
  isMapPending: false,
  isRefining: false,
  timings: { contextMs: 0, choicesMs: null, extrasMs: null, layoutMs: null, bandMs: null, mapMs: null, isPrefetched: false },
})

describe('empty and whitespace input', () => {
  test('an empty reply gives no four, no extras, no blend', () => {
    expect(parseChoices('')).toBe(null)
    expect(parseChoices('   \n\n\t')).toBe(null)
    expect(parseExtras('', 8)).toEqual([])
    expect(parseExtras('\n\n', 8)).toEqual([])
    expect(parseBlend('')).toBe(null)
    expect(parseBlend('   ')).toBe(null)
    expect(parseBlend('""')).toBe(null)
    expect(cleanText('')).toBe(null)
    expect(cleanText(' \n ')).toBe(null)
    expect(cleanText(undefined)).toBe(null)
  })

  test('a four with one blank line is not four', () => {
    expect(parseChoices(['AXES: a | b | c | d', '1: Ship it', '2:   ', '3: Check', '4: Harden'].join('\n'))).toBe(null)
  })

  test('extras keep no blank bullets and no bullet of only a dash', () => {
    expect(parseExtras(['- ', '-', '- Real one', '• ', '1. ', '2.  Another'].join('\n'), 8)).toEqual(['Real one', 'Another'])
  })

  test('a select reply that names nothing for a line is not a pick', () => {
    const pool = [{ text: 'Ship it', x: 0, y: 0, isPrimary: false }]
    expect(parseSelect(['AXES: a | b | c | d', '1: #1', '2:', '3: Check', '4: Harden'].join('\n'), pool)).toBe(null)
  })

  test('empty messages summarize to their role alone and never throw', () => {
    const summary = summarizeMessages([
      { role: 'user', text: '', toolUses: [] },
      { role: 'assistant', text: '   ', toolUses: [{ tool: 'Read', input: { file_path: '' } }] },
    ])
    expect(summary.split('\n')).toEqual(['user: ', 'assistant:  [tools: Read]'])
  })

  test('the similarity space takes empty texts without throwing and keeps the rest apart', () => {
    expect(tokensOf('')).toEqual([])
    expect(tokensOf('   ')).toEqual([])
    const sim = similarityMatrix(['', 'Ship it', ''])
    expect(sim[1]?.[1]).toBe(1)
    expect(sim[0]?.[1]).toBe(0)
    expect(layoutTexts([''])).toEqual([{ x: 0, y: 0 }])
    const points = layoutTexts(['', 'Ship it', 'Check the output'])
    expect(points).toHaveLength(3)
    points.forEach(p => expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true))
    expect(nearestTo(['Ship it', 'Check'], '')).toBe(-1)
    expect(nearestTo([], 'anything')).toBe(-1)
  })

  test('an empty goal clears the goal; a blank one too', async ($, on) => {
    const engine = stand(on)
    await compass($, 'goal ship it')
    expect(engine.state('goal')).toBe('ship it')
    await compass($, 'goal    ')
    expect(engine.state('goal')).toBe(null)
  })

  test('a pool of empty lines prepares nothing: the four are made afresh at the turn end', async ($, on) => {
    const engine = stand(on, { replies: { POOL: '- \n-\n   \n' } })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await engine.clock.settle()
    await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await engine.clock.settle()
    expect(engine.count('POOL')).toBe(1)
    expect(engine.count('SELECT')).toBe(0)
    expect(engine.count('CHOICES')).toBe(1)
    expect(engine.four()).toHaveLength(4)
  })
})

describe('symbols-only input', () => {
  test('a symbols-only instruction is kept as written: the model wrote it, the person reads it', () => {
    const set = parseChoices(['AXES: ↑ | → | ↓ | ←', '1: ???', '2: !!!', '3: ---', '4: ...'].join('\n'))
    expect(set?.items.map(i => i.text)).toEqual(['???', '!!!', '---', '...'])
    expect(set?.axes).toEqual({ up: '↑', right: '→', down: '↓', left: '←' })
  })

  test('four identical symbol lines are not four', () => {
    expect(parseChoices(['AXES: a | b | c | d', '1: ***', '2: ***', '3: ***', '4: ***'].join('\n'))).toBe(null)
  })

  test('symbol-only texts lay out without NaN and apart from each other', () => {
    const texts = ['???', '!!!', '---', '...', '***']
    expect(tokensOf('???')).toEqual(['??', '??'])
    const points = layoutTexts(texts)
    expect(points).toHaveLength(5)
    points.forEach(p => expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true))
    points.forEach((p, i) => points.forEach((q, j) => { if (i < j) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(0.01) }))
  })

  test('a symbols-only newcomer joins an existing map off the centre and off every spot', () => {
    const parsed = parseChoices(['AXES: a | b | c | d', '1: Ship it', '2: Widen the scope', '3: Check the output', '4: Add tests'].join('\n'))
    if (parsed === null) throw new Error('four expected')
    const set = SET(parsed)
    const next = addExtras(set, ['※※※', '→→→'])
    const spots = next.items.map(i => ({ x: i.x, y: i.y }))
    spots.forEach((a, i) => spots.forEach((b, j) => { if (i < j) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(0.15 - 1e-9) }))
    next.items.slice(4).forEach(i => expect(Math.hypot(i.x, i.y)).toBeGreaterThanOrEqual(0.15 - 1e-9))
    expect(placeAmong([], ['#'])).toEqual([{ x: 0, y: 0 }])
  })

  test('a symbols-only goal is kept and seeds nothing it does not resemble', () => {
    const pool = ['Ship it', 'Widen the scope', 'Check the output', 'Add tests', 'Profile the build']
    const withGoal = pickFromPool(pool, '###', new Map())
    const without = pickFromPool(pool, null, new Map())
    expect(withGoal?.parsed.items.map(i => i.text)).toEqual(without?.parsed.items.map(i => i.text))
  })
})

describe('replies that mix Japanese and English in one line', () => {
  test('a four whose lines each mix both scripts parses whole, numbering styles included', () => {
    const set = parseChoices(['AXES: 進める | widen | 確かめる | harden', '1) README を English で書き直して', '2. CHANGELOG に「parser fix」を追加して', '3: npm test を再実行して flaky かどうか見て', '4: parsePairs() の edge case テストを足して'].join('\n'))
    expect(set?.items.map(i => i.text)).toEqual([
      'README を English で書き直して',
      'CHANGELOG に「parser fix」を追加して',
      'npm test を再実行して flaky かどうか見て',
      'parsePairs() の edge case テストを足して',
    ])
  })

  test('a select reply mixing scripts in its names and picks resolves by number', () => {
    const pool = ['README を English で書き直して', 'Profile the parser', 'npm test を再実行して'].map(text => ({ text, x: 0, y: 0, isPrimary: false }))
    const picked = parseSelect(['AXES: 進める/forward | 広げる | check | 固める', '1: #1 (docs)', '2: #2 — profiling', '3: #3', '4: parser.ts の型を strict にして'].join('\n'), pool)
    expect(picked?.parsed.items.map(i => i.text)).toEqual(['README を English で書き直して', 'Profile the parser', 'npm test を再実行して', 'parser.ts の型を strict にして'])
    expect(picked?.parsed.axes.up).toBe('進める/forward')
  })

  test('a blend reply in mixed scripts keeps its inner quotes; only outer ASCII quotes go', () => {
    expect(parseBlend('"README を更新しつつ "parser fix" の CHANGELOG entry を足して"')).toBe('README を更新しつつ "parser fix" の CHANGELOG entry を足して')
    expect(parseBlend('「README を更新して」')).toBe('「README を更新して」')
  })

  test('extras mixing scripts with inner whitespace are kept as one line each', () => {
    expect(parseExtras(['- parser.ts   の型を\tstrict にして', '- Open a PR  titled 「parser fix」'].join('\n'), 8)).toEqual(['parser.ts の型を strict にして', 'Open a PR titled 「parser fix」'])
  })
})

describe('conversations that mix Japanese and English in one message', () => {
  const MESSAGES = [
    { role: 'user', text: 'parser.ts の flaky test を直して。See the CI log: `Error: timeout in parsePairs`', toolUses: [] },
    { role: 'assistant', text: 'parsePairs() の race を直しました。All 12 tests pass now (npm test).', toolUses: [{ tool: 'Bash', input: { command: 'npm test -- --grep "parsePairs" && echo 完了' } }] },
  ]

  test('the summary keeps the mixed line whole, backticks and the command included', () => {
    const summary = summarizeMessages(MESSAGES)
    expect(summary).toContain('See the CI log: `Error: timeout in parsePairs`')
    expect(summary).toContain('All 12 tests pass now (npm test).')
    expect(summary).toContain('Bash(npm test -- --grep "parsePairs" && echo 完了)')
  })

  test('a mixed goal finds the candidate it shares words with, in either script', () => {
    const pool = ['README を English で書き直して', 'Profile the parser', 'npm test を再実行して', 'parser.ts の型を strict にして']
    expect(nearestTo(pool, 'make the parser types strict')).toBe(3)
    expect(nearestTo(pool, 'README を書き直す')).toBe(0)
    expect(nearestTo(pool, 'npm test')).toBe(2)
  })

  test('a mixed pick text reaches the preview whole and is sent as written', async ($, on) => {
    const text = 'parser.ts の型を strict にしてから、open a PR titled 「parser fix」'
    const engine = stand(on, { blendTexts: [text] })
    await compass($, 'refresh')
    const pane = await mountPane($)
    await pickAt(pane, 0.2, -0.3)
    expect(engine.state('preview')?.text).toBe(text)
    await pickAt(pane, 0.2, -0.3)
    expect(engine.submitted).toEqual([text])
  })
})
