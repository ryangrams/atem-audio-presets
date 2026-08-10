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
Wave 1 (parallel, no file overlap) — the release-blocking bug fixes:
  A  app.js + tips.js + index.html + server.js + electron/main.js   ← the big one (incl. cut snapshot)
  C  demo.js
  D  style.css
  F  presets-seed/ + first-run seed (Ryan-owned content; runs alongside)
Wave 2 (after A lands; larger, does NOT block the Wave-1 release):
  B  full community backend — browse.js + server proxy + atem-preset-library (Cloudflare D1)
Wave 3:
  E  integration verification pass (no code ownership; files bugs back to A–D)
```

Decisions folded in (from Ryan): snapshot/restore is **cut**, not rehomed (Package A);
the community browser gets the **full backend** built (Package B, wave 2); publishing is the
**GitHub PR flow**; ship **~5 seed presets** + research real catalogue content (Package F).

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
8. **HTML-01/APP-15 (#summary missing — the "what goes where" line is gone)** — restore a summary
   element in the status bar so updateSummary has a target again.
   **HTML-02/APP-16 (snapshot) — DECISION: cut it entirely.** Remove the snapshot/restore feature:
   delete `snapshot()`, `restoreSnapshot()`, the dead `#snapshot-A/#snapshot-B` handlers, the
   `/api/snapshot` and `/api/restore` server routes, and any help/tour/empty-state copy that
   mentions snapshots. Presets + per-channel copy cover the need; less surface. (DEMO-05/DEMO-07,
   the demo snapshot stubs, then become dead too — tell Package C to delete them.)
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

## Package B — Community catalogue: build the real backend (wave 2, separate larger effort)

Owns: `public/browse.js`, the `/api/community` section of `server.js`, AND the
`~/SUDev/atem-preset-library` repo (Cloudflare Pages Functions + D1). AUDIT ids BRW-01..BRW-13.
**DECISION: build the full backend.** This is now the biggest package and spans two repos, so it
is deliberately sequenced AFTER the Wave-1 bug fixes ship — it must not block the release that
fixes the sample switcher, undo, etc.

**Starting point.** Today the catalogue (presets.studioupgrade.com, Cloudflare Pages + D1) serves
only: `GET /index.json`, `GET /packs/<file>`, `GET /api/votes`, `POST /api/vote`. browse.js
(BRW-01) expects a much richer API. Build the missing half.

Backend to build in `atem-preset-library` (Pages Functions + D1, patterns already established there):
- **Ratings** — a `ratings` table (pack_id, voter-hash, stars 1–5, created_at); `GET /api/ratings`
  → `{id:{avg,count}}`, `POST /api/rate {packId,stars}`, one rating per voter (salted-IP hash, as
  votes already do). Keep the existing votes as a separate "useful" signal or fold into ratings —
  your call, but don't lose existing vote data.
- **Comments** — a `comments` table (pack_id, author, body, created_at); `GET /api/comments?packId`,
  `POST /api/comment {packId,author,body}`. Rate-limit and length-cap server-side; **add Cloudflare
  Turnstile** on the comment and rating POSTs — an unauthenticated write endpoint gets abused fast.
  Sanitise on read (comments render as text, never HTML).
- **Install/use counts** — increment on add-to-library via a lightweight `POST /api/installed
  {packId}` (best-effort, deduped by voter-hash) or derive from votes; don't fabricate the numbers.
- Extend `build-index.mjs`/index.json with `mic`, `style`, `notes`, `sampleUrl` per preset so the
  browser's facets and detail have real data (they're already validated on submission).
- Publishing stays the **GitHub PR flow** (Ryan gates what enters the catalogue): the publish form
  exports a valid pack and opens a prefilled PR against atem-preset-library. Do NOT build a public
  write-endpoint for new packs — only for interactions (ratings/comments/installs) on packs that
  already passed review.

Then wire browse.js to the real endpoints and fix its local bugs: search focus loss on re-render
(BRW-02 — patch the grid, don't rebuild it), add-to-library overwrite (BRW-03 — suffix like
importFile), privacy claim vs payload (BRW-05 — make the claim true by stripping), detail-error
spinner (BRW-07), stale CAT.error poisoning the list (BRW-09), notes/sampleUrl prefill (BRW-11),
Escape-during-publish null-deref (BRW-12), double-escaped toast (BRW-13). Server proxy: forward
index.json, /packs/*, and every new /api/* with the 8s timeout and polite failure.

Verify: against a local fixture (`ATEM_CATALOGUE_URL` → a local Pages dev server) exercise search,
facets, detail, rate, comment (with Turnstile in test mode), add-to-library (install count ticks),
and offline degrade; publish produces a pack that `atem-preset-library/scripts/build-index.mjs
--check` accepts; comments/ratings survive a reload (persisted in D1).

## Package E — Integration pass (wave 3, no code ownership)

Fresh eyes, no prior context. Run: clean first-run tour end-to-end (complete AND skip AND
mid-tour connect); every demo scenario; a full copy/undo cycle against `?demo=connected`
asserting the confirm→progress→outcome→undo chain; keyboard-only session (tab everywhere,
multi-select via keyboard, Enter safety); Electron launch twice (storage persistence, stable
port); `node --check` all JS + the CSS brace balance; the classscan for emitted-vs-defined
drift. File anything found as new AUDIT entries and hand back to the owning package — do not fix
in place.

## Package F — Seed presets (Ryan-owned content, do this alongside Wave 1)

Owns: a new `presets-seed/` directory + the first-run seed logic in `electron/main.js` and/or
`server.js`. **DECISION: ship ~5 seed presets locally, and research real values for the online
catalogue too.**

- Author ~5 starter presets as real `atem-audio-preset` files (the demo.js chains — SM7B, PodMic,
  gooseneck/lectern, a lav, a safety-net gate — are a good basis; refine the values against
  published best-practice for each mic). Put them in `presets-seed/`; on first launch, if the
  user's preset dir is empty, copy them in (Electron `app.whenReady`, guarded so it runs once).
  They also serve as honest examples.
- **Research task (Ryan asked for online sleuthing):** gather credible, sourced EQ/dynamics
  starting points for common broadcast/podcast mics and translate them into the ATEM raw format
  (dB×100, Hz, Q×100, shape ids). Cite sources in each preset's `notes`.
- **Honesty rule:** seed content is authored by **Studio Upgrade**, labelled as such — never
  faked as anonymous "community" submissions with invented usernames or ratings. The catalogue's
  whole premise is "chains real people dialled in"; SU's own starter packs are legitimate, fake
  personas are not. These seed the catalogue via the normal PR/validation path.

## Open — Ryan-owned, non-blocking

- Sponsors letter (app.js ~1714): CONFIRMED by Ryan — $5/month tier and one-time giving both
  exist. Leave the copy as written.
