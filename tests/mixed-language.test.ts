import { describe, expect, test } from 'claude-code/testing'

import { arrangeSet, repick } from '../hooks/arrange'
import { buildChoicesPrompt, parseChoices, parseExtras, parseSelect, summarizeMessages } from '../hooks/compass'
import { layoutTexts, similarityMatrix, tokensOf } from '../hooks/similarity'
import type { CompassSet } from '../types'
import { compass, endTurn, mountPane, stand, startTurn } from './state-helpers'

/**
 * Conversations and model replies that mix Japanese and English: file names,
 * English logs and Japanese requests in one transcript, candidates in both
 * languages. The mod keeps every text whole, lays them out together, and asks
 * the model for one language regardless of what the conversation mixes.
 */

const MIXED_MESSAGES = [
  { role: 'user', text: 'parser.ts の flaky test を直して', toolUses: [] },
  {
    role: 'assistant',
    text: 'Fixed the race in parsePairs(). テストは全部通りました。\nnpm test → 12 passed',
    toolUses: [
      { tool: 'Edit', input: { file_path: '/work/app/src/parser.ts' } },
      { tool: 'Bash', input: { command: 'npm test -- --grep "parsePairs"' } },
    ],
  },
  { role: 'user', text: 'README も英語で更新して', toolUses: [] },
]

const MIXED_FOUR = [
  'AXES: 進める | widen | 確かめる | harden',
  '1: README の Install section を英語で書き直して',
  '2: Add a CHANGELOG entry for the parser fix',
  '3: npm test をもう一度回して flaky でないか確かめて',
  '4: parsePairs() にエッジケースのテストを追加して',
].join('\n')

const MIXED_EXTRAS = [
  '- Profile the parser on a large input',
  '- parser.ts の型を厳しくして',
  '- Open a PR titled "Fix parsePairs race"',
  '- parser.ts の型を厳しくして',
].join('\n')

describe('a transcript that mixes Japanese and English', () => {
  test('the summary keeps both languages, the file and the command', () => {
    const summary = summarizeMessages(MIXED_MESSAGES)
    expect(summary).toContain('parser.ts の flaky test を直して')
    expect(summary).toContain('Fixed the race in parsePairs()')
    expect(summary).toContain('テストは全部通りました')
    expect(summary).toContain('Edit(/work/app/src/parser.ts)')
    expect(summary).toContain('Bash(npm test -- --grep "parsePairs")')
    expect(summary.split('\n')).toHaveLength(3)
  })

  test('the prompt still names one language whatever the transcript mixes', () => {
    const transcript = summarizeMessages(MIXED_MESSAGES)
    const ja = buildChoicesPrompt({ goal: 'ship v1 by Friday', transcript, lang: 'ja' }).map(b => b.text).join('\n')
    const en = buildChoicesPrompt({ goal: '金曜までに v1 を出す', transcript, lang: 'en' }).map(b => b.text).join('\n')
    expect(ja).toContain('in Japanese')
    expect(ja).not.toContain('in English')
    expect(en).toContain('in English')
    expect(en).not.toContain('in Japanese')
    // The goal and the transcript travel as they are, in whatever language they were written.
    expect(ja).toContain('ship v1 by Friday')
    expect(en).toContain('金曜までに v1 を出す')
  })
})

describe('model replies that mix the two languages', () => {
  test('four mixed-language choices parse whole, with their mixed axis names', () => {
    const set = parseChoices(MIXED_FOUR)
    expect(set).not.toBe(null)
    expect(set?.items.map(i => i.text)).toEqual([
      'README の Install section を英語で書き直して',
      'Add a CHANGELOG entry for the parser fix',
      'npm test をもう一度回して flaky でないか確かめて',
      'parsePairs() にエッジケースのテストを追加して',
    ])
    expect(set?.axes).toEqual({ up: '進める', right: 'widen', down: '確かめる', left: 'harden' })
  })

  test('mixed extras parse whole and a repeated Japanese line counts once', () => {
    expect(parseExtras(MIXED_EXTRAS, 8)).toEqual([
      'Profile the parser on a large input',
      'parser.ts の型を厳しくして',
      'Open a PR titled "Fix parsePairs race"',
    ])
  })

  test('a select reply may pick a Japanese candidate by number and write an English one', () => {
    const pool = ['README の Install section を英語で書き直して', 'Profile the parser on a large input', 'npm test をもう一度回して', 'parser.ts の型を厳しくして'].map(text => ({
      text,
      x: 0,
      y: 0,
      isPrimary: false,
    }))
    const picked = parseSelect(['AXES: 進める | 広げる | check | harden', '1: #1', '2: Open a PR for the parser fix', '3: #3', '4: #4'].join('\n'), pool)
    expect(picked?.parsed.items.map(i => i.text)).toEqual([
      'README の Install section を英語で書き直して',
      'Open a PR for the parser fix',
      'npm test をもう一度回して',
      'parser.ts の型を厳しくして',
    ])
    expect(picked?.used).toEqual([0, 2, 3])
  })
})

describe('mixed-language candidates on one map', () => {
  const TEXTS = [
    'README の Install section を英語で書き直して',
    'Add a CHANGELOG entry for the parser fix',
    'npm test をもう一度回して flaky でないか確かめて',
    'parsePairs() にエッジケースのテストを追加して',
    'Profile the parser on a large input',
    'parser.ts の型を厳しくして',
  ]

  test('tokens of a mixed text hold both the Latin words and the character bigrams', () => {
    const tokens = tokensOf('parser.ts の型を厳しくして')
    expect(tokens).toContain('parser')
    expect(tokens).toContain('ts')
    expect(tokens.some(t => t === '厳し' || t === 'しく')).toBe(true)
  })

  test('shared identifiers pull a Japanese and an English text together', () => {
    const sim = similarityMatrix(['parsePairs() にエッジケースのテストを追加して', 'Add a test for parsePairs()', 'Profile the build on big data'])
    expect(sim[0]?.[1] ?? 0).toBeGreaterThan(sim[0]?.[2] ?? 0)
  })

  test('six mixed texts land on six distinct spots inside the square, the same every time', () => {
    const points = layoutTexts(TEXTS)
    expect(points).toHaveLength(6)
    points.forEach((p, i) => {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(0.85 + 1e-6)
      expect(Math.abs(p.y)).toBeLessThanOrEqual(0.85 + 1e-6)
      points.forEach((q, j) => {
        if (i < j) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(0.01)
      })
    })
    expect(layoutTexts(TEXTS)).toEqual(points)
  })

  test('a mixed four arranged with mixed extras keeps every text and every axis name', () => {
    const parsed = parseChoices(MIXED_FOUR)
    expect(parsed).not.toBe(null)
    if (parsed === null) return
    const set = arrangeSet(parsed, TEXTS.slice(4), new Map())
    expect(set.items.filter(i => i.isPrimary)).toHaveLength(4)
    expect(set.items.map(i => i.text).sort()).toEqual(TEXTS.slice().sort())
    expect([set.axes.up, set.axes.right, set.axes.down, set.axes.left].sort()).toEqual(['harden', 'widen', '確かめる', '進める'].sort())
  })

  test('a re-pick that swaps a Japanese choice for an English one keeps the others where they were', () => {
    const parsed = parseChoices(MIXED_FOUR)
    if (parsed === null) throw new Error('four expected')
    const before: CompassSet = { id: 1, ...arrangeSet(parsed, [], new Map()), isMapPending: false, isRefining: true, timings: { contextMs: 0, choicesMs: null, extrasMs: null, layoutMs: null, bandMs: null, mapMs: null, isPrefetched: true } }
    const kept = before.items.slice(0, 3).map(i => i.text)
    const next = repick(before, { axes: parsed.axes, items: [...kept, 'Open a PR titled "Fix parsePairs race"'].map(text => ({ text, x: 0, y: 0, isPrimary: true })) }, [])
    for (const text of kept) {
      const was = before.items.find(i => i.text === text)
      const is = next.items.find(i => i.text === text)
      expect([is?.x, is?.y]).toEqual([was?.x, was?.y])
    }
    expect(next.items.filter(i => !i.isPrimary).map(i => i.text)).toEqual([before.items[3]?.text])
  })
})

describe('the language option against a mixed conversation', () => {
  const mixedReplies = {
    CHOICES: MIXED_FOUR,
    EXTRAS: MIXED_EXTRAS,
    POOL: ['- README の Install section を英語で書き直して', '- Add a CHANGELOG entry for the parser fix', '- npm test をもう一度回して', '- parser.ts の型を厳しくして', '- Profile the parser on a large input', '- Open a PR for the parser fix'].join('\n'),
  }

  test('auto with a Japanese Claude Code asks every call for Japanese, even over an English-heavy transcript', async ($, on) => {
    const engine = stand(on, { settings: { language: 'Japanese' }, replies: mixedReplies, messages: MIXED_MESSAGES })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    await compass($, 'map')
    await startTurn($)
    await $.tool.call({ tool: 'Read', file_path: '/work/app/src/parser.ts' })
    await engine.clock.settle()
    await endTurn($)
    await engine.clock.settle()
    expect(engine.prompts.length).toBeGreaterThan(0)
    for (const prompt of engine.prompts) {
      expect(prompt).toContain('in Japanese')
      expect(prompt).not.toContain('in English')
    }
  })

  test('choiceLanguage en overrides a Japanese UI for the predictions alone', { options: { choiceLanguage: 'en' } }, async ($, on) => {
    const engine = stand(on, { settings: { language: 'Japanese' }, replies: mixedReplies, messages: MIXED_MESSAGES })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    const opened = await compass($, 'map')
    expect(opened.text).toBe('マップを開きました。')
    await compass($, 'refresh')
    await engine.clock.settle()
    expect(engine.prompts.length).toBeGreaterThan(0)
    for (const prompt of engine.prompts) expect(prompt).toContain('in English')
  })

  test('mixed-language four reach the band whole, and a mixed pick on the map is sent as written', async ($, on) => {
    const engine = stand(on, { replies: mixedReplies, blendTexts: ['README を英語で更新しつつ、a CHANGELOG entry も足して'] })
    await compass($, 'refresh')
    await engine.clock.settle()
    expect(engine.four()).toEqual([
      'README の Install section を英語で書き直して',
      'Add a CHANGELOG entry for the parser fix',
      'npm test をもう一度回して flaky でないか確かめて',
      'parsePairs() にエッジケースのテストを追加して',
    ].sort((a, b) => (engine.four()?.indexOf(a) ?? 0) - (engine.four()?.indexOf(b) ?? 0)))
    const pane = await mountPane($)
    await pane.post({ kind: 'pick', x: 0.3, y: 0.3, fill: false, previewShownWhole: true }, { in: 'space@2' })
    await engine.clock.settle()
    expect(engine.state('preview')?.text).toBe('README を英語で更新しつつ、a CHANGELOG entry も足して')
    await pane.post({ kind: 'pick', x: 0.3, y: 0.3, fill: false, previewShownWhole: true, isOnPreview: true }, { in: 'space@2' })
    expect(engine.submitted).toEqual(['README を英語で更新しつつ、a CHANGELOG entry も足して'])
  })
})
