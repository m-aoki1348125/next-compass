import { describe, expect, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'

import { compass, endTurn, mountBand, mountPane, stand, startTurn } from './state-helpers'

/**
 * State transitions, read straight from the plugin's state: each test is one
 * edge of the machine (event in, state out), so a break shows which edge.
 *
 *   idle ──turn.start──▶ working ──turn.complete(answer)──▶ thinking ──▶ shown
 *     ▲                     │ aborted / error                 │ fail      │ press / ✎ / turn.start
 *     └─────────────────────┴─────────────── idle ◀── error ◀─┘           ▼
 *   shown ──map pick──▶ blending ──▶ shown (+ prompt filled) | error      idle
 *   any ──/compass demo──▶ demo ──turn.start / refresh──▶ (demo off)
 */

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
    expect(engine.count('CHOICES-V')).toBe(1)
  })

  test('turn.complete with an answer: not working, the four made, phase back to idle', async ($, on) => {
    const engine = stand(on)
    await startTurn($)
    await endTurn($)
    await engine.clock.settle()
    expect(engine.state('isWorking')).toBe(false)
    expect(engine.four()).toEqual(['Implement the export', 'Refactor the parser', 'Investigate the flaky test', 'Add tests for the parser'])
    expect(engine.state('phase')).toBe('idle')
    expect((engine.state('set'))?.isRefining).toBe(false)
  })

  for (const reason of ['aborted', 'error'] as const) {
    test(`turn.complete ${reason}: not working, no four, no model call`, async ($, on) => {
      const engine = stand(on)
      await startTurn($)
      await endTurn($, 't1', reason)
      await engine.clock.settle()
      expect(engine.state('isWorking')).toBe(false)
      expect(engine.four()).toBe(null)
      expect(engine.asked.filter(m => m.startsWith('CHOICES'))).toEqual([])
    })
  }

  test('a new turn while the four are still being made: the late four are dropped, phase idle', async ($, on) => {
    const engine = stand(on, { delay: { 'CHOICES-V': 1000, 'CHOICES-H': 1000 } })
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
    const engine = stand(on, { fail: { 'CHOICES-V': 'empty' } })
    await compass($, 'refresh')
    expect(engine.state('phase')).toBe('error')
    expect(engine.state('note')).toBeTruthy()
    expect(engine.count('CHOICES-V')).toBe(1)
    const band = await mountBand($)
    expect(await band.find({ key: 'retry' })).toBeDefined()
  })

  test('a refused request: phase error, never left thinking', async ($, on) => {
    const engine = stand(on, { fail: { 'CHOICES-V': 'throw' } })
    await startTurn($)
    await endTurn($)
    await engine.clock.settle()
    expect(engine.state('phase')).toBe('error')
    expect(engine.state('note')).toContain('モデル')
  })
})

describe('send edges', () => {
  test('a band press: the drawn text submitted, the four cleared', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    await (await mountBand($)).press({ key: 'pick:2' })
    expect(engine.submitted).toEqual(['Investigate the flaky test'])
    expect(engine.four()).toBe(null)
  })

  test('✎: the text filled into the prompt box, nothing submitted, the four cleared', async ($, on) => {
    const engine = stand(on)
    await compass($, 'refresh')
    await (await mountBand($)).press({ key: 'edit:0' })
    expect(engine.filled).toEqual(['Implement the export'])
    expect(engine.submitted).toEqual([])
    expect(engine.four()).toBe(null)
  })
})

describe('prefetch and refine edges', () => {
  const preparedTurn = async ($: Engine, engine: ReturnType<typeof stand>) => {
    await startTurn($)
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await engine.clock.settle()
    await endTurn($)
    await engine.clock.settle()
  }

  test('with a pool: the four at once and refining, then refined and not refining', async ($, on) => {
    const engine = stand(on, { delay: { SELECT: 1000 } })
    await preparedTurn($, engine)
    expect((engine.state('set'))?.isRefining).toBe(true)
    expect(engine.four()).toContain('Check the export by hand')
    await engine.clock.advance(1000)
    expect((engine.state('set'))?.isRefining).toBe(false)
    expect(engine.four()).toContain('Ask which format matters')
  })

  test('a refine that lands after a new turn started changes nothing', async ($, on) => {
    const engine = stand(on, { delay: { SELECT: 1000 } })
    await preparedTurn($, engine)
    await startTurn($, 't2')
    await engine.clock.advance(1000)
    expect(engine.four()).toBe(null)
  })

  test('a refused select: refining ends, the four shown at once stay', async ($, on) => {
    const engine = stand(on, { fail: { SELECT: 'throw' } })
    await preparedTurn($, engine)
    expect((engine.state('set'))?.isRefining).toBe(false)
    expect(engine.four()).toContain('Check the export by hand')
  })

  test("a subagent's tool calls start no prefetch", async ($, on) => {
    const engine = stand(on)
    await startTurn($)
    await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'agent-1' } as never)
    await engine.clock.settle()
    expect(engine.count('POOL')).toBe(0)
  })
})

describe('map edges', () => {
  test('extras in flight: map pending, then not pending once they land', async ($, on) => {
    const engine = stand(on, { delay: { 'EXTRAS-A': 500, 'EXTRAS-B': 500 } })
    await compass($, 'map')
    const refresh = compass($, 'refresh')
    await engine.clock.settle()
    expect((engine.state('set'))?.isMapPending).toBe(true)
    await engine.clock.advance(500)
    await refresh
    expect((engine.state('set'))?.isMapPending).toBe(false)
  })

  test('extras refused: not pending, the four kept, no error', async ($, on) => {
    const engine = stand(on, { fail: { 'EXTRAS-A': 'throw' } })
    await compass($, 'map')
    await compass($, 'refresh')
    await engine.clock.settle()
    expect((engine.state('set'))?.isMapPending).toBe(false)
    expect(engine.four()).toHaveLength(4)
    expect(engine.state('phase')).toBe('idle')
  })

  test('a pick between choices: blending, then the prompt filled, the four kept, idle', async ($, on) => {
    const engine = stand(on, { blendDelays: [500] })
    await compass($, 'refresh')
    const pane = await mountPane($)
    const post = pane.post({ kind: 'pick', x: 0.4, y: 0.4, fill: false }, { in: 'space@1' })
    await engine.clock.settle()
    expect(engine.state('phase')).toBe('blending')
    await engine.clock.advance(500)
    await post
    expect(engine.filled).toEqual(['Blend the two steps'])
    expect(engine.state('phase')).toBe('idle')
    expect(engine.four()).toHaveLength(4)
  })

  test('a blend refused: phase error, nothing filled', async ($, on) => {
    const engine = stand(on, { fail: { BLEND: 'throw' } })
    await compass($, 'refresh')
    await (await mountPane($)).post({ kind: 'pick', x: 0.4, y: 0.4, fill: false }, { in: 'space@1' })
    expect(engine.state('phase')).toBe('error')
    expect(engine.filled).toEqual([])
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
