import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { CompassPhase, CompassPoint, CompassPreview, CompassSet } from '../types'
import { clampExtra } from './compass'
import type { Lang } from './i18n'

/**
 * The plugin's state, one atom per key, read and written through the
 * functions below: the engine's scan follows `$` into function declarations
 * and reads each atom where it is declared, so every value the mod keeps is
 * named here and nowhere else.
 */

export type $ = EngineInterface

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
const previewAtom = atom({ plugin: 'next-compass', key: 'preview' } as const, null)

export function getSet($: $): Promise<CompassSet | null> {
  return read($, setAtom)
}
export async function putSet($: $, fn: (set: CompassSet | null) => CompassSet | null): Promise<void> {
  await update($, setAtom, fn)
}
export function getPhase($: $): Promise<CompassPhase> {
  return read($, phaseAtom)
}
export function getNote($: $): Promise<string | null> {
  return read($, noteAtom)
}
export function getGoal($: $): Promise<string | null> {
  return read($, goalAtom)
}
export async function putGoal($: $, goal: string | null): Promise<void> {
  await update($, goalAtom, () => goal)
}
export function getHidden($: $): Promise<boolean> {
  return read($, hiddenAtom)
}
export async function putHidden($: $, isHidden: boolean): Promise<void> {
  await update($, hiddenAtom, () => isHidden)
}
export function getWorking($: $): Promise<boolean> {
  return read($, workingAtom)
}
export async function putWorking($: $, isWorking: boolean): Promise<void> {
  await update($, workingAtom, () => isWorking)
}
export function getActivity($: $): Promise<string[]> {
  return read($, activityAtom)
}
export async function putActivity($: $, fn: (list: string[]) => string[]): Promise<void> {
  await update($, activityAtom, fn)
}
export function getDemo($: $): Promise<boolean> {
  return read($, demoAtom)
}
export async function putDemo($: $, isDemo: boolean): Promise<void> {
  await update($, demoAtom, () => isDemo)
}
export function getGhost($: $): Promise<CompassPoint | null> {
  return read($, ghostAtom)
}
export async function putGhost($: $, ghost: CompassPoint | null): Promise<void> {
  await update($, ghostAtom, () => ghost)
}
export function getFaults($: $): Promise<number> {
  return read($, faultsAtom)
}
export async function putFaults($: $, fn: (n: number) => number): Promise<void> {
  await update($, faultsAtom, fn)
}
export function getPreview($: $): Promise<CompassPreview | null> {
  return read($, previewAtom)
}
export async function putPreview($: $, preview: CompassPreview | null): Promise<void> {
  await update($, previewAtom, () => preview)
}

export async function setPhase($: $, phase: CompassPhase, note: string | null): Promise<void> {
  await update($, phaseAtom, () => phase)
  await update($, noteAtom, () => note)
}

/** Drops the four, the preview and any error: the band and the map show nothing of the last generation. */
export async function clearChoices($: $): Promise<void> {
  await update($, setAtom, () => null)
  await update($, previewAtom, () => null)
  await setPhase($, 'idle', null)
}

/** Merges into the set only while it is still this generation's. */
export async function patchSet($: $, id: number, fn: (set: CompassSet) => CompassSet): Promise<void> {
  await update($, setAtom, set => (set !== null && set.id === id ? fn(set) : set))
}

export type Generator = 'haiku' | 'sonnet' | 'opus' | 'fork'

export type Settings = {
  generator: Generator
  showMap: boolean
  extraCount: number
  language: Lang | 'auto'
  /** The language the predicted instructions are written in; `auto` follows the UI language. */
  choiceLanguage: Lang | 'auto'
}

const GENERATORS: readonly Generator[] = ['haiku', 'sonnet', 'opus', 'fork']

export const readSettings = (options: PluginOptions): Settings => ({
  generator: GENERATORS.find(g => g === options.generator) ?? 'haiku',
  showMap: options.showMap !== false,
  extraCount: clampExtra(typeof options.extraCount === 'number' ? options.extraCount : 8),
  language: options.language === 'ja' || options.language === 'en' ? options.language : 'auto',
  choiceLanguage: options.choiceLanguage === 'ja' || options.choiceLanguage === 'en' ? options.choiceLanguage : 'auto',
})
