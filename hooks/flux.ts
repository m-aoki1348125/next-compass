import { PALETTE, lighten } from './compass'
import { blend } from './field'
import type { Run } from './field'

/**
 * The lights the space draws while Claude works: one gem per recent tool
 * call, its palette color by the kind of work, drifting in the field with a
 * fading trail; and the rainbow label, as ultrathink is drawn.
 */

const HALO = 2.6
const TRAIL = 4

/** The facets a gem turns through as it drifts, so it seems to catch the light. */
const FACETS = ['✦', '✧', '✦', '❖'] as const

/**
 * Where a gem floats at time t, in cells: a slow loop of its own, swayed by
 * a ripple, so the lights seem carried along by the field.
 */
const gemAt = (index: number, t: number, columns: number, rows: number) => {
  const phase = index * 2.39
  const x = 0.5 + Math.sin(t * 0.23 + phase) * 0.4 + Math.sin(t * 0.9 + phase * 3) * 0.04
  const y = 0.5 + Math.cos(t * 0.19 + phase * 1.3) * 0.38 + Math.cos(t * 1.1 + phase) * 0.05
  return { col: x * (columns - 1), row: y * (rows - 1) }
}

export type Light = { col: number; row: number; color: string; strength: number; glyph: string | null; isHead: boolean }

/** Each gem's head and the fading points of its trail. */
/**
 * Where the gems are drawn to while the space settles into the four: gem i
 * glides `pull` of the way to `targets[i]` (in cells) and dims as it lands.
 */
export type Pull = { targets: readonly { col: number; row: number }[]; pull: number }

export const lightsOf = (
  gems: readonly number[],
  t: number,
  frame: number,
  columns: number,
  rows: number,
  toward: Pull = { targets: [], pull: 0 },
): Light[] =>
  gems.flatMap((kind, i) => {
    const color = PALETTE[kind % PALETTE.length] ?? PALETTE[0]
    const facet = FACETS[(frame + i) % FACETS.length] ?? '✦'
    const target = toward.targets[i % Math.max(1, toward.targets.length)]
    const f = target === undefined ? 0 : toward.pull * toward.pull * (3 - 2 * toward.pull)
    return Array.from({ length: TRAIL + 1 }, (_, k) => {
      const at = gemAt(i, t - k * 0.25, columns, rows)
      const col = target === undefined ? at.col : at.col + (target.col - at.col) * f
      const row = target === undefined ? at.row : at.row + (target.row - at.row) * f
      const strength = (1 - k / (TRAIL + 1)) * (1 - toward.pull * 0.8)
      return { col, row, color, strength, glyph: k === 0 ? facet : k <= 2 ? '·' : null, isHead: k === 0 }
    })
  })

/** One cell: the field, brightened toward each light near it; a gem or a trail point on top. */
export const lit = (col: number, row: number, base: Run, lights: readonly Light[]): Run => {
  const near = lights
    .map(l => ({ l, d: Math.hypot((l.col - col) * 0.5, l.row - row) }))
    .filter(({ d }) => d < HALO)
  const bg = near.reduce((c, { l, d }) => blend(c, l.color, (1 - d / HALO) ** 2 * 0.55 * l.strength), base.bg)
  const on = near.find(({ l }) => l.glyph !== null && Math.round(l.col) === col && Math.round(l.row) === row)
  if (on === undefined) return { ...base, bg, color: near.length > 0 ? lighten(bg, 0.4) : base.color }
  const { isHead } = on.l
  return {
    text: on.l.glyph ?? base.text,
    color: isHead ? lighten(on.l.color, 0.7) : lighten(on.l.color, 0.35),
    bg: isHead ? blend(bg, on.l.color, 0.5) : bg,
    bold: isHead,
  }
}

/** A hue (degrees) at full-ish saturation as hex, for the rainbow label. */
const hue = (deg: number, light: number): string => {
  const h = ((deg % 360) + 360) % 360
  const c = (1 - Math.abs(2 * light - 1)) * 0.9
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = light - c / 2
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return `#${[r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`
}

/**
 * The label as a rainbow that flows, as ultrathink is drawn: each character
 * a hue further along, the hues moving with the frames, and a bright band
 * sweeping across now and then.
 */
export const rainbow = (label: string, frame: number) => {
  const chars = Array.from(label)
  const sweep = (frame * 1.5) % (chars.length + 24)
  return chars.map((char, i) => {
    const shine = Math.max(0, 1 - Math.abs(i - sweep) / 3)
    return { char, color: hue(i * 14 - frame * 18, 0.66 + shine * 0.24), bold: shine > 0.3 }
  })
}
