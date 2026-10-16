import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, RenderNode, RenderPropsOf } from 'claude-code'

import { parseSelect } from '../hooks/compass'
import type { CompassChoice } from '../types'

const POOL: CompassChoice[] = [
  { text: 'Ship the export feature', x: 0.1, y: 0.8, isPrimary: false },
  { text: 'Add CSV to the export', x: 0.7, y: 0.2, isPrimary: false },
  { text: 'Check the export output by hand', x: 0.1, y: -0.7, isPrimary: false },
  { text: 'Add tests for the export', x: -0.8, y: 0.1, isPrimary: false },
  { text: 'Document the export command', x: 0.5, y: 0.5, isPrimary: false },
]

const select = (lines: string[]) => ['AXES: a | b | c | d', ...lines].join('\n')

describe('parseSelect edge cases', () => {
  test('a number outside the pool gives null, never a literal "#9"', () => {
    expect(parseSelect(select(['1: #1', '2: #2', '3: #9', '4: #4']), POOL)).toBe(null)
  })

  test('"#3 (note)" and "#3 - reason" resolve to the candidate', () => {
    const picked = parseSelect(select(['1: #1 (still fits)', '2: #2 - widens', '3: #3', '4: #4 — tests']), POOL)
    expect(picked?.parsed.items.map(i => i.text)).toEqual([
      'Ship the export feature',
      'Add CSV to the export',
      'Check the export output by hand',
      'Add tests for the export',
    ])
    expect(picked?.used).toEqual([0, 1, 2, 3])
  })

  test('new instructions mix with numbered ones; used names only the pool entries taken', () => {
    const picked = parseSelect(select(['1: #5', '2: Ask which format matters', '3: #3', '4: Write the changelog']), POOL)
    expect(picked?.parsed.items.map(i => i.text)).toEqual([
      'Document the export command',
      'Ask which format matters',
      'Check the export output by hand',
      'Write the changelog',
    ])
    expect(picked?.used).toEqual([2, 4])
  })

  test('a number glued to letters stays unresolved and gives null', () => {
    expect(parseSelect(select(['1: #12abc', '2: #2', '3: #3', '4: #4']), POOL)).toBe(null)
  })

  test('the same candidate twice gives null', () => {
    expect(parseSelect(select(['1: #1', '2: #1', '3: #3', '4: #4']), POOL)).toBe(null)
  })
})

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const LONG_V = '進'.repeat(16)
const LONG_H = '広'.repeat(16)

const CHOICES = [
  `AXES: ${LONG_V} | ${LONG_H} | ${'調'.repeat(16)} | ${'固'.repeat(16)}`,
  '1: Implement the export feature',
  '2: Refactor the parser module',
  '3: Investigate the flaky test',
  '4: Add tests for the parser',
].join('\n')

const COMMAND = {
  command: 'next',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}

const PANE_PROPS = {
  title: '意味空間マップ',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { bodyRows: 30, offset: 0 },
  view: {},
} as unknown as RenderPropsOf['Pane']

const engineBeneath = (on: On) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', (_$, e) => {
    const text = e.prompt.includes('(CHOICES)') ? CHOICES : 'none'
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('session.messages', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine') as RenderElement
  })
}

const textOf = (node: RenderNode): string =>
  typeof node === 'string' ? node : 'children' in node ? (node.children ?? []).map(textOf).join('') : ''

const cellsOf = (row: string): number =>
  Array.from(row).reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0)

const mountMap = ($: Engine) =>
  $.ui.mount({
    plugin: 'next-compass',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'next-compass-map',
    props: PANE_PROPS,
    viewport: { columns: 60, rows: 30 } as never,
  })

describe('chips on a narrow map', () => {
  for (const size of [
    { columns: 20, rows: 10 },
    { columns: 14, rows: 8 },
  ]) {
    test(`long CJK direction names never widen a row at ${size.columns}x${size.rows}`, async ($, on) => {
      engineBeneath(on)
      await $.command.run({ ...COMMAND, args: 'map' })
      await $.command.run({ ...COMMAND, args: 'refresh' })
      const ui = await mountMap($)
      await ui.resize({ ...size, in: 'space@2' })
      const root = await ui.drawn({ in: 'space@2' })
      const rows = ('children' in root ? (root.children ?? []) : []).map(textOf).slice(0, size.rows - 2)
      expect(rows).toHaveLength(size.rows - 2)
      expect(rows.map(cellsOf)).toEqual(rows.map(() => size.columns))
      const grid = rows.join('\n')
      for (const n of ['1', '2', '3', '4']) expect(grid).toMatch(new RegExp(` ${n} `))
    })
  }
})
