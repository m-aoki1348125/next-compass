import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, RenderNode, RenderPropsOf } from 'claude-code'

import { compass, stand } from './state-helpers'

const DEMO = {
  command: 'compass',
  args: 'demo',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}

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

/** Japanese UI: the demo's texts and toasts are read as the person reads them. */
const JA = { options: { language: 'ja' } }

const MAP = { columns: 56, rows: 18 }
/** The map's grid rows: the region less the blend bar and the caption. */
const GRID_ROWS = MAP.rows - 2

/** Stands for the engine: every model call, prompt and toast recorded; the pane placed. */
const engineBeneath = (on: On) => {
  const asked: string[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', (_$, e) => {
    asked.push(e.prompt)
    return { value: { isAnswered: true as const, text: '', usage: USAGE } }
  })
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine') as RenderElement
  })
  return { asked, submitted, toasts, clock }
}

const textOf = (node: RenderNode): string =>
  typeof node === 'string' ? node : 'children' in node ? (node.children ?? []).map(textOf).join('') : ''

const mountPane = ($: Engine) =>
  $.ui.mount({
    plugin: 'next-compass',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'next-compass-map',
    props: PANE_PROPS,
    viewport: { columns: 60, rows: 30 } as never,
  })

const mountBand = ($: Engine) =>
  $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: BAND })

/** The pane's one Client: the free field while Claude works, the map once the four are in. */
const SPACE = 'space@2'

/** The space's frame clock time the melt from the free field to the map takes, with room to spare. */
const MELT_MS = 1200

/** The map's grid rows as text, laid out at MAP's size. */
const gridOf = async (ui: Awaited<ReturnType<typeof mountPane>>): Promise<string[]> => {
  await ui.resize({ ...MAP, in: SPACE })
  const root = await ui.drawn({ in: SPACE })
  return ('children' in root ? (root.children ?? []) : []).map(textOf).slice(0, GRID_ROWS)
}

const gems = (rows: readonly string[]): number => Array.from(rows.join('')).filter(c => c === '✦').length

/** The row the pointer ✛ is on, or -1. */
const pointerRow = (rows: readonly string[]): number => rows.findIndex(r => r.includes('✛'))

describe('demo mode', () => {
  // The script plays 16 s of frames at 120 ms, some 130 redraws of the space: given time on a loaded machine.
  test('plays from Claude working to four picked from the space, calling no model and sending nothing', { ...JA, timeoutMs: 20_000 }, async ($, on) => {
    const engine = engineBeneath(on)
    await $.command.run(DEMO)
    const pane = await mountPane($)

    await engine.clock.advance(3000)
    await pane.redraw()
    expect(await pane.find({ in: SPACE, text: /（デモ）Claude が作業中/ })).toBeDefined()

    await engine.clock.advance(2500)
    await pane.redraw()
    // The eight surface as the space melts into the map; once it has, the gems are gone and only the eight remain.
    await pane.advance(MELT_MS)
    const pool = await gridOf(pane)
    expect(gems(pool)).toBe(8)
    expect(pool.join('\n')).not.toContain('仕上げる')
    const band = await mountBand($)
    expect(await band.find({ text: /デモ：空間から4択を選んでいます/ })).toBeDefined()

    await engine.clock.advance(1500)
    await pane.redraw()
    const two = (await gridOf(pane)).join('\n')
    expect(two).toContain(' 1 仕上げる')
    expect(two).toContain(' 2 広げる')
    expect(gems(two.split('\n'))).toBe(6)

    await engine.clock.advance(3500)
    await pane.redraw()
    const four = await gridOf(pane)
    for (const chip of [' 1 仕上げる', ' 2 広げる', ' 3 確かめる', ' 4 固める']) expect(four.join('\n')).toContain(chip)
    expect(pointerRow(four)).toBe(GRID_ROWS / 2)
    await band.redraw()
    expect(await band.find({ text: /次の一手（デモ）/ })).toBeDefined()
    for (const text of ['エクスポート機能を仕上げて', 'JSON 出力', '実際に開いて確認', 'テストを追加']) {
      expect(await band.find({ text: new RegExp(text) })).toBeDefined()
    }
    for (const key of ['pick:0', 'pick:1', 'pick:2', 'pick:3']) expect(await band.find({ type: 'Button', key })).toBeDefined()

    await band.press({ key: 'pick:0' })
    expect(engine.submitted).toEqual([])
    expect(engine.toasts.some(t => t.includes('デモのため送信しません'))).toBe(true)

    await engine.clock.advance(2500)
    await pane.redraw()
    expect(pointerRow(await gridOf(pane))).toBeLessThan(GRID_ROWS / 2)
    expect(engine.toasts.some(t => t.includes('デモ：この位置なら'))).toBe(true)

    await engine.clock.advance(3500)
    await pane.redraw()
    expect(pointerRow(await gridOf(pane))).toBe(GRID_ROWS / 2)
    expect(engine.asked).toEqual([])
    expect(engine.submitted).toEqual([])
  })

  test('a prompt stops the demo: its later frames do not fill the band again', JA, async ($, on) => {
    const engine = engineBeneath(on)
    await $.command.run(DEMO)
    await engine.clock.advance(5500)
    await $.turn.start({ text: 'real work', turnId: 't1' })
    await engine.clock.advance(6000)
    const band = await mountBand($)
    expect(await band.find({ text: 'engine' })).toBeDefined()
    expect(await band.find({ text: /デモ/ })).toBe(undefined)
    expect(engine.submitted).toEqual([])
  })

  test('in English the demo plays with the English script', { options: { language: 'en' }, timeoutMs: 20_000 }, async ($, on) => {
    const engine = stand(on)
    await compass($, 'demo')
    await engine.clock.advance(13_000)
    expect(engine.toasts.some(t => t.startsWith('Demo: this spot would send: Take a middle road'))).toBe(true)
    expect(engine.toasts.some(t => /[ぁ-んァ-ン一-龥]/.test(t))).toBe(false)
    const four = engine.four() ?? []
    expect(four).toHaveLength(4)
    expect(four.every(t => !/[ぁ-んァ-ン一-龥]/.test(t))).toBe(true)
  })
})
