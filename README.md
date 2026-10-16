# next-compass

[日本語](README.ja.md)

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that predicts your **next
instruction in four directions** every time Claude finishes a turn, and lets you send one with a single
key. Beside the transcript, a **meaning map** lays the four and more candidates out in a similarity
space: click between them and the mod writes the in-between instruction for you.

The idea: keep choosing, and the project moves the way you meant.

```
✦ Next step   Empty prompt: 1-4 sends · ✎ fills the prompt to edit · a choice ending in … fills instead
1 Finish the export and open a PR                                     ✎
2 Add JSON output next to CSV                                         ✎
3 Open the exported file and check it by hand                         ✎
4 Add tests for the export module                                     ✎
```

## How it works

1. **While Claude works**, a fast model (haiku) prepares 6–12 candidate instructions from a short
   summary of the recent conversation. The map pane shows a moving field with one light per tool call.
2. **The moment the turn ends**, four candidates are picked locally and shown at once: the four that are
   furthest apart in the similarity space (seeded with the one nearest your `goal`, if you set one).
   A second fast call then re-picks for Claude's final answer and replaces them in place. Claude Code's
   own Tab suggestion, when it lands, joins the candidates too.
3. **The map** is laid out by the mod itself, not by the model: candidate texts are compared by
   character n-grams and words (TF-IDF cosine), placed by classical MDS, and aligned to the previous
   turn's layout so the map does not spin. Same candidates, same map, every time. The four take the
   directions (up / right / down / left) their spots point to; the model only names them.
4. **Picking a candidate** (its gem, number or name) shows that candidate's own words, as written.
   **Picking a spot** between candidates writes one instruction blending the nearest three in the
   shares the caption shows. Either way the first pick shows the text under the map; a second pick at
   the same spot sends it. Shift fills the prompt box instead.

What is sent is always what you read: a choice the band had to cut short with `…` goes to the prompt
box instead of being sent.

## Install

```bash
claude plugin marketplace add m-aoki1348125/next-compass
claude plugin install next-compass@next-compass
```

Or try it for one session from a clone: `claude --plugin-dir ./next-compass`.

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `m-aoki1348125/next-compass`, then **Add plugin**. A plugin installed from a terminal at
the user scope also loads in the desktop app's local sessions.

Before installing any mod you can list what it does without running it:
`claude plugin validate ./next-compass`.

## Use

| Action | Result |
|---|---|
| `1`–`4` in the empty prompt box, or click a choice | Sends that instruction as yours |
| `✎` next to a choice | Puts it in the prompt box to edit |
| Map: click, or arrow keys + Enter | On a candidate: shows its own words. Between candidates: writes the instruction for that spot. Shown under the map |
| Map: click / Enter again at the same spot | Sends it (Shift: fills the prompt box) |
| Map: `1`–`4` | Puts that choice in the prompt box (the map shows chips, not the full text) |

The map adapts to its size: wide and tall, it names the directions and shows every extra candidate on a
textured ground; smaller (above the prompt in a small terminal), it keeps the gems and numbers and drops the
names, then the extras.
| `/compass goal <text>` | Sets the goal the four lean toward; `/compass goal` clears it |
| `/compass map` · `hide` · `show` · `refresh` | Opens the map, hides or shows the band, remakes the four |
| `/compass stats` | How often the next steps were taken, across sessions |
| `/compass demo` | A 16-second scripted demo; no model is called and nothing is sent |

The map pane docks beside the transcript in a wide terminal (about 144 columns) or in the desktop
app; the band above the prompt works everywhere.

## Options (`/config`)

| Option | Values (default in bold) | Meaning |
|---|---|---|
| `language` | **`auto`** / `ja` / `en` | UI language. `auto` follows Claude Code's own `language` setting |
| `choiceLanguage` | **`auto`** / `ja` / `en` | Language the predicted instructions are written in. `auto` follows the UI language, so the four never mix languages |
| `generator` | **`haiku`** / `sonnet` / `opus` / `fork` | Model that writes the four and the blended instruction. `fork` asks the session's own model over the whole conversation |
| `showMap` | **`true`** / `false` | Open the map at session start |
| `extraCount` | **8** (0–16) | Candidates besides the four to place on the map |

Candidates prepared while Claude works and the final pick always use haiku.

## Privacy

Everything the mod sends goes through Claude Code's own model calls (`$.model.complete` / `fork`) to the
same provider your session uses; nothing goes anywhere else. What it sends with `haiku` / `sonnet` /
`opus`: a summary of the last 12 messages (each cut to a few hundred characters, with the names of the
tools called and their main argument: a file path, a command, a search pattern or a subagent's brief),
the goal you set, the tail of Claude's final answer, Claude Code's own Tab suggestion, and the candidate
texts. Common credential forms in tool arguments (`KEY=value`, `token: value`, `Authorization: Bearer …`)
are masked before they leave; other forms (a password in a URL, a token after a flag) are not, so treat
the summary as you treat the conversation itself. With `fork`, the session's own model reads the whole
conversation for the four and the blend; the candidates prepared while Claude works and the final pick
still go to haiku with the summary. The one thing stored across sessions is the four counters behind
`/compass stats`.

The transcript is sent as data, fenced and marked as such, but a model can still be led by text inside
it. The rule the mod follows is therefore: the band sends only a choice it could show in full, the map
sends a blended instruction only after drawing it in full at the spot you pick again, and everything else
goes to the prompt box for you to read first. Claude Code's own permission prompts still apply to whatever
the instruction makes Claude do.

Note that in the empty prompt box a bare digit presses the band's choice with that number. When Claude
has just asked you a numbered question, type the digit with a word (`option 1`) or click the choice.

## Requirements

- Claude Code with mods. Developed and tested with 2.1.301; the map draws in the terminal and the desktop app.
- Organizations can block user-installed mods; if `/compass` does not exist after installing, ask your
  administrator.

## Known limits

- The similarity space compares the candidates' **text**, not their meaning: two differently worded
  instructions for the same thing can land apart. It is deterministic and fast, which is what the map
  needs; a model-judged refinement is a possible later step.
- `fork` reads the whole conversation and is slower; `haiku` with the summary is the default for speed.
- The context block is marked for the prompt cache, but the calls of one generation run in parallel and
  the summary's window moves every turn, so cache hits are a bonus, not the design's speed.

## Development

```bash
claude plugin validate .          # what the mod hooks and calls
claude plugin test .              # the test suite
npx -y -p typescript tsc -p . --noEmit
```

See [CHANGELOG.md](CHANGELOG.md) for releases.

## License

MIT
