import type { CompassAxes, CompassChoice, CompassSet } from '../types'
import { PRIMARY_COUNT, sharesAt } from './compass'
import type { Point } from './compass'
import type { Lang } from './i18n'

/**
 * The demo: a scripted turn, no model called. Claude "works" while gems
 * gather, eight candidates surface in the space, four are picked one by one
 * and settle into their directions, then a pointer glides between two to show
 * what an in-between pick would send. Pure data: register.tsx plays it.
 */

/** Where the four settle in the demo: the compass points. */
const ANCHORS: readonly Point[] = [
  { x: 0, y: 0.8 },
  { x: 0.8, y: 0 },
  { x: 0, y: -0.8 },
  { x: -0.8, y: 0 },
]

const AXES: Record<Lang, CompassAxes> = {
  ja: { up: '仕上げる', right: '広げる', down: '確かめる', left: '固める' },
  en: { up: 'ship it', right: 'widen', down: 'check', left: 'harden' },
}

/** Where the eight candidates sit, the same in both languages. */
const SPOTS: readonly Point[] = [
  { x: 0.1, y: 0.72 },
  { x: 0.72, y: 0.2 },
  { x: 0.15, y: -0.7 },
  { x: -0.75, y: 0.12 },
  { x: 0.52, y: 0.6 },
  { x: -0.5, y: -0.45 },
  { x: 0.58, y: -0.42 },
  { x: -0.48, y: 0.55 },
]

/** Eight candidates where a turn adding an export feature might leave the user, in each language. */
const TEXTS: Record<Lang, readonly string[]> = {
  ja: [
    'エクスポート機能を仕上げて PR を作って',
    'CSV に加えて JSON 出力にも対応して',
    '出力ファイルを実際に開いて確認して',
    'エクスポートのテストを追加して',
    'README にエクスポートの使い方を書いて',
    'エクスポート周りのコードを整理して',
    '大きなデータで速度を測って',
    'エラー時のメッセージを分かりやすくして',
  ],
  en: [
    'Finish the export feature and open a PR',
    'Add JSON output next to CSV',
    'Open the exported file and check it by hand',
    'Add tests for the export',
    'Document the export in the README',
    'Clean up the export module',
    'Measure the speed on big data',
    'Make the error messages clearer',
  ],
}

const poolOf = (lang: Lang): CompassChoice[] => TEXTS[lang].map((text, i) => ({ text, ...(SPOTS[i] ?? { x: 0, y: 0 }), isPrimary: false }))

/** The tool calls the scripted turn makes, one gem each. */
const TOOLS = ['Read', 'Grep', 'Edit', 'Bash', 'Edit', 'Read'] as const

/** Where the pointer glides to: between choice 1 (up) and choice 2 (right). */
const GLIDE_TO: Point = { x: 0.36, y: 0.34 }

export type DemoFrame = {
  /** Milliseconds from the start of the demo. */
  at: number
  set?: CompassSet | null
  isWorking?: boolean
  activity?: string[]
  ghost?: Point | null
  toast?: string
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f

/** The demo's set: the first `picked` candidates promoted, each `settle` of the way to its direction. */
const demoSet = (lang: Lang, picked: number, settle: number): CompassSet => {
  const POOL = poolOf(lang)
  const primaries = POOL.slice(0, picked).map((c, i) => ({
    ...c,
    x: lerp(c.x, ANCHORS[i]?.x ?? c.x, settle),
    y: lerp(c.y, ANCHORS[i]?.y ?? c.y, settle),
    isPrimary: true,
  }))
  return {
    id: -1,
    axes: AXES[lang],
    items: [...primaries, ...POOL.slice(picked)],
    isMapPending: false,
    isRefining: false,
    timings: {
      contextMs: 0,
      choicesMs: null,
      extrasMs: null,
      layoutMs: null,
      bandMs: null,
      mapMs: null,
      isPrefetched: true,
    },
  }
}

/** The text an in-between pick would send in the demo: the two nearest candidates and their shares. */
export const demoBlendText = (point: Point, items: readonly CompassChoice[], lang: Lang = 'ja'): string => {
  const [a, b] = sharesAt(point, items)
  const first = a === undefined ? undefined : items[a.index]
  const second = b === undefined ? undefined : items[b.index]
  if (first === undefined || second === undefined || a === undefined || b === undefined) return first?.text ?? ''
  const share = (w: number) => Math.round((w / (a.weight + b.weight)) * 100)
  return lang === 'ja'
    ? `「${first.text}」${share(a.weight)}% と「${second.text}」${share(b.weight)}% の間をとって進めて`
    : `Go between "${first.text}" (${share(a.weight)}%) and "${second.text}" (${share(b.weight)}%)`
}

/** The whole script, in time order. */
export const demoFrames = (lang: Lang = 'ja'): DemoFrame[] => {
  const demo = (picked: number, settle: number) => demoSet(lang, picked, settle)
  const settled = demo(PRIMARY_COUNT, 1)
  return [
    { at: 0, set: null, isWorking: true, activity: [], ghost: null },
    ...TOOLS.map((_, i) => ({ at: 700 * (i + 1), activity: TOOLS.slice(0, i + 1).map(String) })),
    { at: 5000, isWorking: false, set: demo(0, 0) },
    ...Array.from({ length: PRIMARY_COUNT }, (_, i) => ({ at: 6000 + i * 800, set: demo(i + 1, 0) })),
    ...Array.from({ length: 8 }, (_, k) => ({ at: 9000 + k * 120, set: demo(PRIMARY_COUNT, (k + 1) / 8) })),
    ...Array.from({ length: 11 }, (_, k) => ({
      at: 11000 + k * 150,
      ghost: { x: lerp(0, GLIDE_TO.x, k / 10), y: lerp(0, GLIDE_TO.y, k / 10) },
    })),
    {
      at: 12800,
      toast:
        lang === 'ja'
          ? `デモ：この位置なら ${demoBlendText(GLIDE_TO, settled.items, lang)} を送信します`
          : `Demo: this spot would send ${demoBlendText(GLIDE_TO, settled.items, lang)}`,
    },
    { at: 16000, ghost: null },
  ]
}
