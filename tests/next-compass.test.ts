import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, RenderNode, RenderPropsOf } from 'claude-code'

/**
 * The mod end to end through the engine: the band, the map pane's space, the
 * pool prepared while Claude works. Parsing and the local layout are in
 * parse.test.ts; single state edges in state*.test.ts.
 */

const CHOICES = [
  'AXES: 進める | 広げる | 調べる | 固める',
  '1: Implement the export feature',
  '2: Refactor the parser module',
  '3: Investigate the flaky test',
  '4: Add tests for the parser',
].join('\n')

const EXTRAS = ['- Write the README section', '- Profile the build', '- Split the config file'].join('\n')

/** Japanese UI, so the strings the tests read are the ones the person reads. */
const JA = { options: { language: 'ja' } }

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

/** What the prefetch prepares while Claude works: six candidates, texts only. */
const POOL_TEXTS = [
  'Ship the export feature',
  'Add CSV to the export',
  'Check the export output by hand',
  'Add tests for the export',
  'Document the export command',
  'Clean up the export module',
]
const POOL = POOL_TEXTS.map(t => `- ${t}`).join('\n')

/** The end-of-turn pick: three by number, one written anew. */
const SELECT = ['AXES: 進める | 広げる | 確かめる | 固める', '1: #1', '2: #2', '3: Ask which format matters most', '4: #4'].join('\n')

const replyFor = (prompt: string, blendText: string): string => {
  if (prompt.includes('(POOL)')) return POOL
  if (prompt.includes('(SELECT)')) return SELECT
  if (prompt.includes('(CHOICES)')) return CHOICES
  if (prompt.includes('(EXTRAS)')) return EXTRAS
  return blendText
}

/** How the engine answers: the select call failing or late, the pool late, the pane placed or not. */
type ModelBehavior = { failSelect?: boolean; selectDelayMs?: number; poolDelayMs?: number; placed?: boolean }

const engineBeneath = (on: On, submitted: string[], behavior: ModelBehavior = {}) => {
  const asked: string[] = []
  const models: string[] = []
  const filled: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', async (_$, e) => {
    asked.push(e.prompt)
    models.push(e.model)
    const isSelect = e.prompt.includes('(SELECT)')
    if (isSelect && behavior.failSelect === true) {
      return { value: { isAnswered: false as const, reason: 'aborted' as const, usage: USAGE } }
    }
    const delay = isSelect ? behavior.selectDelayMs : e.prompt.includes('(POOL)') ? behavior.poolDelayMs : undefined
    if (delay !== undefined) await clock.sleep(delay)
    const text = replyFor(e.prompt, 'Refactor and document the parser')
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', () => ({ value: (behavior.placed === false ? { isPlaced: false } : { isPlaced: true }) as never }))
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

/** How many model calls carried the marker. */
const asked = (engine: readonly string[], marker: string): number => engine.filter(p => p.includes(marker)).length

/** The text of a drawn node, its children joined. */
const textOf = (node: RenderNode): string =>
  typeof node === 'string' ? node : 'children' in node ? (node.children ?? []).map(textOf).join('') : ''

/** Cells a row takes on the terminal: two for a wide character. */
const cellsOf = (row: string): number =>
  Array.from(row).reduce((n, c) => n + (/[⺀-꓏가-힣＀-｠]/.test(c) ? 2 : 1), 0)

/** The pane's one Client: the free field while Claude works, the map once the four are in. */
const SPACE = 'space@2'

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

/** The four directions' chips as the map draws them: some number, then the name that followed its text. */
const CHIP_NAMES = ['進める', '広げる', '調べる', '固める']
const hasChips = (grid: string): boolean => CHIP_NAMES.every(n => new RegExp(` [1-4] ${n}`).test(grid))

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
    const shown = (await ui.find({ key: 'pick:1' }))?.text ?? ''
    await ui.press({ key: 'pick:1' })
    expect(submitted).toHaveLength(1)
    expect(shown).toContain(submitted[0] ?? '-')
    expect(await ui.find({ text: 'engine' })).toBeDefined()
  })

  test('without the map pane one CHOICES call and no extras call', async ($, on) => {
    const asked = engineBeneath(on, [], { placed: false })
    await $.command.run(OPEN_MAP)
    await $.command.run(REFRESH)
    expect(asked.filter(p => p.includes('(EXTRAS)'))).toHaveLength(0)
    expect(asked.filter(p => p.includes('(CHOICES)'))).toHaveLength(1)
  })
})

describe('map', () => {
  test('one CHOICES call and one EXTRAS call, no other; the status shows both times', JA, async ($, on) => {
    const asked = engineBeneath(on, [])
    await $.command.run(OPEN_MAP)
    await $.command.run(REFRESH)
    await asked.clock.settle()
    expect(asked.filter(p => p.includes('(CHOICES)'))).toHaveLength(1)
    expect(asked.filter(p => p.includes('(EXTRAS)'))).toHaveLength(1)
    expect(asked).toHaveLength(2)
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
      expect(hasChips(map)).toBe(true)
      expect(Array.from(map).filter(c => c === '✦')).toHaveLength(3)
    })
  }

  test('a click writes the instruction for its spot and shows it; a second click there sends it', async ($, on) => {
    const submitted: string[] = []
    const engine = engineBeneath(on, submitted)
    await $.command.run(OPEN_MAP)
    await $.command.run(REFRESH)
    const ui = await mountMap($)
    await ui.resize({ columns: 40, rows: 16, in: SPACE })
    await ui.advance(MELT_MS)
    await ui.pointer({ type: 'down', x: 28, y: 10, button: 'left' })
    await ui.redraw()
    expect(engine.filled).toEqual([])
    expect(submitted).toEqual([])
    expect(await ui.find({ in: SPACE, text: /Refactor and document the parser/ })).toBeDefined()

    await ui.pointer({ type: 'down', x: 28, y: 10, button: 'left' })
    expect(submitted).toEqual(['Refactor and document the parser'])
    expect(engine.filled).toEqual([])
    expect(asked(engine, '(BLEND)')).toBe(1)
  })

  test('shift on the second click fills the prompt box instead', async ($, on) => {
    const submitted: string[] = []
    const engine = engineBeneath(on, submitted)
    await $.command.run(OPEN_MAP)
    await $.command.run(REFRESH)
    const ui = await mountMap($)
    await ui.resize({ columns: 40, rows: 16, in: SPACE })
    await ui.advance(MELT_MS)
    await ui.pointer({ type: 'down', x: 10, y: 4, button: 'left' })
    await ui.pointer({ type: 'down', x: 10, y: 4, button: 'left', shift: true })
    expect(engine.filled).toEqual(['Refactor and document the parser'])
    expect(submitted).toEqual([])
  })
})

describe('a settled map', () => {
  test('is still while it waits for a pick: its colors mean positions', async ($, on) => {
    engineBeneath(on, [])
    await $.command.run(OPEN_MAP)
    await $.command.run(REFRESH)
    const ui = await mountMap($)
    await ui.resize({ columns: 48, rows: 14, in: SPACE })
    await ui.advance(MELT_MS)
    const grid = async () => {
      const root = await ui.drawn({ in: SPACE })
      return ('children' in root ? (root.children ?? []) : []).map(textOf).slice(0, 12)
    }
    const before = await grid()
    await ui.advance(1000)
    const after = await grid()
    expect(after).toEqual(before)
    expect(hasChips(after.join('\n'))).toBe(true)
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
      expect(hasChips(textOf(map))).toBe(true)
    })
  }
})

describe('candidates prepared while Claude works', () => {
  const count = (asked: readonly string[], marker: string) => asked.filter(p => p.includes(marker)).length
  const END = { answer: 'Exported the report.', durationMs: 9000, isAborted: false, turnId: 't1', reason: 'answer' as const }
  const SUBMIT = { text: 'add an export', origin: { kind: 'composer' as const }, wait: false }
  const mountBand = ($: Engine) =>
    $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  /** The four buttons' texts as the band draws them. */
  const bandTexts = async (band: Awaited<ReturnType<typeof mountBand>>) =>
    (await Promise.all([0, 1, 2, 3].map(i => band.find({ key: `pick:${i}` })))).flatMap(b => (b === undefined ? [] : [b.text]))

  test('the first tool call starts preparing, and the end shows four at once, then refines', JA, async ($, on) => {
    const submitted: string[] = []
    const asked = engineBeneath(on, submitted, { selectDelayMs: 1500 })
    on('tool.call', () => ({ result: 'ok' }))
    await $.turn.start({ text: SUBMIT.text, turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await asked.clock.settle()
    expect(count(asked, '(POOL)')).toBe(1)

    await $.turn.complete(END)
    await asked.clock.settle()
    const band = await mountBand($)
    expect(await bandTexts(band)).toHaveLength(4)
    expect((await bandTexts(band)).every(t => POOL_TEXTS.some(p => t.includes(p)))).toBe(true)
    expect(await band.find({ text: /回答に合わせて調整中/ })).toBeDefined()
    expect(count(asked, '(CHOICES)')).toBe(0)
    expect(count(asked, '(EXTRAS)')).toBe(0)

    await asked.clock.advance(1500)
    await band.redraw()
    expect(await band.find({ text: /Ask which format matters most/ })).toBeDefined()
    expect(await band.find({ text: /調整中/ })).toBe(undefined)
    const shown = (await band.find({ key: 'pick:0' }))?.text ?? ''
    await band.press({ key: 'pick:0' })
    expect(submitted).toHaveLength(1)
    expect(shown).toContain(submitted[0] ?? '-')
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

  test('what was not picked is on the map at once', JA, async ($, on) => {
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
    const asked = engineBeneath(on, [], { poolDelayMs: 1000 })
    on('tool.call', () => ({ result: 'ok' }))
    await $.turn.start({ text: SUBMIT.text, turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await asked.clock.settle()
    await $.turn.complete(END)
    await asked.clock.advance(1000)
    await asked.clock.settle()
    expect(count(asked, '(CHOICES)')).toBe(0)
    expect(count(asked, '(SELECT)')).toBe(1)
    expect(await bandTexts(await mountBand($))).toHaveLength(4)
  })

  test('a failed pick keeps the four shown at once', JA, async ($, on) => {
    const asked = engineBeneath(on, [], { failSelect: true })
    await $.turn.start({ text: SUBMIT.text, turnId: 't1' })
    await asked.clock.advance(3500)
    await $.turn.complete(END)
    await asked.clock.settle()
    const band = await mountBand($)
    const texts = await bandTexts(band)
    expect(texts).toHaveLength(4)
    expect(texts.every(t => POOL_TEXTS.some(p => t.includes(p)))).toBe(true)
    expect(await band.find({ text: /調整中/ })).toBe(undefined)
    expect(count(asked, '(CHOICES)')).toBe(0)
  })
})
