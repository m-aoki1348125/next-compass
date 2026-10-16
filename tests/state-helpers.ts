import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PluginState, RenderElement, RenderPropsOf } from 'claude-code'

/**
 * The engine beneath the plugin for the state-transition tests: canned model
 * replies by the marker each prompt carries, failures and delays per marker,
 * and recorders for what the plugin submits, fills and asks.
 */

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const REPLIES: Record<string, string> = {
  'CHOICES-V': ['AXIS: 進める | 調べる', '1: Implement the export', '3: Investigate the flaky test'].join('\n'),
  'CHOICES-H': ['AXIS: 広げる | 固める', '2: Refactor the parser', '4: Add tests for the parser'].join('\n'),
  CHOICES: [
    'AXES: 進める | 広げる | 調べる | 固める',
    '1: Implement the export',
    '2: Refactor the parser',
    '3: Investigate the flaky test',
    '4: Add tests for the parser',
  ].join('\n'),
  'EXTRAS-A': ['0.4 0.4 Write the README section', '-0.4 -0.4 Clean up the module'].join('\n'),
  'EXTRAS-B': ['-0.4 0.4 Profile the build'].join('\n'),
  EXTRAS: ['- Write the README section', '- Profile the build'].join('\n'),
  PLACE: ['1 0.4 0.4', '2 -0.4 0.4'].join('\n'),
  POOL: [
    '0.1 0.8 Ship the export',
    '0.7 0.2 Add CSV to the export',
    '0.1 -0.7 Check the export by hand',
    '-0.8 0.1 Add tests for the export',
    '0.5 0.5 Document the export',
    '-0.4 -0.4 Clean up the export module',
  ].join('\n'),
  SELECT: ['AXES: 進める | 広げる | 確かめる | 固める', '1: #1', '2: #2', '3: Ask which format matters', '4: #4'].join('\n'),
}

const MARKER = /\((CHOICES-V|CHOICES-H|CHOICES|EXTRAS-A|EXTRAS-B|EXTRAS|PLACE|POOL|SELECT)\)/

export type Marker = keyof typeof REPLIES | 'BLEND'

/**
 * How the model behaves: `fail` a marker with an empty reply or a thrown
 * (refused) request; `delay` a marker's reply on the mocked clock; the blend
 * calls answer `blendTexts` in order, each after its own `blendDelays` entry.
 */
export type Behavior = {
  fail?: Partial<Record<Marker, 'empty' | 'throw'>>
  delay?: Partial<Record<Marker, number>>
  blendTexts?: string[]
  blendDelays?: number[]
}

export const stand = (on: On, behavior: Behavior = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const asked: Marker[] = []
  const submitted: string[] = []
  const filled: string[] = []
  const toasts: string[] = []
  on('model.complete', async (_$, e) => {
    const marker = (MARKER.exec(e.prompt)?.[1] ?? 'BLEND') as Marker
    const blendIndex = asked.filter(m => m === 'BLEND').length
    asked.push(marker)
    const delay = marker === 'BLEND' ? behavior.blendDelays?.[blendIndex] : behavior.delay?.[marker]
    if (delay !== undefined) await clock.sleep(delay)
    const failure = behavior.fail?.[marker]
    if (failure === 'throw') throw new Error(`refused ${marker}`)
    if (failure === 'empty') return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
    const text = marker === 'BLEND' ? (behavior.blendTexts?.[blendIndex] ?? 'Blend the two steps') : (REPLIES[marker] ?? '')
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.render', ($, e) => h($.ui.resolve(e).Text, {}, 'engine') as RenderElement)
  // The test's $ has no state noun: every write the plugin makes passes here on its way to the
  // kit's store, so the last one per key is the state as the host holds it.
  const written: Partial<Record<Keys, unknown>> = {}
  on('state.set', (_$, e, next) => {
    const write = e as unknown as { plugin: string; key: string; value: unknown }
    if (write.plugin === 'next-compass') written[write.key as Keys] = write.value
    return next(e)
  })
  const count = (marker: Marker) => asked.filter(m => m === marker).length
  /** A value of the plugin's state now: the last write, or the atom's initial value. */
  const state = <K extends Keys>(key: K): PluginState['next-compass'][K] =>
    (key in written ? written[key] : INITIAL[key]) as PluginState['next-compass'][K]
  /** The primaries of the set now: their texts, or null with no set. */
  const four = (): string[] | null => {
    const set = state('set')
    return set === null ? null : set.items.filter(i => i.isPrimary).map(i => i.text)
  }
  return { clock, asked, submitted, filled, toasts, count, state, four }
}

type Keys = keyof PluginState['next-compass'] & string

/** The atoms' initial values, as register.tsx declares them. */
const INITIAL: { [K in Keys]: PluginState['next-compass'][K] } = {
  set: null,
  phase: 'idle',
  note: null,
  goal: null,
  isHidden: false,
  isWorking: false,
  isDemo: false,
  ghost: null,
  faults: 0,
  activity: [],
}

/** `/compass <args>` as the person runs it. */
export const compass = ($: Engine, args: string) =>
  $.command.run({ command: 'compass', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

export const startTurn = ($: Engine, turnId = 't1', agentId?: string) =>
  $.turn.start({ text: 'do the work', turnId, ...(agentId === undefined ? {} : { agentId }) })

export const endTurn = ($: Engine, turnId = 't1', reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string) =>
  $.turn.complete({
    answer: 'Done.',
    durationMs: 1000,
    isAborted: reason === 'aborted',
    turnId,
    reason,
    ...(agentId === undefined ? {} : { agentId }),
  })

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { bodyRows: 12, offset: 0 } as unknown as RenderPropsOf['AbovePrompt']['scroll'],
  view: {} as RenderPropsOf['AbovePrompt']['view'],
}

export const mountBand = ($: Engine) =>
  $.ui.mount({ plugin: 'next-compass', surface: 'terminal', component: 'AbovePrompt', props: BAND })

export const mountPane = ($: Engine) =>
  $.ui.mount({
    plugin: 'next-compass',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'next-compass-map',
    props: {
      title: '意味空間マップ',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { bodyRows: 30, offset: 0 },
      view: {},
    } as unknown as RenderPropsOf['Pane'],
  })
