# Changelog

## 0.3.3 — 2026-10-16

- English wording reviewed: the band hint and the map help say what a pick does (a candidate as written, a
  spot between them blended), the stats line reads as a sentence (`2 offered · 1 sent from the four …`),
  "running commands" and "other tools" are back in the working label. The Japanese map help and the
  resting line follow the same pick rule.

## 0.3.2 — 2026-10-16

- The map's working label no longer counts "(5 actions)": it names the kinds of work this turn, with one
  gem per call, the same gems that drift in the field: `✦ Claude is working · reading (✦✦) · editing (✦)
  · running commands (✦)`. The kinds keep a fixed order (read, edit, run, other tools), so the line does
  not reshuffle as work goes on. "The meaning space is moving" is gone from the label; the motion shows.
- Shorter English strings throughout the UI (hints, statuses, reasons); the Japanese is unchanged.
- The map's marks redrawn: a primary is a gem `❖` in its color, its number in white and its name in a
  lighter tint, written over the field with no colored box; the pointer is a white `✛` on a soft glow of
  the ground instead of a white block, the mouse a `✧`. At rest the map carries no pointer and no
  caption: the pointer appears where the keys or the mouse first put it (the keys start from the middle).
- A pick on a candidate itself (its gem, number or name on the map) previews that candidate's own words,
  with no model call; the second pick sends them. Only a spot off every candidate is blended from its
  position. Before, every pick was blended, so a pick right on a choice could send different words.
- The band numbers its choices (`1 …`, in the choice's color) instead of pointing with `↑ → ↓ ←`: the
  number is the key that sends it.
- Option `keyMode` and the arrow-key cross are removed: the arrow keys belong to Claude Code's own history
  and focus movement, and a focused band's ring moves in drawing order, not by direction. Digits and
  clicks pick a choice.

## 0.3.1 — 2026-10-16

- Similarity tokens: Latin words without English function words (`the`, `to`, …), character bigrams only
  within each run of other scripts, never across a Latin word; a lone punctuation mark is a separator. A
  goal like "make the parser types strict" now finds the candidate about parser types, not the one that
  shares "the parser".
- Candidates alike to nothing else no longer share one spot: the layout keeps every pair at least 0.15
  apart, deterministically.
- Tests for empty, whitespace and symbols-only input, and for replies and conversations that mix
  Japanese and English in one line (34 cases).

## 0.3.0 — 2026-10-16

- New option `choiceLanguage` (auto / ja / en): the language every predicted instruction, pick and
  blend is written in. `auto` follows the UI language. Before, prompts asked for "the language the user
  writes in", and the four could come back mixed.

## 0.2.2 — 2026-10-16

- The map's help line said digits send a choice; they put it in the prompt box (the map shows chips, not
  text). Fixed in both languages. English wording of the demo and three messages tightened.

## 0.2.1 — 2026-10-16

- The demo plays in the UI language: an English script beside the Japanese one.
- Less CPU while Claude works: the field is computed once per pair of columns (a cell is twice as tall as
  wide), gem trails are shorter, each cell looks only at the lights within its reach, colors are rounded
  once per frame, runs are built in place, and the field draws six frames a second instead of eight. One
  frame of a 200×46 pane went from about 93 ms to about 50 ms of script time, at two thirds the rate.

## 0.2.0 — 2026-10-16

The product release: the same four-direction band and meaning map, rebuilt for accuracy, speed and a
map that means what it shows.

### Prediction
- The model reads a longer context: the last 12 messages, each user request's head, each answer's head
  and tail, and the tools called with the file or command they were given (was 6 messages × 240 chars).
- Every call opens with the same context block marked for the prompt cache (`cache: true`). The calls of
  one generation run in parallel and the summary's window moves each turn, so hits are a bonus; the speed
  comes from the pool prepared while Claude works and the local layout.
- The final pick reads the tail of Claude's answer (1,200 chars, was the head's 800) and Claude Code's
  own Tab suggestion when it has landed; the suggestion also joins the map as a candidate.
- The pool prepared while Claude works grows with the map (6–12 candidates) and no longer asks the
  model for coordinates, which makes its replies shorter.
- `/compass stats` counts offered, taken (band / map) and typed-over next steps across sessions.

### Meaning map
- Coordinates are computed locally from the candidate texts (TF-IDF over character n-grams and words,
  classical MDS, Procrustes alignment to the previous layout). The same candidates give the same map;
  the model never writes a coordinate.
- The four take the compass directions their spots point to; the fixed "forward/back × widen/harden"
  axes are gone, as the concept asked. Options `choiceMode` (split / single) removed.
- The caption's shares and the blend's shares are the same three candidates, renormalized the same way.
- A settled map is still: colors mean positions. The field keeps moving while Claude works and melts
  into the map as before.

### Interaction
- Picking a spot is two steps: the first writes and shows the instruction under the map, a second pick
  at the same spot sends it; Shift fills the prompt box. The silent "near a candidate sends it at once"
  rule is gone.
- A choice the band cuts with `…` fills the prompt box instead of being sent: what is sent is what was
  read.

### Speed
- The settled map stops its clock and is redrawn only on input or new data; the free field's color
  fitting remembers the step that fit last frame (two attempts instead of five).
- Every model call has a timeout; a stuck call shows why instead of "thinking…" forever.
- Removed the unused `CompassMap` and `Flux` clients; `map.ts` and `flux.ts` keep the helpers.

### Fixes (the five known defects)
- A demo cut short by `/compass refresh` no longer leaves the working state on.
- A failed extras call no longer hides the four or leaves the map pending.
- Two picks on the map in a row: the later pick wins, a slower earlier reply is dropped.
- `/clear` during a turn stops the prefetch timer.
- A reload resets the phase to idle.

### Map stability (from the live test)
- Nothing on the map moves under the person: the final pick and the extras that land later keep every
  candidate where it was; newcomers join at the similarity-weighted spot among the placed ones, kept
  apart from them and off the cursor's centre cell (`placeAmong`, `repick`).
- After a choice is sent or filled, the map's colors stay as they were, still and without chips, until
  Claude starts working; only then does the field melt back into motion.
- The cursor over a candidate keeps the candidate's glyph in the cursor's colors instead of hiding it.

### Review fixes before release
- The field moves only while Claude works (and during the melt into or out of the map); waiting for the
  person, before any turn or after `/clear`, it is still, like the settled map.
- A preview the caption had to cut, or a digit pressed on the map (which shows chips, not text), fills the
  prompt box instead of sending. A layout change (final pick, extras, Claude Code's suggestion) drops a
  preview and any blend in flight, so a stale instruction is never sent for a moved spot.
- `fork` calls are bounded by the same timeouts as `complete` calls.
- A blend that fails keeps the four and says why in a toast, instead of hiding them behind an error.
- The second pick is matched by cell (the Client says so), not by a distance that spanned neighbors.
- A stale generation can no longer bring a cleared set back; the previous map's spots survive a turn's
  reset, so the alignment to the previous layout works at turn end.
- The transcript is sent fenced as data with a rule not to follow instructions found in it; common
  credential forms in tool arguments (`KEY=value`, `token: value`, `Bearer …`) are masked before leaving.
- Emoji count as two cells; a cut choice is the text's head only; a goal sharing nothing with the pool
  seeds nothing.

### Product
- English and Japanese UI (`language` option, `auto` follows Claude Code's setting).
- README (en / ja), LICENSE (MIT), marketplace manifest, author metadata, `.catch` handlers on the
  gating hooks.

## 0.1.0 — 2026-10-15

First working version, built in one session: the four above the prompt, the pool prepared while Claude
works, the meaning map pane with the moving field, the demo and the intro video.
