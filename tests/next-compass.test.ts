import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, RenderNode, RenderPropsOf } from 'claude-code'

import { parseChoices, parseExtras, parsePlacedExtras, parsePlacement, weightsAt } from '../hooks/compass'

const CHOICES = [
  'AXES: 進める | 広げる | 調べる | 固める',
  '1: Implement the export feature',
  '2: Refactor the parser module',
  '3: Investigate the flaky test',
  '4: Add tests for the parser',
].join('\n')

const EXTRAS = ['- Write the README section', '- Profile the build', '- Split the config file'].join('\n')

/** Self-placed extras from the two split halves, crowded at almost the same spot. */
const EXTRAS_A = ['0.4 0.4 Write the README section', '0.41 0.4 Profile the build'].join('\n')
const EXTRAS_B = ['0.4 0.41 Split the config file'].join('\n')

/** Every extra asked for at almost the same spot, so the map has to spread them. */
const PLACE_CROWDED = ['1 0.4 0.4', '2 0.41 0.4', '3 0.4 0.41'].join('\n')

const REFRESH = {
  command: 'compass',
  args: 'refresh',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}

const OPEN_MAP = { ...REFRESH, args: 'map' }

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { bodyRows: 12, offset: 0 } as unknown as RenderPropsOf['AbovePrompt']['scroll'],
  view: {} as RenderPropsOf['AbovePrompt']['view'],
}

const PANE_PROPS = {
  title: '意味空間マップ',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { bodyRows: 30, offset: 0 },
  view: {},
} as unknown as RenderPropsOf['Pane']

/** Which prompt a model call is, by the marker each prompt carries. */
const PAIR_V = ['AXIS: 進める | 調べる', '1: Implement the export feature', '3: Investigate the flaky test'].join('\n')
const PAIR_H = ['AXIS: 広げる | 固める', '2: Refactor the parser module', '4: Add tests for the parser'].join('\n')

/** What the prefetch prepares while Claude works: six placed candidates. */
const POOL = [
  '0.1 0.8 Ship the export feature',
  '0.7 0.2 Add CSV to the export',
  '0.1 -0.7 Check the export output by hand',
  '-0.8 0.1 Add tests for the export',
  '0.5 0.5 Document the export command',
  '-0.4 -0.4 Clean up the export module',
].join('\n')

/** The end-of-turn pick: three by number, one written anew. */
const SELECT = ['AXES: 進める | 広げる | 確かめる | 固める', '1: #1', '2: #2', '3: Ask which format matters most', '4: #4'].join('\n')

const replyFor = (prompt: string, place: string, blendText: string): string => {
  if (prompt.includes('(POOL)')) return POOL
  if (prompt.includes('(SELECT)')) return SELECT
  if (prompt.includes('(CHOICES)')) return CHOICES
  if (prompt.includes('(CHOICES-V)')) return PAIR_V
  if (prompt.includes('(CHOICES-H)')) return PAIR_H
  if (prompt.includes('(EXTRAS)')) return EXTRAS
  if (prompt.includes('(EXTRAS-A)')) return EXTRAS_A
  if (prompt.includes('(EXTRAS-B)')) return EXTRAS_B
  if (prompt.includes('(PLACE)')) return place
  return blendText
}

/** Stands for the engine: canned model replies, an empty transcript, the pane placed, submits recorded. */
/** How the engine's model answers: the select call failing, or answering only after a delay. */
type ModelBehavior = { failSelect?: boolean; selectDelayMs?: number; poolDelayMs?: number }

const engineBeneath = (on: On, submitted: string[], place = PLACE_CROWDED, behavior: ModelBehavior = {}) => {
  const asked: string[] = []
  const models: string[] = []
  const filled: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('model.complete', async (_$, e) => {
    asked.push(e.prompt)
    models.push(e.model)
    const isSelect = e.prompt.includes('(SELECT)')
    if (isSelect && behavior.failSelect === true) {
      return { value: { isAnswered: false as const, reason: 'aborted' as const, usage: USAGE } }
    }
    const delay = isSelect ? behavior.selectDelayMs : e.prompt.includes('(POOL)') ? behavior.poolDelayMs : undefined
    if (delay !== undefined) await clock.sleep(delay)
    const text = replyFor(e.prompt, place, 'Refactor and document the parser')
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
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
  return Object.assign(asked, { clock, models, filled })
}

/** The text of a drawn node, its children joined. */
const textOf = (node: RenderNode): string =>
  typeof node === 'string' ? node : 'children' in node ? (node.children ?? []).map(textOf).join('') : ''

/** Cells a row takes on the terminal: two for a wide character. */
const cellsOf = (row: string): number =>
  Array.from(row).reduce((n, c) => n + (/[⺀-꓏가-힣＀-｠]/.test(c) ? 2 : 1), 0)

/** The pane's one Client: the free field while Claude works, the map once the four are in. */
const SPACE = 'space@1'

/** Ticks of the space's frame clock that take it from the free field all the way to the map. */
const MELT_MS = 1200

const mountMap = ($: Engine) =>
  $.ui.mount({
    plugin: 'next-compass',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'next-compass-map',
    props: PANE_PROPS,
    viewport: { columns: 60, rows: 30 } as never,
  })

describe('parsing', () => {
  test('reads four choices and the axes', () => {
    const set = parseChoices(`Sure.\n${CHOICES}`)
    expect(set?.items).toHaveLength(4)
    expect(set?.axes.left).toBe('固める')
    expect(set?.items[1]).toEqual({ text: 'Refactor the parser module', x: 0.8, y: 0, isPrimary: true })
  })

  test('rejects a reply missing one of the four', () => {
    expect(parseChoices('1: a\n2: b\n3: c')).toBe(null)
  })

  test('reads extras and fills placements the reply left out', () => {
    expect(parseExtras(`${EXTRAS}\n- Profile the build`, 8)).toHaveLength(3)
    const points = parsePlacement('1 0.5 -0.2\n3 2 2', 3)
    expect(points[0]).toEqual({ x: 0.5, y: -0.2 })
    expect(points[2]).toEqual({ x: 0.9, y: 0.9 })
    expect(points[1]).toBeDefined()
  })

  test('weights favor the nearest item', () => {
    const top = weightsAt({ x: 0.8, y: 0 }, parseChoices(CHOICES)?.items ?? [])[0]
    expect(top?.index).toBe(1)
  })
})

describe('band', () => {
  test('shows four choices and sends the pressed one as the user', async ($, on) => {
    const submitted: string[] = []
    engineBeneath(on, submitted)
    await $.command.run(REFRESH)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'next-compass', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.findAll({ type: 'Button', key: 'pick:3' })).toHaveLength(1)
      expect(await ui.find({ text: /Refactor the parser/ })).toBeDefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    await ui.press({ key: 'pick:1' })
    expect(submitted).toEqual(['Refactor the parser module'])
    expect(await ui.find({ text: 'engine' })).toBeDefined()
  })

  test('without the map pane no extras call is made', async ($, on) => {
    const asked = engineBeneath(on, [])
    await $.command.run(REFRESH)
    expect(asked.filter(p => p.includes('(EXTRAS'))).toHaveLength(0)
    expect(asked.filter(p => p.includes('(CHOICES-V)'))).toHaveLength(1)
    expect(asked.filter(p => p.includes('(CHOICES-H)'))).toHaveLength(1)
  })
})

describe('map', () => {
  test('split: two self-placing extras halves, no placing call, merged into one set', async ($, on) => {
    const asked = engineBeneath(on, [])
    await $.command.run(OPEN_MAP)
    await $.command.run(REFRESH)
    expect(asked.filter(p => p.includes('(EXTRAS-A)'))).toHaveLength(1)
    expect(asked.filter(p => p.includes('(EXTRAS-B)'))).toHaveLength(1)
    expect(asked.filter(p => p.includes('(PLACE)'))).toHaveLength(0)
    const ui = await mountMap($)
    expect(await ui.find({ text: /4択 \d/ })).toBeDefined()
    expect(await ui.find({ text: /マップ \d/ })).toBeDefined()
  })

  test('single: one call of four, extras as texts, then a placing call', { options: { choiceMode: 'single' } }, async ($, on) => {
    const asked = engineBeneath(on, [])
    await $.command.run(OPEN_MAP)
    await $.command.run(REFRESH)
    expect(asked.filter(p => p.includes('(CHOICES)'))).toHaveLength(1)
    expect(asked.filter(p => p.includes('(EXTRAS)'))).toHaveLength(1)
    expect(asked.filter(p => p.includes('(PLACE)'))).toHaveLength(1)
    const ui = await mountMap($)
    expect(await ui.find({ text: /4択 \d/ })).toBeDefined()
    expect(await ui.find({ text: /マップ \d/ })).toBeDefined()
  })

  for (const size of [
    { columns: 56, rows: 18 },
    { columns: 36, rows: 12 },
  ]) {
    test(`chips and extras never overlap at ${size.columns}x${size.rows}`, async ($, on) => {
      engineBeneath(on, [])
      await $.command.run(OPEN_MAP)
      await $.command.run(REFRESH)
      const ui = await mountMap($)
      await ui.resize({ ...size, in: SPACE })
      const root = await ui.drawn({ in: SPACE })
      const rows = ('children' in root ? (root.children ?? []) : []).map(textOf).slice(0, size.rows - 2)
      const map = rows.join('\n')
      expect(rows.every(r => cellsOf(r) === size.columns)).toBe(true)
      for (const label of [' 1 進める', ' 2 広げる', ' 3 調べる', ' 4 固める']) expect(map).toContain(label)
      expect(Array.from(map).filter(c => c === '✦')).toHaveLength(3)
    })
  }

  test('a pick near a choice sends it, a pick between choices puts a blend in the prompt box', async ($, on) => {
    const submitted: string[] = []
    const engine = engineBeneath(on, submitted)
    await $.command.run(OPEN_MAP)
    await $.command.run(REFRESH)
    const ui = await mountMap($)
    await ui.resize({ columns: 40, rows: 16, in: SPACE })
    await ui.post({ kind: 'pick', x: -0.8, y: 0, fill: false }, { in: SPACE })
    expect(submitted).toEqual(['Add tests for the parser'])

    await $.command.run(REFRESH)
    await ui.redraw()
    await ui.advance(MELT_MS)
    await ui.pointer({ type: 'down', x: 28, y: 10, button: 'left' })
    expect(engine.filled).toEqual(['Refactor and document the parser'])
    expect(submitted).toEqual(['Add tests for the parser'])
  })
})

describe('flux while Claude works', () => {
  const rowsOf = async (ui: Awaited<ReturnType<typeof mountMap>>) => {
    const root = await ui.drawn({ in: SPACE })
    return ('children' in root ? (root.children ?? []) : []).map(textOf)
  }

  test('the empty pane moves, and each tool call drifts in as a gem, never as text', async ($, on) => {
    engineBeneath(on, [])
    on('tool.call', () => ({ result: 'ok' }))
    const ui = await mountMap($)
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
})

describe('the space keeps breathing', () => {
  test('the map keeps breathing while it waits for a pick', async ($, on) => {
    engineBeneath(on, [])
    await $.command.run(OPEN_MAP)
    await $.command.run(REFRESH)
    const ui = await mountMap($)
    await ui.resize({ columns: 48, rows: 14, in: SPACE })
    const grid = async () => {
      const root = await ui.drawn({ in: SPACE })
      return ('children' in root ? (root.children ?? []) : []).map(textOf).slice(0, 12)
    }
    const before = await grid()
    await ui.advance(1000)
    const after = await grid()
    expect(after).not.toEqual(before)
    expect(after.join('\n')).toContain(' 3 調べる')
  })
})

describe('big panes stay drawn', () => {
  /** A Client's tree past 100,000 serialized characters is unmounted by the engine. */
  const LIMIT = 100_000

  for (const size of [
    { columns: 90, rows: 45 },
    { columns: 120, rows: 60 },
  ]) {
    test(`flux and map fit the tree at ${size.columns}x${size.rows}`, async ($, on) => {
      engineBeneath(on, [])
      on('tool.call', () => ({ result: 'ok' }))
      const ui = await mountMap($)
      await $.turn.start({ text: 'x', turnId: 't1' })
      for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Bash', command: 'ls' })
      await ui.redraw()
      await ui.resize({ ...size, in: SPACE })
      await ui.advance(900)
      expect(JSON.stringify(await ui.drawn({ in: SPACE })).length).toBeLessThan(LIMIT)

      await $.command.run(OPEN_MAP)
      await $.command.run(REFRESH)
      await ui.redraw()
      await ui.resize({ ...size, in: SPACE })
      await ui.advance(MELT_MS)
      const map = await ui.drawn({ in: SPACE })
      expect(JSON.stringify(map).length).toBeLessThan(LIMIT)
      expect(textOf(map)).toContain('3 調べる')
    })
  }
})

describe('candidates prepared while Claude works', () => {
  const count = (asked: readonly string[], marker: string) => asked.filter(p => p.includes(marker)).length
  const END = { answer: 'Exported the report.', durationMs: 9000, isAborted: false, turnId: 't1', reason: 'answer' as const }
  const SUBMIT = { text: 'add an export', origin: { kind: 'composer' as const }, wait: false }
  const mountBand = ($: Engine) =>
    $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  test('the first tool call starts preparing, and the end shows four at once, then refines', async ($, on) => {
    const submitted: string[] = []
    const asked = engineBeneath(on, submitted, PLACE_CROWDED, { selectDelayMs: 1500 })
    on('tool.call', () => ({ result: 'ok' }))
    await $.turn.start({ text: SUBMIT.text, turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await asked.clock.settle()
    expect(count(asked, '(POOL)')).toBe(1)

    await $.turn.complete(END)
    await asked.clock.settle()
    const band = await mountBand($)
    expect(await band.find({ text: /Check the export output by hand/ })).toBeDefined()
    expect(await band.find({ text: /回答に合わせて調整中/ })).toBeDefined()
    expect(count(asked, '(CHOICES')).toBe(0)

    await asked.clock.advance(1500)
    await band.redraw()
    expect(await band.find({ text: /Ask which format matters most/ })).toBeDefined()
    expect(await band.find({ text: /調整中/ })).toBe(undefined)
    await band.press({ key: 'pick:0' })
    expect(submitted.at(-1)).toBe('Ship the export feature')
  })

  test('preparing and picking use haiku whatever writes the rest', { options: { generator: 'sonnet' } }, async ($, on) => {
    const asked = engineBeneath(on, [])
    on('tool.call', () => ({ result: 'ok' }))
    await $.turn.start({ text: SUBMIT.text, turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await asked.clock.settle()
    await $.turn.complete(END)
    await asked.clock.settle()
    const fast = asked.flatMap((p, i) => (p.includes('(POOL)') || p.includes('(SELECT)') ? [asked.models[i]] : []))
    expect(fast).toEqual(['haiku', 'haiku'])
  })

  test('what was not picked is on the map at once', async ($, on) => {
    const asked = engineBeneath(on, [])
    on('tool.call', () => ({ result: 'ok' }))
    await $.turn.start({ text: SUBMIT.text, turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await asked.clock.settle()
    await $.turn.complete(END)
    await asked.clock.settle()
    const ui = await mountMap($)
    await ui.resize({ columns: 56, rows: 18, in: SPACE })
    const root = await ui.drawn({ in: SPACE })
    const grid = ('children' in root ? (root.children ?? []) : []).map(textOf).slice(0, 16).join('')
    expect(Array.from(grid).filter(c => c === '✦')).toHaveLength(3)
    expect(await ui.find({ text: /（作業中に準備）/ })).toBeDefined()
  })

  test('a turn with no tool calls starts preparing after three seconds', async ($, on) => {
    const asked = engineBeneath(on, [])
    await $.turn.start({ text: SUBMIT.text, turnId: 't1' })
    await asked.clock.advance(2500)
    expect(count(asked, '(POOL)')).toBe(0)
    await asked.clock.advance(1000)
    expect(count(asked, '(POOL)')).toBe(1)
  })

  test('the end waits briefly for a pool still being prepared', async ($, on) => {
    const asked = engineBeneath(on, [], PLACE_CROWDED, { poolDelayMs: 1000 })
    on('tool.call', () => ({ result: 'ok' }))
    await $.turn.start({ text: SUBMIT.text, turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await asked.clock.settle()
    await $.turn.complete(END)
    await asked.clock.advance(1000)
    await asked.clock.settle()
    expect(count(asked, '(CHOICES')).toBe(0)
    expect(await (await mountBand($)).find({ text: /Ship the export feature/ })).toBeDefined()
  })

  test('a failed pick keeps the four shown at once', async ($, on) => {
    const asked = engineBeneath(on, [], PLACE_CROWDED, { failSelect: true })
    await $.turn.start({ text: SUBMIT.text, turnId: 't1' })
    await asked.clock.advance(3500)
    await $.turn.complete(END)
    await asked.clock.settle()
    const band = await mountBand($)
    expect(await band.find({ text: /Ship the export feature/ })).toBeDefined()
    expect(await band.find({ text: /Add tests for the export/ })).toBeDefined()
    expect(await band.find({ text: /調整中/ })).toBe(undefined)
    expect(count(asked, '(CHOICES')).toBe(0)
  })
})

describe('placed lines as a fast model writes them', () => {
  test('reads bullets, commas, parentheses, x= and numbering, and keeps a leading minus', () => {
    const lines = [
      '- 0.1, 0.8: Ship it',
      '(0.7, 0.2) Add CSV',
      'x=0.1 y=-0.7 Check by hand',
      '3. -0.8 0.1 — Add tests',
      '-0.4 -0.4 Clean up',
      'no numbers here',
    ].join('\n')
    expect(parsePlacedExtras(lines, 8).map(c => [c.x, c.y, c.text])).toEqual([
      [0.1, 0.8, 'Ship it'],
      [0.7, 0.2, 'Add CSV'],
      [0.1, -0.7, 'Check by hand'],
      [-0.8, 0.1, 'Add tests'],
      [-0.4, -0.4, 'Clean up'],
    ])
  })
})
