/**
 * Every string the person reads, in Japanese and English. The language is an
 * option (`language`), `auto` following Claude Code's own `language` setting.
 * Model prompts are not here: they are English, and ask for the `choiceLanguage`.
 */

export type Lang = 'ja' | 'en'

export const LANGUAGE_OPTIONS = ['auto', 'ja', 'en'] as const

/** `auto` reads Claude Code's `language` setting: "ja", "ja-JP", "Japanese", "日本語" (not "Javanese"). */
export const resolveLang = (option: unknown, settingsLanguage: unknown): Lang => {
  if (option === 'ja' || option === 'en') return option
  const s = String(settingsLanguage ?? '').toLowerCase()
  return /^ja([-_]|$)/.test(s) || s.includes('japan') || s.includes('日本') ? 'ja' : 'en'
}

type Entry = { ja: string; en: string }

const STRINGS = {
  paneTitle: { ja: '意味空間マップ', en: 'Meaning map' },
  commandDescription: {
    ja: '次の一手の4択とマップを操作します（map / goal <目的> / refresh / hide / show / stats / demo）',
    en: 'Next steps and the meaning map (map / goal <goal> / refresh / hide / show / stats / demo)',
  },
  commandHint: { ja: '[map | goal <目的> | refresh | hide | show | stats | demo]', en: '[map | goal <goal> | refresh | hide | show | stats | demo]' },
  goalSet: { ja: '目的を「{goal}」に設定しました。', en: 'Goal set to "{goal}".' },
  goalCleared: { ja: '目的を消しました。', en: 'Goal cleared.' },
  demoStarted: {
    ja: 'デモを再生します（約16秒）。モデルは呼ばず、何も送信しません。次にプロンプトを送ると終わります。',
    en: 'Demo (about 16 s): no model call, nothing sent. Your next prompt ends it.',
  },
  refreshed: { ja: '次の一手を作り直しました。', en: 'Next steps remade.' },
  hidden: { ja: '帯の4択を隠しました。マップには引き続き表示します。', en: 'Four hidden above the prompt; the map still shows them.' },
  shown: { ja: '帯の4択とマップを表示します。', en: 'Showing the four and the map.' },
  mapOpened: { ja: 'マップを開きました。', en: 'Map opened.' },
  unknownVerb: { ja: '「{verb}」は使えません。使い方：/compass {hint}', en: 'Unknown command "{verb}". Usage: /compass {hint}' },
  stats: {
    ja: '次の一手の採用状況：提示 {offered} 回 · 4択を送信 {band} 回 · マップから送信 {map} 回 · 自分で入力 {typed} 回（採用率 {rate}%）',
    en: 'Next steps: offered {offered} times · four sent {band} · map sent {map} · typed instead {typed} (taken {rate}%)',
  },
  statsNone: { ja: 'まだ記録がありません。', en: 'Nothing recorded yet.' },
  reasonApiError: { ja: 'API に接続できませんでした', en: 'no API connection' },
  reasonEmpty: { ja: 'モデルから返答がありませんでした', en: 'empty reply' },
  reasonAborted: { ja: '途中で取り消されました', en: 'call cut short' },
  reasonNothingToFork: { ja: 'まだ会話がありません', en: 'no conversation yet' },
  reasonRefused: { ja: 'モデルを呼び出せませんでした', en: 'model call refused' },
  reasonUnparsed: { ja: '候補を読み取れませんでした', en: 'unreadable reply' },
  reasonNoBlend: { ja: '指示を作れませんでした', en: 'no instruction made' },
  blendFailed: { ja: 'その位置の指示を作れませんでした：{why}', en: 'No instruction for that spot: {why}' },
  demoNoSend: { ja: 'デモのため送信しません：「{text}」', en: 'Demo: not sending "{text}"' },
  thinking: { ja: '次の一手を考えています…', en: 'Thinking of next steps…' },
  blending: { ja: 'マップで選んだ位置から指示を作っています…', en: 'Writing the instruction for that spot…' },
  failed: { ja: '次の一手を作れませんでした：{why} ', en: 'No next steps: {why} ' },
  retry: { ja: '再試行する', en: 'Retry' },
  pickingFour: { ja: '空間から4択を選んでいます…', en: 'Picking four…' },
  demoPrefix: { ja: 'デモ：', en: 'Demo: ' },
  bandTitle: { ja: '✦ 次の一手', en: '✦ Next step' },
  demoTag: { ja: '（デモ）', en: ' (demo)' },
  refining: { ja: '回答に合わせて調整中… ', en: 'Refining… ' },
  hintNumber: {
    ja: '入力欄が空のとき 1〜4 で送信 · ✎ は入力欄に入れて手直し · …で切れた択は入力欄に入ります · /compass でマップ',
    en: 'Empty prompt: 1-4 sends · ✎ fills to edit · … fills, not sends · /compass: map',
  },
  paneWorking: { ja: '✦ {demo}Claude が作業中です{kinds}', en: '✦ {demo}Claude is working{kinds}' },
  // The kinds of work seen this turn, named after what Claude is doing, never counted: the gems show how much.
  kindEdit: { ja: '編集', en: 'editing' },
  kindRun: { ja: 'コマンド実行', en: 'running' },
  kindRead: { ja: '読み取り', en: 'reading' },
  kindOther: { ja: 'ほかのツール', en: 'other' },
  kindCount: { ja: '{name}({gems})', en: '{name} ({gems})' },
  paneReady: { ja: '✦ 位置を選ぶと、その場所の指示を作ります。', en: '✦ Pick a spot to write its instruction.' },
  paneIdle: { ja: 'Claude の返答が終わると、ここに次の一手の候補が並びます。', en: 'Next steps appear here when Claude finishes.' },
  paneThinking: { ja: '✦ 次の一手を考えています…', en: '✦ Thinking of next steps…' },
  statusDemo: { ja: 'デモ表示中：モデルは呼ばず、選んでも送信しません。', en: 'Demo: no model call, nothing sent.' },
  statusTimes: { ja: '4択 {band}{prefetched} · マップ {map}', en: 'four: {band}{prefetched} · map: {map}' },
  statusPrefetched: { ja: '（作業中に準備）', en: ' (prepared)' },
  statusMapPending: { ja: '候補を作成中…', en: 'adding candidates…' },
  helpMap: {
    ja: 'クリック／矢印キー＋Enter で、その位置の指示を作成 · もう一度で送信 · Shift で入力欄へ · 1〜4 でその択を入力欄へ',
    en: 'Click / arrows + Enter writes that spot’s instruction · again sends · Shift fills the prompt · 1-4 fills a choice',
  },
  helpPreview: { ja: 'もう一度クリック（Enter）で送信 · Shift で入力欄へ · 別の位置で作り直し', en: 'Again to send · Shift fills the prompt · another spot remakes it' },
  helpBlending: { ja: '指示を作っています…', en: 'Writing the instruction…' },
  faultText: {
    ja: '空間の描画で問題が続いたため、簡易表示にしています。/reload-plugins で再挑戦できます。',
    en: 'The space kept failing to draw; this is the plain view. /reload-plugins retries.',
  },
  noMapHere: { ja: 'この画面ではマップを表示できません。', en: 'No map on this surface.' },
  redraw: { ja: 'next-compass: 空間を描き直します（{phase}: {reason}）', en: 'next-compass: redrawing the space ({phase}: {reason})' },
  seconds: { ja: '{s}秒', en: '{s}s' },
} satisfies Record<string, Entry>

export type StringKey = keyof typeof STRINGS

export type Translate = (key: StringKey, params?: Record<string, string | number>) => string

/** The translator for a language: `t('goalSet', { goal })` fills `{goal}`. */
export const makeT =
  (lang: Lang): Translate =>
  (key, params = {}) =>
    Object.entries(params).reduce((text, [k, v]) => text.split(`{${k}}`).join(String(v)), STRINGS[key][lang])
