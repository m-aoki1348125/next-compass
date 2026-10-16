import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * The map pane's title as `$.ui.open` receives it: the language's own word for
 * the pane once the session has started, and the English fallback before.
 * `showMap` (true by default) opens it at session start, so the tests of the
 * command turn it off.
 */

const JA_TITLE = '意味空間マップ'
const EN_TITLE = 'Meaning map'

/**
 * The engine beneath: Claude Code's `language` setting as given, every pane
 * opened recorded by title and answered "placed". No model is ever asked.
 */
const stand = (on: On, settings: Record<string, unknown> = {}): { titles: string[]; clock: ReturnType<typeof mock.clock> } => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const titles: string[] = []
  on('settings.read', () => ({ value: settings as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', (_$, e) => {
    titles.push(e.title ?? '')
    return { value: { isPlaced: true as const } }
  })
  return { titles, clock }
}

/** `/next <args>` as the person runs it. */
const compass = ($: Engine, args: string) =>
  $.command.run({ command: 'next', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const startSession = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)

describe('the pane title', () => {
  test('is English by default', { options: { showMap: false } }, async ($, on) => {
    const { titles } = stand(on)
    await startSession($)
    await compass($, 'map')
    expect(titles).toEqual([EN_TITLE])
  })

  test('is Japanese with the ja option', { options: { language: 'ja', showMap: false } }, async ($, on) => {
    const { titles } = stand(on)
    await startSession($)
    await compass($, 'map')
    expect(titles).toEqual([JA_TITLE])
  })

  test("auto follows Claude Code's own language setting", { options: { showMap: false } }, async ($, on) => {
    const { titles } = stand(on, { language: 'Japanese' })
    await startSession($)
    await compass($, 'map')
    expect(titles).toEqual([JA_TITLE])
  })

  test('the option wins over the setting', { options: { language: 'en', showMap: false } }, async ($, on) => {
    const { titles } = stand(on, { language: 'ja' })
    await startSession($)
    await compass($, 'map')
    expect(titles).toEqual([EN_TITLE])
  })

  test('a pane opened at session start (showMap, the default) already carries the language', {}, async ($, on) => {
    const { titles, clock } = stand(on, { language: 'ja' })
    await startSession($)
    await clock.settle()
    expect(titles).toEqual([JA_TITLE])
  })

  test('every opening in a session uses the same title', { options: { language: 'ja' } }, async ($, on) => {
    const { titles } = stand(on)
    await startSession($)
    await compass($, 'map')
    await compass($, 'show')
    expect(titles.length).toBeGreaterThanOrEqual(2)
    expect(new Set(titles)).toEqual(new Set([JA_TITLE]))
  })

  test('before the session starts, the fallback is English', { options: { showMap: false } }, async ($, on) => {
    const { titles } = stand(on, { language: 'ja' })
    await compass($, 'map')
    expect(titles).toEqual([EN_TITLE])
  })
})
