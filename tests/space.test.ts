import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, RenderNode, RenderPropsOf } from 'claude-code'

/**
 * The pane's one space: the free field while Claude works melts into the map
 * when the four land, in the same Client instance, and back on a new prompt.
 */

const SPACE = 'space@2'
const TICK_MS = 160
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const CHOICES = [
  'AXES: 進める | 広げる | 調べる | 固める',
  '1: Implement the export feature',
  '2: Refactor the parser module',
  '3: Investigate the flaky test',
  '4: Add tests for the parser',
].join('\n')
/** Three extras, as texts: the map lays them out itself. */
const EXTRAS = ['- Write the README section', '- Profile the build', '- Split the config file'].join('\n')
/** Japanese UI, so the strings the tests read are the ones the person reads. */
const JA = { options: { language: 'ja' } }

const command = (args: string) => ({
  command: 'compass',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})

const PANE_PROPS = {
  title: '意味空間マップ',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { bodyRows: 30, offset: 0 },
  view: {},
} as unknown as RenderPropsOf['Pane']

const replyFor = (prompt: string): string => {
  if (prompt.includes('(CHOICES)')) return CHOICES
  if (prompt.includes('(EXTRAS)')) return EXTRAS
  return ''
}

/** Stands for the engine: canned replies, the pane placed, every submit and fill recorded. */
const engineBeneath = (on: On) => {
  const submitted: string[] = []
  const filled: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', (_$, e) => ({ value: { isAnswered: true as const, text: replyFor(e.prompt), usage: USAGE } }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine') as RenderElement
  })
  return { submitted, filled, clock }
}

const textOf = (node: RenderNode): string =>
  typeof node === 'string' ? node : 'children' in node ? (node.children ?? []).map(textOf).join('') : ''

/** Cells a row takes on the terminal: two for a wide character. */
const cellsOf = (row: string): number =>
  Array.from(row).reduce(
    (n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1),
    0,
  )

const mountPane = ($: Engine) =>
  $.ui.mount({
    plugin: 'next-compass',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'next-compass-map',
    props: PANE_PROPS,
    viewport: { columns: 60, rows: 30 } as never,
  })

type Pane = Awaited<ReturnType<typeof mountPane>>

/** The space's rows as text: the grid first, the two caption rows last. */
const rowsOf = async (pane: Pane): Promise<string[]> => {
  const root = await pane.drawn({ in: SPACE })
  return ('children' in root ? (root.children ?? []) : []).map(textOf)
}

/** The four names; which number each takes depends on where its text landed. */
const NAMES = ['進める', '広げる', '調べる', '固める']
const hasChips = (grid: string): boolean => NAMES.every(n => new RegExp(` [1-4] ${n}`).test(grid))
const anyChip = (grid: string): boolean => NAMES.some(n => new RegExp(` [1-4] ${n}`).test(grid))
const count = (text: string, char: string): number => Array.from(text).filter(c => c === char).length

/** Claude at work in a pane already showing the space: a prompt and two tool calls, so two gems drift. */
const working = async ($: Engine, on: On, size = { columns: 56, rows: 18 }) => {
  const engine = engineBeneath(on)
  const pane = await mountPane($)
  await pane.resize({ ...size, in: SPACE })
  await $.command.run(command('map'))
  await $.turn.start({ text: 'add an export', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await pane.redraw()
  return { engine, pane, grid: async () => (await rowsOf(pane)).slice(0, size.rows - 2).join('\n') }
}

describe('one space from the free field to the map', () => {
  test('the four melt in: the same Client, no chips at first, extras at ~0.3, chips by ~1.1 s', async ($, on) => {
    const { pane, grid } = await working($, on)
    expect(await grid()).toMatch(/[✦✧❖]/)

    await $.command.run(command('refresh'))
    await pane.redraw()
    expect(await pane.find({ key: SPACE })).toBeDefined()
    const start = await grid()
    expect(anyChip(start)).toBe(false)

    await pane.advance(3 * TICK_MS)
    const third = await grid()
    expect(anyChip(third)).toBe(false)

    await pane.advance(6 * TICK_MS)
    expect(await pane.find({ key: SPACE })).toBeDefined()
    const settled = await grid()
    expect(hasChips(settled)).toBe(true)
    expect(settled).not.toMatch(/[✧❖]/)
    expect(count(settled, '✦')).toBe(3)
  })

  test('with no gems, the extras surface before the chips', async ($, on) => {
    engineBeneath(on)
    const pane = await mountPane($)
    await pane.resize({ columns: 56, rows: 18, in: SPACE })
    await $.command.run(command('map'))
    await $.turn.start({ text: 'add an export', turnId: 't1' })
    await pane.redraw()
    const grid = async () => (await rowsOf(pane)).slice(0, 16).join('\n')

    await $.command.run(command('refresh'))
    await pane.redraw()
    expect(count(await grid(), '✦')).toBe(0)

    await pane.advance(3 * TICK_MS)
    const third = await grid()
    expect(count(third, '✦')).toBe(3)
    expect(anyChip(third)).toBe(false)

    await pane.advance(6 * TICK_MS)
    expect(hasChips(await grid())).toBe(true)
  })

  test('a new prompt melts back: the chips go and the caption shows Claude at work', JA, async ($, on) => {
    const { pane, grid } = await working($, on)
    await $.command.run(command('refresh'))
    await pane.redraw()
    await pane.advance(10 * TICK_MS)
    expect(hasChips(await grid())).toBe(true)

    await $.turn.start({ text: 'next step', turnId: 't1' })
    await pane.redraw()
    await pane.advance(10 * TICK_MS)
    const back = await grid()
    expect(anyChip(back)).toBe(false)
    const caption = (await rowsOf(pane)).slice(16).join('\n')
    expect(caption).toContain('Claude が作業中です')
  })

  test('a click while the space is still melting does nothing', async ($, on) => {
    const { engine, pane } = await working($, on)
    await $.command.run(command('refresh'))
    await pane.redraw()
    await pane.advance(2 * TICK_MS)
    await pane.pointer({ type: 'down', x: 28, y: 3, button: 'left' })
    await pane.pointer({ type: 'down', x: 40, y: 10, button: 'left' })
    expect(engine.filled).toEqual([])
    expect(engine.submitted).toEqual([])
  })
})

describe('flux while Claude works', () => {
  test('waiting for the person, the empty pane is still; it moves only once Claude works', JA, async ($, on) => {
    engineBeneath(on)
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    const ui = await mountPane($)
    await ui.resize({ columns: 48, rows: 14, in: SPACE })
    const idle = await rowsOf(ui)
    await ui.advance(1000)
    expect((await rowsOf(ui)).slice(0, 12)).toEqual(idle.slice(0, 12))

    await $.turn.start({ text: 'fix the parser', turnId: 't1' })
    await ui.redraw()
    const working = await rowsOf(ui)
    await ui.advance(700)
    expect((await rowsOf(ui)).slice(0, 12)).not.toEqual(working.slice(0, 12))

    // The turn ends without an answer (aborted): nothing to show, the field settles and stops.
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
    await ui.advance(2000)
    const settled = await rowsOf(ui)
    await ui.advance(1000)
    expect((await rowsOf(ui)).slice(0, 12)).toEqual(settled.slice(0, 12))
  })

  test('the empty pane moves, and each tool call drifts in as a gem, never as text', JA, async ($, on) => {
    engineBeneath(on)
    const ui = await mountPane($)
    await ui.resize({ columns: 48, rows: 14, in: SPACE })
    expect(await ui.find({ in: SPACE, text: /返答が終わると/ })).toBeDefined()

    await $.turn.start({ text: 'fix the parser', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/app/register.tsx' })
    await ui.redraw()
    expect(await ui.find({ in: SPACE, text: /作業中/ })).toBeDefined()
    const label = (await ui.findAll({ in: SPACE, type: 'Text' })).filter(t => t.text.length === 1 && '作業中'.includes(t.text))
    expect(label.length).toBeGreaterThanOrEqual(3)
    const before = await rowsOf(ui)
    expect(before.join('\n')).not.toContain('register.tsx')
    expect(before.slice(0, 12).join('\n')).toMatch(/[✦✧❖]/)

    await ui.advance(700)
    const after = await rowsOf(ui)
    expect(after.slice(0, 12)).not.toEqual(before.slice(0, 12))
    expect(after.slice(0, 12).every(r => cellsOf(r) === 48)).toBe(true)
  })

  test('the working label names the kinds of work with one gem per call, never a count', JA, async ($, on) => {
    engineBeneath(on)
    const ui = await mountPane($)
    await ui.resize({ columns: 80, rows: 14, in: SPACE })
    await $.turn.start({ text: 'fix the parser', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await ui.redraw()
    const rows = (await rowsOf(ui)).join('\n')
    expect(rows).toContain('Claude が作業中です · 読み取り(✦✦) · 編集(✦) · コマンド実行(✦)')
    expect(rows).not.toMatch(/件の操作|意味空間が動いて/)
  })
})

describe('big spaces stay drawn', () => {
  /** A Client's tree past 100,000 serialized characters is unmounted by the engine. */
  const LIMIT = 100_000

  for (const columns of [120, 200, 400]) {
    test(`both moments fit the tree and keep every row at ${columns}x48`, async ($, on) => {
      const size = { columns, rows: 48 }
      const { pane } = await working($, on, size)
      await pane.advance(5 * TICK_MS)
      const flux = await pane.drawn({ in: SPACE })
      expect(JSON.stringify(flux).length).toBeLessThan(LIMIT)
      expect((await rowsOf(pane)).slice(0, size.rows - 2).map(cellsOf)).toEqual(Array(size.rows - 2).fill(columns))

      await $.command.run(command('refresh'))
      await pane.redraw()
      await pane.advance(10 * TICK_MS)
      const map = await pane.drawn({ in: SPACE })
      expect(JSON.stringify(map).length).toBeLessThan(LIMIT)
      const rows = (await rowsOf(pane)).slice(0, size.rows - 2)
      expect(rows.map(cellsOf)).toEqual(Array(size.rows - 2).fill(columns))
      expect(hasChips(rows.join('\n'))).toBe(true)
    })
  }
})
