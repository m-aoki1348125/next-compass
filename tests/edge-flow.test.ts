import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf } from 'claude-code'

/** Edge cases of the flow: slash commands, a demo cut short, /clear, unknown verbs, long Japanese. */

const LONG = 'エクスポート機能を仕上げてテストを追加し、README の使い方も書き直してから PR を作って'
const CHOICES = [
  'AXES: 進める | 広げる | 調べる | 固める',
  `1: ${LONG}`,
  '2: Refactor the parser module',
  '3: Investigate the flaky test',
  '4: Add tests for the parser',
].join('\n')
/** Japanese UI, so the strings the tests read are the ones the person reads. */
const JA = { options: { language: 'ja' } }
const SPACE = 'space@2'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const command = (args: string) => ({
  command: 'next',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})

const bandProps = (bodyColumns: number): RenderPropsOf['AbovePrompt'] => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns,
  scroll: { bodyRows: 12, offset: 0 } as unknown as RenderPropsOf['AbovePrompt']['scroll'],
  view: {} as RenderPropsOf['AbovePrompt']['view'],
})

const engine = (on: On, submitted: string[], asked: string[] = [], filled: string[] = []) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', (_$, e) => {
    asked.push(e.prompt)
    const text = e.prompt.includes('(CHOICES)') ? CHOICES : ''
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
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
  return clock
}

type Band = { find: (q: { key: string }) => Promise<{ text: string } | undefined> }

/** The key of the band's button whose text starts with `head`: the four take their keys by direction. */
const keyOf = async (band: Band, head: string): Promise<string> => {
  for (const i of [0, 1, 2, 3]) {
    const button = await band.find({ key: `pick:${i}` })
    if (button !== undefined && button.text.includes(head)) return `pick:${i}`
  }
  throw new Error(`no button shows "${head}"`)
}

/** Cells a text takes on the terminal: two for a wide character. */
const cellsOf = (text: string): number =>
  Array.from(text).reduce((n, c) => n + (/[⺀-꓏가-힣＀-｠]/.test(c) ? 2 : 1), 0)

describe('edges of the flow', () => {
  test('a slash command keeps the four and starts no work', async ($, on) => {
    engine(on, [])
    await $.command.run(command('refresh'))
    await $.prompt.submit({
      text: '/next map',
      origin: { kind: 'composer' },
      wait: false,
      command: { name: 'next', args: 'map' },
    })
    const band = await $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: bandProps(100) })
    expect(await band.find({ key: 'pick:1' })).toBeDefined()
  })

  /** A background task's notification, as the engine stamps it. */
  const notification = (turnId?: string) => ({
    text: '<task-notification>Agent finished</task-notification>',
    origin: { kind: 'task-notification' as const },
    wait: false,
    ...(turnId === undefined ? {} : { turnId }),
  })
  const END = { answer: 'Done.', durationMs: 1000, isAborted: false, reason: 'answer' as const }
  const mountBand = ($: Engine) =>
    $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: bandProps(100) })

  test('a notification that starts no turn keeps the four', async ($, on) => {
    const clock = engine(on, [])
    await $.command.run(command('refresh'))
    await $.prompt.submit(notification())
    await clock.settle()
    const band = await mountBand($)
    expect(await band.find({ key: 'pick:0' })).toBeDefined()
    expect(await band.find({ text: /Refactor the parser module/ })).toBeDefined()
  })

  test('a notification delivered into a running turn makes the four once, at its end', async ($, on) => {
    const asked: string[] = []
    const clock = engine(on, [], asked)
    await $.turn.start({ text: 'add an export', turnId: 't1' })
    await $.prompt.submit(notification('t1'))
    await $.turn.complete({ ...END, turnId: 't1' })
    await clock.settle()
    expect(asked.filter(p => p.includes('(CHOICES)'))).toHaveLength(1)
    const band = await mountBand($)
    expect(await band.find({ key: 'pick:3' })).toBeDefined()
  })

  test('a notification that starts its own turn clears the four, then makes new ones for its answer', async ($, on) => {
    const asked: string[] = []
    const clock = engine(on, [], asked)
    await $.command.run(command('refresh'))
    await $.prompt.submit(notification())
    await $.turn.start({ text: '', turnId: 't2' })
    const during = await mountBand($)
    expect(await during.find({ key: 'pick:0' })).toBe(undefined)
    await during.unmount()
    await $.turn.complete({ ...END, turnId: 't2' })
    await clock.settle()
    const after = await mountBand($)
    expect(await after.find({ key: 'pick:0' })).toBeDefined()
    expect(asked.filter(p => p.includes('(CHOICES)'))).toHaveLength(2)
  })

  test('hide hides the band only: the four are still made for the map', async ($, on) => {
    engine(on, [])
    await $.command.run(command('hide'))
    await $.command.run(command('refresh'))
    const band = await $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: bandProps(100) })
    expect(await band.find({ key: 'pick:0' })).toBe(undefined)
    const pane = await $.ui.mount({
      plugin: 'next-compass',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'next-compass-map',
      props: { title: 't', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { bodyRows: 30, offset: 0 }, view: {} } as never,
    })
    await pane.resize({ columns: 56, rows: 18, in: SPACE })
    expect(await pane.find({ in: SPACE, text: /[1-4] 進める/ })).toBeDefined()
  })

  test('real choices end a demo, so they send', JA, async ($, on) => {
    const submitted: string[] = []
    const clock = engine(on, submitted)
    await $.command.run(command('demo'))
    await clock.advance(10500)
    await $.command.run(command('refresh'))
    const band = await $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: bandProps(100) })
    expect(await band.find({ text: /（デモ）/ })).toBe(undefined)
    const key = await keyOf(band, 'Refactor the parser module')
    await band.press({ key })
    expect(submitted).toEqual(['Refactor the parser module'])
    await clock.advance(6000)
    expect(await band.find({ text: /Investigate the flaky test/ })).toBe(undefined)
  })

  test('/clear drops the last conversation’s four', async ($, on) => {
    engine(on, [])
    await $.command.run(command('refresh'))
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    const band = await $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: bandProps(100) })
    expect(await band.find({ key: 'pick:0' })).toBe(undefined)
  })

  test('an unknown verb says how to use the command', JA, async ($, on) => {
    engine(on, [])
    const result = await $.command.run(command('foo'))
    expect(result.text).toContain('「foo」は使えません')
  })

  test('a long Japanese choice is cut to the band by cells, not characters, and fills the prompt box', async ($, on) => {
    const submitted: string[] = []
    const filled: string[] = []
    engine(on, submitted, [], filled)
    await $.command.run(command('refresh'))
    const band = await $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: bandProps(40) })
    const key = await keyOf(band, 'エクスポート機能')
    const cut = await band.find({ key })
    expect(cut?.text).toContain('…')
    expect(cellsOf(cut?.text ?? '')).toBeLessThanOrEqual(40 - 10 + 2)
    // What was cut is not sent unread: the whole text goes to the prompt box.
    await band.press({ key })
    expect(filled).toEqual([LONG])
    expect(submitted).toEqual([])
  })

  test('a choice the band shows whole is submitted', async ($, on) => {
    const submitted: string[] = []
    const filled: string[] = []
    engine(on, submitted, [], filled)
    await $.command.run(command('refresh'))
    const band = await $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: bandProps(100) })
    const key = await keyOf(band, 'Add tests for the parser')
    expect((await band.find({ key }))?.text).not.toContain('…')
    await band.press({ key })
    expect(submitted).toEqual(['Add tests for the parser'])
    expect(filled).toEqual([])
  })
})
