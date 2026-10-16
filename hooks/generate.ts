import type { Timer } from 'claude-code'

import type { CompassChoice, CompassSet, CompassTimings } from '../types'
import { addExtras, arrangeSet, pickFromPool, spotsOf } from './arrange'
import {
  MAX_EXTRA,
  PRIMARY_COUNT,
  buildBlendPrompt,
  buildChoicesPrompt,
  buildExtrasPrompt,
  buildPoolPrompt,
  buildSelectPrompt,
  cleanText,
  parseBlend,
  parseChoices,
  parseExtras,
  parseSelect,
  poolSize,
  summarizeMessages,
} from './compass'
import type { Block, Point } from './compass'
import { demoBlendText } from './demo'
import type { Translate } from './i18n'
import { clearChoices, getDemo, getGoal, getPhase, getPreview, getSet, patchSet, putPreview, putSet, setPhase } from './state'
import type { $, Settings } from './state'

/**
 * The generation pipeline: candidates prepared while Claude works (the pool),
 * the four picked and shown the moment a turn ends, the pick refined for the
 * final answer, the map's extras, and the instruction written for a spot
 * between candidates. Every call carries a stale-check, so a reply that lands
 * after a newer generation, turn or pick changes nothing.
 */

export type Runtime = { settings: Settings; t: Translate }

/** Preparing and picking always go to the fastest model, whatever writes the rest. */
const FAST_MODEL = 'haiku'
/** Past these the call is given up: the four shown stay, or the band says why. */
const CALL_TIMEOUT_MS = 12_000
const SELECT_TIMEOUT_MS = 4_000
const BLEND_TIMEOUT_MS = 15_000
/** A prefetch starts after this many tool calls, or this long into the turn, whichever comes first. */
const PREFETCH_AFTER_CALLS = 1
const PREFETCH_DELAY_MS = 3_000
/** Later prefetches refresh the pool at most this often, at most this many times a turn. */
const PREFETCH_GAP_MS = 10_000
const MAX_PREFETCH = 6
/** How long the end of the turn waits for a prefetch still in flight before generating afresh. */
const PREFETCH_WAIT_MS = 2_500
/** A second pick this close to the preview's spot (in map units) sends it, when the space did not say by cell. */
const SAME_SPOT = 0.02

/** Bumped by every new generation, send or prompt; an older reply that lands late is dropped. */
let latest = 0
/** This turn's number: a prefetch that lands after its turn ended is dropped. */
let turnSeq = 0
/** Candidates prepared while Claude works, for the end of the turn to pick four from. */
let pool: string[] = []
let prefetchingSeq: number | null = null
let turnCalls = 0
let prefetchCount = 0
let lastPrefetchAt = Number.NEGATIVE_INFINITY
let prefetchTimer: Timer | null = null
/** The in-flight prefetch's work, so the end of the turn can wait a little for it. */
let inflight: Promise<void> | null = null
/** Claude Code's own guess at the next prompt, and the turn it was made for. */
let suggestion: { text: string; seq: number } | null = null
/** Whether the map pane is placed on a surface; extras are made only while it is. */
let isMapShown = false
/** Bumped by every pick on the map; a blend that lands after a newer pick is dropped. */
let pickSeq = 0
/** The last map's spots by text, kept across the turn's reset so the next map keeps shared candidates where they were. */
let lastSpots: ReadonlyMap<string, Point> = new Map()

export function setMapShown(shown: boolean): void {
  isMapShown = shown
}

/** Everything a new conversation or turn makes stale: the four, the pool, the prefetch and the suggestion. */
export async function resetTurn($: $): Promise<void> {
  const set = await getSet($)
  if (set !== null) lastSpots = spotsOf(set)
  latest += 1
  turnSeq += 1
  pickSeq += 1
  pool = []
  turnCalls = 0
  prefetchCount = 0
  lastPrefetchAt = Number.NEGATIVE_INFINITY
  prefetchingSeq = null
  suggestion = null
  prefetchTimer?.cancel()
  prefetchTimer = null
  await clearChoices($)
}

/** A main-loop turn began: the prefetch clock starts. */
export function beginTurn($: $, rt: Runtime): void {
  prefetchTimer = $.clock.after(PREFETCH_DELAY_MS, () => startPrefetch($, rt))
}

/** A main-loop tool call: past the first, candidates start being prepared. */
export function noteToolCall($: $, rt: Runtime): void {
  turnCalls += 1
  if (turnCalls >= PREFETCH_AFTER_CALLS) startPrefetch($, rt)
}

export function endTurn(): void {
  prefetchTimer?.cancel()
  prefetchTimer = null
}

/** Claude Code's own next-prompt guess: a candidate for this turn's four, free and already here. */
export async function noteSuggestion($: $, text: string): Promise<void> {
  suggestion = cleanText(text) === null ? suggestion : { text, seq: turnSeq }
  // Landing after the four are shown, it joins the map as an extra.
  const clean = cleanText(text)
  const set = await getSet($)
  if (clean !== null && set !== null && set.items.filter(i => i.isPrimary).length === PRIMARY_COUNT) {
    await relayout($, set.id, s => addExtras(s, [clean]))
  }
}

const suggestionFor = (seq: number): string | null => (suggestion !== null && suggestion.seq === seq ? suggestion.text : null)

const joined = (blocks: readonly Block[]): string => blocks.map(b => b.text).join('\n\n')

/** One model call: a fork over the conversation, or a completion on the chosen model with its cache marks. */
function ask($: $, rt: Runtime, prompt: readonly Block[], maxTokens: number, timeoutMs = CALL_TIMEOUT_MS) {
  return rt.settings.generator === 'fork'
    ? forkWithin($, joined(prompt), timeoutMs)
    : $.model.complete({ model: rt.settings.generator, prompt, maxTokens, effort: 'low', timeoutMs })
}

/** A fork takes no timeout of its own: past `timeoutMs` the call is given up as aborted and the fork's late reply dropped. */
async function forkWithin($: $, prompt: string, timeoutMs: number): Promise<Answered> {
  const stop = new AbortController()
  const late = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(
    (): Answered => ({ isAnswered: false, reason: 'aborted' }),
    (): Answered => ({ isAnswered: false, reason: 'aborted' }),
  )
  const reply = await Promise.race([$.model.fork({ prompt }), late])
  stop.abort()
  return reply
}

function fast($: $, prompt: readonly Block[], maxTokens: number, timeoutMs = CALL_TIMEOUT_MS) {
  return $.model.complete({ model: FAST_MODEL, prompt, maxTokens, effort: 'low', timeoutMs })
}

type Reply = { text: string | null; ms: number; why: string | null }

const reasonOf = (rt: Runtime, reason: string): string => {
  switch (reason) {
    case 'api-error':
      return rt.t('reasonApiError')
    case 'empty-reply':
      return rt.t('reasonEmpty')
    case 'aborted':
      return rt.t('reasonAborted')
    case 'nothing-to-fork':
      return rt.t('reasonNothingToFork')
    default:
      return reason
  }
}

/** Any model reply: answered with its text, or not with why. */
type Answered = { isAnswered: true; text: string } | { isAnswered: false; reason: string }

/** Runs one call and times it; the reply's text, or null with why. A refused request is a reason too, never a throw. */
async function timed($: $, rt: Runtime, run: () => Promise<Answered>): Promise<Reply> {
  const start = await $.clock.now()
  const reply = await run().catch((): Answered => ({ isAnswered: false, reason: 'refused' }))
  const ms = (await $.clock.now()) - start
  if (!reply.isAnswered) return { text: null, ms, why: reply.reason === 'refused' ? rt.t('reasonRefused') : reasonOf(rt, reply.reason) }
  return { text: reply.text, ms, why: null }
}

/** The context the generator reads; a fork reads the conversation itself, so it gets none. The fast calls always get the summary. */
async function context($: $, rt: Runtime, isFast = false) {
  return {
    goal: await getGoal($),
    transcript: rt.settings.generator === 'fork' && !isFast ? null : summarizeMessages(await $.session.messages()),
  }
}

/** Prepares candidates while Claude works; the newest pool replaces the last. */
async function prefetch($: $, rt: Runtime, seq: number): Promise<void> {
  if (prefetchingSeq === seq || seq !== turnSeq || prefetchCount >= MAX_PREFETCH) return
  // Claimed before any await, so tool calls landing together start one prefetch, not several.
  prefetchingSeq = seq
  try {
    const now = await $.clock.now()
    if (now - lastPrefetchAt < PREFETCH_GAP_MS) return
    prefetchCount += 1
    lastPrefetchAt = now
    const work = fillPool($, rt, seq)
    inflight = work.then(
      () => undefined,
      () => undefined,
    )
    await work
  } finally {
    if (prefetchingSeq === seq) prefetchingSeq = null
  }
}

async function fillPool($: $, rt: Runtime, seq: number): Promise<void> {
  const count = poolSize(rt.settings.extraCount, isMapShown)
  const reply = await fast($, buildPoolPrompt({ ...(await context($, rt, true)), count }), 40 * count + 40)
  const found = reply.isAnswered ? parseExtras(reply.text, count) : []
  if (seq === turnSeq && found.length >= PRIMARY_COUNT) pool = found
}

/** The pool for the turn that just ended, emptied: as it is, or after a short wait for a prefetch in flight. */
async function takePool($: $): Promise<string[]> {
  const seq = turnSeq
  if (pool.length < PRIMARY_COUNT && prefetchingSeq === seq && inflight !== null) {
    const stop = new AbortController()
    const nap = $.clock.sleep(PREFETCH_WAIT_MS, { signal: stop.signal }).catch(() => undefined)
    await Promise.race([inflight, nap])
    stop.abort()
  }
  if (seq !== turnSeq) return []
  const taken = pool.length >= PRIMARY_COUNT ? pool : []
  pool = []
  return taken
}

function startPrefetch($: $, rt: Runtime): void {
  void prefetch($, rt, turnSeq).catch(() => undefined)
}

const NO_TIMINGS: CompassTimings = { contextMs: 0, choicesMs: null, extrasMs: null, layoutMs: null, bandMs: null, mapMs: null, isPrefetched: false }

/** `answer`: Claude's final answer when a turn just ended; null for a refresh asked by command. */
export async function generate($: $, rt: Runtime, answer: string | null): Promise<void> {
  try {
    await generateChoices($, rt, answer)
  } catch {
    await setPhase($, 'error', rt.t('reasonRefused'))
  }
}

async function generateChoices($: $, rt: Runtime, answer: string | null): Promise<void> {
  const id = (latest = latest + 1)
  const seq = turnSeq
  const start = await $.clock.now()
  const current = await getSet($)
  const previous = current === null ? lastSpots : spotsOf(current)
  await putPreview($, null)
  await setPhase($, 'thinking', null)
  const prepared = answer !== null ? await takePool($) : []
  if (id !== latest) return
  if (prepared.length > 0) return generateFromPool($, rt, { id, seq, start, previous }, answer ?? '', prepared)
  const ctx = await context($, rt)
  const contextMs = (await $.clock.now()) - start
  const wantsExtras = isMapShown && rt.settings.extraCount > 0
  const choicesCall = timed($, rt, () => ask($, rt, buildChoicesPrompt(ctx), 300))
  const extrasCall = wantsExtras ? timed($, rt, () => ask($, rt, buildExtrasPrompt({ ...ctx, count: rt.settings.extraCount }), 40 * rt.settings.extraCount + 40)) : null
  const choices = await choicesCall
  if (id !== latest) return
  const parsed = choices.text === null ? null : parseChoices(choices.text)
  if (parsed === null) return setPhase($, 'error', choices.why ?? rt.t('reasonUnparsed'))
  const laidAt = await $.clock.now()
  const arranged = arrangeSet(parsed, [suggestionFor(seq) ?? ''].filter(t => t.length > 0), previous)
  const bandMs = (await $.clock.now()) - start
  const timings: CompassTimings = { ...NO_TIMINGS, contextMs, choicesMs: choices.ms, layoutMs: bandMs - (laidAt - start), bandMs }
  await putSet($, prev => (id === latest ? { id, ...arranged, isMapPending: extrasCall !== null, isRefining: false, timings } : prev))
  if (id !== latest) return
  await setPhase($, 'idle', null)
  await bumpStat($, 'offered')
  if (extrasCall !== null) await mergeExtras($, id, start, extrasCall)
}

type Ids = { id: number; seq: number; start: number; previous: ReadonlyMap<string, Point> }

/**
 * The end of a turn with a pool: the four picked locally and shown at once,
 * then the fast select call picks again for Claude's final answer and, if it
 * lands, the four are replaced in place; the rest of the pool is the map.
 */
async function generateFromPool($: $, rt: Runtime, ids: Ids, answer: string, prepared: string[]): Promise<void> {
  const { id, seq, start, previous } = ids
  const goal = await getGoal($)
  const local = pickFromPool(prepared, goal, previous)
  if (local === null) return
  const bandMs = (await $.clock.now()) - start
  const timings: CompassTimings = { ...NO_TIMINGS, layoutMs: bandMs, bandMs, mapMs: bandMs, isPrefetched: true }
  await putSet($, prev => (id === latest ? { id, ...local.parsed, isMapPending: false, isRefining: true, timings } : prev))
  if (id !== latest) return
  await setPhase($, 'idle', null)
  await bumpStat($, 'offered')
  const poolItems: CompassChoice[] = prepared.map(text => ({ text, x: 0, y: 0, isPrimary: false }))
  const prompt = buildSelectPrompt({ answer, pool: poolItems, goal, suggestion: suggestionFor(seq) })
  const reply = await timed($, rt, () => fast($, prompt, 200, SELECT_TIMEOUT_MS))
  const picked = reply.text === null ? null : parseSelect(reply.text, poolItems)
  await relayout($, id, s => {
    const t = { ...s.timings, choicesMs: reply.ms }
    if (picked === null) return { ...s, isRefining: false, timings: t }
    const extras = [...prepared, ...s.items.map(i => i.text)]
    return { ...s, ...arrangeSet(picked.parsed, extras, spotsOf(s)), isRefining: false, timings: t }
  })
}

/** Waits for the parallel extras and lays them into the map. */
async function mergeExtras($: $, id: number, start: number, extrasCall: Promise<Reply>): Promise<void> {
  const extras = await extrasCall
  const texts = extras.text === null ? [] : parseExtras(extras.text, MAX_EXTRA)
  const mapMs = (await $.clock.now()) - start
  await relayout($, id, s => ({ ...addExtras(s, texts), isMapPending: false, timings: { ...s.timings, extrasMs: extras.ms, mapMs } }))
}

/**
 * A patch that moves candidates on the map: an instruction written for a spot
 * of the old map, shown or still being written, no longer means what the
 * caption would show there, so it is dropped with the patch.
 */
async function relayout($: $, id: number, fn: (set: CompassSet) => CompassSet): Promise<void> {
  pickSeq += 1
  await putPreview($, null)
  // A blend in flight is dropped with the spot it was written for: the band must not wait for it.
  if ((await getPhase($)) === 'blending') await setPhase($, 'idle', null)
  await patchSet($, id, fn)
}

export type StatKey = 'offered' | 'band' | 'map' | 'typed'

export type Stats = Record<StatKey, number>

const STATS_KEY = 'stats'

export async function readStats($: $): Promise<Stats> {
  const raw = (await $.store.get(STATS_KEY).catch(() => undefined)) as Partial<Stats> | undefined
  return { offered: raw?.offered ?? 0, band: raw?.band ?? 0, map: raw?.map ?? 0, typed: raw?.typed ?? 0 }
}

/** Counts how the next steps fare across sessions: offered, taken from the band or the map, or typed over. */
export async function bumpStat($: $, key: StatKey): Promise<void> {
  const stats = await readStats($)
  await $.store.set(STATS_KEY, { ...stats, [key]: stats[key] + 1 }).catch(() => undefined)
}

/** True while a send of ours is on its way, so `prompt.submit` does not count it as typed. */
let isSending = false
export const sendingNow = (): boolean => isSending

async function send($: $, text: string, fill: boolean, via: 'band' | 'map'): Promise<void> {
  latest += 1
  pickSeq += 1
  await clearChoices($)
  await bumpStat($, via)
  if (fill) return void (await $.prompt.fill({ text }))
  isSending = true
  try {
    await $.prompt.submit({ text, asUser: true })
  } finally {
    isSending = false
  }
}

/**
 * Sends one of the four. `shown` is the text the band drew under the key: that is
 * what is sent, never a text the four were replaced with since. A choice the band
 * had to cut goes to the prompt box, so what is sent is always what was read.
 */
export async function choose($: $, rt: Runtime, index: number, fill: boolean, shown?: string): Promise<void> {
  const text = shown ?? (await getSet($))?.items[index]?.text
  if (text === undefined) return
  if (await getDemo($)) return $.ui.toast(rt.t('demoNoSend', { text }))
  await send($, text, fill, 'band')
}

const near = (a: Point, b: Point): boolean => Math.hypot(a.x - b.x, a.y - b.y) < SAME_SPOT

/**
 * A pick on the map: the first at a spot writes the instruction for it and
 * shows it under the map; a second pick at the same spot sends it (Shift, or
 * a preview the caption could not show whole, fills the prompt box instead).
 * A pick elsewhere writes anew.
 */
export type PickSpot = { point: Point; fill: boolean; isOnPreview: boolean; previewText: string | null }

export async function pick($: $, rt: Runtime, { point, fill, isOnPreview, previewText }: PickSpot): Promise<void> {
  const set = await getSet($)
  if (set === null) return
  if (await getDemo($)) return $.ui.toast(rt.t('demoNoSend', { text: demoBlendText(point, set.items) }))
  const preview = await getPreview($)
  // The second pick sends the preview the Client showed: by cell when the Client said so (and its text matches), by distance otherwise.
  const isSameText = previewText === null || previewText === preview?.text
  if (preview !== null && isSameText && (isOnPreview || near(preview, point))) return send($, preview.text, fill, 'map')
  const seq = (pickSeq = pickSeq + 1)
  const id = latest
  await putPreview($, null)
  await setPhase($, 'blending', null)
  const goal = await getGoal($)
  const reply = await timed($, rt, () => ask($, rt, buildBlendPrompt({ point, axes: set.axes, items: set.items, goal }), 300, BLEND_TIMEOUT_MS))
  // Stale: a newer pick, a new layout or a new generation has already settled the phase.
  if (seq !== pickSeq || id !== latest) return
  const text = reply.text === null ? null : parseBlend(reply.text)
  await setPhase($, 'idle', null)
  // The four stay usable: a spot that could not be written is said in a toast, not an error that hides them.
  if (text === null) return $.ui.toast(rt.t('blendFailed', { why: reply.why ?? rt.t('reasonNoBlend') }))
  await putPreview($, { x: point.x, y: point.y, text })
}
