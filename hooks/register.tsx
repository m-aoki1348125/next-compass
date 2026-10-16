import type { Register, Timer } from 'claude-code'

import type { CompassPhase, CompassTimings } from '../types'
import { ARROWS, PALETTE, PRIMARY_COUNT } from './compass'
import { demoFrames } from './demo'
import type { DemoFrame } from './demo'
import { cutToCells } from './field'
import {
  beginTurn,
  bumpStat,
  choose,
  endTurn,
  generate,
  noteSuggestion,
  noteToolCall,
  pick,
  readStats,
  resetTurn,
  sendingNow,
  setMapShown,
} from './generate'
import type { Runtime } from './generate'
import { makeT, resolveLang } from './i18n'
import type { Translate } from './i18n'
import {
  getActivity,
  getDemo,
  getFaults,
  getGhost,
  getHidden,
  getNote,
  getPhase,
  getPreview,
  getSet,
  getWorking,
  putActivity,
  putDemo,
  putFaults,
  putGhost,
  putGoal,
  putHidden,
  putPreview,
  putSet,
  putWorking,
  readSettings,
  setPhase,
} from './state'
import type { $ } from './state'

const PANE = 'next-compass-map'

/**
 * The Clients' keys carry their props' version: a new shape is a new key, so
 * a reload mounts fresh instances instead of handing old ones props they
 * cannot read.
 */
const SPACE_KEY = 'space@2'

/** The space never grows past this many rows, which keeps its tree well inside the engine's bound. */
const SPACE_MAX_ROWS = 48

/**
 * A failed space is drawn again under a new key, so it always comes back; past this many failures
 * since load the fault is taken as lasting and the pane draws its plain text instead.
 */
const MAX_FAULTS = 3

const spaceKey = (faults: number): string => (faults === 0 ? SPACE_KEY : `${SPACE_KEY}#${faults}`)

const ACTIVITY_KEEP = 8

/** The kind of work a tool call is, as a palette index: 0 edit, 1 command, 2 read or search, 3 other. */
const kindOf = (tool: string): number => {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 0
  if (/^(Bash|PowerShell|BashOutput)$/.test(tool)) return 1
  if (/^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch)$/.test(tool)) return 2
  return 3
}

const KIND_NAMES = ['kindEdit', 'kindRun', 'kindRead', 'kindOther'] as const
/** The kinds in the order the label names them: read, edit, run, other. */
const KIND_ORDER = [2, 0, 1, 3] as const

/**
 * The recent tool calls by kind of work, as " · 読み取り(✦✦) · 編集(✦)": one gem
 * per call, the same gems that drift in the field, named and grouped. A kind
 * with no call is left out.
 */
const kindsLine = (t: Translate, tools: readonly string[]): string => {
  const counts = tools.map(kindOf).reduce<number[]>((acc, k) => acc.map((n, i) => (i === k ? n + 1 : n)), [0, 0, 0, 0])
  const parts = KIND_ORDER.filter(k => (counts[k] ?? 0) > 0).map(k =>
    t('kindCount', { name: t(KIND_NAMES[k] ?? 'kindOther'), gems: '✦'.repeat(counts[k] ?? 0) }),
  )
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`
}

const NO_TIMINGS: CompassTimings = { contextMs: 0, choicesMs: null, extrasMs: null, layoutMs: null, bandMs: null, mapMs: null, isPrefetched: false }

/** Bumped by every demo start and every prompt, so a demo's later frames stop once it is over. */
let demoRun = 0
let demoTimers: Timer[] = []

/** Stops a demo still playing: its timers and every state it wrote. */
async function stopDemo($: $): Promise<number> {
  demoRun += 1
  const run = demoRun
  demoTimers.forEach(t => t.cancel())
  demoTimers = []
  if (await getDemo($)) {
    await putWorking($, false)
    await putActivity($, () => [])
  }
  await putDemo($, false)
  await putGhost($, null)
  return run
}

async function playDemo($: $, rt: Runtime): Promise<void> {
  const run = await stopDemo($)
  await resetTurn($)
  await putDemo($, true)
  await openMap($)
  // A prompt that arrived while starting has stopped this run: leave nothing of it behind.
  if (run !== demoRun) return void (await putDemo($, false))
  demoTimers = demoFrames(rt.lang).map(frame => $.clock.after(frame.at, () => void applyFrame($, run, frame)))
}

async function applyFrame($: $, run: number, frame: DemoFrame): Promise<void> {
  if (run !== demoRun) return
  if (frame.set !== undefined) await putSet($, () => frame.set ?? null)
  if (frame.isWorking !== undefined) await putWorking($, frame.isWorking === true)
  if (frame.activity !== undefined) await putActivity($, () => frame.activity ?? [])
  if (frame.ghost !== undefined) await putGhost($, frame.ghost ?? null)
  if (frame.toast !== undefined) $.ui.toast(frame.toast)
}

async function openMap($: $) {
  const placed = await $.ui.open({ id: PANE, title: paneTitle })
  setMapShown(placed.isPlaced)
  return placed
}

/** The pane's title as registered; set once the language is known. */
let paneTitle = 'Meaning map'

const seconds = (rt: Runtime, ms: number | null): string => (ms === null ? '—' : rt.t('seconds', { s: (ms / 1000).toFixed(1) }))

/** A refresh or a retry: the four made anew, outside any turn. */
async function refresh($: $, rt: Runtime): Promise<void> {
  if (await getDemo($)) await stopDemo($)
  await generate($, rt, null)
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const rt: Runtime = { settings, t: makeT(resolveLang(settings.language, undefined)), lang: resolveLang(settings.language, undefined) }

  on('session.start', async ($, e, next) => {
    // A load (a reload after a fix included) gives the space a fresh start, and no work of the old module is still running.
    const claude = (await $.settings.read().catch(() => ({}))) as { language?: unknown }
    rt.lang = resolveLang(settings.language, claude.language)
    rt.t = makeT(rt.lang)
    paneTitle = rt.t('paneTitle')
    await putFaults($, () => 0)
    await setPhase($, 'idle', null)
    await putPreview($, null)
    await $.command.register({ name: 'compass', description: rt.t('commandDescription'), argumentHint: rt.t('commandHint') })
    if (settings.showMap) void openMap($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // `/clear` starts the conversation afresh: the last one's four, pool and work state go with it.
    if (e.reason === 'clear') {
      await stopDemo($)
      await resetTurn($)
      await putWorking($, false)
      await putActivity($, () => [])
    }
    return next(e)
  })

  on('ui.fault', { requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    $.ui.log(rt.t('redraw', { phase: e.phase, reason: e.reason }))
    await putFaults($, n => n + 1)
    return result
  })

  on('command.run', { command: 'compass' }, async ($, e) => {
    const [verb = 'map', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    const { t } = rt
    switch (verb) {
      case 'goal':
        await putGoal($, (arg.length > 0 ? arg.slice(0, 500) : null))
        return { text: arg.length > 0 ? t('goalSet', { goal: arg }) : t('goalCleared') }
      case 'demo':
        await playDemo($, rt)
        return { text: t('demoStarted') }
      case 'refresh':
        await refresh($, rt)
        return { text: t('refreshed') }
      case 'hide':
      case 'show':
        await putHidden($, verb === 'hide')
        if (verb === 'show') await openMap($)
        return { text: verb === 'hide' ? t('hidden') : t('shown') }
      case 'stats': {
        const s = await readStats($)
        const taken = s.band + s.map
        const rate = s.offered === 0 ? 0 : Math.round((taken / s.offered) * 100)
        return { text: s.offered === 0 ? t('statsNone') : t('stats', { ...s, rate }) }
      }
      case '':
      case 'map':
        await openMap($)
        return { text: t('mapOpened') }
      default:
        return { text: t('unknownVerb', { verb, hint: t('commandHint') }) }
    }
  })

  /**
   * A new model turn on the main loop is what makes the four stale, not a submission: a slash
   * command, or a notification that starts no turn, leaves them as they are. A subagent's turns
   * carry an `agentId` and change nothing here.
   */
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await stopDemo($)
      await resetTurn($)
      await putWorking($, true)
      await putActivity($, () => [])
      beginTurn($, rt)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      await putActivity($, list => [...list, String(e.tool)].slice(-ACTIVITY_KEEP)).catch(() => undefined)
      noteToolCall($, rt)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await putWorking($, false)
      endTurn()
      if (e.reason === 'answer') void generate($, rt, e.answer)
    }
    return result
  })

  // Claude Code's own guess at the next prompt stays shown as it is; it also becomes one of our candidates.
  on('prompt.suggest', async ($, e, next) => {
    if (e.origin.kind === 'suggestion') void noteSuggestion($, e.text).catch(() => undefined)
    return next(e)
  })

  // A prompt the person typed while the four were up counts against them.
  on('prompt.submit', async ($, e, next) => {
    if (!sendingNow() && e.command === undefined && e.isMeta !== true && (await getSet($)) !== null) {
      void bumpStat($, 'typed')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    setMapShown(false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || !e.element.startsWith(SPACE_KEY)) return next(e)
    const data = (e.data ?? {}) as Record<string, unknown>
    const fill = data.fill === true
    // The map shows the four as chips, never their whole text: a digit there fills the prompt box.
    if (data.kind === 'choose' && typeof data.index === 'number') {
      await choose($, rt, Math.trunc(data.index), true)
    } else if (data.kind === 'pick' && typeof data.x === 'number' && typeof data.y === 'number') {
      await pick($, rt, {
        point: { x: data.x, y: data.y },
        fill: fill || data.previewShownWhole !== true,
        isOnPreview: data.isOnPreview === true,
        previewText: typeof data.previewText === 'string' ? data.previewText : null,
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking || (await getHidden($))) return next(e)
    const set = await getSet($)
    const phase: CompassPhase = await getPhase($)
    const note = await getNote($)
    const { t } = rt
    const { Box, Button, Text } = $.ui.resolve(e)

    if (phase === 'thinking' || phase === 'blending') {
      return <Text dimColor>✦ {phase === 'thinking' ? t('thinking') : t('blending')}</Text>
    }
    if (phase === 'error') {
      return (
        <Box flexDirection="row">
          <Text color="warning">{t('failed', { why: note ?? '' })}</Text>
          <Button plain key="retry" label={t('retry')} onPress={() => void refresh($, rt)} />
        </Box>
      )
    }
    if (set === null) return next(e)
    const isDemo = await getDemo($)
    if (set.items.filter(i => i.isPrimary).length < PRIMARY_COUNT) {
      return <Text color="claude">✦ {isDemo ? t('demoPrefix') : ''}{t('pickingFour')}</Text>
    }

    const width = Math.max(20, e.props.bodyColumns)
    // A choice the band cannot show whole is sent to the prompt box instead: what is sent is what was read.
    const pickButton = (i: number, room: number) => {
      const text = set.items[i]?.text ?? ''
      const cut = cutToCells(text, Math.max(4, room))
      const isCut = cut !== text
      return (
        <Button plain key={`pick:${i}`} hotkey={String(i + 1)} onPress={() => void choose($, rt, i, isCut, text)}>
          <Text color={PALETTE[i]} bold>
            {ARROWS[i]}{' '}
          </Text>
          {cut}
        </Button>
      )
    }
    const edit = (i: number) => (
      <Button plain dimColor key={`edit:${i}`} label="✎" onPress={() => void choose($, rt, i, true, set.items[i]?.text)} />
    )
    const header = (
      <Box flexDirection="row">
        <Text color="claude" bold>
          {t('bandTitle')}{isDemo ? t('demoTag') : ''}{' '}
        </Text>
        {set.isRefining === true && <Text color="claude">{t('refining')}</Text>}
        <Text dimColor>{settings.keyMode === 'arrow' ? t('hintArrow') : t('hintNumber')}</Text>
      </Box>
    )

    if (settings.keyMode === 'arrow') {
      const room = Math.floor(width / 2) - 6
      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="row" justifyContent="center">{pickButton(0, room)}{edit(0)}</Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row">{pickButton(3, room)}{edit(3)}</Box>
            <Box flexDirection="row">{pickButton(1, room)}{edit(1)}</Box>
          </Box>
          <Box flexDirection="row" justifyContent="center">{pickButton(2, room)}{edit(2)}</Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {header}
        {Array.from({ length: PRIMARY_COUNT }, (_, i) => (
          <Box key={`row:${i}`} flexDirection="row">
            {pickButton(i, width - 10)}
            <Text> </Text>
            {edit(i)}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { t } = rt
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>{t('noMapHere')}</Text>
    }
    const { Box, Client, Text } = $.ui.resolve(e)
    const set = await getSet($)
    const phase = await getPhase($)
    const isBusy = phase === 'thinking' || phase === 'blending'
    const isWorking = await getWorking($)
    const words = await getActivity($)
    const isDemo = await getDemo($)
    const ghost = await getGhost($)
    const preview = await getPreview($)
    const label = isBusy
      ? t('paneThinking')
      : isWorking
        ? t('paneWorking', { demo: isDemo ? t('demoTag') : '', kinds: kindsLine(t, words) })
        : t('paneIdle')
    const labels = set === null ? [] : [set.axes.up, set.axes.right, set.axes.down, set.axes.left]
    const tm: CompassTimings = set?.timings ?? NO_TIMINGS
    // One Client for every moment, so the free field melts into the map without a seam; its
    // height is fixed (two footer lines always) and capped, which also bounds its tree.
    const height = Math.min(SPACE_MAX_ROWS, Math.max(8, e.props.scroll.bodyRows - 2))
    const status =
      set === null
        ? ' '
        : isDemo
          ? t('statusDemo')
          : t('statusTimes', {
              band: seconds(rt, tm.bandMs),
              prefetched: tm.isPrefetched ? t('statusPrefetched') : '',
              map: set.isMapPending ? t('statusMapPending') : seconds(rt, tm.mapMs),
            })
    const help = set === null ? ' ' : phase === 'blending' ? t('helpBlending') : preview !== null ? t('helpPreview') : t('helpMap')
    const faults = await getFaults($)
    if (faults >= MAX_FAULTS) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{label}</Text>
          <Text dimColor>{t('faultText')}</Text>
          <Text dimColor wrap="truncate-end">
            {status}
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Client
          key={spaceKey(faults)}
          module="./space.tsx"
          props={{ gems: words.map(kindOf), label, isWorking: isWorking || isBusy, items: set?.items ?? [], labels, isBusy, ghost, preview }}
          width="100%"
          height={height}
        />
        <Text color={isDemo ? 'claude' : undefined} dimColor={!isDemo} wrap="truncate-end">
          {status}
        </Text>
        <Text dimColor wrap="truncate-end">
          {help}
        </Text>
      </Box>
    )
  })
}
