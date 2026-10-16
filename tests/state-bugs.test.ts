import { describe, expect, test } from 'claude-code/testing'

import { compass, mountPane, stand, startTurn } from './state-helpers'

/**
 * Known bugs in the state machine, each pinned as the behaviour it SHOULD
 * have. These fail until the bug is fixed (the plugin code is unchanged on
 * purpose); a fix turns its test green. Each names the review finding.
 */

describe('BUG: known state-transition defects (red until fixed)', () => {
  test('BUG M5: a demo cut short by /compass refresh leaves the work state on', async ($, on) => {
    const engine = stand(on)
    await compass($, 'demo')
    await engine.clock.advance(3000)
    expect(engine.state('isWorking')).toBe(true)
    await compass($, 'refresh')
    await engine.clock.advance(6000)
    // stopDemo cancels the 5 s frame that would have turned it off, and resets neither isWorking nor activity.
    expect(engine.state('isWorking')).toBe(false)
  })

  test('BUG M2: in single mode a refused placing call hides the four behind an error and leaves the map pending', { options: { choiceMode: 'single' } }, async ($, on) => {
    const engine = stand(on, { fail: { PLACE: 'throw' } })
    await compass($, 'map')
    await compass($, 'refresh')
    await engine.clock.settle()
    expect(engine.four()).toHaveLength(4)
    expect(engine.state('phase')).toBe('idle')
    expect(engine.state('set')?.isMapPending).toBe(false)
  })

  test('BUG M3: two picks on the map in a row: the earlier, slower reply overwrites the later one', async ($, on) => {
    const engine = stand(on, { blendTexts: ['first pick', 'second pick'], blendDelays: [1000, 100] })
    await compass($, 'refresh')
    const pane = await mountPane($)
    const first = pane.post({ kind: 'pick', x: 0.4, y: 0.4, fill: false }, { in: 'space@1' })
    await engine.clock.settle()
    const second = pane.post({ kind: 'pick', x: -0.4, y: 0.4, fill: false }, { in: 'space@1' })
    await engine.clock.advance(1000)
    await Promise.all([first, second])
    // What ends in the prompt box should be what the person picked last.
    expect(engine.filled.at(-1)).toBe('second pick')
  })

  test('BUG L3: /clear during a turn does not stop the prefetch timer: a pool is prepared for a cleared session', async ($, on) => {
    const engine = stand(on)
    await startTurn($)
    await engine.clock.advance(1000)
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
    await engine.clock.advance(3000)
    expect(engine.count('POOL')).toBe(0)
  })

  test('BUG M4: a load (hot reload) leaves a phase that only the dropped work would have reset', async ($, on) => {
    const engine = stand(on, { delay: { 'CHOICES-V': 5000, 'CHOICES-H': 5000 } })
    void compass($, 'refresh')
    await engine.clock.settle()
    expect(engine.state('phase')).toBe('thinking')
    // On a real reload the in-flight generate is gone with the old module; only session.start runs.
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    expect(engine.state('phase')).toBe('idle')
  })
})
