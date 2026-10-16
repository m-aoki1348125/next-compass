import { describe, expect, test } from 'claude-code/testing'

import { addExtras, arrangeSet, pickFromPool, placeAmong, repick } from '../hooks/arrange'
import { BLEND_TOP, buildBlendPrompt, buildChoicesPrompt, buildExtrasPrompt, buildPoolPrompt, buildSelectPrompt, parseBlend, parseChoices, parseExtras, sharesAt, weightsAt } from '../hooks/compass'
import { resolveLang } from '../hooks/i18n'
import type { CompassChoice, CompassSet } from '../types'

/** Parsing the model's replies, the weights at a spot, and the local layout from texts to a set. */

const CHOICES = [
  'AXES: 進める | 広げる | 調べる | 固める',
  '1: Implement the export feature',
  '2: Refactor the parser module',
  '3: Investigate the flaky test',
  '4: Add tests for the parser',
].join('\n')

const NAMES: Record<string, string> = {
  'Implement the export feature': '進める',
  'Refactor the parser module': '広げる',
  'Investigate the flaky test': '調べる',
  'Add tests for the parser': '固める',
}

const LIMIT = 0.85 + 1e-6

const inside = (items: readonly CompassChoice[]): boolean => items.every(i => Math.abs(i.x) <= LIMIT && Math.abs(i.y) <= LIMIT)

const parsed = () => {
  const set = parseChoices(CHOICES)
  if (set === null) throw new Error('CHOICES did not parse')
  return set
}

describe('parseChoices', () => {
  test('reads four choices in reply order and the axes, with no position yet', () => {
    const set = parseChoices(`Sure.\n${CHOICES}`)
    expect(set?.items.map(i => i.text)).toEqual(Object.keys(NAMES))
    expect(set?.items.every(i => i.isPrimary && i.x === 0 && i.y === 0)).toBe(true)
    expect(set?.axes).toEqual({ up: '進める', right: '広げる', down: '調べる', left: '固める' })
  })

  test('rejects a reply missing one of the four', () => {
    expect(parseChoices('1: a\n2: b\n3: c')).toBe(null)
  })

  test('rejects four lines with one instruction twice', () => {
    expect(parseChoices('1: Ship it\n2: Test it\n3: Ship it\n4: Document it')).toBe(null)
  })

  test('keeps the first line for a number given twice, and works without AXES', () => {
    const set = parseChoices('1: a\n1: z\n2: b\n3: c\n4: d')
    expect(set?.items.map(i => i.text)).toEqual(['a', 'b', 'c', 'd'])
    expect(set?.axes).toEqual({ up: '', right: '', down: '', left: '' })
  })
})

describe('parseExtras', () => {
  test('reads "- ", "* " and numbered lines, deduplicated, at most count', () => {
    const text = ['Here you go:', '- Write the README', '* Profile the build', '3. Split the config', '- Write the README', '- One more'].join('\n')
    expect(parseExtras(text, 8)).toEqual(['Write the README', 'Profile the build', 'Split the config', 'One more'])
    expect(parseExtras(text, 2)).toEqual(['Write the README', 'Profile the build'])
  })

  test('takes no coordinates apart: a line is its text, whatever it starts with', () => {
    expect(parseExtras('- 0.4 0.4 Write it', 4)).toEqual(['0.4 0.4 Write it'])
    expect(parseExtras('no list here', 4)).toEqual([])
  })
})

describe('parseBlend', () => {
  test('strips quotes and squeezes whitespace; empty is null', () => {
    expect(parseBlend('"Refactor  and\n document the parser"')).toBe('Refactor and document the parser')
    expect(parseBlend('  ')).toBe(null)
  })
})

describe('weights at a spot', () => {
  const items: CompassChoice[] = [
    { text: 'up', x: 0, y: 0.8, isPrimary: true },
    { text: 'right', x: 0.8, y: 0, isPrimary: true },
    { text: 'down', x: 0, y: -0.8, isPrimary: true },
    { text: 'left', x: -0.8, y: 0, isPrimary: true },
    { text: 'extra', x: 0.5, y: 0.5, isPrimary: false },
  ]

  test('weightsAt: every item, heaviest first, the nearest on top, summing to 1', () => {
    const w = weightsAt({ x: 0.8, y: 0 }, items)
    expect(w).toHaveLength(items.length)
    expect(w[0]?.index).toBe(1)
    expect(Math.abs(w.reduce((s, x) => s + x.weight, 0) - 1)).toBeLessThan(1e-9)
    expect(w.every((x, i) => i === 0 || (w[i - 1]?.weight ?? 0) >= x.weight)).toBe(true)
  })

  test('sharesAt: the top three renormalized among themselves', () => {
    const s = sharesAt({ x: 0.3, y: 0.3 }, items)
    expect(s).toHaveLength(BLEND_TOP)
    expect(Math.abs(s.reduce((sum, x) => sum + x.weight, 0) - 1)).toBeLessThan(1e-9)
    expect(s.map(x => x.index)).toEqual(weightsAt({ x: 0.3, y: 0.3 }, items).slice(0, BLEND_TOP).map(x => x.index))
  })

  test('sharesAt with fewer items than the top keeps them all', () => {
    expect(sharesAt({ x: 0, y: 0 }, items.slice(0, 2))).toHaveLength(2)
    expect(sharesAt({ x: 0, y: 0 }, [])).toEqual([])
  })
})

describe('arrangeSet', () => {
  const extras = ['Write the README section', 'Profile the build', 'Split the config file']

  test('four primaries first with distinct texts, then the extras, all inside the square', () => {
    const set = arrangeSet(parsed(), extras, new Map())
    expect(set.items.slice(0, 4).every(i => i.isPrimary)).toBe(true)
    expect(set.items.slice(4).map(i => i.text)).toEqual(extras)
    expect(set.items.slice(4).every(i => !i.isPrimary)).toBe(true)
    expect(new Set(set.items.slice(0, 4).map(i => i.text)).size).toBe(4)
    expect([...set.items.slice(0, 4).map(i => i.text)].sort()).toEqual(Object.keys(NAMES).sort())
    expect(inside(set.items)).toBe(true)
  })

  test("each axis name follows its text to whichever direction it took", () => {
    const set = arrangeSet(parsed(), extras, new Map())
    const four = set.items.slice(0, 4).map(i => i.text)
    expect([set.axes.up, set.axes.right, set.axes.down, set.axes.left]).toEqual(four.map(t => NAMES[t]))
  })

  test('an extra equal to one of the four, or given twice, is laid once', () => {
    const set = arrangeSet(parsed(), ['Add tests for the parser', 'Profile the build', 'Profile the build'], new Map())
    expect(set.items.map(i => i.text).filter(t => t === 'Profile the build')).toHaveLength(1)
    expect(set.items.map(i => i.text).filter(t => t === 'Add tests for the parser')).toHaveLength(1)
    expect(set.items).toHaveLength(5)
  })

  test('the same texts give the same set', () => {
    expect(arrangeSet(parsed(), extras, new Map())).toEqual(arrangeSet(parsed(), extras, new Map()))
  })
})

describe('pickFromPool', () => {
  const POOL = [
    'Ship the export feature',
    'Add CSV output to the export',
    'Check the export output by hand',
    'Add tests for the export',
    'Document the export command',
    'Clean up the export module',
    'Measure the export speed on big data',
  ]

  test('null below four candidates', () => {
    expect(pickFromPool(POOL.slice(0, 3), null, new Map())).toBe(null)
  })

  test('four distinct primaries first, the rest of the pool as extras, nothing lost', () => {
    const picked = pickFromPool(POOL, null, new Map())
    const items = picked?.parsed.items ?? []
    expect(items.slice(0, 4).every(i => i.isPrimary)).toBe(true)
    expect(items.slice(4).every(i => !i.isPrimary)).toBe(true)
    expect(new Set(items.slice(0, 4).map(i => i.text)).size).toBe(4)
    expect([...items.map(i => i.text)].sort()).toEqual([...POOL].sort())
    expect(picked?.used).toHaveLength(4)
    expect(picked?.used.map(i => POOL[i])).toEqual(items.slice(0, 4).map(i => i.text))
    expect(inside(items)).toBe(true)
  })

  test('spread: the four are farther apart than the closest pair in the pool', () => {
    const items = pickFromPool(POOL, null, new Map())?.parsed.items ?? []
    const gaps = (ps: readonly CompassChoice[]) => ps.flatMap((a, i) => ps.slice(i + 1).map(b => Math.hypot(a.x - b.x, a.y - b.y)))
    expect(Math.min(...gaps(items.slice(0, 4)))).toBeGreaterThan(Math.min(...gaps(items)))
  })

  test('a goal seeds the pick with the candidate nearest it', () => {
    const picked = pickFromPool(POOL, 'measure speed on big data', new Map())
    expect(picked?.parsed.items.slice(0, 4).map(i => i.text)).toContain('Measure the export speed on big data')
  })
})

describe('addExtras', () => {
  const base = (): CompassSet => ({
    id: 1,
    ...arrangeSet(parsed(), ['Profile the build'], new Map()),
    isMapPending: true,
    isRefining: false,
    timings: { contextMs: 0, choicesMs: null, extrasMs: null, layoutMs: null, bandMs: null, mapMs: null, isPrefetched: false },
  })

  test('keeps the items it had, in order and still primary, and adds the new ones after', () => {
    const set = base()
    const next = addExtras(set, ['Write the README section', 'Split the config file'])
    expect(next.items.slice(0, set.items.length).map(i => [i.text, i.isPrimary])).toEqual(set.items.map(i => [i.text, i.isPrimary]))
    expect(next.items.slice(set.items.length).map(i => i.text)).toEqual(['Write the README section', 'Split the config file'])
    expect(next.items.slice(set.items.length).every(i => !i.isPrimary)).toBe(true)
    expect(inside(next.items)).toBe(true)
    expect(set.items).toHaveLength(5)
  })

  test('deduplicates against the set and within the new texts; nothing new returns the same set', () => {
    const set = base()
    const next = addExtras(set, ['Profile the build', 'Implement the export feature', 'Open a PR', 'Open a PR'])
    expect(next.items.map(i => i.text).filter(t => t === 'Open a PR')).toHaveLength(1)
    expect(next.items).toHaveLength(set.items.length + 1)
    expect(addExtras(set, ['Profile the build'])).toBe(set)
  })
})

describe('resolveLang', () => {
  test('the option wins; auto reads Japanese settings in their forms, anything else is English', () => {
    expect(resolveLang('en', 'ja')).toBe('en')
    expect(resolveLang('ja', undefined)).toBe('ja')
    for (const s of ['ja', 'ja-JP', 'Japanese', '日本語']) expect(resolveLang('auto', s)).toBe('ja')
    for (const s of [undefined, '', 'en', 'Javanese', 'jav']) expect(resolveLang('auto', s)).toBe('en')
  })
})

describe('a map that does not move under the person', () => {
  const base = () => ({
    id: 1,
    ...arrangeSet(parsed(), ['Profile the build', 'Clean up the export module'], new Map()),
    isMapPending: false,
    isRefining: true,
    timings: { contextMs: 0, choicesMs: null, extrasMs: null, layoutMs: null, bandMs: null, mapMs: null, isPrefetched: true },
  })

  test('addExtras keeps every existing spot exactly and places newcomers apart from them', () => {
    const set = base()
    const next = addExtras(set, ['Write the README section', 'Measure speed on big data'])
    set.items.forEach((item, i) => expect(next.items[i]).toEqual(item))
    const spots = next.items.map(i => [i.x, i.y] as const)
    spots.forEach((a, i) => spots.forEach((b, j) => { if (i < j) expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThanOrEqual(0.15 - 1e-9) }))
  })

  test('placeAmong puts a newcomer near the placed text it resembles', () => {
    const placed = [
      { text: 'Add tests for the parser', spot: { x: -0.8, y: 0 } },
      { text: 'Write the README section', spot: { x: 0.8, y: 0 } },
    ]
    const [p] = placeAmong(placed, ['Add more tests for the parser module'])
    expect(p).toBeDefined()
    expect((p?.x ?? 0) < 0).toBe(true)
  })

  test('repick keeps known texts where they were and demotes the rest to extras', () => {
    const set = base()
    const kept = set.items.find(i => i.isPrimary)
    const picked = {
      axes: { up: 'a', right: 'b', down: 'c', left: 'd' },
      items: [kept?.text ?? '', 'Profile the build', 'Brand new step', 'Another new step'].map(text => ({ text, x: 0, y: 0, isPrimary: true })),
    }
    const next = repick(set, picked, ['Clean up the export module'])
    const primaries = next.items.filter(i => i.isPrimary)
    expect(primaries).toHaveLength(4)
    const again = next.items.find(i => i.text === kept?.text)
    expect([again?.x, again?.y]).toEqual([kept?.x, kept?.y])
    const profile = next.items.find(i => i.text === 'Profile the build')
    const before = set.items.find(i => i.text === 'Profile the build')
    expect([profile?.x, profile?.y]).toEqual([before?.x, before?.y])
    expect(next.items.filter(i => !i.isPrimary).map(i => i.text)).toContain('Clean up the export module')
    expect(new Set(next.items.map(i => i.text)).size).toBe(next.items.length)
  })
})

describe('one language for every instruction', () => {
  const ctx = (lang: 'ja' | 'en') => ({ goal: null, transcript: 'user: fix the parser', lang })
  const text = (blocks: readonly { text: string }[]) => blocks.map(b => b.text).join('\n')

  test('the choices, extras and pool prompts name the language and never say "the language the user writes in"', () => {
    for (const lang of ['ja', 'en'] as const) {
      const name = lang === 'ja' ? 'Japanese' : 'English'
      for (const prompt of [buildChoicesPrompt(ctx(lang)), buildExtrasPrompt({ ...ctx(lang), count: 3 }), buildPoolPrompt({ ...ctx(lang), count: 6 })]) {
        expect(text(prompt)).toContain(`in ${name}`)
        expect(text(prompt)).not.toContain('language the user writes in')
      }
    }
  })

  test('the select and blend prompts name the language too', () => {
    const pool = [{ text: 'a', x: 0, y: 0, isPrimary: false }]
    expect(text(buildSelectPrompt({ answer: 'done', pool, goal: null, suggestion: null, lang: 'en' }))).toContain('in English')
    expect(text(buildSelectPrompt({ answer: 'done', pool, goal: null, suggestion: null, lang: 'ja' }))).not.toContain('language of the candidates')
    const axes = { up: '', right: '', down: '', left: '' }
    expect(text(buildBlendPrompt({ point: { x: 0, y: 0 }, axes, items: pool, goal: null, lang: 'ja' }))).toContain('in Japanese')
  })
})
