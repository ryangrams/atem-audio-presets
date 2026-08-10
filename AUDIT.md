# Audit ledger — design-pass port (2026-08-08)

Every functional defect found in the design-pass port, each one **adversarially verified against the
code** (0 of 111 raw findings survived refutation wrongly — everything here has a reproduced trace).
Method: 10 scoped auditors → dedupe → per-file adversarial verification → completeness critic.
Totals: **77 findings** — 4 critical, 20 major, 37 minor, 16 polish.

Fix assignments and ordering live in [OPUS-FIX-PLAN.md](OPUS-FIX-PLAN.md). IDs here are referenced there.

**The four load-bearing house rules — violating any of these is a regression, not a fix:**
1. A channel's on/off state (mixOption) is never copied, never displayed, never stored in presets.
2. Every write to a switcher is verified by read-back; success is measured, never assumed.
3. The curve maths in strip.js (RBJ biquads, dynamics transfer order) is correct — do not touch.
4. Plain JS, no framework, no build step, no CDN assets, tabs, no semicolons.


## app.js (41)

### APP-01 · CRITICAL · `public/app.js:1780`

**renderCardHint coach marks hijack the running tour at step 4, killing the sequence and stranding the sample switcher**

- **Evidence:** Reproduced the trace: renderCardHint (app.js:1778-1797) fires plain Tips.show({key:'blocks'}) whenever state.A.detail is set and Tips.show({key:'multi'}) when B has channels with <2 selected; it is called from renderDetail at app.js:789 and 804 with no tour guard. tips.js show() (193-198) only guards `if (!opts.seqCtl && seen(opts.key)) return` then unconditionally `cur = opts; renderBody(opts)` — renderBody (179-189) draws a lone 'Got it' button for non-sequence tips. Tour step 'tour.blocks' (app.js:2056-2066) runs demoBlockClicks un-awaited; each clickBlock calls renderDetail('A'); renderDetail('B') (1999-2000), so ~770 ms into step 4 the '4 of 9' callout with Next/Back/Skip is replaced. The sequence closure is orphaned: done() never runs, seq.first-run-v1 is never marked (tips.js:236-239), onDone→exitTourDemo (app.js:2106) never fires — the sample switcher stays with Copy/Blend/Undo disabled (updateActionUI 865-877) and the broken tour auto-runs again on every reload (2571-2573). Deterministic on every genuine first run; this is the primary mechanism behind the reported 'sample switcher not working' bug.
- **Fix:** Guard renderCardHint with `if (tourDemo) return`, and make tips.js show() refuse to replace an active sequence step: `if (cur?.seqCtl && !opts.seqCtl) return`.

### APP-02 · MAJOR · `public/app.js:145`

**Two-switcher connect during the tour drops the sample marking but leaves the OTHER column's fake channels live and copyable to a real switcher**

- **Evidence:** Reproduced: dropSample (145-151) only clears tourDemo, the .sample/.sample-on classes, the ghost and the tip — its 'real channels are about to be written over the top' assumption holds only for connectSingle, which rewrites both columns (390-407). The per-side path in connectSide (300-331) rewrites one side after `if (tourDemo) dropSample()` (303). The tour forces this path: enterTourDemo writes 'sample switcher' into both ip inputs (1929), so a real address in B trips `bIp && bIp !== aIp` (285) → state.two = true, persisted by applyMode (371). Afterwards the untouched column keeps ip='sample', the six fake channels and detail; the parked real state is discarded; Copy re-enables (tourDemo null) and payloadRef sends from.ip='sample' (1001-1005), which server requireIp accepts and which hangs 12 s in atem-pool before failing. One correction to the finder claims: the sample device banner (set at 1930) is NOT cleared by dropSample, so the phantom column is not entirely unbadged — but its banner says 'nothing can be written' while Copy is enabled and fails, and two-switcher mode is now persisted off fake text.
- **Fix:** In the per-side connect path call exitTourDemo() (restoring the parked state for the untouched column) instead of dropSample(), and treat the 'sample switcher' text as empty when testing for two-switcher mode.

### APP-03 · MAJOR · `public/app.js:291`

**Two-switcher mode can never be collapsed from the destination column, and it engages/persists before the second connect succeeds**

- **Evidence:** Reproduced: the collapse test exists only in the `side === 'A' && state.two` branch (291-298). With state.two already true, pressing Go on B with B's address equal to A's skips both branches (282 is false because state.two is true) and falls into the per-side connect — state.two stays true and persisted (applyMode 371). This contradicts both the function's own comment (279-281, 'pointing it back at the source's address turns it off') and the Help text (2194). Also confirmed: state.two = true + applyMode (286-287) and the `${LS}.ip.B` write (304) all happen before the await at 308, and the catch never reverts, so a typo'd B address flips the app into persistent two-switcher mode; and refreshAfterWrite (425-428) skips side A when state.two, so same-box copies stop refreshing the source column while stuck in this state.
- **Fix:** Mirror the collapse in the B path: when state.two && bIp === aIp, set state.two = false, applyMode(), return connectSingle(); only commit state.two/LS after the B connect succeeds.

### APP-04 · MAJOR · `public/app.js:383`

**Connecting mid-tour (which step 1 explicitly invites) kills the tour without marking it seen, so the auto-tour and sample switcher replay on every subsequent app start**

- **Evidence:** The tour's first step (app.js:2034-2040, 'Start with the switcher's address') tells the user: 'Type it here… press Connect'. Doing exactly that runs connectSingle → app.js:383 `if (tourDemo) dropSample()` (same at app.js:303 for connectSide). dropSample (app.js:145-151) calls `Tips.hide()`, and tips.js:210-213 `hide()` sets `cur = null` and removes the layer WITHOUT calling `markSeen`. The only paths that mark `seq.first-run-v1` seen are tips.js:236-239 `done()` — reached solely via the last step's Next or via Skip (tips.js:266). So an interrupted tour leaves the flag unset, and app.js:2571-2573's load handler (`if (!state.A.channels?.length) setTimeout(() => startTour(), 500)`) re-runs the whole tour, sample switcher and all, at the next launch — the check at app.js:2028 passes because the flag was never written.
- **User sees:** First run: tour starts, step 1 says to type the switcher's address. The user does, presses Go, connects, and works normally — tour UI silently vanishes. Next time they open the app (channels are always empty at load; there is no autoconnect), the tour auto-runs again 500ms in, replacing both columns with the sample switcher and overwriting the address box with 'sample switcher'. This loops on every launch until the user ignores the tour's own instruction and instead clicks through all 9 steps or finds Skip.
- **Fix:** In dropSample()/exitTourDemo, mark the sequence seen when the running tour is torn down by a real connect — e.g. call Tips.dismiss('seq.first-run-v1') from dropSample; or give tips.js a sequence-abort API that marks the seq flag.
- **Note:** found by the completeness critic (post-verification); re-verify the trace before fixing.

### APP-05 · MAJOR · `public/app.js:388`

**Connect in flight when the auto-tour timer fires leaves the sample switcher permanently latched over a real connection**

- **Evidence:** Reproduced: connectSingle checks `if (tourDemo) dropSample()` at 383, before `await api(...)` at 388 (connectSide identically: 303 vs 308); neither the success path (390-408) nor the error path (410-421) re-checks tourDemo. The load listener (2571-2573) starts the tour 500 ms after every load while the seq flag is unseen and channels are empty — always true mid-connect — and enterTourDemo (1904-1936) parks the empty pre-connect state and marks both panels .sample. A connect resolving afterwards writes real channels while tourDemo stays set: updateActionUI (865-877) keeps Copy/Blend/Undo disabled with the sample tooltip, and pressing Done runs exitTourDemo (1938-1951), which Object.assigns the parked EMPTY state back, wiping the live connection. Reachable via prefilled IP + Enter (1566-1571), recent-IP chips (2140-2145) and ipdrop rows (1543-1548). Downgraded from critical: needs a connect started inside the first 500 ms AND the tour never completed — though the coach-mark stomp bug keeps the seq flag unseen for everyone, which widens this window considerably.
- **Fix:** Re-check tourDemo (dropSample) after the await in connectSingle and connectSide, and cancel/skip the pending auto-tour while a connect is in flight.

### APP-06 · MAJOR · `public/app.js:745`

**Clicking a sample-switcher channel during the tour issues a real /api/channel request to ip='sample', blanking the detail card**

- **Evidence:** Reproduced: selectChannel (704-737) has no tourDemo guard; loadDetail (740-757) fetches `/api/channel?ip=${s.ip}` with s.ip='sample' (set by enterTourDemo at 1922). The fake bodies map is a local variable (1916-1917) never consulted after setup. demo.js is inert in the real app (demo.js:12-15 returns early on 127.0.0.1/localhost without ?demo). server.js requireIp accepts 'sample' (IP_RE = /^[a-zA-Z0-9.\-]+$/, server.js:36) and lib/atem-pool.js CONNECT_TIMEOUT_MS = 12000 means the request hangs 12 s before failing; loadDetail's catch then sets s.detail = null (748) and renders the empty-card prompt. The tour step explicitly invites this click. Downgraded from critical only because the tour is already dead by step 4 via the coach-mark stomp; the interaction failure itself is deterministic.
- **Fix:** Store the tour bodies on tourDemo and have loadDetail short-circuit to them (`if (tourDemo) { s.detail = clone(tourDemo.bodies[key]); renderDetail(side); updateActionUI(); return }`).

### APP-07 · MAJOR · `public/app.js:821`

**Toggling a section block (or changing the source channel) rebuilds the save form and silently discards everything the user typed**

- **Evidence:** Reproduced: the block-click delegate (1647-1661) calls renderDetail('B') on every section toggle; with the library on B that goes straight to renderSaveCard (783), which rebuilds #np-name/#np-group/#np-mic/#np-style/#np-notes/#np-sample via innerHTML from stored values only (823-835), never from the live DOM. loadDetail also re-renders the form on every source-channel click (753: `if (side === 'A' && isLib('B')) renderDetail('B')`). savePresetFlow reads the DOM at save time (1355-1367), so typed names, mic, style and notes are genuinely lost. The savenote's own copy ('ticked sections … become its defaults', 837-841) invites toggling sections after filling the form, making this the designed flow.
- **Fix:** Read the existing #np-* values before rebuilding and prefer them over stored defaults, or update only the savenote/preview on section toggles.

### APP-08 · MAJOR · `public/app.js:1039`

**askBar leaks its document keydown listener when superseded, so a later Enter keypress silently re-runs an unconfirmed copy; Copy is also not disabled during the confirm phase, allowing double-fire**

- **Evidence:** Reproduced: #apply is only disabled inside performCopy (1052), so two clicks during the /api/preview await (1034) start two apply() invocations. askBar (111-136) overwrites bar.innerHTML (125), destroying invocation #1's buttons, but #1's document keydown listener (134) is removed only in its own done() (117), and its onKey resolves true on ANY Enter with no target filtering (122). apply() then proceeds straight to performCopy (1044-1045) with the stale src/to — an unconfirmed write. With Enter on the stacked bars, both onKey handlers fire and both copies run concurrently; server-side each /api/apply overwrites lastBackup for that ip (server.js:203), so Undo restores only the intermediate state. Additional confirmed wrinkle: the stale done() also hides and clears the bar (114-116), so a stray Enter destroys any dialog currently showing. Downgraded from critical: requires a double-click (or two clicks) during the preview round-trip followed by a later Enter — real but not an everyday path.
- **Fix:** Disable #apply for the whole of apply() (or bail if a confirm is pending), and make askBar cancel any prior instance — resolve(false) and remove its keydown listener — before rendering a new one.

### APP-09 · MAJOR · `public/app.js:1107`

**A transient failure of the post-copy refresh is misreported as 'The copy did not run' — an error modal that directly contradicts the success toast already on screen (same pattern in blend and undo)**

- **Evidence:** performCopy's try block ends with app.js:1107 `await refreshAfterWrite()` — AFTER the copy has succeeded, been logged, and announced via the success toast at app.js:1102 (`showOutcome('ok', 'Copied … read back and verified' …)`). refreshAfterWrite → refreshSide (app.js:1411-1426) does `await api(...)` with no error handling, so any transient failure of the follow-up GET /api/switcher propagates into performCopy's catch (app.js:1108-1112), which does `setStatus('')` and `showError('The copy did not run', e.message)` — a blocking modal asserting the opposite of what happened. Identical wiring in applyBlend: app.js:1340 refresh inside try → app.js:1344 `showError('The blend did not run', …)`; and in undo: app.js:1448 → app.js:1451 `showError('Could not undo', …)`.
- **User sees:** User copies a mic chain onto three cameras. The write and read-back verify; the green 'Copied to 3 channels — read back and verified' toast appears. A moment later the refresh read fails transiently — e.g. someone opens ATEM Software Control and takes one of the ATEM's few control connections (the app's own error copy names this as the most common failure) — and a modal pops up: 'The copy did not run: connection refused'. In an app whose whole pitch is measured, trustworthy read-back, the operator now has two directly contradictory verdicts and no way to tell which is true; if they re-run the copy, 'Undo' now restores to the already-copied state, so the original settings are unrecoverable. For undo, a refresh hiccup shows 'Could not undo' after the restore in fact succeeded, inviting a second undo that fails with 'No backup recorded'.
- **Fix:** Move `await refreshAfterWrite()` out of the try (or wrap it in its own try/catch) in performCopy, applyBlend and undo, reporting a refresh failure honestly, e.g. a warn toast 'Copied and verified, but re-reading the switcher failed — press Go to refresh the lists'.
- **Note:** found by the completeness critic (post-verification); re-verify the trace before fixing.

### APP-10 · MAJOR · `public/app.js:1688`

**Keyboard users can never multi-select destination channels: the keydown handler re-dispatches a modifier-less synthetic click, so Enter/Space always collapses the selection to one — despite aria-multiselectable="true"**

- **Evidence:** The listbox keyboard handler (app.js:1665-1691) handles Enter/Space on a `.chan` row with app.js:1688 `row.click()`. `HTMLElement.click()` dispatches a MouseEvent with metaKey/ctrlKey/shiftKey all false, so selectChannel's multi-select branches — app.js:708 `if (s.multi && (event?.metaKey || event?.ctrlKey))` and app.js:712 `else if (s.multi && event?.shiftKey && s.anchor)` — can never be taken from the keyboard; execution always falls to app.js:719-721 `s.selection = [key]`. The arrow-key branch (app.js:1678-1685) moves focus only and offers no shift-extend or ctrl+space toggle. Yet index.html:90 declares the destination list `aria-multiselectable="true"`, and the redesign commit message claims 'keyboard operation'. Real modifier keydowns held during Enter are not forwarded — the synthesized click discards them.
- **User sees:** A keyboard-only (or screen-reader) user connects, tabs into the destination list, and tries to select Camera 1, 2 and 3 to paste one mic chain onto all of them — the app's headline flow. Every Enter/Space replaces the selection with the single focused row; 'Copy → N channels' is unreachable without a mouse. Worse: a mouse user who ⌘-clicked three channels and then presses Space on a row (e.g. after tabbing back in) silently destroys the multi-selection down to one, and the copy lands on a single channel.
- **Fix:** In the keydown handler, call selectChannel(side, key, e) directly with the real KeyboardEvent (its metaKey/ctrlKey/shiftKey pass the existing checks), or implement standard listbox keys: Shift+Arrow extends, Ctrl/Cmd+Space toggles.
- **Note:** found by the completeness critic (post-verification); re-verify the trace before fixing.

### APP-11 · MAJOR · `public/app.js:1944`

**exitTourDemo crashes (deviceLine on null device) when a parked side has an ip but no device, leaving the sample switcher stuck**

- **Evidence:** Reproduced: connectSide sets s.ip before the try (301) and its catch (322-331) never touches s.device, so a first-ever failed two-mode connect parks {ip: set, device: null}. exitTourDemo (1938-1951) restores it and line 1944 calls deviceLine(state[side].device); deviceLine (335-340) dereferences device.model → TypeError on null. The throw escapes mid-loop before `tourDemo = null` (1949) and updateActionUI (1950), and propagates out of the sequence's done() (tips.js:236-239 — note hide() and markSeen run first, so the tip layer closes but the sample state and disabled buttons stay). connectSingle's failure path is safe (it never sets s.ip on failure), so the trigger genuinely requires two-switcher mode with a never-connected side plus a run of the tour ended by Skip or Done.
- **Fix:** `state[side].ip && state[side].device ? deviceLine(state[side].device) : (state[side].ip ? '<span class="err">●</span> Not connected' : '')`, and/or make deviceLine null-safe and wrap the restore loop so tourDemo is always cleared.

### APP-12 · MAJOR · `public/app.js:2030`

**Auto-tour with column A left on 'Presets' loads the sample switcher invisibly and dead-locks the header buttons**

- **Evidence:** Reproduced: kind persists via localStorage (57-58); a lib column's channels stay empty, so the load timer (2571-2573) fires startTour → wasEmpty true → enterTourDemo (2030), which never resets kind; renderList (432-434) routes the lib side to renderLibrary, so the sample channels are never rendered there. Verified in style.css 2979-2985: `#panel-A.lib .conn, #panel-A.lib .device { display: none }` — tour step 1's target '#panel-A .conn' (2036) is display:none, tips.js visible() (68-73) returns false and place() (79-82) removes the layer's 'on' class, so no callout and no reachable Skip — while updateActionUI's tourDemo branch (865-877) has already disabled Copy/Blend/Undo/Redo and the A ip box now reads 'sample switcher' (1929). With only B on Presets, renderDetail('B') shows the save form (783) under sample-switcher narration instead.
- **Fix:** Park each side's kind in tourDemo and force both columns to 'atem' for the tour (restore in exitTourDemo); make tips.js render a centered callout when a step's target is invisible so Skip is always reachable.

### APP-13 · MINOR · `public/app.js:12`

**Diff table labels EQ shape 4 as 'Band pass' — it is a Bell/peaking filter**

- **Evidence:** Reproduced: app.js:12 SHAPE[4] = 'Band pass', used by fmtField for shape paths in the preview/read-back diff (256); strip.js — the declared ground truth — names the same id 'Bell' (SHAPE_NAME at strip.js:15, SHAPE_ABBR at 16). The diff table and the card beside it disagree about the same setting.
- **Fix:** Change SHAPE[4] to 'Bell' in app.js.

### APP-14 · MINOR · `public/app.js:360`

**applyMode clobbers a destination address the user is still typing whenever it runs in single-switcher mode**

- **Evidence:** Reproduced: line 360 mirrors A's ip into B's input on every applyMode call while !state.two, and applyMode runs from setKind (468) — so a kind-toggle click while a not-yet-connected second address sits in B's box silently replaces it (two-switcher mode only engages when B's Go is pressed, 282-288). No error explains why a subsequent Go connects to the same box.
- **Fix:** Mirror only on the two→one transition, or skip when B's input has focus / differs from the last synced value.

### APP-15 · MINOR · `public/app.js:367`

**Hardcoded ⌘ in two user-facing strings ignores the MOD platform variable — Windows/Linux users are told to ⌘-click**

- **Evidence:** Reproduced: applyMode sets the Destination title tooltip with a literal ⌘ in both branches (366-368), and destinations() throws 'Pick one or more destination channels (⌘-click or shift-click for several)' (985), which reaches the log via apply()'s catch (1021-1024). MOD exists precisely for this (27-29) and is used elsewhere (e.g. 1795, 1827, 2053).
- **Fix:** Interpolate ${MOD} in both strings.

### APP-16 · MINOR · `public/app.js:395`

**connectSingle wipes the library column's selection/detail before its isLib guard, disabling Copy while a preset card is still displayed**

- **Evidence:** Reproduced: the success loop clears s.detail for BOTH sides (394-398) before `if (isLib(side)) { s.channels = []; continue }` (401-405), and the continue skips renderSideAll, so the stale preset card stays on screen while sourceChannel() (76) is now null — updateActionUI (887-889) disables Copy with 'Pick a preset on the left to copy from'. state.library.selectedFile is untouched, so the row stays highlighted. Downgraded from major: recovery is a single click on the already-selected preset (selectPreset re-sets state.A.detail from cache, 639-650), and the claimed updateSummary contradiction is moot because #summary does not exist in index.html (separate finding) — the failure is a confusing dead Copy button, not data loss.
- **Fix:** Move the isLib check above the per-side state resets, or re-run selectPreset for the library side after connect.

### APP-17 · MINOR · `public/app.js:669`

**Roving tabindex breaks when the last-selected channel is a hidden MADI strip: the whole listbox drops out of the tab order**

- **Evidence:** Reproduced: focusKey = s.selection[last] ?? visible[0]?.key (669) is not filtered against `visible` (667), and the toggle-minor button (694-697) flips showMinor without touching selection — so a selected-but-hidden minor key makes every rendered row tabIndex -1 (676). index.html's channel-list tabindex="0" (58/90) doesn't rescue it: the keydown handler requires e.target.closest('.chan') (1673-1675), so with focus on the container arrows and Enter do nothing. A mouse click recovers (re-render with visible selection).
- **Fix:** Fall back to the last selected key that is actually visible: `[...s.selection].reverse().find((k) => visible.some((c) => c.key === k)) ?? visible[0]?.key`.

### APP-18 · MINOR · `public/app.js:745`

**loadDetail has no request-ordering guard: a slow earlier read overwrites the detail for the currently selected channel**

- **Evidence:** Reproduced structurally: loadDetail (740-757) assigns s.detail unconditionally on resolve with no sequence token, abort, or selection re-check, and two quick clicks (or Enter presses, 1686-1690) start overlapping fetches. The consequence split is real: state.A.detail feeds Blend (1281, 1197) and Save preset (1353), while a plain Copy uses the selection (1002-1005) — a lost race makes blend/save operate on a different channel than the highlight and Copy. Downgraded from major: both requests hit the same local server (and the wrong card is visibly rendered, giving the user a cue), so out-of-order completion is possible (browsers use parallel connections) but uncommon; the write itself is still verified against what was actually sent.
- **Fix:** Stamp loadDetail calls with a per-side sequence number (or compare key against s.selection after the await) and discard stale responses; same in refreshSide's trailing loadDetail (1423-1424).

### APP-19 · MINOR · `public/app.js:839`

**'Saves a new preset.' — but a new save whose name collides with an existing preset silently replaces that file**

- **Evidence:** Reproduced client and server: the client confirms only when overFile is set (1371-1379); server POST /api/presets with no overwrite derives `file = overwrite ?? fileNameFor(name)` and fs.writeFile replaces any existing file (server.js:366-371; backupPreset stashes silently). Also confirmed: safeName strips characters like apostrophes (server.js:268-272), so the success toast (1399) can name a preset stored under a different name. Contrast /api/presets/import, which auto-suffixes on collision (server.js:471-473) — the interactive path has no such protection.
- **Fix:** Detect the collision client-side (or via the server response) and confirm or auto-suffix; echo the sanitised name in the toast.

### APP-20 · MINOR · `public/app.js:937`

**updateSummary writes to #summary, which no longer exists — the 'what is about to go where' status line is dead code after the redesign**

- **Evidence:** Reproduced: updateSummary bails on `if (!box) return` (936-938) and index.html's footer (110-118) contains only #status and .madeby — no #summary anywhere in the document. updateSummary is called from ~10 sites (selection 728, block toggles 1657, applyMode 373, loadPresets 1472, the ghost demo 2001/2015 whose comment claims 'the status bar names what travels'), all silently no-oping. The promised source→destination·sections readout never appears anywhere in the app.
- **Fix:** Restore `<div class="summary" id="summary"></div>` to the status bar, or delete updateSummary and its call sites.

### APP-21 · MINOR · `public/app.js:1300`

**Blend failure path leaves the blend bar open with its 'Apply blend' button disabled — the finally block re-enables the wrong button**

- **Evidence:** Reproduced: applyBlend disables `$('.blendgo')` (1300); the catch (1341-1344) shows the error modal without closeBlend()/renderBlendBar(), and the finally (1345-1348) re-enables only #apply. Nothing else touches the button (slider input at 1267-1271 only re-renders the card). Verified the `$('.blendgo')` global selector safely hits the blend bar's button (the confirm bar is hidden and emptied when closed). Downgraded from major: recovery is toggling Blend off and on (renderBlendBar rebuilds the button), though nothing hints at that.
- **Fix:** In catch/finally re-enable the bar's own button — `const go = $('#blendbar .blendgo'); if (go) go.disabled = false` — or call closeBlend().

### APP-22 · MINOR · `public/app.js:1304`

**Blend loops one /api/apply per destination, so Undo after a multi-destination blend restores only the last channel (server keeps only the last call's backup batch)**

- **Evidence:** Reproduced end to end: applyBlend issues one /api/apply per destination (1304-1309) and never checks to.length; server.js ends each apply with `lastBackup.set(targets[0].ip, batch)` (203) and /api/undo restores only that batch then deletes it (233-252). The one-at-a-time guard is genuinely advisory: updateActionUI's closeBlend on dests>1 (904-913) runs only at the end of loadDetail's awaited fetch (selectChannel 732 → loadDetail 756), so between the ⌘-click and the response the bar is open and 'Apply blend' clickable with to.length === 2. The progress modal's 'Undo restores the whole batch' claim (2434) is then false. Kept minor: the window is typically sub-second against a local server.
- **Fix:** Guard applyBlend explicitly (`if (to.length > 1) return setStatus(...)`) or batch the blend into one request.

### APP-23 · MINOR · `public/app.js:1604`

**Snapshot download is unreachable: the #snapshot-A/#snapshot-B buttons were removed from index.html and snapshot() has no other caller**

- **Evidence:** Reproduced: index.html contains no #snapshot-A/#snapshot-B; the optional-chained bindings (1604-1605) silently no-op; snapshot() (1512-1518) has no other call site; applyMode still relabels the missing button (369-370); restoreSnapshot stays reachable only via importing a snapshot file (1610-1611) that the app can no longer produce.
- **Fix:** Restore the snapshot buttons, or remove snapshot(), the dead bindings and the applyMode relabel.

### APP-24 · MINOR · `public/app.js:1609`

**importFile has no error handling — a malformed pack file fails silently**

- **Evidence:** Reproduced: `JSON.parse(await file.text())` (1609) throws on bad JSON and the awaited api() calls can reject; importFile is wired directly as onchange (565, 1643, 2339) with no try/catch, so the rejection is unhandled and no setStatus/log runs; `e.target.value = ''` (1631) is unreached on throw, so re-picking the same file will not re-fire change.
- **Fix:** Wrap importFile's body in try/catch, surface e.message, and reset the input value in finally.

### APP-25 · MINOR · `public/app.js:1762`

**renderRecent maintains a #recent-ips datalist that no input references, and the input[data-sec] change delegate matches nothing**

- **Evidence:** Reproduced both halves: index.html's ip inputs (51, 83) carry no list="recent-ips" while the datalist (100) is populated by renderRecent (1762-1768) and refreshed by rememberIp — dead plumbing, so typed-prefix address suggestions never appear (only the ▾ menu works). And strip.js renders every section block as `<div class="…block" data-sec=… role="checkbox">` (357-435) with no `<input data-sec>` anywhere in the codebase, so the change delegate at app.js:1592-1598 never fires; the click delegate at 1647 is the live path.
- **Fix:** Add list="recent-ips" to both .ip inputs (or delete the datalist and its upkeep); delete the input[data-sec] change delegate.

### APP-26 · MINOR · `public/app.js:1928`

**Backing up from tour step 4+ replays demoBlockClicks on top of a sample card the ghost already mutated, and Back to step 1 while connected mid-tour re-runs before() hooks against real state — before() hooks are re-entrant but not idempotent-guarded against the running ghost**

- **Evidence:** tips.js:257-259 `onBack: () => { i = Math.max(0, i - 1); showStep() }` re-runs `step.before()` every time a step is re-entered (tips.js:246-250). Step 'tour.blocks' (app.js:2061-2065) fires `demoBlockClicks()` un-awaited on every entry. demoBlockClicks (app.js:1978-2017) captures `const before = { ...state.sections }` at entry (app.js:2005); the ghostRun bump (app.js:1979) cancels the previous run *after its next await*, but the cancelled run exits via `return removeGhost()` (app.js:2008-2009) without restoring `before`, while the new run has already captured the half-toggled sections as ITS `before`. Navigating Next past 'tour.blocks' then Back into it repeatedly therefore snapshots whatever mid-script section state the previous cancelled run left (e.g. eq flipped off after the first of its two eq toggles) and 'restores' that corrupted state as final.
- **User sees:** During the tour a curious user clicks Back from step 5 to step 4 to re-watch the ghost demo (the step text says 'Watch, then try it yourself'). The first run is cancelled mid-script with EQ toggled off; the second run captures {eq:false, dynamics:true} as its baseline and, on completion, 'restores' exactly that. The user finishes the tour, connects their real switcher, and every subsequent copy silently excludes EQ — the section object survives the tour (exitTourDemo restores columns, not state.sections). This extends the reported 2008 finding (interrupt skips restore) to the Back-navigation path, where the corruption is captured and made permanent by a run that完成 normally.
- **Fix:** Keep one module-level saved-sections snapshot for the ghost demo (set on first entry, cleared on restore), and have demoBlockClicks restore from it in every exit path — including cancellation — instead of a per-invocation `before` copy.
- **Note:** found by the completeness critic (post-verification); re-verify the trace before fixing.

### APP-27 · MINOR · `public/app.js:2008`

**Interrupting the ghost block demo skips the state.sections restore — EQ/Dynamics silently excluded from every future copy**

- **Evidence:** Reproduced: demoBlockClicks snapshots `before` (2005) and restores only after the full script (2011-2012); every abort path (2008-2009 `return removeGhost()`, and the run-counter check at 2011) exits without restoring, and removeGhost is triggered by Skip/Done (exitTourDemo 1939), the 'tour.yourturn' before (2101) and dropSample (149). The perturbed windows are ~1.5 s after toggles 1 and 3 (eq or dynamics left false). Downgraded from major on two verified grounds: (1) on the common broken first run the coach-mark stomp removes the Skip button just as the first toggle lands, so the script runs to completion and restores correctly — the leak needs a forced/replayed tour with the hint keys already seen; (2) the leftover state is visible (the block loses its green edge and the confirm bar lists the sections), so it is not fully silent.
- **Fix:** Restore `before` in a finally on every exit path (guarded by the run counter), or have removeGhost trigger the restore.

### APP-28 · MINOR · `public/app.js:2046`

**Tour and first-run copy say 'press Connect' but the button is labelled 'Go'**

- **Evidence:** Reproduced: index.html 54/86 label the button 'Go'; 'press Connect' appears in tour.both (2046), tour.yourturn (2100), renderFirstRun B (2127) and A (2134), and the reconnect guide (1817), while Help correctly says 'press Go' (2191, 2194) — inconsistent within the same app.
- **Fix:** Relabel the button 'Connect' or change the five strings to 'Go'.

### APP-29 · MINOR · `public/app.js:2050`

**Tour step 'tour.pick' spotlights the SOURCE list while teaching ⌘/shift multi-select, which only works on the destination side (confirmed known bug)**

- **Evidence:** Reproduced: the step (2048-2054) targets '#panel-A .channel-list' while its text teaches ⌘/shift multi-select; A is single-select (`multi: false`, app.js:57, re-asserted at 462 and 1577) — multi-select exists only on B (58). Matches the audit brief's pre-confirmed known bug.
- **Fix:** Split the multi-select sentence into a step targeting '#panel-B .channel-list', or trim the step to source-picking.

### APP-30 · MINOR · `public/app.js:2100`

**Final tour step says 'That was a sample switcher — it disappears when you press Done' even when the tour ran on the user's real switcher**

- **Evidence:** Reproduced: startTour only enters the sample when channels are empty (2029-2030: wasEmpty gate), but the tour.yourturn text (2100) is static. Help's 'Show me how it works' (2261-2264) forces the tour while connected, so a connected user is told their real channel list was fake and will vanish.
- **Fix:** Capture wasEmpty and branch the closing text on whether enterTourDemo ran.

### APP-31 · MINOR · `public/app.js:2214`

**Help text points at a menu that doesn't exist: 'Presets → Reveal preset folder' vs actual Electron menu Help → 'Show presets folder'**

- **Evidence:** Reproduced: app.js:2214 says 'Presets → Reveal preset folder'; electron/main.js builds appMenu/fileMenu/editMenu/View/windowMenu/help only (63-78), with the item under role:'help' labelled 'Show presets folder' (78). No Presets menu exists.
- **Fix:** Change the help copy to 'Help → Show presets folder' (or rename the menu item).

### APP-32 · MINOR · `public/app.js:2323`

**renderConnectError markup doesn't match the stylesheet: li items lack .gcause/.gwhat/.gfix and .gacts has no CSS (known, confirmed)**

- **Evidence:** Reproduced: app.js 2319-2325 emits `<li><b>…</b><span>…</span>` inside ol.gcauses and `<div class="gacts">`; style.css defines .gcause (3222, flex row + separators), .gdot (3231, sized for the flex cause row), .gwhat/.gfix (3239/3245, display:block) and .gfail (3273) — none emitted — while .gacts has zero rules (grep confirms; .gactions at 851/3175 exists and renderFirstRun uses it correctly at 2136, supporting the typo reading). The emitted .gdot sits inside the block-level ghead where its flex sizing does not apply. Downgraded from major: the diagnosis content is all present and readable, just visually degraded (run-together cause/fix text, unstyled action row) at the error moment.
- **Fix:** Emit `<li class="gcause"><span class="gdot"></span><span><b class="gwhat">…</b><span class="gfix">…</span></span></li>` and use .gactions (or .gfail) for the action row.

### APP-33 · MINOR · `public/app.js:2351`

**renderLibraryGuide's .gsteps list has no CSS: double numbering and run-together step text (known, confirmed)**

- **Evidence:** Reproduced: app.js 2351-2355 emits ol.gsteps with `<i>n</i><b>…</b><span>…</span>` per li; grep of style.css finds zero .gsteps rules, so UA list markers render alongside the literal italic digits and the inline b/span run together. Downgraded from major: onboarding text is degraded but fully readable.
- **Fix:** Add .gsteps CSS (list-style:none; li i as a number badge; b/span as blocks) mirroring .gcause, or drop the <i>n</i> markers.

### APP-34 · POLISH · `public/app.js:693`

**Minor-strip toggle pluralises unconditionally ('Show 1 MADI strips') and the recent-IPs datalist is orphaned**

- **Evidence:** The plural half is reproduced: line 693 interpolates `${hidden} MADI strips` with no singular form, unlike other counts in the file. The datalist half duplicates the app-core finding 'renderRecent maintains a #recent-ips datalist that no input references…' and is verified there.
- **Fix:** Conditional plural on hidden === 1; datalist fix per the merged finding.

### APP-35 · POLISH · `public/app.js:700`

**role=listbox lists get non-option children (MADI toggle button, group headers, empty-state block), breaking the declared listbox semantics**

- **Evidence:** Reproduced: renderChannels appends the toggle-minor <button> into the role=listbox container (list.append(btn), 691-700); renderLibrary appends .grouphead divs (486-499) and renderLibraryEmpty a .libempty div with a file input (2332-2342) into the same listbox; index.html hard-codes aria-multiselectable="true" on B (90) even when it holds single-select preset rows; preset rows all get tabIndex 0 (507), defeating the roving-tabindex pattern renderChannels uses (676).
- **Fix:** Move non-option children outside the listbox element, toggle aria-multiselectable with s.multi, and rove tabindex on preset rows.

### APP-36 · POLISH · `public/app.js:1430`

**Undo clicked with no destination connected appears to do nothing — the error goes only to the hidden log drawer**

- **Evidence:** Reproduced: updateActionUI enables Undo unconditionally outside the tour (878) even with state.B.ip empty; undo() bails with log(...) only (1430); log prepends into #log inside #logbox, which ships hidden (index.html:105) and is only revealed by showResult(), never called here. No toast, status or modal.
- **Fix:** Route through setStatus(msg, 'err') or disable Undo when !state.B.ip.

### APP-37 · POLISH · `public/app.js:1592`

**Single tip slot + unconditional per-side hints: every A+B re-render flips the visible tip from 'blocks' to 'multi' before it can be read**

- **Evidence:** Reproduced: the block-click delegate (1647-1661, and the dead-but-parallel change delegate at 1592) runs renderDetail('A') then renderDetail('B'); each ends in renderCardHint (804), so with a source detail showing and <2 destinations selected, Tips.show('blocks') is immediately replaced by Tips.show('multi') (tips.js keeps one cur, 197) — the blocks tip vanishes the instant the user performs the action it teaches, and replacement never marks it seen. Downgraded to polish: the tip is readable up to that first block click and nothing functional is lost.
- **Fix:** Let renderCardHint show at most one pending hint (skip B's while 'blocks' is unseen and a source detail shows), or queue in tips.js instead of replacing.

### APP-38 · POLISH · `public/app.js:1799`

**'kinds' hint is gated on the WRONG key (!Tips.isSeen('blocks')): dismissing the blocks tip permanently suppresses the never-seen kinds tip**

- **Evidence:** Reproduced: the gate at 1799 references the other tip's seen flag; Tips.show already no-ops on its own seen key (tips.js:195), so the extra condition can only wrongly suppress. The block comment above (1772-1776) says each of the three hints is 'gone for good once dismissed' — i.e. its own dismissal — which the cross-key gate contradicts: once 'blocks' is dismissed, the never-shown 'kinds' hint can never appear. Downgraded to polish: the only loss is one onboarding hint, and an intentional 'stop hinting experienced users' reading is at least arguable.
- **Fix:** Drop the !Tips.isSeen('blocks') condition (or invert it if the intent was 'after blocks').

### APP-39 · POLISH · `public/app.js:2086`

**Tour step 'Presets other people made' tells users to save presets via the Community presets button, which only browses/shares**

- **Evidence:** Reproduced: tour.library targets #browse-open and says 'Save your own here too' (2083-2087), but saving happens via the column kind toggle and renderSaveCard (783, 813); browse.js's own publish empty-state says 'Sharing starts from your own library: dial a channel in, flip a column to Presets, and save it' (browse.js:512-514) — the tour sends users to a place that redirects them back.
- **Fix:** Reword to point the save half of the sentence at the column toggle.

### APP-40 · POLISH · `public/app.js:2242`

**Help footer 'Join the community' uses .footbtn.loop outside .madeby, so its pill styling and yellow accent never apply**

- **Evidence:** Reproduced: toggleHelp emits `<a class="footbtn loop">` inside .helpend-acts (2242); style.css scopes the pill background/border/colour to .madeby (.madeby button, .madeby .footbtn at 1200-1210; .madeby .loop at 1211-1219), while .helpend-acts .footbtn (1033-1039) supplies only font-size/padding/radius/text-decoration — no background, border or colour — so the anchor renders as padded link text beside the fully styled 'Say thanks' pill.
- **Fix:** Extend the rules to `.helpend-acts .footbtn` / `.helpend-acts .loop`, or unscope the base pill styles.

### APP-41 · POLISH · `public/app.js:2510`

**Toast stack eviction silently discards sticky error/Undo toasts once more than four are showing**

- **Evidence:** Reproduced: notify prepends then trims blindly (`while (stack.children.length > 4) stack.lastElementChild.remove()`, 2509-2510) with no regard for kind; err toasts are deliberately sticky (TOAST_LIFE.err = 0, 2456) and undo-bearing toasts never expire (2513), yet either can be evicted unread by four quick successes.
- **Fix:** Skip sticky (err or undo) toasts when trimming; evict the oldest auto-dismissing toast first.


## tips.js (2)

### TIPS-01 · MAJOR · `public/tips.js:79`

**A sequence step whose target is off-screen hides the ENTIRE tour UI — including Next/Skip — with no scroll-into-view, stranding the user**

- **Evidence:** tips.js:78-82: place() does `layer.classList.remove('on'); return` when visible(targetEl) fails, and visible() (68-72) demands viewport intersection. style.css:3285-3297 makes .tiplayer without .on `opacity:0; visibility:hidden`, and the callout carrying Skip/Back/Next (tips.js:154-178) is inside that same layer (tips.js:51) — so every tour control vanishes. No scrollIntoView/scrollTo exists in any public/*.js (only an unrelated box.scrollTop=0 at app.js:2271). style.css:1841-1849 stacks the columns with a scrolling body at ≤1100px; index.html places #panel-B (line 69) after all of panel A, so step 2 'tour.both' → '#panel-B .list-col' (app.js:2043) and 'tour.startup' → '#panel-B .card-col' (app.js:2090) sit below the fold. The capture-phase scroll listener (tips.js:55) re-runs place() if the user happens to scroll panel B into view, so recovery is possible but uncued — the first-run tour simply appears dead after one Next click. Major is fair, not oversold: silent death of onboarding, mitigated only by accidental scrolling.
- **Fix:** In place(), when targetEl is connected but fails the viewport test, call targetEl.scrollIntoView({block:'center'}) and re-measure instead of hiding; reserve the hide path for a truly absent/zero-size target, and for sequence steps keep the callout (navigation) visible even then.

### TIPS-02 · POLISH · `public/tips.js:56`

**Tip layer's own attribute writes re-trigger its MutationObserver: perpetual rAF/place loop with forced reflows whenever a tip is visible**

- **Evidence:** tips.js:56 observes document.body with subtree+attributes, and the tip layer is appended to body (52), so the layer's own writes are in scope. The loop is guaranteed without even relying on same-value setAttribute semantics: every place() pass sets callout.style.left to '-9999px' (93) and then to the final coordinate (132) — two real value changes per pass, each queuing an attribute mutation record (arrow.className at 134 adds more). Records deliver after the rAF callback in which place() ran; raf was reset to null at 63 before place(), so the observer's schedule() (60-66) passes the `!cur || raf` guard and arms the next frame → place() → mutations → repeat, one pass per frame while cur is set, stopping only when hide() nulls cur (211). Each pass forces synchronous layout via getBoundingClientRect (84) and offsetWidth/offsetHeight reads after the -9999px write (96-97). Real but purely a perf/battery drain with no functional failure — polish severity is correct.
- **Fix:** In the MutationObserver callback, filter out mutations whose target is inside dom.layer before calling schedule(), or takeRecords()/disconnect around place()'s writes; alternatively skip the reposition when nothing outside the layer changed.


## server.js (1)

### SRV-01 · CRITICAL · `server.js:245`

**Undo passes stale 'levels' section key, so gain/fader/pan are never restored**

- **Evidence:** server.js:240-246 calls applyChannel with { levels: true, eq: true, dynamics: true, inputConfig: false }, but lib/fairlight.js gates level writes on sections.gain (line 236), sections.volume (line 251), and sections.pan (line 253) — sections.levels is never read anywhere in the repo (server.js:245 is the only 'levels: true' occurrence). Reproduced by executing applyChannel against a mock atem with exactly the undo path's sections object and a payload containing levels {gain:-6, faderGain:-12, balance:-20, framesDelay:2}: the sole CFSP write was {equalizerEnabled, equalizerGain, makeUpGain} — no gain/faderGain/balance/framesDelay — while EQ and dynamics restored. All other applyChannel callers (server.js:196, 571) go through normalizeSections (server.js:117-126) which emits the six real keys; the undo path is the one hand-built old-shape object. No read-back follows the restore (server.js:247), so the toast reports full success while the switcher keeps the copied gain/fader/pan.
- **Fix:** In server.js /api/undo pass { gain: true, volume: true, pan: true, eq: true, dynamics: true, inputConfig: false } (or normalizeSections({gain:1,volume:1,pan:1,eq:1,dynamics:1})), and ideally read back and diff after restore as /api/apply does.


## main.js (1)

### ELEC-01 · CRITICAL · `electron/main.js:90`

**Desktop app serves from a new random port every launch, so localStorage (tour seen-flags, tips, saved IPs, two-switcher mode) is wiped each start — the tour and sample switcher replay on every single launch of the packaged app**

- **Evidence:** electron/main.js:90 `const { url } = await server.start({ port: 0 })` — the OS assigns a fresh port every launch, and main.js:50 `win.loadURL(serverUrl)` points the window at `http://127.0.0.1:<random-port>`. Web storage is partitioned by origin, and origin includes the port, so every launch of the desktop app gets an empty localStorage. Everything the design pass gates on localStorage is therefore reset each start: tips.js:27 `PREFIX = 'atem-audio-presets.tip.'` seen-flags (including `seq.first-run-v1`, checked at app.js:2028 `if (Tips.isSeen('seq.first-run-v1') && !force) return`), and app.js:22 `LS = 'atem-audio-presets'` keys — `\${LS}.ip.A/B` (restored at app.js:1566), `.recent`, `.kind.A/B`, `.two`. The auto-run at app.js:2571-2573 (`window.addEventListener('load', ... setTimeout(() => startTour(), 500)`) fires whenever channels are empty and the seq flag is unseen — which in Electron is every launch.
- **User sees:** A desktop-app user opens ATEM Audio Presets for the fifth time. Their previously saved switcher address is gone from the box, the recent-addresses menu is empty, their Presets-column choice is reset — and 500ms after launch the full first-run tour starts again with the sample switcher hijacking both columns, exactly as if they had never used the app. This repeats on every launch forever, and directly matches the report of the sample switcher appearing when it should not. (Pre-redesign this only cost the remembered IP; the design pass made all onboarding depend on this broken store.)
- **Fix:** Persist state outside origin-scoped storage in Electron (e.g. have the server expose a small settings store on disk, or pin a stable localhost port / use a fixed hostname alias so the origin is stable), or have the Electron main pass a stable port. Minimal fix: try the fixed default port first and fall back to 0 only on EADDRINUSE.
- **Note:** found by the completeness critic (post-verification); re-verify the trace before fixing.


## index.html (4)

### HTML-01 · MAJOR · `public/index.html:21`

**Snapshot download buttons (#snapshot-A/#snapshot-B) were removed — whole-switcher snapshot is unreachable**

- **Evidence:** index.html contains no element with id snapshot-A or snapshot-B and no script creates one. app.js:1604-1605 binds with optional chaining ($('#snapshot-A')?.addEventListener) so the miss is silent; applyMode:369-370 relabels behind `if (snapA)`. snapshot() (app.js:1512-1518) and GET /api/snapshot (server.js:549-556) are therefore dead code. The asymmetry is real: the restore path is alive — importFile branches on format === 'atem-audio-snapshot' (app.js:1610) into restoreSnapshot (1476-1490) hitting POST /api/restore (server.js:557+), renderLibrary/browse filter snapshot files (app.js:480, 600; browse.js:486, 508), and demo.js:389 even stubs /api/snapshot — all expecting files the UI can no longer produce.
- **Fix:** Re-add snapshot buttons with ids #snapshot-A/#snapshot-B (per-panel or a single header control), or intentionally strip snapshot()/the applyMode relabel/the restore advertising.

### HTML-02 · MAJOR · `public/index.html:111`

**The status-bar summary element (#summary) was dropped in the redesign — the 'what goes where' line is silently dead**

- **Evidence:** updateSummary (app.js:936-973) starts `const box = $('#summary'); if (!box) return` and builds the source→destination·sections line plus the empty-state coaching strings ('Pick a channel on the left to copy from.', 'Pick one or more destination channels on the right.') and the amber 'nothing ticked' state. Reproduced call sites: app.js 373 (applyMode), 728, 771 (selection/count), 1472, 1657 (section toggles), 1693, 2001, 2015 (demo block clicks) — every one no-ops. index.html footer (110-118) contains only #status and .madeby; grep across demo.js/tips.js/browse.js finds nothing creating '#summary'. style.css:671-686 still ships the full .summary rule set, evidence the element existed pre-redesign.
- **Fix:** Restore <div class="summary" id="summary"></div> in the footer status bar before #status.

### HTML-03 · MINOR · `public/index.html:100`

**#recent-ips datalist is populated but no input references it — dead wiring**

- **Evidence:** index.html:100 keeps <datalist id="recent-ips">; renderRecent (app.js:1762-1768) fills it and runs from applyMode:372, rememberIp:1759, and startup:2575. Neither ip input references it: index.html:51 (#ip-A) and :83 (#ip-B) have no list attribute, so the browser never surfaces the options. Severity correctly minor: openIpMenu (app.js:1528-1538) independently offers recentIps() plus the other column's address and the factory default via the ▾ button, so recents remain reachable — this is dead plumbing and lost native-autocomplete redundancy, not feature loss.
- **Fix:** Add list="recent-ips" to #ip-A and #ip-B, or remove the datalist and the datalist-filling half of renderRecent.

### HTML-04 · POLISH · `public/index.html:54`

**Connect button was renamed 'Go' but six user-facing strings (tour, first-run, help, empty state) still say 'press Connect'**

- **Evidence:** index.html:54 and :86: <button class="connect">Go</button>. Strings instructing 'press Connect' reproduced at app.js:2046 and 2100 (tour steps), 2127 and 2134 (renderFirstRun, including 'press <em>Connect</em>'), 1817 (renderEmptyCard: 'Press Connect to list this switcher's channels again.'). The help panel meanwhile says 'press <em>Go</em>' at 2191 and 2194 — both vocabularies ship simultaneously, and the tour actively points users at a button label that does not exist.
- **Fix:** Pick one label — 'Connect' matches the .connect class and every instructional string — and align the two button labels in index.html plus the help-panel 'Go' strings.


## style.css (6)

### CSS-01 · MINOR · `public/style.css:1241`

**.sample panel border cue never applies: #panel-A/#panel-B ID rules outrank .sample .list-col**

- **Evidence:** style.css 1241-1244: `.sample .list-col, .sample .card-col { border-color: rgba(255,195,16,.5) }` — specificity (0,2,0). style.css 494-498 and 505-509: `#panel-A .list-col, #panel-A .card-col { border-color: rgba(87,193,253,.45); background:#1b2027 }` and the #panel-B twin — specificity (1,1,0), which beats (0,2,0) regardless of source order. app.js enterTourDemo does `panel(side).classList.add('sample')` (app.js:1932) where panel() is $(`#panel-${side}`) (app.js:79), so both selector sets target the very same .list-col/.card-col elements and the ID rules always win on border-color. Surviving cues: .sample .device color (1245), the per-card 'SAMPLE — NOT A REAL SWITCHER' ::after badge (1248-1260) — and channel lists carry no badge at all.
- **Fix:** Scope to win: `#panel-A.sample .list-col, #panel-A.sample .card-col, #panel-B.sample .list-col, #panel-B.sample .card-col { border-color: … }`.

### CSS-02 · MINOR · `public/style.css:2954`

**Focus ring clipped on the Switcher|Presets toggle and browser sort control: overflow:hidden pill wrappers cut off the outline**

- **Evidence:** The only focus affordance in the entire stylesheet is `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }` (style.css:34-38) — grep confirms no other :focus rules except .skip:focus (62). .kinds (2954, `border-radius:999px; overflow:hidden`) and .catsorts (2299-2305, same) wrap their buttons, which have no margin and fill the wrapper, so the +2px-offset outline is painted outside the button's border box in the wrapper's clipped overflow area; ancestor overflow:hidden clips descendant outlines. Minor nuance vs. the claim: the ring segment on the INNER edge (between the two buttons) falls inside the wrapper and paints over the sibling, so a thin vertical sliver can remain — but top, bottom, and outer edges (plus the 999px-radius corners) are clipped, leaving no recognisable focus indicator.
- **Fix:** `.kinds .kind:focus-visible, .catsort:focus-visible { outline-offset: -2px }` or move the ring to the wrapper with :focus-within.

### CSS-03 · MINOR · `public/style.css:3288`

**Tip layer (z-index 65) stacks above modal dialogs (z-index 50): coach-mark scrim and callout render over confirm/error modals**

- **Evidence:** style.css: .tiplayer z-index 65 (3285-3293), .tip-spotlight box-shadow 0 0 0 9999px rgba(6,8,11,.62) (3298-3304), .tip-callout pointer-events:auto (3313) vs .modal-overlay z-index 50 (1722-1729). tips.js keeps `cur` set until markSeen/hide, and place() only checks the TARGET's rect via visible() (tips.js:70-75) — a modal overlaying it does not clear the tip; the MutationObserver (tips.js:58) re-places it when modal nodes are inserted. Nothing hides tips on modal open: the only non-tour Tips.hide() is inside dropSample (app.js:150). The 'multi' tip shows whenever B is a connected switcher with <2 selected (app.js:1789-1797), and from exactly that state the user reaches modals under the tip: confirming Copy (askBar) leads to the showProgress modal-overlay (app.js:1053, 2424-2436), and Undo/delete-preset/overwrite-preset open askConfirm (app.js:1431, 532, 1372) — all z 50, under the tip's scrim and clickable callout. ONE CORRECTION: the finding's claim that pressing Copy opens askConfirm is wrong — apply() confirms via askBar, an in-layout bar (app.js:111, 1039); the modal that actually appears under the tip after Copy is showProgress. The defect and severity are unchanged.
- **Fix:** Raise .modal-overlay above .tiplayer (or drop .tiplayer below 50), and/or call Tips.hide() when any modal-overlay is appended.

### CSS-04 · POLISH · `public/style.css:341`

**#browse-open carries two competing skins (.libcta blue vs ID-rule fire): hover computes yellow text on blue background**

- **Evidence:** index.html:29: `<button id="browse-open" class="big libcta">`. Base: .libcta (306-311) sets background var(--panel-2), but #browse-open (341-344) wins color: var(--fire) and border-color rgba(255,98,56,.4). Hover: `.libcta:hover:not(:disabled)` (312-316) supplies background: var(--accent) = #4a90d9 (the ID rule sets no background) while `#browse-open:hover:not(:disabled)` (345-348) wins color: var(--focus) = #ffc310 and border-color: var(--fire) = #ff6238 (:root values at 13, 23-24). Net hover state: yellow text on mid-blue with an orange border, ~2:1 contrast — neither skin's intended state.
- **Fix:** Remove the libcta class from #browse-open, or delete the #browse-open ruleset.

### CSS-05 · POLISH · `public/style.css:894`

**Toast stack (z 92) sits under the help sheet (z 95): toasts unreadable/unhoverable while help is open; narrow window for a timed warn to expire unseen**

- **Evidence:** z-order fact confirmed: .helppanel position:fixed inset:0, z 95, background rgba(8,9,11,.86) (style.css:891-897) vs .toasts z 92 at top:62px right:16px (1895-1903) — toasts render under the sheet's 86%-opaque scrim and cannot receive mouseenter, so the pause-on-hover at app.js:2517-2520 is unreachable. IMPACT OVERSOLD, however: the finding's scenario ('copy in flight; user opens Help') cannot happen — showProgress appends a viewport-covering .modal-overlay (app.js:2425-2437, style.css:1722-1729 inset:0 flex) that intercepts the click on #help-open until endProgress() removes it, and with help already open (inset:0 z 95) no copy can be started. Remaining real cases: (a) a finite-life toast already alive when help opens — e.g. the 11s `${good}/${n} verified` warn from setStatus (app.js:1093 → 932, TOAST_LIFE.warn 11000 at 2456) — expires covered while the user reads 'Did it work'; (b) err toasts are sticky (life 0) so they are delayed, not lost. Downgraded in wording; polish severity stands.
- **Fix:** Raise .toasts above .helppanel (z-index 96+), or pause toast timers while body.help-on (set at app.js:2162).

### CSS-06 · POLISH · `public/style.css:2128`

**Demo chip (z 60) hidden behind the browse sheet (z 70), breaking the demo harness's own browse scenarios**

- **Evidence:** style.css: .demochip position:fixed bottom:12px z 60 (2122-2128) vs .browse position:fixed inset:0 z 70 with its own background (2179-2189) — the sheet covers and intercepts clicks over the chip everywhere, including its 22px padding gutter. demo.js: the gate at 12-15 (`if (!forced && local) return`) keeps it out of the real app; drive() calls openBrowser() for every scenario matching /^browse/ and 'catalogue-offline' (demo.js:471-483), and the scenario <select> lives in the chip (demo.js:499-533). So in exactly the browse scenarios, switching scenarios requires Escape-closing the sheet first (browserKeys, browse.js:93-102). Demo-only; polish is right.
- **Fix:** Raise .demochip above every sheet (e.g. z-index 99).


## browse.js (13)

### BRW-01 · CRITICAL · `public/browse.js:111`

**Entire community browser is dead: every endpoint browse.js calls is absent from the real catalogue, and the Pages SPA fallback (200 + HTML) makes the app show a bogus 'Can't reach the catalogue' card with a raw TypeError**

- **Evidence:** Live-reproduced: `curl http://127.0.0.1:8730/api/community/presets?q=&mic=&style=&sort=top` returns 200, Content-Type application/json, body `<!doctype html>...` (the catalogue site's SPA page) — server.js:537-538 relabels any upstream text as JSON (`res.status(upstream.status).type('application/json').send(text)`). Upstream direct: GET https://presets.studioupgrade.com/api/votes → 200 JSON `{"votes":{}}`, GET .../api/presets → 200 text/html — the API browse.js targets does not exist. api() (app.js:87-95) sees res.ok=true, res.json() rejects, and RETURNS `{error:'200 OK'}` as a success. loadCatalogue then sets CAT.items=undefined (browse.js:112) and throws at 113 (`body.total ?? body.presets.length` → TypeError reading 'length' of undefined); catch (115-118) sets CAT.items=[], CAT.error=the TypeError message; catList:223 renders catOffline (301-311) which prints the raw message; 'Try again' (308) re-calls loadCatalogue forever.
- **Fix:** Proxy: reject non-JSON upstream bodies (JSON.parse or content-type check → 502). Client: make api() treat unparseable 200s as errors and shape-check body.presets. Root cause: build the list/detail/rate/comment/publish endpoints upstream or gate the browser behind a capability probe.

### BRW-02 · MAJOR · `public/browse.js:195`

**Search box loses focus (and the grid flashes 'Loading…') after every 220 ms typing pause, because loadCatalogue re-renders the whole sheet**

- **Evidence:** search.oninput (browse.js:195-199) debounces into loadCatalogue; loadCatalogue (105-108) sets CAT.items=null and calls renderBrowser(), which does `root.textContent = ''` (140) and rebuilds a brand-new #cat-q (188-193). Value is restored (192, `search.value = CAT.q`) but focus/caret are not — the only `.focus()` in the file is openBrowser's one-shot at line 79. The intermediate items=null render also shows 'Loading the catalogue…' (221-222) on every debounce fire. Reachable today even with the broken catalogue, since catList always renders the search bar (187-215) above the error card.
- **Fix:** Skip the intermediate render (or re-render only .catmain) and restore focus/caret to #cat-q after re-render if it was focused.

### BRW-03 · MAJOR · `public/browse.js:428`

**'Add to my library' silently overwrites an existing local preset with the same name — no collision check, unlike the app's own save flow**

- **Evidence:** installPreset (browse.js:423-456) POSTs /api/presets with `name: p.name` and no overwrite field and no collision check. server.js:366-370: `const file = overwrite ?? fileNameFor(name)` then `await backupPreset(file); await fs.writeFile(...)` — an existing file of the same derived name is replaced, recoverable only from presets/_backups/. Contrast the app's own save flow (app.js:1371-1378), which runs askConfirm('Overwrite this preset?') before sending `overwrite: overFile` (1390), and the import endpoint (server.js:471-473), which auto-suffixes instead of overwriting. Latent today only because the detail page is unreachable while the list is dead (finding 1) — the code path destroys data with zero warning the moment the catalogue works.
- **Fix:** Check for a name/file collision first and confirm or auto-suffix (reuse the import endpoint's suffix loop at server.js:471-473).

### BRW-04 · MAJOR · `public/browse.js:587`

**Publish claims 'Nothing about your switcher or network travels except the model and firmware build' — but the full device record, including the switcher's IP and uniqueId, is sent**

- **Evidence:** The ready-state note (browse.js:587) promises only model and firmware travel. go.onclick fetches the whole preset file (`const body = await api('/api/presets/' + file)`, 598) and POSTs `preset: { ...body, mic…, style…, notes…, sampleUrl… }` (606) — body.device is untouched. deviceInfo (server.js:56-65) puts `{ ip, model, build, release, uniqueId }` into every saved preset (app.js:1391 stores state.A.device with fallback `{ ip: state.A.ip }`), and the pack exporter deliberately strips device to model/release/build (server.js:425) to honour the same promise. Severity stands at major even though the upstream route is missing: the proxy (server.js:531-538) transmits the POST body to presets.studioupgrade.com regardless of whether the route answers — the IP and uniqueId leave the machine.
- **Fix:** Before POSTing, replace device with `{ model, release, build }` exactly as /api/presets/pack does.

### BRW-05 · MAJOR · `public/browse.js:600`

**Publish form submits to POST /api/community/presets, which does not exist on the real catalogue — publishing always fails with a raw status message (or falsely 'succeeds' if the fallback 200s)**

- **Evidence:** go.onclick (browse.js:593-619) POSTs {author, preset} to /api/community/presets; upstream has no /api/presets API route (GET returns the SPA HTML page, live-verified; only /api/votes answers JSON). The proxy forwards blindly (server.js:531-538). If the upstream errors, api() throws its status → bare setStatus toast (616). If the deployment 200-HTMLs the POST as it does GETs, api() returns {error:'200 OK'} WITHOUT throwing and the success path runs: CAT.publish=null, sort='new', loadCatalogue, showOutcome('ok', '…is published') (609-613) — a false success. Line 599 also writes the author name to localStorage before the community POST. 'Share one of yours' is always visible in the header (170-172), so this is reachable today. I did not POST to verify the exact upstream status (audit rule), so the failure mode is 'error toast or false success', both broken.
- **Fix:** Implement the upstream endpoint or hide the publish flow behind a capability check; make api() reject unparseable 200 bodies so a fallback page can never read as success.

### BRW-06 · MINOR · `public/browse.js:223`

**Stale CAT.error from a failed detail fetch makes the list view show the full-screen 'Can't reach the catalogue' card over perfectly loaded results**

- **Evidence:** openPreset's catch sets CAT.error (browse.js:129-131). The back button (156-161) clears sel/detail/publish but not error; the Escape branch (98-102) likewise. catList checks `else if (CAT.error)` (223) BEFORE `!CAT.items.length` (225), so a still-populated CAT.items grid is replaced by catOffline(). Only loadCatalogue (107) ever resets CAT.error, so the user must press 'Try again' to re-fetch a list the app already holds.
- **Fix:** Clear CAT.error in the back-button and Escape paths, or scope errors per view (listError vs detailError).

### BRW-07 · MINOR · `public/browse.js:318`

**Detail page shows 'Loading…' forever when the detail fetch genuinely fails — the error is stored but never rendered, and no retry is offered**

- **Evidence:** openPreset (browse.js:122-133): on api() throw (e.g. the proxy's 8 s timeout → 503, server.js:529/540) the catch sets CAT.error (130) but CAT.detail stays null. catDetail (315-321): `if (!p) { wrap.append(el('div','catnote','Loading…')); return wrap }` — CAT.error is never consulted anywhere in the detail view; catOffline is only reachable from catList (223-224). Note the exact trigger needs a thrown api() (timeout/network/5xx): the live 200-HTML fallback does NOT throw, it sets CAT.detail to a garbage object instead. Recoverable via the back button, hence minor.
- **Fix:** In catDetail, when detail is null and CAT.error is set, render an error with a retry that re-calls openPreset(CAT.sel).

### BRW-08 · MINOR · `public/browse.js:413`

**Comment 'Helpful' upvote is a client-side fake: it increments a local counter, posts nothing, and reverts on refresh**

- **Evidence:** browse.js:412-417: `up.onclick = () => { c.votes = (c.votes ?? 0) + 1; renderBrowser() }` — no api() call, unlimited increments per click, and c belongs to the transient CAT.detail object so the count resets on refetch. Every other write in the file at least attempts a POST (sendRating:462, sendComment:475); this is a mockup leftover. demo.js's community routes (442-457) carry no votes endpoint either.
- **Fix:** POST to a real comment-vote endpoint when one exists, or remove/disable the button; at minimum disable after one click.

### BRW-09 · MINOR · `public/browse.js:462`

**Rating stars post to a nonexistent endpoint and swallow the failure — the star lights up but the rating is never stored anywhere**

- **Evidence:** sendRating (browse.js:458-468) optimistically sets p.yourRating (459), POSTs /api/community/presets/:id/rate (462) — a route the upstream does not serve (its real write API is POST /api/vote; GET /api/votes answers JSON, verified live, and browse.js never touches either). The catch (464-466) is deliberately empty with no queue/retry/persistence — the mark lives only in the transient CAT.detail object. On a 200-HTML fallback, api() returns {error:'200 OK'} and line 463 `Object.assign(p, body)` grafts an error key onto the preset. Downgraded from major: the detail page is unreachable while the list is dead (finding 1), and even when triggered it is a silent no-op, not data destruction.
- **Fix:** Wire to the endpoint that exists (POST /api/vote, read back via GET /api/votes) and revert the optimistic mark with a toast on failure.

### BRW-10 · MINOR · `public/browse.js:473`

**Posting a comment clears the textarea before the request, so a failed post destroys the user's typed note**

- **Evidence:** sendComment (browse.js:470-481): `input.value = ''` (473) runs before `await api(...)` (475). On failure the catch (477-479) shows only a toast, and renderBrowser() (480) rebuilds the form empty — the text exists nowhere in CAT state, so it is unrecoverable. Against the current upstream this endpoint never exists, so every post would fail this way.
- **Fix:** Clear the input only after api() resolves; on failure keep the text (stash it in CAT state so the re-render preserves it).

### BRW-11 · MINOR · `public/browse.js:495`

**Publish form never prefills Notes or Sample URL — the library list endpoint omits those fields — so re-sharing publishes with the preset's saved notes silently dropped**

- **Evidence:** loadPublishEdits (browse.js:493-501) reads `p?.notes` and `p?.sampleUrl` off a state.library.presets row; those rows come from GET /api/presets whose projection (server.js:283-299) includes mic (296) and style (297) but no notes or sampleUrl keys — verified against the projection object — even though the on-disk file stores both (server.js:486-489 on import; app.js:1391 payload on save). So edits.notes/sampleUrl always start ''. The publish handler fetches the FULL body (browse.js:598) — which has the notes — and then overrides them away: `preset: { ...body, notes: d.notes.trim() || null, sampleUrl: d.sampleUrl.trim() || null }` (606). Downgraded from major: publishing is entirely dead today (see publish finding), and the blank Notes field is at least visible to the user before submitting.
- **Fix:** Add notes/sampleUrl to the GET /api/presets projection (server.js ~297), or build edits from the full GET /api/presets/:file body.

### BRW-12 · MINOR · `public/browse.js:615`

**Pressing Escape while a publish is in flight null-derefs in the error handler (CAT.publish.sending on null)**

- **Evidence:** browserKeys (browse.js:93-97): Escape with CAT.publish truthy sets `CAT.publish = null` and re-renders, with no check of CAT.publish.sending. The in-flight go.onclick continues; on rejection the catch (614-617) runs `CAT.publish.sending = false` → TypeError 'Cannot set properties of null', thrown inside the catch so setStatus/renderBrowser never run and the rejection surfaces as an unhandled console error with no user feedback. The window needs a slow upstream (up to the 8 s proxy timeout, server.js:529), so it is narrow but real.
- **Fix:** Guard the catch with `if (CAT.publish) CAT.publish.sending = false`, or ignore Escape while sending.

### BRW-13 · POLISH · `public/browse.js:450`

**installPreset double-escapes the style name in a plain-text toast**

- **Evidence:** browse.js:450 passes `Filed under ${esc(p.style || 'Community')}. …` as the detail argument of showOutcome; showOutcome → notify (app.js:2526-2527) renders detail via `el('div', 'odetail', detail)` (app.js:2465), and el() sets textContent (app.js:80-85), so esc()'s entities (app.js:243 escapes &<>) display literally: a style of 'R&B vocal' shows as 'Filed under R&amp;B vocal.'
- **Fix:** Drop the esc() call — textContent needs no escaping.


## demo.js (9)

### DEMO-01 · MAJOR · `public/demo.js:490`

**Demo scenarios write through to the real app's localStorage (kind.A/B, recent IPs, ip.A) on the shared 127.0.0.1:8730 origin**

- **Evidence:** Every persisting hop verified. demo.js:490 setKind('A','library') → app.js:461 writes 'atem-audio-presets.kind.A' and '.kind.B', which boot state trusts (app.js:57-58) — next real launch opens with column A on the preset library. demo.js:472/487/498 fill the ip box and call connectSingle → app.js:384 unconditionally writes '.ip.A'='192.168.8.20' (even on connect-fail), prefilled at boot (app.js:1566-1567); on stub success app.js:389 rememberIp → app.js:1757-1758 puts the fake IP at the head of '.recent' (capped 5, can evict a real address), resurfaced by the empty-state chips (app.js:2130-2143) and the IP menu (app.js:1535). Gate verified: demo.js:13-15 activates with ?demo on 127.0.0.1 — the exact origin whose localStorage the real app reads — and demo.js:9 documents ?demo=1 on the locally-served page as supported. Electron/npm-start without ?demo stay inert (electron/main.js:49 loadURL of server.start url, server.js:589-594 host default '127.0.0.1').
- **Fix:** While demo is active, snapshot-and-restore or shim localStorage for 'atem-audio-presets.*' keys (excluding demo's own chip-pos key), or have drive() stage state via paths that skip persistence.

### DEMO-02 · MAJOR · `public/demo.js:575`

**Demo never suppresses the app's 500ms auto-tour, so the tour (and its sample switcher) hijacks every scenario on a fresh profile; 'connect-fail' is destroyed outright**

- **Evidence:** Reproduced the full trace. index.html:126-127 loads demo.js before app.js, so demo's load listener (demo.js:575-578) fires first and drive() suspends at the stub's `await delay(80)` (demo.js:307); app.js:2571-2572 then always arms `setTimeout(() => startTour(), 500)` because state.A.channels is still []. startTour (app.js:2028) only aborts on Tips.isSeen('seq.first-run-v1') — localStorage key 'atem-audio-presets.tip.seq.first-run-v1' (tips.js:27-29, sequence key tips.js:233-234) — and nothing in demo.js ever sets it. connect-fail: stub fails at ~780ms (demo.js:307 + 311 delay 700), so at t=500 wasEmpty is true, enterTourDemo (app.js:1919) shallow-snapshots channels=[]/error=null and installs the sample; at ~780ms connectSingle's catch (app.js:411-420) wipes the sample channels and renders the connect-error card mid-tour; Done runs exitTourDemo (app.js:1941-1949) restoring the t=500 snapshot — error gone, blank first-run column. library-empty never fetches (drive() demo.js:485-496 only calls setKind) so it is always hijacked with the sample; connected scenarios (channels loaded ~230ms) skip the sample but still get the full forced tour with scrim and ghost-cursor section toggling (app.js:1998, 2006-2010). One softener: it happens once per origin profile — completing the tour sets the flag and later demo loads are clean.
- **Fix:** In demo.js before drive(), set localStorage['atem-audio-presets.tip.seq.first-run-v1']='1' for every scenario except 'first-run' (leave first-run to showcase the tour deliberately).

### DEMO-03 · MINOR · `public/demo.js:357`

**Demo /api/undo restores nothing and hard-codes 'Camera 1', contradicting the app's read-back promise in the same screen**

- **Evidence:** demo.js:357-363 returns a canned restored:[{label:'Camera 1',...}] and never touches `box`, while /api/apply genuinely mutated it (demo.js:332-336). app.js undo (1441-1447) reports 'Put back 1 channel' and 'Camera 1 ... restored from the backup' straight from body.restored, then refreshAfterWrite (app.js:1448 → 425-428) re-reads /api/channel which serves the still-mutated box (demo.js:317-319). So the demo visibly claims an undo that read-back disproves on the same screen — including when the copy went to Lectern only. Demo-only blast radius keeps it minor.
- **Fix:** Snapshot the affected box entries in the /api/apply handler and restore them (deriving `restored` from the snapshot) in /api/undo.

### DEMO-04 · MINOR · `public/demo.js:365`

**Demo /api/presets/pack returns rows with no channel bodies and ignores the requested file selection; /api/presets/import fakes success from its own list**

- **Evidence:** demo.js:365 returns the library ROWS array (file/name/group/summary, built without channel bodies at demo.js:177, 202-208) and discards the { group, files, name } filter exportPack sends (app.js:580-582); the real route filters by files/group and embeds body.channel per preset plus format:'atem-audio-preset-pack' (server.js:407-443). exportPack downloads whatever comes back (app.js:585), so a 2-preset group export contains all 4 rows and zero settings. demo.js:366 /api/presets/import returns imported: presets.map(p=>p.name) without reading body.pack, and importFile's Array.isArray(body.presets) branch (app.js:1612-1616) accepts even {"presets":[]} and reports the demo library's own count.
- **Fix:** Build pack presets via presetBody() honoring body.files/body.group and add the format field; have import read body.pack.presets.

### DEMO-05 · MINOR · `public/demo.js:371`

**Installing a community preset during a demo session permanently marks it 'In your library' in the real app**

- **Evidence:** Trace reproduced: demo POST /api/presets (demo.js:368-372) stores the install only in in-memory savedBodies/presets, but the click path is browse.js installPreset (browse.js:423-447) which persists 'atem-audio-presets.installed' with the catalogue id at browse.js:446-447; the real app boot-reads that set (browse.js:28) and disables Install / shows 'In your library' via CAT.installed.has(p.id) (browse.js:296, 339-340, 424) with no UI to clear it. Caveat that keeps this minor: the user-visible mislabel requires the live catalogue (proxied service, server.js:521-526 presets.studioupgrade.com) to share an id with the demo's ('sm7b-broadcast', 'safety-net', ... demo.js:236-260) — plausible since the demo mirrors the same author and preset names, but not provable from code. The localStorage pollution itself is unconditional.
- **Fix:** Fence localStorage writes during demo (same remedy as the kind/recent-IP leak), or namespace demo catalogue ids (e.g. 'demo-sm7b-broadcast').

### DEMO-06 · MINOR · `public/demo.js:389`

**Demo /api/snapshot omits the snapshot envelope, so the demo's own download-then-import round-trip is rejected**

- **Evidence:** demo.js:389 returns bare { channels: [...] }; the real route returns extractSwitcher's envelope { format: 'atem-audio-snapshot', version, savedAt, device, channels } (server.js:554, lib/fairlight.js:185-193). importFile (app.js:1610-1629) branches on body.format === 'atem-audio-snapshot', then Array.isArray(body.presets), then body.channel — the demo file matches none and hits the final 'neither a channel preset nor a switcher snapshot' branch (app.js:1629). One count correction: the demo has 24 strips (8 DEFS + 16 MADI, demo.js:82-92), so the download logs 24, not 32.
- **Fix:** Return { format: 'atem-audio-snapshot', version: 1, savedAt, device: DEVICE, channels } to match extractSwitcher.

### DEMO-07 · MINOR · `public/demo.js:390`

**Demo /api/restore claims every strip restored regardless of the uploaded snapshot, and changes nothing**

- **Evidence:** demo.js:390 returns { results: channelList().map(c => ({ ok: true, ... })) } — the request's snapshot and sections (sent by restoreSnapshot, app.js:1490) are never read and `box` is untouched, yet all demo strips report ok; app.js:1492-1493 then logs 'Restored N/N strips' while refreshAfterWrite shows unchanged cards. Count correction: the demo has 24 strips (demo.js:82-92), so the log reads 24/24, not 32/32 — the mismatch with the uploaded file's channel count stands either way.
- **Fix:** Apply the uploaded snapshot's matching channels to `box` (respecting sections) and report only those keys.

### DEMO-08 · POLISH · `public/demo.js:459`

**Route/shape inventory: only /api/status is unstubbed (404'd by catch-all, swallowed); gate is inert in Electron and npm start; no global leaks; channel shape matches extractChannel**

- **Evidence:** Inventory re-verified independently. Full client route list (grep over app.js/browse.js): apply, channel, community/presets(+/:id, /rate, /comments), presets(+/:file, /import, /pack), preview, restore, snapshot, status, switcher, undo — every one except /api/status has a demo handler (community subroutes match the regex at demo.js:442), and the catch-all 404 (demo.js:459) plus app.js:2274-2281's swallowed .catch make the Help panel's preset-dir line silently stay generic. Gate: demo.js:12-15 returns before hooking for 127.0.0.1/localhost/[::1] without ?demo; Electron loads server.start's 127.0.0.1 URL (electron/main.js:49 loadURL, url built at main.js:90-91, server.js:589-594 host default '127.0.0.1') — note the loadURL is line 49, not 100 as stated. Globals: strict IIFE, only window.fetch reassigned (demo.js:300); connectSingle/setKind/selectPreset (app.js:378/450/639) and openBrowser/openPreset/startPublish (browse.js:72/122/485) exist as top-level script globals. Shape: demo box entries match extractChannel field-for-field including levels.mixOption (lib/fairlight.js:134-181 vs demo.js:98-122); renderChannels (app.js:663-686) reads only key/minor/inputId/leg/label/configurationLabel/summary.{eqActive,eqBandsOn,dynActive}, all provided; demo summarize (demo.js:127-131) omits the gateEnabled term of summarizeChannel (lib/fairlight.js:61) but no demo data sets gateEnabled true.
- **Fix:** Optional: stub /api/status with { presetDir: '~/…/presets' } for demo fidelity.

### DEMO-09 · POLISH · `public/demo.js:498`

**Scenario chip promises states drive() never reaches ('Copy in progress', 'Copy finished — a value was clamped'); inputConfig section is a silent no-op**

- **Evidence:** SCENARIOS (demo.js:22-23) label the states, but drive() (demo.js:498-508) for copying/clamped only sets the IP, connects, and stages the Mic 1 → Cameras 1-3 selection; the labelled state requires the user to press Copy and confirm askBar (app.js:1038-1045) before the 60s apply delay (demo.js:325) or clamp (demo.js:339-342) engage. Separately, demo diffFor (demo.js:269-296) and the apply mutation block (demo.js:332-336) omit sections.inputConfig, which the real lib handles (lib/fairlight.js:324, 383-385) — ticking Input in demo contributes zero diffs and copies nothing.
- **Fix:** Have drive() invoke performCopy directly for 'copying'/'clamped' (it bypasses askBar by design, app.js performCopy), or relabel the scenarios; add inputConfig to diffFor/apply.


## Needs Ryan (not code)

- `public/app.js:1714` — 'Say thanks' letter promises a $5/month tier and an 'Or, pay once' one-time option on GitHub Sponsors — unverifiable from code, needs Ryan's confirmation
  - The strings exist exactly as claimed (app.js:1714-1715, SUPPORT_URL at 25), but whether github.com/sponsors/ryangrams is live with a $5 monthly tier and one-time payments enabled is external account configuration that cannot be verified from this repository — not a code defect, a content-accuracy check for Ryan.