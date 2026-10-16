export type CompassChoice = { text: string; x: number; y: number; isPrimary: boolean }

export type CompassAxes = { up: string; right: string; down: string; left: string }

/**
 * How long each stage of one generation took, in milliseconds; null for a
 * stage not run (yet). `bandMs` and `mapMs` run from the start to when the
 * four, and then the map, were shown.
 */
export type CompassTimings = {
  contextMs: number
  choicesMs: number | null
  extrasMs: number | null
  placeMs: number | null
  bandMs: number | null
  mapMs: number | null
  /** True when the four were picked from candidates prepared while Claude worked. */
  isPrefetched: boolean
}

/**
 * One generation's display data: the four (shown first) and, once the
 * parallel extras call and the placing call land, the extras merged in.
 */
export type CompassSet = {
  id: number
  axes: CompassAxes
  items: CompassChoice[]
  isMapPending: boolean
  /** True while the four shown at once from the pool wait for the pick made for Claude's final answer. */
  isRefining: boolean
  timings: CompassTimings
}

export type CompassPoint = { x: number; y: number }

export type CompassPhase = 'idle' | 'thinking' | 'blending' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'next-compass': {
      set: CompassSet | null
      phase: CompassPhase
      note: string | null
      goal: string | null
      isHidden: boolean
      isWorking: boolean
      /** True while `/compass demo` plays and until the next prompt: nothing is sent. */
      isDemo: boolean
      /** The demo's pointer on the map, gliding to an in-between spot; null when none. */
      ghost: CompassPoint | null
      /** How many times the space's Client failed since load: each one remounts it under a new key. */
      faults: number
      /** The tool names of the turn's latest calls, oldest first. */
      activity: string[]
    }
  }
}
