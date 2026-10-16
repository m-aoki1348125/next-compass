# Changelog

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
