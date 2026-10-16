import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { CompassChoice, CompassPhase, CompassSet, CompassTimings } from '../types'
import {
  ARROWS,
  PALETTE,
  PRIMARY_COUNT,
  buildBlendPrompt,
  buildChoicesPrompt,
  buildPairPrompt,
  buildPlacedExtrasPrompt,
  buildPoolPrompt,
  buildSelectPrompt,
  buildExtrasPrompt,
  buildPlacePrompt,
  clampExtra,
  parseBlend,
  parseChoices,
  parseExtras,
  parsePairs,
  parsePlacedExtras,
  parseSelect,
  pickLocally,
  POOL_SIZE,
  parsePlacement,
  summarizeMessages,
  weightsAt,
} from './compass'
import type { Point } from './compass'
import { demoBlendText, demoFrames } from './demo'
import { cutToCells } from './field'
import type { DemoFrame } from './demo'

const PANE = 'next-compass-map'
const PANE_TITLE = '意味空間マップ'

/**
 * The Clients' keys carry their props' version: a new shape is a new key, so
 * a reload mounts fresh instances instead of handing old ones props they
 * cannot read.
 */
const SPACE_KEY = 'space@1'

/** The space never grows past this many rows, which keeps its tree well inside the engine's bound. */
const SPACE_MAX_ROWS = 48

/**
 * A failed space is drawn again under a new key, so it always comes back; past this many failures
 * since load the fault is taken as lasting and the pane draws its plain text instead.
 */
const MAX_FAULTS = 3

/** The space's key: the first instance keeps the plain key, each remount after a fault a new one. */
const spaceKey = (faults: number): string => (faults === 0 ? SPACE_KEY : `${SPACE_KEY}#${faults}`)

const setAtom = atom({ plugin: 'next-compass', key: 'set' } as const, null)
const phaseAtom = atom({ plugin: 'next-compass', key: 'phase' } as const, 'idle')
const noteAtom = atom({ plugin: 'next-compass', key: 'note' } as const, null)
const goalAtom = atom({ plugin: 'next-compass', key: 'goal' } as const, null)
const hiddenAtom = atom({ plugin: 'next-compass', key: 'isHidden' } as const, false)
const workingAtom = atom({ plugin: 'next-compass', key: 'isWorking' } as const, false)
const activityAtom = atom({ plugin: 'next-compass', key: 'activity' } as const, [])
const demoAtom = atom({ plugin: 'next-compass', key: 'isDemo' } as const, false)
const ghostAtom = atom({ plugin: 'next-compass', key: 'ghost' } as const, null)
const faultsAtom = atom({ plugin: 'next-compass', key: 'faults' } as const, 0)

const ACTIVITY_KEEP = 8

/** The kind of work a tool call is, as a palette index: 0 edit, 1 command, 2 read or search, 3 other. */
const kindOf = (tool: string): number => {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 0
  if (/^(Bash|PowerShell|BashOutput)$/.test(tool)) return 1
  if (/^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch)$/.test(tool)) return 2
  return 3
}

type $ = EngineInterface

type Settings = {
  keyMode: 'number' | 'arrow'
  choiceMode: 'split' | 'single'
  generator: 'haiku' | 'sonnet' | 'opus' | 'fork'
  showMap: boolean
  extraCount: number
}

const readSettings = (options: PluginOptions): Settings => ({
  keyMode: options.keyMode === 'arrow' ? 'arrow' : 'number',
  choiceMode: options.choiceMode === 'single' ? 'single' : 'split',
  generator:
    options.generator === 'sonnet' || options.generator === 'opus' || options.generator === 'fork'
      ? options.generator
      : 'haiku',
  showMap: options.showMap !== false,
  extraCount: clampExtra(typeof options.extraCount === 'number' ? options.extraCount : 8),
})

const REASONS: Record<string, string> = {
  'api-error': 'API に接続できませんでした',
  'empty-reply': 'モデルから返答がありませんでした',
  aborted: '途中で取り消されました',
  'nothing-to-fork': 'まだ会話がありません',
}

const setPhase = async ($: $, phase: CompassPhase, note: string | null): Promise<void> => {
  await update($, phaseAtom, () => phase)
  await update($, noteAtom, () => note)
}

const clearChoices = async ($: $): Promise<void> => {
  await update($, setAtom, () => null)
  await setPhase($, 'idle', null)
}

/** Bumped by every new generation, send or prompt; an older reply that lands late is dropped. */
let latest = 0

/** Whether the map pane is placed on a surface; extras are made only while it is. */
let isMapShown = false

/** One model call: a fork over the conversation, or a plain completion on the chosen model. */
async function ask($: $, settings: Settings, prompt: string, maxTokens: number, timeoutMs?: number) {
  if (settings.generator === 'fork') return $.model.fork({ prompt })
  const limit = timeoutMs === undefined ? {} : { timeoutMs }
  return $.model.complete({ model: settings.generator, prompt, maxTokens, effort: 'low', ...limit })
}

/** This turn's number: a prefetch that lands after its turn ended is dropped. */
let turnSeq = 0
/** Candidates prepared while Claude works, for the end of the turn to pick four from. */
let pool: CompassChoice[] = []
/** The turn whose prefetch is in flight, if any: one at a time. */
let prefetchingSeq: number | null = null
let turnCalls = 0
let prefetchCount = 0
let lastPrefetchAt = Number.NEGATIVE_INFINITY
let prefetchTimer: Timer | null = null

/** The in-flight prefetch's work, so the end of the turn can wait a little for it. */
let inflight: Promise<void> | null = null

/** A prefetch starts after this many tool calls, or this long into the turn, whichever comes first. */
const PREFETCH_AFTER_CALLS = 1
const PREFETCH_DELAY_MS = 3000
/** Later prefetches refresh the pool at most this often, at most this many times a turn. */
const PREFETCH_GAP_MS = 10000
const MAX_PREFETCH = 6
/** How long the end of the turn waits for a prefetch still in flight before generating afresh. */
const PREFETCH_WAIT_MS = 2500
/** Preparing and picking always go to the fastest model, whatever writes the rest. */
const FAST_MODEL = 'haiku'
/** Past this the select call is given up and the four picked at once stay. */
const SELECT_TIMEOUT_MS = 4000

/**
 * Prepares candidates while Claude works: one placed call over the
 * conversation so far. The newest pool replaces the last, so the end of the
 * turn picks from the freshest.
 */
async function prefetch($: $, settings: Settings, seq: number): Promise<void> {
  if (prefetchingSeq === seq || seq !== turnSeq || prefetchCount >= MAX_PREFETCH) return
  // Claimed before any await, so tool calls landing together start one prefetch, not several.
  prefetchingSeq = seq
  try {
    const now = await $.clock.now()
    if (now - lastPrefetchAt < PREFETCH_GAP_MS) return
    prefetchCount += 1
    lastPrefetchAt = now
    const work = fillPool($, seq)
    inflight = work.then(
      () => undefined,
      () => undefined,
    )
    await work
  } finally {
    if (prefetchingSeq === seq) prefetchingSeq = null
  }
}

/** One fast call over the conversation so far; its candidates become the pool if the turn is still on. */
async function fillPool($: $, seq: number): Promise<void> {
  const goal = await read($, goalAtom)
  const transcript = summarizeMessages(await $.session.messages())
  const prompt = buildPoolPrompt({ goal, transcript })
  const reply = await $.model.complete({ model: FAST_MODEL, prompt, maxTokens: 50 * POOL_SIZE + 40, effort: 'low' })
  const found = reply.isAnswered ? parsePlacedExtras(reply.text, POOL_SIZE) : []
  if (seq === turnSeq && found.length >= PRIMARY_COUNT) pool = found
}

/**
 * The pool for the turn that just ended, emptied: as it is, or after waiting
 * up to PREFETCH_WAIT_MS for a prefetch still in flight. Empty when there is
 * none worth picking from.
 */
async function takePool($: $): Promise<CompassChoice[]> {
  const seq = turnSeq
  if (pool.length < PRIMARY_COUNT && prefetchingSeq === seq && inflight !== null) {
    const stop = new AbortController()
    const nap = $.clock.sleep(PREFETCH_WAIT_MS, { signal: stop.signal }).catch(() => undefined)
    await Promise.race([inflight, nap])
    stop.abort()
  }
  // A new turn began while waiting: the pool now filling is that turn's, not this one's.
  if (seq !== turnSeq) return []
  const taken = pool.length >= PRIMARY_COUNT ? pool : []
  pool = []
  return taken
}

/** Starts a prefetch unawaited; a failed one only means the end of the turn generates afresh. */
function startPrefetch($: $, settings: Settings): void {
  if (settings.choiceMode !== 'split') return
  void prefetch($, settings, turnSeq).catch(() => undefined)
}

/** The placing call needs no conversation, so it always goes to the cheapest model. */
async function askPlace($: $, settings: Settings, prompt: string) {
  const model = settings.generator === 'fork' ? 'haiku' : settings.generator
  return $.model.complete({ model, prompt, maxTokens: 300, effort: 'low' })
}

const NO_TIMINGS: CompassTimings = {
  contextMs: 0,
  choicesMs: null,
  extrasMs: null,
  placeMs: null,
  bandMs: null,
  mapMs: null,
  isPrefetched: false,
}

const seconds = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}秒`)


/** Runs one call and times it; the reply's text, or null with why. */
async function timed($: $, run: () => ReturnType<typeof ask>) {
  const start = await $.clock.now()
  const reply = await run()
  const ms = (await $.clock.now()) - start
  return reply.isAnswered
    ? { text: reply.text, ms, why: null }
    : { text: null, ms, why: REASONS[reply.reason] ?? reply.reason }
}

type ContextArgs = { goal: string | null; transcript: string | null }

/**
 * The four, timed: split runs the two axes' halves in parallel (the time is
 * the slower half's), single asks for all four at once.
 */
async function askChoices($: $, settings: Settings, context: ContextArgs) {
  if (settings.choiceMode === 'single') {
    const one = await timed($, () => ask($, settings, buildChoicesPrompt(context), 400))
    return { parsed: one.text === null ? null : parseChoices(one.text), ms: one.ms, why: one.why }
  }
  const [v, h] = await Promise.all([
    timed($, () => ask($, settings, buildPairPrompt(context, 'vertical'), 160)),
    timed($, () => ask($, settings, buildPairPrompt(context, 'horizontal'), 160)),
  ])
  const parsed = v.text === null || h.text === null ? null : parsePairs(v.text, h.text)
  return { parsed, ms: Math.max(v.ms, h.ms), why: v.why ?? h.why }
}

/** What the extras calls bring: candidates already placed (split), or texts still to place (single). */
type Extras = { placed: CompassChoice[] | null; texts: string[]; ms: number }

/** Extras calls that failed bring nothing, so the map stops waiting for them. */
const NO_EXTRAS: Extras = { placed: [], texts: [], ms: 0 }

/**
 * The extras, timed. Split: two self-placing halves in parallel, so no placing
 * call follows. Single: one call of texts, placed once the four are known.
 */
async function askExtras($: $, settings: Settings, context: ContextArgs): Promise<Extras> {
  const n = settings.extraCount
  if (settings.choiceMode === 'single') {
    const one = await timed($, () => ask($, settings, buildExtrasPrompt({ ...context, count: n }), 700))
    return { placed: null, texts: one.text === null ? [] : parseExtras(one.text, n), ms: one.ms }
  }
  const counts = { a: Math.ceil(n / 2), b: Math.floor(n / 2) }
  const halves = await Promise.all(
    (['a', 'b'] as const)
      .filter(half => counts[half] > 0)
      .map(half =>
        timed($, () => ask($, settings, buildPlacedExtrasPrompt({ ...context, count: counts[half], half }), 60 * counts[half] + 40)).then(
          r => ({ placed: r.text === null ? [] : parsePlacedExtras(r.text, counts[half]), ms: r.ms }),
        ),
      ),
  )
  const placed = halves.flatMap(h => h.placed).filter((e, i, all) => all.findIndex(o => o.text === e.text) === i)
  return { placed, texts: [], ms: Math.max(0, ...halves.map(h => h.ms)) }
}

/** The pool's candidates a pick did not use, as map extras. */
const restOf = (prepared: readonly CompassChoice[], used: readonly number[]): CompassChoice[] =>
  prepared.filter((_, i) => !used.includes(i)).map(c => ({ ...c, isPrimary: false }))

/** Extras with each text once, none repeating one of the four. */
const distinctExtras = (primaries: readonly CompassChoice[], extras: readonly CompassChoice[]): CompassChoice[] =>
  extras.filter(
    (e, i) => !primaries.some(p => p.text === e.text) && extras.findIndex(o => o.text === e.text) === i,
  )

/**
 * The end of a turn with a pool: the four picked locally and shown at once,
 * then the fast select call picks again for Claude's final answer and, if it
 * lands, the four are replaced in place. The map gets the rest at once and
 * the parallel extras when they land.
 */
async function generateFromPool(
  $: $,
  settings: Settings,
  ids: { id: number; start: number },
  answer: string,
  prepared: CompassChoice[],
): Promise<void> {
  const { id, start } = ids
  const local = pickLocally(prepared)
  if (local === null) return
  const wantsExtras = isMapShown && settings.extraCount > 0
  const bandMs = (await $.clock.now()) - start
  const timings: CompassTimings = {
    contextMs: 0,
    choicesMs: null,
    extrasMs: null,
    placeMs: null,
    bandMs,
    mapMs: null,
    isPrefetched: true,
  }
  const items = [...local.parsed.items, ...restOf(prepared, local.used)]
  await update($, setAtom, (): CompassSet => ({ id, axes: local.parsed.axes, items, isMapPending: wantsExtras, isRefining: true, timings }))
  await setPhase($, 'idle', null)
  const goal = await read($, goalAtom)
  const extrasCall = wantsExtras
    ? $.session
        .messages()
        .then(m => askExtras($, settings, { goal, transcript: summarizeMessages(m) }))
        .catch(() => NO_EXTRAS)
    : null
  await refine($, id, answer, prepared, goal)
  if (extrasCall !== null) await mergeExtras($, settings, id, start, extrasCall)
}

/** Replaces the four shown at once with the select call's pick for the final answer, if it lands in time. */
async function refine($: $, id: number, answer: string, prepared: CompassChoice[], goal: string | null): Promise<void> {
  const prompt = buildSelectPrompt({ answer, pool: prepared, goal })
  const request = { model: FAST_MODEL, prompt, maxTokens: 200, effort: 'low' as const, timeoutMs: SELECT_TIMEOUT_MS }
  // A call that throws (a refused request) must still end the "refining" note.
  const reply = await timed($, () => $.model.complete(request)).catch(() => ({ text: null, ms: null, why: null }))
  const picked = reply.text === null ? null : parseSelect(reply.text, prepared)
  await patchSet($, id, s => {
    const timings = { ...s.timings, choicesMs: reply.ms }
    if (picked === null) return { ...s, isRefining: false, timings }
    const primaries = picked.parsed.items
    const extras = distinctExtras(primaries, [...restOf(prepared, picked.used), ...s.items.filter(i => !i.isPrimary)])
    return { ...s, axes: picked.parsed.axes, items: [...primaries, ...extras], isRefining: false, timings }
  })
}

/** Merges into the set only while it is still this generation's. */
async function patchSet($: $, id: number, fn: (set: CompassSet) => CompassSet): Promise<void> {
  await update($, setAtom, set => (set !== null && set.id === id ? fn(set) : set))
}

/** `answer`: Claude's final answer when a turn just ended; null for a refresh asked by command. */
async function generate($: $, settings: Settings, answer: string | null): Promise<void> {
  try {
    await generateChoices($, settings, answer)
  } catch {
    // Only a request the engine refuses to send rejects (a blocked model, say): say so, never hang.
    await setPhase($, 'error', 'モデルを呼び出せませんでした')
  }
}

async function generateChoices($: $, settings: Settings, answer: string | null): Promise<void> {
  // Real choices end a demo, or they would show and refuse to send.
  if (await read($, demoAtom)) await stopDemo($)
  const id = (latest = latest + 1)
  const start = await $.clock.now()
  await setPhase($, 'thinking', null)
  const prepared = answer !== null && settings.choiceMode === 'split' ? await takePool($) : []
  if (id !== latest) return
  if (prepared.length > 0) return generateFromPool($, settings, { id, start }, answer ?? '', prepared)
  const goal = await read($, goalAtom)
  const transcript = settings.generator === 'fork' ? null : summarizeMessages(await $.session.messages())
  const contextMs = (await $.clock.now()) - start
  const wantsExtras = isMapShown && settings.extraCount > 0
  const context = { goal, transcript }
  const choicesCall = askChoices($, settings, context)
  const extrasCall = wantsExtras ? askExtras($, settings, context).catch(() => NO_EXTRAS) : null
  const choices = await choicesCall
  if (id !== latest) return
  const { parsed } = choices
  if (parsed === null) return setPhase($, 'error', choices.why ?? '候補を読み取れませんでした')
  const bandMs = (await $.clock.now()) - start
  const timings: CompassTimings = {
    contextMs,
    choicesMs: choices.ms,
    extrasMs: null,
    placeMs: null,
    bandMs,
    mapMs: null,
    isPrefetched: false,
  }
  const set: CompassSet = { id, ...parsed, isMapPending: extrasCall !== null, isRefining: false, timings }
  await update($, setAtom, () => set)
  await setPhase($, 'idle', null)
  if (extrasCall !== null) await mergeExtras($, settings, id, start, extrasCall)
}

/** Waits for the parallel extras, places them if they came as texts, and merges them into the set. */
async function mergeExtras(
  $: $,
  settings: Settings,
  id: number,
  start: number,
  extrasCall: Promise<Extras>,
): Promise<void> {
  const extras = await extrasCall
  const set = await read($, setAtom)
  if (set === null || set.id !== id) return
  const own = new Set(set.items.map(i => i.text))
  const placeCall =
    extras.placed !== null || extras.texts.length === 0
      ? null
      : await timed($, () =>
          askPlace($, settings, buildPlacePrompt({ axes: set.axes, primaries: set.items.map(i => i.text), extras: extras.texts })),
        )
  const points = parsePlacement(placeCall?.text ?? '', extras.texts.length)
  const placed = (
    extras.placed ??
    extras.texts.map((text, i): CompassChoice => ({ text, x: points[i]?.x ?? 0, y: points[i]?.y ?? 0, isPrimary: false }))
  ).filter(e => !own.has(e.text))
  const mapMs = (await $.clock.now()) - start
  await patchSet($, id, s => ({
    ...s,
    items: [...s.items, ...placed.filter(p => !s.items.some(i => i.text === p.text))],
    isMapPending: false,
    timings: { ...s.timings, extrasMs: extras.ms, placeMs: placeCall?.ms ?? null, mapMs },
  }))
}

async function send($: $, text: string, fill: boolean): Promise<void> {
  latest += 1
  await clearChoices($)
  if (fill) {
    await $.prompt.fill({ text })
    return
  }
  await $.prompt.submit({ text, asUser: true })
}

/**
 * Sends a choice. `shown` is the text the band drew under the key pressed: that is what is sent,
 * never a text the four were replaced with since (a refine landing just before the press).
 */
async function choose($: $, index: number, fill: boolean, shown?: string): Promise<void> {
  const text = shown ?? (await read($, setAtom))?.items[index]?.text
  if (text === undefined) return
  if (await read($, demoAtom)) return $.ui.toast(`デモのため送信しません：「${text}」`)
  await send($, text, fill)
}

/** Bumped by every demo start and every prompt, so a demo's later frames stop once it is over. */
let demoRun = 0
let demoTimers: Timer[] = []

/** Stops a demo still playing: its timers and the demo state. */
async function stopDemo($: $): Promise<number> {
  demoRun += 1
  const run = demoRun
  demoTimers.forEach(t => t.cancel())
  demoTimers = []
  await update($, demoAtom, () => false)
  await update($, ghostAtom, () => null)
  return run
}

/** Plays the scripted demo: each frame on a timer, all of them dropped once another demo or a prompt starts. */
async function playDemo($: $): Promise<void> {
  const run = await stopDemo($)
  latest += 1
  await update($, demoAtom, () => true)
  await setPhase($, 'idle', null)
  await openMap($)
  // A prompt that arrived while starting has stopped this run: leave nothing of it behind.
  if (run !== demoRun) return void (await update($, demoAtom, () => false))
  demoTimers = demoFrames().map(frame => $.clock.after(frame.at, () => void applyFrame($, run, frame)))
}

/** One frame of the demo, written to the state the band and the panes draw from. */
async function applyFrame($: $, run: number, frame: DemoFrame): Promise<void> {
  if (run !== demoRun) return
  if (frame.set !== undefined) await update($, setAtom, () => frame.set ?? null)
  if (frame.isWorking !== undefined) await update($, workingAtom, () => frame.isWorking === true)
  if (frame.activity !== undefined) await update($, activityAtom, () => frame.activity ?? [])
  if (frame.ghost !== undefined) await update($, ghostAtom, () => frame.ghost ?? null)
  if (frame.toast !== undefined) $.ui.toast(frame.toast)
}

async function blend($: $, settings: Settings, point: Point, fill: boolean): Promise<void> {
  const set = await read($, setAtom)
  if (set === null) return
  if (await read($, demoAtom)) return $.ui.toast(`デモのため送信しません：${demoBlendText(point, set.items)}`)
  const top = weightsAt(point, set.items)[0]
  const nearest = top === undefined ? undefined : set.items[top.index]
  if (top !== undefined && nearest !== undefined && top.weight >= 0.8) {
    return send($, nearest.text, fill)
  }
  const id = latest
  await setPhase($, 'blending', null)
  const goal = await read($, goalAtom)
  const prompt = buildBlendPrompt({ point, axes: set.axes, items: set.items, goal })
  const reply = await ask($, settings, prompt, 300).catch(() => null)
  if (id !== latest) return
  const text = reply?.isAnswered === true ? parseBlend(reply.text) : null
  if (text === null || reply === null) {
    const why = reply === null || reply.isAnswered ? '指示を作れませんでした' : (REASONS[reply.reason] ?? reply.reason)
    return setPhase($, 'error', why)
  }
  // A text the model wrote from the conversation (files, pages) goes to the prompt box to be
  // read and sent by the person, never submitted unseen in their name.
  await setPhase($, 'idle', null)
  await $.prompt.fill({ text })
}

async function openMap($: $) {
  const placed = await $.ui.open({ id: PANE, title: PANE_TITLE })
  isMapShown = placed.isPlaced
  return placed
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.end', async ($, e, next) => {
    // `/clear` starts the conversation afresh: the last one's four, pool and work state go with it.
    if (e.reason === 'clear') {
      await stopDemo($)
      latest += 1
      turnSeq += 1
      pool = []
      await clearChoices($)
      await update($, workingAtom, () => false)
      await update($, activityAtom, () => [])
    }
    return next(e)
  })

  on('ui.fault', { requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    // The engine dropped the space: count it, which redraws the pane with a fresh instance.
    $.ui.log(`next-compass: 空間を描き直します（${e.phase}: ${e.reason}）`)
    await update($, faultsAtom, n => n + 1)
    return result
  })

  on('session.start', async ($, e, next) => {
    // A load (a reload after a fix included) gives the space a fresh start.
    await update($, faultsAtom, () => 0)
    await $.command.register({
      name: 'compass',
      description: '次の一手の4択とマップを操作します（map / goal <目的> / refresh / hide / show / demo）',
      argumentHint: '[map | goal <目的> | refresh | hide | show | demo]',
    })
    if (settings.showMap) void openMap($)
    return next(e)
  })

  on('command.run', { command: 'compass' }, async ($, e) => {
    const [verb = 'map', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    if (verb === 'goal') {
      await update($, goalAtom, () => (arg.length > 0 ? arg.slice(0, 500) : null))
      return { text: arg.length > 0 ? `目的を「${arg}」に設定しました。` : '目的を消しました。' }
    }
    if (verb === 'demo') {
      await playDemo($)
      return { text: 'デモを再生します（約13秒）。モデルは呼ばず、何も送信しません。次にプロンプトを送ると終わります。' }
    }
    if (verb === 'refresh') {
      await generate($, settings, null)
      return { text: '次の一手を作り直しました。' }
    }
    if (verb === 'hide' || verb === 'show') {
      await update($, hiddenAtom, () => verb === 'hide')
      if (verb === 'show') await openMap($)
      return {
        text: verb === 'hide' ? '帯の4択を隠しました。マップには引き続き表示します。' : '帯の4択とマップを表示します。',
      }
    }
    if (verb === '' || verb === 'map') {
      await openMap($)
      return { text: 'マップを開きました。' }
    }
    return { text: `「${verb}」は使えません。使い方：/compass [map | goal <目的> | refresh | hide | show | demo]` }
  })

  /**
   * A new model turn on the main loop is what makes the four stale, not a submission: a slash
   * command, or a notification that starts no turn, leaves them as they are. A turn the person
   * did not type (a background task's notification answered) still replaces them, as its answer
   * is new context; a subagent's turns carry an `agentId` and change nothing here.
   */
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await stopDemo($)
      latest += 1
      await clearChoices($)
      await update($, workingAtom, () => true)
      await update($, activityAtom, () => [])
      turnSeq += 1
      pool = []
      turnCalls = 0
      prefetchCount = 0
      lastPrefetchAt = Number.NEGATIVE_INFINITY
      prefetchTimer?.cancel()
      prefetchTimer = $.clock.after(PREFETCH_DELAY_MS, () => startPrefetch($, settings))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      const tool = String(e.tool)
      await update($, activityAtom, list => [...list, tool].slice(-ACTIVITY_KEEP))
      turnCalls += 1
      if (turnCalls >= PREFETCH_AFTER_CALLS) startPrefetch($, settings)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, workingAtom, () => false)
      prefetchTimer?.cancel()
      prefetchTimer = null
    }
    if (e.agentId === undefined && e.reason === 'answer') {
      void generate($, settings, e.answer)
    }
    return result
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    isMapShown = false
    return result
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || !e.element.startsWith(SPACE_KEY)) return next(e)
    const data = (e.data ?? {}) as Record<string, unknown>
    const fill = data.fill === true
    if (data.kind === 'choose' && typeof data.index === 'number') {
      await choose($, Math.trunc(data.index), fill)
    } else if (data.kind === 'pick' && typeof data.x === 'number' && typeof data.y === 'number') {
      await blend($, settings, { x: data.x, y: data.y }, fill)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking || (await read($, hiddenAtom))) return next(e)
    const set = await read($, setAtom)
    const phase = await read($, phaseAtom)
    const note = await read($, noteAtom)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (phase === 'thinking' || phase === 'blending') {
      const label = phase === 'thinking' ? '次の一手を考えています…' : 'マップで選んだ位置から指示を作っています…'
      return <Text dimColor>✦ {label}</Text>
    }
    if (phase === 'error') {
      return (
        <Box flexDirection="row">
          <Text color="warning">次の一手を作れませんでした：{note ?? ''} </Text>
          <Button plain key="retry" label="再試行する" onPress={() => void generate($, settings, null)} />
        </Box>
      )
    }
    if (set === null) return next(e)
    const isDemo = await read($, demoAtom)
    if (set.items.filter(i => i.isPrimary).length < PRIMARY_COUNT) {
      return <Text color="claude">✦ {isDemo ? 'デモ：' : ''}空間から4択を選んでいます…</Text>
    }

    const width = Math.max(20, e.props.bodyColumns)
    const pick = (i: number, room: number) => {
      const text = set.items[i]?.text ?? ''
      const cut = cutToCells(text, Math.max(4, room))
      return (
        <Button plain key={`pick:${i}`} hotkey={String(i + 1)} onPress={() => void choose($, i, false, set.items[i]?.text)}>
          <Text color={PALETTE[i]} bold>
            {ARROWS[i]}{' '}
          </Text>
          {cut}
        </Button>
      )
    }
    const edit = (i: number) => (
      <Button plain dimColor key={`edit:${i}`} label="✎" onPress={() => void choose($, i, true, set.items[i]?.text)} />
    )
    const header = (
      <Box flexDirection="row">
        <Text color="claude" bold>
          ✦ 次の一手{isDemo ? '（デモ）' : ''}{' '}
        </Text>
        {set.isRefining === true && <Text color="claude">回答に合わせて調整中… </Text>}
        <Text dimColor>
          {settings.keyMode === 'arrow'
            ? 'ctrl+x tab で選択に移り、矢印キーと Enter で送信 · 数字キーも使えます · ✎ は入力欄へ'
            : '入力欄が空のとき 1〜4 で送信 · ✎ は入力欄に入れて手直し · /compass でマップ'}
        </Text>
      </Box>
    )

    if (settings.keyMode === 'arrow') {
      const room = Math.floor(width / 2) - 6
      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="row" justifyContent="center">{pick(0, room)}{edit(0)}</Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row">{pick(3, room)}{edit(3)}</Box>
            <Box flexDirection="row">{pick(1, room)}{edit(1)}</Box>
          </Box>
          <Box flexDirection="row" justifyContent="center">{pick(2, room)}{edit(2)}</Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {header}
        {Array.from({ length: PRIMARY_COUNT }, (_, i) => (
          <Box key={`row:${i}`} flexDirection="row">
            {pick(i, width - 10)}
            <Text> </Text>
            {edit(i)}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>この画面ではマップを表示できません。</Text>
    }
    const { Box, Client, Text } = $.ui.resolve(e)
    const set = await read($, setAtom)
    const phase = await read($, phaseAtom)
    const isBusy = phase === 'thinking' || phase === 'blending'
    const isWorking = await read($, workingAtom)
    const words = await read($, activityAtom)
    const isDemo = await read($, demoAtom)
    const ghost = await read($, ghostAtom)
    const label = isBusy
      ? '✦ 次の一手を考えています…'
      : isWorking
        ? `✦ ${isDemo ? '（デモ）' : ''}Claude が作業中です。意味空間が動いています${words.length > 0 ? `（${words.length}件の操作）` : ''}`
        : 'Claude の返答が終わると、ここに次の一手の候補が並びます。'
    const labels = set === null ? [] : [set.axes.up, set.axes.right, set.axes.down, set.axes.left]
    // A set kept in state from before timings existed (a hot reload) has none.
    const t: CompassTimings = set?.timings ?? NO_TIMINGS
    // One Client for every moment, so the free field melts into the map without a seam; its
    // height is fixed (two footer lines always) and capped, which also bounds its tree.
    const height = Math.min(SPACE_MAX_ROWS, Math.max(8, e.props.scroll.bodyRows - 2))
    const status =
      set === null
        ? ' '
        : isDemo
          ? 'デモ表示中：モデルは呼ばず、選んでも送信しません。'
          : `4択 ${seconds(t.bandMs)}${t.isPrefetched === true ? '（作業中に準備）' : ''} · マップ ${set.isMapPending === true ? '候補を作成中…' : seconds(t.mapMs)}`
    const help =
      set === null
        ? ' '
        : isBusy
          ? '指示を作っています…'
          : 'クリック／矢印キー＋Enter で、その位置の指示を入力欄へ · 1〜4 で4択を送信'
    const faults = await read($, faultsAtom)
    if (faults >= MAX_FAULTS) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{label}</Text>
          <Text dimColor>空間の描画で問題が続いたため、簡易表示にしています。/reload-plugins で再挑戦できます。</Text>
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
          props={{ gems: words.map(kindOf), label, isWorking: isWorking || isBusy, items: set?.items ?? [], labels, isBusy, ghost }}
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
