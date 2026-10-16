import { describe, expect, test } from 'claude-code/testing'

import { SPACE, compass, endTurn, mountBand, mountPane, pickAt, preparedTurn, stand, startTurn } from './state-helpers'

/**
 * The map's edges (extras, the two-step pick through a preview), the set's
 * shape as the local layout gives it, Claude Code's own suggestion, the
 * stats kept across sessions, and the UI language.
 */

const LIMIT = 0.85 + 1e-6

describe('the set as laid out locally', () => {
  test('four primaries first, extras after, every text distinct, every spot inside the square', async ($, on) => {
    const engine = stand(on)
    await compass($, 'map')
    await compass($, 'refresh')
    await engine.clock.settle()
    const set = engine.state('set')
    expect(set).not.toBe(null)
    const items = set?.items ?? []
    expect(items.slice(0, 4).every(i => i.isPrimary)).toBe(true)
    expect(items.slice(4).every(i => !i.isPrimary)).toBe(true)
    expect(engine.extras()).toEqual(expect.arrayContaining(['Write the README section', 'Profile the build', 'Split the config file']))
    const texts = items.map(i => i.text)
    expect(new Set(texts).size).toBe(texts.length)
    for (const i of items) {
      expect(Math.abs(i.x)).toBeLessThanOrEqual(LIMIT)
      expect(Math.abs(i.y)).toBeLessThanOrEqual(LIMIT)
    }
  })

  test("each direction's name follows its text", async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    const set = engine.state('set')
    const nameOf: Record<string, string> = {
      'Implement the export': '進める',
      'Refactor the parser': '広げる',
      'Investigate the flaky test': '調べる',
      'Add tests for the parser': '固める',
    }
    const axes = set === null ? [] : [set.axes.up, set.axes.right, set.axes.down, set.axes.left]
    expect(axes).toEqual((engine.four() ?? []).map(t => nameOf[t]))
  })
})

describe('map edges', () => {
  test('extras in flight: map pending, then not pending once they land', async ($, on) => {
    const engine = stand(on, { delay: { EXTRAS: 500 } })
    await compass($, 'map')
    const refresh = compass($, 'refresh')
    await engine.clock.settle()
    expect(engine.state('set')?.isMapPending).toBe(true)
    await engine.clock.advance(500)
    await refresh
    expect(engine.state('set')?.isMapPending).toBe(false)
    expect(engine.extras()).toHaveLength(3)
  })

  test('without the map pane placed, no EXTRAS call and the map not pending', async ($, on) => {
    const engine = stand(on, { placed: false })
    await compass($, 'map')
    await compass($, 'refresh')
    expect(engine.count('EXTRAS')).toBe(0)
    expect(engine.state('set')?.isMapPending).toBe(false)
  })

  test('a first pick: blending, then a preview at the spot, nothing filled or sent, the four kept, idle', async ($, on) => {
    const engine = stand(on, { blendDelays: [500] })
    await compass($, 'refresh')
    const pane = await mountPane($)
    const post = pickAt(pane, 0.4, 0.4)
    await engine.clock.settle()
    expect(engine.state('phase')).toBe('blending')
    await engine.clock.advance(500)
    await post
    expect(engine.state('preview')).toEqual({ x: 0.4, y: 0.4, text: 'Blend the two steps' })
    expect(engine.filled).toEqual([])
    expect(engine.submitted).toEqual([])
    expect(engine.state('phase')).toBe('idle')
    expect(engine.four()).toHaveLength(4)
  })

  test('a second pick at the same spot sends the preview without another blend', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    const pane = await mountPane($)
    await pickAt(pane, 0.4, 0.4)
    await pickAt(pane, 0.4, 0.4)
    expect(engine.count('BLEND')).toBe(1)
    expect(engine.submitted).toEqual(['Blend the two steps'])
    expect(engine.four()).toBe(null)
    expect(engine.state('preview')).toBe(null)
  })

  test('a second pick with fill puts the preview in the prompt box instead', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    const pane = await mountPane($)
    await pickAt(pane, 0.4, 0.4)
    await pickAt(pane, 0.4, 0.4, true)
    expect(engine.filled).toEqual(['Blend the two steps'])
    expect(engine.submitted).toEqual([])
  })

  test('a pick elsewhere writes a new preview and sends nothing', async ($, on) => {
    const engine = stand(on, { blendTexts: ['first', 'second'] })
    await compass($, 'refresh')
    const pane = await mountPane($)
    await pickAt(pane, 0.4, 0.4)
    await pickAt(pane, -0.4, -0.4)
    expect(engine.count('BLEND')).toBe(2)
    expect(engine.state('preview')).toEqual({ x: -0.4, y: -0.4, text: 'second' })
    expect(engine.submitted).toEqual([])
  })

  test('a blend refused: the four stay, phase idle, a toast says why, no preview, nothing filled', async ($, on) => {
    const engine = stand(on, { fail: { BLEND: 'throw' } })
    await compass($, 'refresh')
    await pickAt(await mountPane($), 0.4, 0.4)
    expect(engine.state('phase')).toBe('idle')
    expect(engine.four()).toHaveLength(4)
    expect(engine.toasts).toHaveLength(1)
    expect(engine.state('preview')).toBe(null)
    expect(engine.filled).toEqual([])
  })

  test('a new turn drops the preview', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    await pickAt(await mountPane($), 0.4, 0.4)
    expect(engine.state('preview')).not.toBe(null)
    await startTurn($)
    expect(engine.state('preview')).toBe(null)
  })
})

describe("Claude Code's own suggestion", () => {
  const suggest = (text: string) => ({ text, origin: { kind: 'suggestion' as const } })

  test('landing after the four are shown, it joins the map as an extra', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    await $.prompt.suggest(suggest('Open a PR for the export') as never)
    await engine.clock.settle()
    expect(engine.four()).toHaveLength(4)
    expect(engine.extras()).toContain('Open a PR for the export')
  })

  test("landing during the turn, it reaches the SELECT prompt as Claude Code's own guess", async ($, on) => {
    const engine = stand(on)
    await startTurn($)
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await engine.clock.settle()
    await $.prompt.suggest(suggest('Open a PR for the export') as never)
    await engine.clock.settle()
    await endTurn($)
    await engine.clock.settle()
    const select = engine.prompts.find(p => p.includes('(SELECT)')) ?? ''
    expect(select).toContain("Claude Code's own guess: Open a PR for the export")
  })

  test("a plugin's suggestion is not taken", async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    await $.prompt.suggest({ text: 'From a plugin', origin: { kind: 'plugin', name: 'other' } } as never)
    await engine.clock.settle()
    expect(engine.extras()).not.toContain('From a plugin')
  })
})

describe('stats', () => {
  test('offered, sent from the band and typed instead are counted and reported', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    await (await mountBand($)).press({ key: 'pick:0' })
    await compass($, 'refresh')
    await $.prompt.submit({ text: 'something of my own', origin: { kind: 'composer' }, wait: false })
    await engine.clock.settle()
    const result = await compass($, 'stats')
    expect(result.text).toContain('offered 2 times')
    expect(result.text).toContain('four sent 1')
    expect(result.text).toContain('map sent 0')
    expect(result.text).toContain('typed instead 1')
    expect(result.text).toContain('taken 50%')
  })

  test('a send from the map is counted, and our own send is not counted as typed', async ($, on) => {
    const engine = stand(on, { store: { stats: { offered: 3, band: 1, map: 0, typed: 0 } } })
    await compass($, 'refresh')
    const pane = await mountPane($)
    await pickAt(pane, 0.4, 0.4)
    await pickAt(pane, 0.4, 0.4)
    await engine.clock.settle()
    const result = await compass($, 'stats')
    expect(result.text).toContain('offered 4 times')
    expect(result.text).toContain('map sent 1')
    expect(result.text).toContain('typed instead 0')
  })

  test('nothing recorded yet', async ($, on) => {
    stand(on)
    expect((await compass($, 'stats')).text).toBe('Nothing recorded yet.')
  })

  test('with a pool the four shown at once count as one offer', async ($, on) => {
    const engine = stand(on)
    await preparedTurn($, engine)
    expect((await compass($, 'stats')).text).toContain('offered 1 times')
  })
})

describe('language', () => {
  test("auto follows Claude Code's language setting once the session starts", async ($, on) => {
    stand(on, { settings: { language: 'ja' } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    expect((await compass($, 'foo')).text).toContain('「foo」は使えません')
  })

  test('with no language setting, auto is English', async ($, on) => {
    stand(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    expect((await compass($, 'foo')).text).toContain('Unknown command "foo"')
  })

  test('the option wins over the setting', { options: { language: 'en' } }, async ($, on) => {
    stand(on, { settings: { language: 'ja' } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    expect((await compass($, 'goal ship it')).text).toBe('Goal set to "ship it".')
  })
})

describe('what the map sends is what was read', () => {
  test('a blend dropped by a new layout leaves the phase idle, the four shown', async ($, on) => {
    const engine = stand(on, { blendDelays: [1000], delay: { SELECT: 500 } })
    await startTurn($)
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await engine.clock.settle()
    const ended = endTurn($)
    await engine.clock.advance(1)
    const pane = await mountPane($)
    const picked = pickAt(pane, 0.4, 0.4)
    // The select call lands (a new layout) while the blend is still being written.
    await engine.clock.advance(600)
    await engine.clock.advance(1000)
    await Promise.all([ended, picked])
    expect(engine.state('phase')).toBe('idle')
    expect(engine.four()).toHaveLength(4)
    expect(engine.state('preview')).toBe(null)
  })

  test('a second pick naming another preview text than the one shown does not send', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    const pane = await mountPane($)
    await pickAt(pane, 0.4, 0.4)
    await pane.post({ kind: 'pick', x: 0.4, y: 0.4, fill: false, previewShownWhole: true, isOnPreview: true, previewText: 'something else' }, { in: SPACE })
    expect(engine.submitted).toEqual([])
  })

  test('a second pick on a preview the caption could not show whole fills the prompt box instead of sending', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    const pane = await mountPane($)
    await pickAt(pane, 0.4, 0.4)
    await pickAt(pane, 0.4, 0.4, false, false)
    expect(engine.submitted).toEqual([])
    expect(engine.filled).toEqual(['Blend the two steps'])
  })

  test('a digit on the map puts the choice in the prompt box, never sends it', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    const pane = await mountPane($)
    await pane.post({ kind: 'choose', index: 0, fill: false }, { in: SPACE })
    expect(engine.submitted).toEqual([])
    expect(engine.filled).toHaveLength(1)
  })
})
