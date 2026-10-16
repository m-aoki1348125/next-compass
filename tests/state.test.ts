import { describe, expect, test } from 'claude-code/testing'

import { POOL_TEXTS, compass, endTurn, mountBand, mountPane, pickAt, preparedTurn, stand, startTurn } from './state-helpers'

/**
 * State transitions, read straight from the plugin's state: each test is one
 * edge of the machine (event in, state out), so a break shows which edge.
 *
 *   idle ──turn.start──▶ working ──turn.complete(answer)──▶ thinking ──▶ shown
 *     ▲                     │ aborted / error                 │ fail      │ press / ✎ / turn.start
 *     └─────────────────────┴─────────────── idle ◀── error ◀─┘           ▼
 *   shown ──map pick──▶ blending ──▶ shown + preview ──pick again──▶ sent    idle
 *   any ──/next demo──▶ demo ──turn.start / refresh──▶ (demo off)
 */

const SET_FOUR = ['Implement the export', 'Refactor the parser', 'Investigate the flaky test', 'Add tests for the parser']

describe('turn edges', () => {
  test('turn.start on the main loop: working, the four cleared, activity reset', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    expect(engine.four()).toHaveLength(4)
    await startTurn($)
    expect(engine.state('isWorking')).toBe(true)
    expect(engine.four()).toBe(null)
    expect(engine.state('activity')).toEqual([])
    expect(engine.state('phase')).toBe('idle')
  })

  test("a subagent's turn.start and turn.complete change nothing", async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    await startTurn($, 'sub', 'agent-1')
    await endTurn($, 'sub', 'answer', 'agent-1')
    await engine.clock.settle()
    expect(engine.four()).toHaveLength(4)
    expect(engine.state('isWorking')).not.toBe(true)
    expect(engine.count('CHOICES')).toBe(1)
  })

  test('turn.complete with an answer: not working, one CHOICES call, the four made, phase idle', async ($, on) => {
    const engine = stand(on)
    await startTurn($)
    await endTurn($)
    await engine.clock.settle()
    expect(engine.state('isWorking')).toBe(false)
    expect(engine.count('CHOICES')).toBe(1)
    expect([...(engine.four() ?? [])].sort()).toEqual([...SET_FOUR].sort())
    expect(engine.state('phase')).toBe('idle')
    expect(engine.state('set')?.isRefining).toBe(false)
  })

  for (const reason of ['aborted', 'error'] as const) {
    test(`turn.complete ${reason}: not working, no four, no model call`, async ($, on) => {
      const engine = stand(on)
      await startTurn($)
      await endTurn($, 't1', reason)
      await engine.clock.settle()
      expect(engine.state('isWorking')).toBe(false)
      expect(engine.four()).toBe(null)
      expect(engine.count('CHOICES')).toBe(0)
    })
  }

  test('a new turn while the four are still being made: the late four are dropped, phase idle', async ($, on) => {
    const engine = stand(on, { delay: { CHOICES: 1000 } })
    await startTurn($, 't1')
    await endTurn($, 't1')
    await engine.clock.settle()
    expect(engine.state('phase')).toBe('thinking')
    await startTurn($, 't2')
    await engine.clock.advance(1000)
    expect(engine.four()).toBe(null)
    expect(engine.state('phase')).toBe('idle')
    expect(engine.state('isWorking')).toBe(true)
  })
})

describe('failure edges', () => {
  test('the four come back empty: phase error with a note and a retry button offered', async ($, on) => {
    const engine = stand(on, { fail: { CHOICES: 'empty' } })
    await compass($, 'refresh')
    expect(engine.state('phase')).toBe('error')
    expect(engine.state('note')).toBeTruthy()
    expect(engine.count('CHOICES')).toBe(1)
    const band = await mountBand($)
    expect(await band.find({ key: 'retry' })).toBeDefined()
  })

  test('a refused request: phase error with the reason in the chosen language, never left thinking', { options: { language: 'ja' } }, async ($, on) => {
    const engine = stand(on, { fail: { CHOICES: 'throw' } })
    await startTurn($)
    await endTurn($)
    await engine.clock.settle()
    expect(engine.state('phase')).toBe('error')
    expect(engine.state('note')).toContain('モデル')
  })

  test('a reply with one instruction twice is not four: phase error, no set', async ($, on) => {
    const twice = ['AXES: a | b | c | d', '1: Ship it', '2: Ship it', '3: Test it', '4: Document it'].join('\n')
    const engine = stand(on, { replies: { CHOICES: twice } })
    await compass($, 'refresh')
    expect(engine.state('phase')).toBe('error')
    expect(engine.four()).toBe(null)
  })
})

describe('send edges', () => {
  test('a band press: the drawn text submitted, the four cleared', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    const shown = engine.four()?.[2]
    await (await mountBand($)).press({ key: 'pick:2' })
    expect(engine.submitted).toEqual([shown])
    expect(engine.four()).toBe(null)
  })

  test('✎: the text filled into the prompt box, nothing submitted, the four cleared', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    const shown = engine.four()?.[0]
    await (await mountBand($)).press({ key: 'edit:0' })
    expect(engine.filled).toEqual([shown])
    expect(engine.submitted).toEqual([])
    expect(engine.four()).toBe(null)
  })
})

describe('prefetch and refine edges', () => {
  test('with a pool: four from the pool at once and refining, then SELECT replaces them; no CHOICES or EXTRAS call', async ($, on) => {
    const engine = stand(on, { delay: { SELECT: 1000 } })
    await compass($, 'map')
    await preparedTurn($, engine)
    expect(engine.state('set')?.isRefining).toBe(true)
    const local = engine.four() ?? []
    expect(local).toHaveLength(4)
    expect(local.every(t => POOL_TEXTS.includes(t))).toBe(true)
    // The pool's rest is on the map at once.
    expect([...local, ...(engine.extras() ?? [])].sort()).toEqual([...POOL_TEXTS].sort())
    await engine.clock.advance(1000)
    expect(engine.state('set')?.isRefining).toBe(false)
    expect([...(engine.four() ?? [])].sort()).toEqual(
      ['Ship the export', 'Add CSV to the export', 'Ask which format matters', 'Add tests for the export'].sort(),
    )
    expect(engine.extras()).toEqual(expect.arrayContaining(['Check the export by hand', 'Document the export', 'Clean up the export module']))
    expect(engine.count('CHOICES')).toBe(0)
    expect(engine.count('EXTRAS')).toBe(0)
    expect(engine.count('SELECT')).toBe(1)
  })

  test('a refine that lands after a new turn started changes nothing', async ($, on) => {
    const engine = stand(on, { delay: { SELECT: 1000 } })
    await preparedTurn($, engine)
    await startTurn($, 't2')
    await engine.clock.advance(1000)
    expect(engine.four()).toBe(null)
  })

  test('a refused select: refining ends, the four picked from the pool stay', async ($, on) => {
    const engine = stand(on, { fail: { SELECT: 'throw' } })
    await preparedTurn($, engine)
    expect(engine.state('set')?.isRefining).toBe(false)
    const four = engine.four() ?? []
    expect(four).toHaveLength(4)
    expect(four.every(t => POOL_TEXTS.includes(t))).toBe(true)
    expect(engine.state('phase')).toBe('idle')
  })

  test("a subagent's tool calls start no prefetch", async ($, on) => {
    const engine = stand(on)
    await startTurn($)
    await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'agent-1' } as never)
    await engine.clock.settle()
    expect(engine.count('POOL')).toBe(0)
  })
})

describe('mode edges', () => {
  test('demo on, then a real turn: demo off, ghost cleared, later frames do nothing', async ($, on) => {
    const engine = stand(on)
    await compass($, 'demo')
    expect(engine.state('isDemo')).toBe(true)
    await engine.clock.advance(11500)
    await startTurn($)
    expect(engine.state('isDemo')).toBe(false)
    expect(engine.state('ghost')).toBe(null)
    await engine.clock.advance(6000)
    expect(engine.four()).toBe(null)
    // The real turn prepares its own pool (POOL); nothing else, and nothing from the demo.
    expect(engine.asked.filter(m => m !== 'POOL')).toEqual([])
  })

  test('/clear: the four, the work state and the activity all reset', async ($, on) => {
    const engine = stand(on)
    await startTurn($)
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await compass($, 'refresh')
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
    await engine.clock.settle()
    expect(engine.four()).toBe(null)
    expect(engine.state('isWorking')).toBe(false)
    expect(engine.state('activity')).toEqual([])
  })

  test('hide then show: the flag flips, the four are made either way', async ($, on) => {
    const engine = stand(on)
    await compass($, 'hide')
    expect(engine.state('isHidden')).toBe(true)
    await compass($, 'refresh')
    expect(engine.four()).toHaveLength(4)
    await compass($, 'show')
    expect(engine.state('isHidden')).toBe(false)
  })
})

/** Defects found in review of the old design, each pinned as the behaviour it must have. */
describe('fixed review findings', () => {
  test('M5: a demo cut short by /next refresh turns the work state off', async ($, on) => {
    const engine = stand(on)
    await compass($, 'demo')
    await engine.clock.advance(3000)
    expect(engine.state('isWorking')).toBe(true)
    await compass($, 'refresh')
    await engine.clock.advance(6000)
    expect(engine.state('isWorking')).toBe(false)
    expect(engine.state('activity')).toEqual([])
  })

  test('M2: a refused EXTRAS call leaves the four shown, phase idle, the map not pending', async ($, on) => {
    const engine = stand(on, { fail: { EXTRAS: 'throw' } })
    await compass($, 'map')
    await compass($, 'refresh')
    await engine.clock.settle()
    expect(engine.count('EXTRAS')).toBe(1)
    expect(engine.four()).toHaveLength(4)
    expect(engine.state('phase')).toBe('idle')
    expect(engine.state('set')?.isMapPending).toBe(false)
  })

  test('M3: two picks on the map in a row: the later pick’s blend is the preview, the earlier reply is dropped', async ($, on) => {
    const engine = stand(on, { blendTexts: ['first pick', 'second pick'], blendDelays: [1000, 100] })
    await compass($, 'refresh')
    const pane = await mountPane($)
    const first = pickAt(pane, 0.4, 0.4)
    await engine.clock.settle()
    const second = pickAt(pane, -0.4, 0.4)
    await engine.clock.advance(1000)
    await Promise.all([first, second])
    expect(engine.count('BLEND')).toBe(2)
    expect(engine.state('preview')?.text).toBe('second pick')
    expect(engine.state('preview')?.x).toBe(-0.4)
    expect(engine.filled).toEqual([])
    expect(engine.submitted).toEqual([])
  })

  test('L3: /clear during a turn cancels the prefetch timer: no POOL call after it', async ($, on) => {
    const engine = stand(on)
    await startTurn($)
    await engine.clock.advance(1000)
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
    await engine.clock.advance(3000)
    expect(engine.count('POOL')).toBe(0)
  })

  test('M4: a load (session.start) resets a phase only the dropped work would have reset', async ($, on) => {
    const engine = stand(on, { delay: { CHOICES: 5000 } })
    void compass($, 'refresh')
    await engine.clock.settle()
    expect(engine.state('phase')).toBe('thinking')
    // On a real reload the in-flight generate is gone with the old module; only session.start runs.
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    expect(engine.state('phase')).toBe('idle')
  })
})
