# Fix plan — design-pass repair (for parallel Opus agents)

Every defect is already found, verified, and traced in [AUDIT.md](AUDIT.md) — **do not re-audit;
fix.** Each finding there has file:line, a reproduced evidence trace, the user-visible failure, and
a suggested minimal fix. The suggested fixes are good defaults, not law; the traces are law.

The repo is now the source of truth. The design mockup this came from is reference only — where
mockup behaviour and this plan disagree, this plan wins.

## Ground rules (all agents)

- **House rules — violating any is a regression:** (1) on/off (mixOption) never copied, displayed,
  or stored; (2) every switcher write verified by read-back, success measured never assumed;
  (3) strip.js curve maths untouched; (4) plain JS, no framework, no build step, no CDN assets;
  tabs, no semicolons; comments explain *why*.
- Fix the **root cause** named in the evidence, not the symptom. If your fix diverges from the
  suggested one, say why in the commit message.
- Real hardware is NOT on this network. Verify with the demo harness
  (`http://127.0.0.1:8730/?demo=<scenario>` — see demo.js SCENARIOS) plus a clean-localStorage
  first-run (`for (const k of Object.keys(localStorage)) localStorage.removeItem(k)`).
  The embedded browser pane can report `window.innerWidth/Height` as 0 — geometry code must
  tolerate that (relevant to TIPS-01).
- Commits: small, one concern each, message references the AUDIT ids ("Fix APP-01, APP-03: …").
  **No AI attribution in commits — house rule.**
- Do not push. Do not touch files owned by another package. Do not add dependencies.

## Execution order

```
Wave 1 (parallel, no file overlap):
  A  app.js + tips.js + index.html + server.js + electron/main.js   ← the big one
  C  demo.js
  D  style.css
Wave 2 (after A lands, because it touches server.js and reacts to A's app.js changes):
  B  browse.js + the community-catalogue reality
Wave 3:
  E  integration verification pass (no code ownership; files bugs back to A–D)
```

---

## Package A — Tour, sample switcher, copy flow, wiring (app.js, tips.js, index.html, server.js, electron/main.js)

Owns: `public/app.js`, `public/tips.js`, `public/index.html`, `server.js`, `electron/main.js`.

**Fix in this order** (earlier fixes unblock verifying later ones):

1. **SRV-01 (critical)** — undo passes stale `levels` key; gain/volume/pan silently never restored.
   One-line fix via `normalizeSections`; also add read-back diff to the undo response like
   /api/apply has, so undo honesty matches copy honesty (house rule 2).
2. **ELEC-01 (critical)** — random ephemeral port each launch wipes origin-keyed localStorage
   (tour/tips/recent IPs forgotten every launch). Prefer a stable port (try 8730, walk upward on
   EADDRINUSE); keep port 0 only as last resort.
3. **APP-01 (critical) + TIPS-anchor** — coach-marks (`renderCardHint`) hijack the running tour at
   step 4, orphaning the sequence; tour never completes, seq flag never set, sample switcher
   stranded with Copy disabled. Fix BOTH ends: `if (tourDemo) return` in renderCardHint, and in
   tips.js `show()` refuse to replace an active sequence step (`if (cur?.seqCtl && !opts.seqCtl) return`).
4. **APP-02..APP-05 + APP-24 (sample-switcher lifecycle)** — the connect-race latch (re-check
   `tourDemo` after every `await` in both connect paths; cancel the pending 500ms auto-tour when a
   connect starts), sample channel clicks hitting the real API with ip='sample' (serve from tour
   bodies stored on `tourDemo`), per-side connect leaving the other column fake-but-copyable (use
   `exitTourDemo()` restore semantics; treat 'sample switcher' input text as empty when deciding
   two-switcher mode), `exitTourDemo` null-device crash (null-safe deviceLine + always clear
   `tourDemo` in a finally), and the Presets-column deadlock (APP-09: force column A to switcher
   kind — visibly — before installing the sample).
5. **TIPS-01 (major)** — off-screen step target hides the whole tour UI including Next/Skip with no
   recovery. `scrollIntoView({block:'center'})` when the target is connected but off-screen; when
   truly absent, keep the callout+nav visible and hide only the spotlight. Add a bounded rAF retry
   for first-paint geometry (viewport may report 0×0 — treat as "try again next frame", max ~10).
6. **APP-06 (major)** — askBar leaks its document keydown listener when superseded (later Enter
   re-runs an unconfirmed copy) and #apply isn't disabled during the confirm phase (double-fire).
   Remove the old listener when a bar is replaced; gate Enter on the bar being current; disable
   Copy from click to resolution.
7. **APP-07, APP-08** — two-switcher collapse impossible from the destination column + applyMode
   clobbering an address mid-typing; and section-toggle rebuilding the save form, discarding the
   user's typed preset name/notes (preserve form state across re-renders).
8. **HTML-01/APP-15 (#summary missing — the "what goes where" line is gone), HTML-02/APP-16
   (snapshot unreachable)** — restore a summary element in the status bar and give snapshot a home
   (recommended: an action row inside each column's ▾ address menu, "Download snapshot of this
   switcher"; your judgment within: reachable, not prominent).
9. **The guide-markup family** — APP-17 (.gcause/.gwhat/.gfix/.gfail markup mismatch),
   APP-18 (.gsteps has no CSS — emit the classes the stylesheet defines; if a rule is genuinely
   missing, coordinate: the CSS file belongs to D in wave 1, so instead emit classes that exist,
   or land your CSS need as a comment for D and use existing classes).
10. **Tour text/anchor truthfulness** — APP-19 (tour.pick spotlights source while teaching
    destination multi-select: split into two steps or re-anchor), APP-25 ("press Connect" vs the
    'Go' button — also HTML-04's six stale strings), APP-26 (hardcoded ⌘ vs MOD), APP-27 (shape 4
    labelled Band pass; it is Bell), APP-28 (final step claims the sample "disappears when you
    press Done" even when it wasn't the sample), XTR items from the critic (mid-tour connect
    should mark the tour seen or re-offer it; keyboard multi-select impossible — make the listbox
    keydown honour shift/⌘ semantics; post-copy refresh failure misreported as "copy did not run" —
    report copy verified + refresh failed distinctly).
11. **The remainder of app.js minors/polish** in AUDIT order: request-ordering guard in loadDetail,
    blend-bar stuck disabled after failure, blend multi-destination undo semantics (batch the
    applies or set expectations in the UI), library wipe before isLib guard, roving tabindex with
    hidden MADI strips, importFile error handling, save-collision warning, toast eviction keeping
    sticky errors, listbox role hygiene, dead #recent-ips wiring (HTML-03: point the inputs at the
    datalist or remove it), 'kinds' hint gated on wrong key, per-side hint flip-flop, pluralisation.

Verification recipe (A): clean-localStorage first run → the tour must run all 9 steps with the
demo clicks visible, survive clicking sample channels (card renders from tour bodies, no network),
complete via Done (sample gone, seq flag set, buttons enabled) AND via Skip; connect mid-tour must
cleanly drop the sample and never latch; `?demo=connected` unaffected; Enter can never fire an
unconfirmed copy; undo restores gain/volume/pan (assert via /api/preview diff = 0 after undo);
relaunch Electron twice — tour must not re-run (stable origin).

## Package C — Demo harness honesty (demo.js only)

Owns: `public/demo.js`. AUDIT ids DEMO-01..DEMO-09. Priorities: DEMO-01 (demo must suppress the
500ms auto-tour except in the first-run scenario — do it inside demo.js, e.g. mark the seq flag
seen in its sandbox before app.js loads); DEMO-02 (scenarios must not write the real app's
localStorage — sandbox all keys the demo touches, including tips flags and library 'installed'
marks: DEMO-03); then make the fake endpoints tell the truth the app expects: undo actually
reverts the injected state (DEMO-04), snapshot envelope round-trips (DEMO-05), pack export
respects file selection and carries channels (DEMO-06), restore reflects the upload (DEMO-07);
stub /api/status (DEMO-09); make the scenario chip reach the copying/clamped states it advertises
(DEMO-08). Constraint: demo.js stays completely inert without its gate; zero new globals beyond
its existing surface. Verify: all 12 scenarios render their advertised state; a real-mode load
(no ?demo) with DevTools network tab shows demo.js touching nothing.

## Package D — Stylesheet stacking and affordances (style.css only)

Owns: `public/style.css`. AUDIT ids CSS-01..CSS-06. Establish ONE documented z-index ladder
(comment block at the top of the z rules): modals must sit above coach-marks (CSS-01), toasts
above the help sheet (CSS-05), demo chip above the browse sheet (CSS-06). Fix the .sample border
cue losing to ID-rule specificity (CSS-02 — `#panel-A.sample .list-col` or `:where()` to flatten),
the clipped focus rings on the pill toggles (CSS-03), and #browse-open's two competing skins
(CSS-04 — pick the fire treatment, remove the dead one). Also: add the missing `.gsteps`/`.gstep`
rules to match Package A's guide markup (numbered rows via the CSS the .gcause family already
establishes — coordinate through comments, not by editing app.js). Verify with the demo scenarios:
open help over toasts, tour over modals, browse over demo chip; keyboard-tab every control
watching focus rings.

## Package B — Community browser vs the real catalogue (wave 2: browse.js + server.js /api/community block)

Owns: `public/browse.js` and the `/api/community` section of `server.js` (A has finished with the
file by now). AUDIT ids BRW-01..BRW-13.

**The existential fact (BRW-01):** browse.js was written against a catalogue API that does not
exist. The real catalogue (presets.studioupgrade.com, Cloudflare Pages + D1) serves exactly:
`GET /index.json` (packs: id/name/description/author/tags/presetCount/presets[]/devices/checksum),
`GET /packs/<file>` (full pack with channel bodies), `GET /api/votes` → `{votes:{id:n}}`,
`POST /api/vote {packId}`. Nothing else. No search endpoint, no ratings, no comments, no publish,
no install counts.

Scope decision, already made — implement it, don't relitigate:
- Rebuild browse.js's data layer on what exists: fetch index.json + votes through the server proxy;
  search/facets computed **client-side** from the index; sort by votes ("Top rated" → "Most voted"),
  name, createdAt. Detail view = the pack's real channels rendered with renderStripCard.
- Rating stars → a single vote affordance backed by POST /api/vote (BRW-06); drop fake helpful
  counters (BRW-10) and comments UI entirely — commenting has no backend; remove rather than fake.
- Publish (BRW-04): the honest path today is the GitHub PR flow. Keep the form; on submit, produce
  the pack file (download) and open the prefilled GitHub new-issue/PR URL with instructions —
  clearly labelled. No fake success.
- Fix the local bugs regardless: search focus loss on re-render (BRW-02 — patch, don't rebuild,
  the grid), add-to-library overwrite without collision check (BRW-03 — suffix like importFile
  does), privacy claim vs actual payload (BRW-05 — make the claim true by stripping, not by
  editing the claim), detail-error spinner (BRW-07), comment-box clearing before send → moot if
  comments go, stale CAT.error poisoning the list view (BRW-09), notes/sampleUrl prefill via the
  full pack fetch (BRW-11), Escape-during-publish null-deref (BRW-12), double-escaped toast
  (BRW-13). Server side: the proxy forwards to the catalogue root — make it serve /index.json and
  /packs/* too, with the same 8s timeout and polite failure.

Verify: with the network up — browse lists the real (currently empty) catalogue and says so
warmly; with packs present locally (point ATEM_CATALOGUE_URL at a local fixture dir) — search,
facets, detail, vote, add-to-library all work; offline — the existing graceful panel; publish
produces a valid pack file that `atem-preset-library/scripts/build-index.mjs --check` accepts.

## Package E — Integration pass (wave 3, no code ownership)

Fresh eyes, no prior context. Run: clean first-run tour end-to-end (complete AND skip AND
mid-tour connect); every demo scenario; a full copy/undo cycle against `?demo=connected`
asserting the confirm→progress→outcome→undo chain; keyboard-only session (tab everywhere,
multi-select via keyboard, Enter safety); Electron launch twice (storage persistence, stable
port); `node --check` all JS + the CSS brace balance; the classscan for emitted-vs-defined
drift. File anything found as new AUDIT entries and hand back to the owning package — do not fix
in place.

## Open items that are Ryan's, not yours

- Sponsors letter promises a $5/month tier and one-time giving (app.js ~1714) — needs Ryan to
  confirm his GitHub Sponsors page actually offers both, or reword.
- Starter presets: ship a `presets-seed/` for first-run? (Decision pending since the port.)
- Whether the community catalogue grows a real API (ratings/comments/publish) later — Package B's
  degrade is the honest v1, not the end state.
