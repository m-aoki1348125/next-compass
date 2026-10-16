import type { CompassAxes, CompassChoice } from '../types'

export const PRIMARY_COUNT = 4
export const MAX_EXTRA = 16
const MAX_TEXT = 120
const MAX_AXIS = 16

/** Arrow glyph per primary choice: 1 up, 2 right, 3 down, 4 left. */
export const ARROWS = ['↑', '→', '↓', '←'] as const

/** Where each primary choice sits on the map, in the order of ARROWS. */
export const ANCHORS: readonly { x: number; y: number }[] = [
  { x: 0, y: 0.8 },
  { x: 0.8, y: 0 },
  { x: 0, y: -0.8 },
  { x: -0.8, y: 0 },
]

/** One color per primary choice: amber, rose, teal, indigo. */
export const PALETTE = ['#f2a93b', '#ef5d8a', '#3cc6b4', '#7b8cff'] as const

export type Point = { x: number; y: number }

export type Weighted = { index: number; weight: number }

export type ParsedSet = { axes: CompassAxes; items: CompassChoice[] }

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

const toText = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const one = v.replace(/\s+/g, ' ').trim()
  return one.length === 0 ? null : one.slice(0, max)
}

export const clampExtra = (n: number): number => clamp(Math.round(n), 0, MAX_EXTRA)

export type ContextInput = { goal: string | null; transcript: string | null }

const STYLE =
  'Write each instruction the way the user would type it: imperative, one short sentence, at most 40 characters, in the same language the user writes in.'

const withContext = ({ goal, transcript }: ContextInput, lines: readonly string[]): string => {
  const body = [...lines, goal ? `The user's overall goal: ${goal}` : ''].filter(l => l.length > 0).join('\n')
  return transcript ? `Recent conversation:\n${transcript}\n\n${body}` : body
}

/** The fast call: four directions and their names, one line each, nothing else. */
export const buildChoicesPrompt = (input: ContextInput): string =>
  withContext(input, [
    'Predict what the user of this Claude Code session will type next.',
    `Give exactly ${PRIMARY_COUNT} next instructions, each a concrete next step, each in a clearly different direction: 1 up, 2 right, 3 down, 4 left, where up and down are opposite directions and so are right and left.`,
    'Name each direction in at most 12 characters (e.g. up "ship it", down "investigate").',
    STYLE,
    input.goal ? 'At least one of the four must move directly toward the goal.' : '',
    'Reply in exactly this format (CHOICES), no other text:',
    'AXES: <up name> | <right name> | <down name> | <left name>',
    '1: <instruction>',
    '2: <instruction>',
    '3: <instruction>',
    '4: <instruction>',
  ])

export type Pair = 'vertical' | 'horizontal'

const PAIRS: Record<Pair, { first: number; second: number; meaning: string }> = {
  vertical: {
    first: 1,
    second: 3,
    meaning: 'how far to go: 1 pushes the work forward (the next build step), 3 steps back (check, investigate or ask before going on)',
  },
  horizontal: {
    first: 2,
    second: 4,
    meaning: 'how wide to go: 2 widens the scope (a related improvement or a new angle), 4 narrows and hardens (tests, cleanup, edge cases)',
  },
}

/**
 * Half of the fast choices: one axis, its two opposite instructions. The two
 * halves run in parallel, each writing half as much, so the four come back in
 * the time of the slower half.
 */
export const buildPairPrompt = (input: ContextInput, pair: Pair): string => {
  const { first, second, meaning } = PAIRS[pair]
  return withContext(input, [
    'Predict what the user of this Claude Code session will type next.',
    `Give exactly 2 next instructions, opposite ends of one axis, ${meaning}.`,
    'Name each end for this moment in at most 12 characters.',
    STYLE,
    input.goal ? 'Lean both toward the goal where it fits.' : '',
    `Reply in exactly this format (CHOICES-${pair === 'vertical' ? 'V' : 'H'}), no other text:`,
    `AXIS: <name of ${first}> | <name of ${second}>`,
    `${first}: <instruction>`,
    `${second}: <instruction>`,
  ])
}

/** The two halves' replies read as one four-choice set; null unless all four are there. */
export const parsePairs = (vertical: string, horizontal: string): ParsedSet | null => {
  const names = (text: string) =>
    (/^\s*AXIS\s*:(.*)$/im.exec(text)?.[1] ?? '').split('|').map(n => n.trim())
  const [up = '', down = ''] = names(vertical)
  const [right = '', left = ''] = names(horizontal)
  const lines = [vertical, horizontal].join('\n').split('\n').filter(l => !/^\s*AXIS\s*:/i.test(l))
  return parseChoices([`AXES: ${up} | ${right} | ${down} | ${left}`, ...lines].join('\n'))
}

/** The split axes, as every self-placing call is told them. */
const MAP_AXES =
  'y from -1 (step back: check, investigate, ask) to 1 (push the work forward); x from -1 (narrow and harden: tests, cleanup) to 1 (widen the scope: a related improvement or new angle).'

export type Half = 'a' | 'b'

const HALVES: Record<Half, string> = {
  a: 'the upper right (forward and wider) and the lower left (step back and harden) quarters',
  b: 'the upper left (forward and harden) and the lower right (step back and wider) quarters',
}

/**
 * Extras that place themselves: with split choices the axes always mean the
 * same, so a call can write each candidate's spot with its text and the map
 * needs no placing call. Two halves run in parallel, each on its own quarters.
 */
export const buildPlacedExtrasPrompt = (input: ContextInput & { count: number; half: Half }): string =>
  withContext(input, [
    'Predict what the user of this Claude Code session will type next.',
    `Give ${input.count} different plausible next instructions (EXTRAS-${input.half.toUpperCase()}), each placed on a map:`,
    MAP_AXES,
    `Spread them over ${HALVES[input.half]}, |x| and |y| between 0.15 and 0.9, no two at the same spot.`,
    STYLE,
    'Reply with one line per instruction, "<x> <y> <instruction>", no other text.',
  ])

/**
 * One placed line, as a fast model may write it: "0.1 0.8 text", "- 0.1, 0.8: text",
 * "(0.1, 0.8) text", "x=0.1 y=0.8 text" or "3. -0.4 -0.4 — text". A numbering
 * counts only when a space follows it, so "0.1" is never read as "0." and "1".
 */
const PLACED_LINE =
  /^\s*(?:[-*•](?=\s)|\d+[.)](?=\s))?\s*\(?\s*(?:x\s*[:=]\s*)?(-?\d*\.?\d+)\s*[,;]?\s*(?:y\s*[:=]\s*)?(-?\d*\.?\d+)\s*\)?\s*[:|,\-–—]?\s+(.+)$/i

/** Reads self-placed extras: placed lines, deduplicated, at most `count`. */
export const parsePlacedExtras = (text: string, count: number): CompassChoice[] =>
  text
    .split('\n')
    .map(l => PLACED_LINE.exec(l))
    .map(m => (m ? { x: Number(m[1]), y: Number(m[2]), text: toText(m[3], MAX_TEXT) } : null))
    .filter((e): e is { x: number; y: number; text: string } => e !== null && e.text !== null)
    .filter((e, i, all) => all.findIndex(o => o.text === e.text) === i)
    .slice(0, count)
    .map(e => ({ text: e.text, x: clamp(e.x, -0.9, 0.9), y: clamp(e.y, -0.9, 0.9), isPrimary: false }))

/** How many candidates the turn prepares while Claude works; four are picked when it ends. */
export const POOL_SIZE = 8

/**
 * The call made while Claude still works: a handful of placed candidates
 * covering all four directions, so the end of the turn only has to pick.
 */
export const buildPoolPrompt = (input: ContextInput): string =>
  withContext(input, [
    'Claude is still working on the request in this Claude Code session. Predict what the user may type once it finishes.',
    `Give ${POOL_SIZE} different plausible next instructions (POOL), each placed on a map:`,
    MAP_AXES,
    'Cover all four directions: at least one with y above 0.5, one with y below -0.5, one with x above 0.5 and one with x below -0.5.',
    STYLE,
    'Reply with one line per instruction, "<x> <y> <instruction>", no other text.',
  ])

export type SelectInput = { answer: string; pool: readonly CompassChoice[]; goal: string | null }

/**
 * The call made when the turn ends: given Claude's final answer, pick one
 * prepared candidate per direction by number, or write a new one where none
 * still fits. Its reply is a few short lines, so it comes back fast.
 */
export const buildSelectPrompt = ({ answer, pool, goal }: SelectInput): string =>
  [
    'Claude just finished a turn in a Claude Code session. Its final answer:',
    answer.slice(0, 800),
    '',
    'Candidate next instructions for the user, prepared while Claude worked:',
    ...pool.map((c, i) => `#${i + 1} ${c.text}`),
    '',
    'Pick the best next instruction for each direction (SELECT): 1 pushes the work forward, 3 steps back (check, investigate, ask), 2 widens the scope, 4 narrows and hardens (tests, cleanup).',
    'Use a candidate by its number (#n) where it still fits after this answer, each at most once; otherwise write a new instruction the way the user would type it, at most 40 characters, in the language of the candidates.',
    'Name each direction for this moment in at most 12 characters.',
    goal ? `The user's overall goal: ${goal}` : '',
    'Reply in exactly this format, no other text:',
    'AXES: <name of 1> | <name of 2> | <name of 3> | <name of 4>',
    '1: #<n> or <instruction>',
    '2: #<n> or <instruction>',
    '3: #<n> or <instruction>',
    '4: #<n> or <instruction>',
  ]
    .filter((line, i, all) => line.length > 0 || all[i - 1] !== '')
    .join('\n')

export type Picked = { parsed: ParsedSet; used: number[] }

/** Reads the select reply: "#n" resolved to the pool's text; null unless four distinct choices. */
/**
 * A choice line that names a candidate: "1: #3", "1: #3 (Ship it)", "1: #3 - why".
 * Whatever follows the number is the model's note, not the instruction.
 */
const PICK_LINE = /^(\s*[1-4]\s*[:.)]\s*)#\s*(\d+)\b.*$/

export const parseSelect = (text: string, pool: readonly CompassChoice[]): Picked | null => {
  const lines = text.split('\n').map(line => {
    const m = PICK_LINE.exec(line)
    if (!m) return { line, isBad: false }
    const hit = pool[Number(m[2]) - 1]
    return hit === undefined ? { line, isBad: true } : { line: `${m[1]}${hit.text}`, isBad: false }
  })
  // A number outside the pool names nothing: keep the four picked locally rather than show "#9".
  if (lines.some(l => l.isBad)) return null
  const parsed = parseChoices(lines.map(l => l.line).join('\n'))
  if (parsed === null) return null
  const texts = parsed.items.map(i => i.text)
  if (texts.some(t => /^#\s*\d/.test(t))) return null
  if (!texts.every((t, i) => texts.indexOf(t) === i)) return null
  const used = pool.flatMap((c, i) => (texts.includes(c.text) ? [i] : []))
  return { parsed, used }
}

/** Names for the split axes when no reply named them. */
const DEFAULT_AXES: CompassAxes = { up: '進める', right: '広げる', down: '確かめる', left: '固める' }

/**
 * The four picked from the pool without a model call: for each direction,
 * the unused candidate lying furthest that way. The fallback when the select
 * call fails or is late.
 */
export const pickLocally = (pool: readonly CompassChoice[]): Picked | null => {
  if (pool.length < PRIMARY_COUNT) return null
  const used = ANCHORS.reduce<number[]>((taken, a) => {
    const best = pool
      .map((c, i) => ({ i, score: c.x * a.x + c.y * a.y }))
      .filter(c => !taken.includes(c.i))
      .sort((p, q) => q.score - p.score)[0]
    return best === undefined ? taken : [...taken, best.i]
  }, [])
  const items = used.map((i, k): CompassChoice => ({
    text: pool[i]?.text ?? '',
    x: ANCHORS[k]?.x ?? 0,
    y: ANCHORS[k]?.y ?? 0,
    isPrimary: true,
  }))
  return { parsed: { axes: DEFAULT_AXES, items }, used }
}

/** The parallel call: more candidates, text only; placing them waits for the four. */
export const buildExtrasPrompt = (input: ContextInput & { count: number }): string =>
  withContext(input, [
    'Predict what the user of this Claude Code session will type next.',
    `Give ${input.count} different plausible next instructions (EXTRAS), varied in direction and size of step.`,
    STYLE,
    'Reply with one instruction per line, each starting with "- ", no other text.',
  ])

export type PlaceInput = { axes: CompassAxes; primaries: readonly string[]; extras: readonly string[] }

/** The short call that puts the extras on the map the four already define. */
export const buildPlacePrompt = ({ axes, primaries, extras }: PlaceInput): string =>
  [
    'Place candidate instructions on a 2D map (PLACE). x and y run from -1 to 1.',
    `Up (y 0.8): "${axes.up}" — ${primaries[0] ?? ''}`,
    `Right (x 0.8): "${axes.right}" — ${primaries[1] ?? ''}`,
    `Down (y -0.8): "${axes.down}" — ${primaries[2] ?? ''}`,
    `Left (x -0.8): "${axes.left}" — ${primaries[3] ?? ''}`,
    'Candidates:',
    ...extras.map((text, i) => `${i + 1}. ${text}`),
    'Put each candidate where it belongs between those four, |x| and |y| at most 0.9, spread out so no two share a spot.',
    'Reply with one line per candidate, "<number> <x> <y>", no other text.',
  ].join('\n')

const LINE = /^\s*([1-4])\s*[:.)]\s*(.+)$/

/** Reads the fast call's reply; null unless all four instructions are there. */
export const parseChoices = (text: string): ParsedSet | null => {
  const lines = text.split('\n')
  const axesLine = lines.find(l => /^\s*AXES\s*:/i.test(l))
  const names = (axesLine?.replace(/^\s*AXES\s*:/i, '') ?? '').split('|').map(n => toText(n, MAX_AXIS) ?? '')
  const found = lines.reduce<Record<number, string>>((acc, l) => {
    const m = LINE.exec(l)
    const t = m ? toText(m[2], MAX_TEXT) : null
    return m && t && acc[Number(m[1])] === undefined ? { ...acc, [Number(m[1])]: t } : acc
  }, {})
  const items = ANCHORS.map((a, i) => {
    const t = found[i + 1]
    return t === undefined ? null : { text: t, x: a.x, y: a.y, isPrimary: true }
  })
  if (items.some(item => item === null)) return null
  return {
    axes: { up: names[0] ?? '', right: names[1] ?? '', down: names[2] ?? '', left: names[3] ?? '' },
    items: items.filter((item): item is CompassChoice => item !== null),
  }
}

/** Reads the extras reply: the "- " lines, deduplicated, at most `count`. */
export const parseExtras = (text: string, count: number): string[] =>
  text
    .split('\n')
    .map(l => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(l)?.[1])
    .map(t => toText(t, MAX_TEXT))
    .filter((t): t is string => t !== null)
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, count)

/** A spot on a ring near the center, for a candidate the placing reply left out. */
const fallbackSpot = (i: number, n: number): Point => {
  const angle = (i / Math.max(1, n)) * Math.PI * 2 + Math.PI / 4
  return { x: Math.cos(angle) * 0.45, y: Math.sin(angle) * 0.45 }
}

/** Reads the placing reply into one point per extra, filling gaps with ring spots. */
export const parsePlacement = (text: string, count: number): Point[] => {
  const found = text.split('\n').reduce<Record<number, Point>>((acc, l) => {
    const m = /^\s*(\d+)[.:)]?\s+(-?\d*\.?\d+)\s*[, ]\s*(-?\d*\.?\d+)/.exec(l)
    if (!m) return acc
    return { ...acc, [Number(m[1])]: { x: clamp(Number(m[2]), -0.9, 0.9), y: clamp(Number(m[3]), -0.9, 0.9) } }
  }, {})
  return Array.from({ length: count }, (_, i) => found[i + 1] ?? fallbackSpot(i, count))
}

/** Inverse-square weights of every item at a point, heaviest first, summing to 1. */
export const weightsAt = (point: Point, items: readonly CompassChoice[]): Weighted[] => {
  const raw = items.map((item, index) => {
    const d2 = (item.x - point.x) ** 2 + (item.y - point.y) ** 2
    return { index, weight: (item.isPrimary ? 1.5 : 1) / (d2 + 0.02) }
  })
  const total = raw.reduce((sum, w) => sum + w.weight, 0)
  return raw.map(w => ({ ...w, weight: w.weight / total })).sort((a, b) => b.weight - a.weight)
}

export type BlendInput = {
  point: Point
  axes: CompassAxes
  items: readonly CompassChoice[]
  goal: string | null
}

export const buildBlendPrompt = ({ point, axes, items, goal }: BlendInput): string => {
  const top = weightsAt(point, items).slice(0, 4)
  const listed = top
    .map(w => `- ${Math.round(w.weight * 100)}%: ${items[w.index]?.text ?? ''}`)
    .join('\n')
  return [
    'The user is choosing their next instruction for a Claude Code session on a map of candidates.',
    `Map axes: up "${axes.up}", down "${axes.down}", right "${axes.right}", left "${axes.left}".`,
    `They pointed at x ${point.x.toFixed(2)}, y ${point.y.toFixed(2)} (each from -1 to 1), between these candidates, weighted by closeness:`,
    listed,
    goal ? `Their overall goal: ${goal}` : '',
    'Write ONE instruction that blends these candidates in those proportions, the way the user would type it: imperative, one or two sentences, in the same language as the candidates.',
    'Reply with the instruction text only.',
  ]
    .filter(line => line.length > 0)
    .join('\n')
}

/** The cleaned single instruction from a blend reply, or null. */
export const parseBlend = (text: string): string | null =>
  toText(text.replace(/^["'`]+|["'`]+$/g, ''), 600)

type Rgb = readonly [number, number, number]

const hexToRgb = (hex: string): Rgb => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const rgbToHex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map(c => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('')}`


/** The color of the item at `index`: its own for a primary, its nearest primary's otherwise. */
export const colorOf = (items: readonly CompassChoice[], index: number): string => {
  const item = items[index]
  if (item === undefined) return PALETTE[0]
  if (item.isPrimary) return PALETTE[index % PALETTE.length] ?? PALETTE[0]
  // The four come first; before any is picked (the demo), a candidate keeps a color of its own.
  const primaries = items.filter(i => i.isPrimary)
  if (primaries.length === 0) return PALETTE[index % PALETTE.length] ?? PALETTE[0]
  const nearest = weightsAt(item, primaries)[0]?.index ?? 0
  return PALETTE[nearest] ?? PALETTE[0]
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

const WHITE: Rgb = [255, 255, 255]

/** A hex color moved toward white by `t` (0 to 1). */
export const lighten = (hex: string, t: number): string => rgbToHex(mix(hexToRgb(hex), WHITE, t))

/** The transcript tail a cheap model reads, newest last, each message cut short. */
export const summarizeMessages = (
  messages: readonly { role: string; text: string; toolUses: readonly { tool: string }[] }[],
  limit = 6,
): string =>
  messages
    .slice(-limit)
    .map(m => {
      const tools = m.toolUses.length > 0 ? ` [tools: ${m.toolUses.map(t => t.tool).join(', ')}]` : ''
      return `${m.role}: ${m.text.slice(0, 240)}${tools}`
    })
    .join('\n')
