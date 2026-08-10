'use strict'

// The switcher stores dB, Q, ratio and dynamics times as integers scaled ×100, and frequency as
// plain Hz. Everything below is display-only — raw values are what get copied.
const dB = (v) => (v === undefined || v === null ? '—' : `${(v / 100).toFixed(2)} dB`)
const ms = (v) => (v === undefined || v === null ? '—' : `${(v / 100).toFixed(2)} ms`)
const ratio = (v) => (v === undefined || v === null ? '—' : `${(v / 100).toFixed(2)}:1`)
const q = (v) => (v === undefined || v === null ? '—' : (v / 100).toFixed(2))
const hz = (v) => (v === undefined || v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v} Hz`)
const pan = (v) => (v === undefined || v === null ? '—' : v === 0 ? 'centre' : `${v > 0 ? 'R' : 'L'} ${Math.abs(v / 100).toFixed(0)}`)

const SHAPE = { 1: 'Low shelf', 2: 'Low pass', 4: 'Bell', 8: 'Notch', 16: 'High pass', 32: 'High shelf' }
const FREQ_RANGE = { 1: 'Low', 2: 'Mid-low', 4: 'Mid-high', 8: 'High' }
const MIX = { 1: 'Off', 2: 'On', 4: 'AFV' }
const CONFIG = { 1: 'Mono', 2: 'Stereo', 4: 'Dual mono' }
const LEVEL = { 0: '', 1: 'Mic', 2: 'Consumer', 4: 'Pro line' }

// `selection` is a list of channel keys. The source side only ever holds one; the destination
// side is multi-select (⌘/ctrl-click toggles, shift-click extends from the anchor), because
// pasting one strip onto four cameras at once is the common job.
/** localStorage namespace — one place, so the stored keys track the app name. */
const LS = 'atem-audio-presets'

// Where the support link points. Empty removes the link rather than shipping a dead link.
const SUPPORT_URL = 'https://github.com/sponsors/ryangrams'

// ⌘ on a Mac, Ctrl everywhere else. A hint that names the wrong key is worse than no hint.
const IS_MAC = /mac/i.test(navigator.platform || navigator.userAgent)
const MOD = IS_MAC ? '⌘' : 'Ctrl'

/** Addresses that have connected before — typing one in is this app's first and highest hurdle. */
const recentIps = () => {
	try {
		return JSON.parse(localStorage.getItem(`${LS}.recent`) ?? '[]')
	} catch {
		return []
	}
}

/** One place for the words a section is called, so the card, summary and outcome agree. */
const SECTION_NAMES = { gain: 'Gain', volume: 'Volume', pan: 'Pan', eq: 'EQ', dynamics: 'Dynamics', inputConfig: 'Input' }

/** The community front door — shared presets, help, and the people doing the same job. */
const LOOP_URL = 'https://loop.studioupgrade.com'

/** A short controlled vocabulary keeps the library scannable; free text is still allowed. */
const PRESET_STYLES = ['Broadcast voice', 'Podcast', 'Speech clarity', 'Live vocal', 'Lav / headset', 'Music', 'Safety net', 'Utility']

/** Mics people actually plug into ATEMs, as suggestions for the save form. */
const COMMON_MICS = ['Shure SM7B', 'Shure SM58', 'Shure MV7', 'Rode PodMic', 'Rode NT1', 'Rode Wireless GO II', 'Audio-Technica AT2020', 'Sennheiser e835', 'Sennheiser MKE 600', 'DPA 4066 headset', 'Behringer XM8500']

// A column holds either a switcher or the preset library. Only one side can be the library at a
// time, which is what makes preset-into-preset impossible rather than merely disallowed.
const state = {
	// `error` holds the last failed connect for that column, so the card area can explain it
	// instead of leaving a raw string beside a red dot.
	A: { kind: localStorage.getItem(`${LS}.kind.A`) ?? 'atem', ip: '', device: null, channels: [], selection: [], anchor: null, detail: null, error: null, showMinor: false, multi: false },
	B: { kind: localStorage.getItem(`${LS}.kind.B`) ?? 'atem', ip: '', device: null, channels: [], selection: [], anchor: null, detail: null, error: null, showMinor: false, multi: true },
	library: { presets: [], selectedFile: null, cache: {} },
	// One switcher is the default: both lists show the same box and a copy moves settings
	// between its channels. Adding a second switcher splits them apart.
	two: localStorage.getItem(`${LS}.two`) === '1',
	// What a copy carries. The checkboxes live in the source card's own block headers, so this
	// object — not the DOM — is the source of truth; the cards render from it.
	sections: { gain: true, volume: true, pan: true, eq: true, dynamics: true, inputConfig: false },
}

const selectedKeys = (side) => state[side].selection.filter((k) => state[side].channels.some((c) => c.key === k))
const channelFor = (side, key) => state[side].channels.find((c) => c.key === key)

const isLib = (side) => state[side].kind === 'library'
/** The preset currently picked in the library column, fully loaded. */
const currentPreset = () => (state.library.selectedFile ? state.library.cache[state.library.selectedFile] : null)
const presetRow = (file) => state.library.presets.find((p) => p.file === file)
/** Whatever is acting as the source right now — a live channel or a preset's stored channel. */
const sourceChannel = () => state.A.detail

const $ = (sel, root = document) => root.querySelector(sel)
const panel = (side) => $(`#panel-${side}`)
const el = (tag, cls, text) => {
	const n = document.createElement(tag)
	if (cls) n.className = cls
	if (text !== undefined) n.textContent = text
	return n
}

async function api(path, options) {
	const res = await fetch(path, {
		...options,
		headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
	})
	const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))
	if (!res.ok) throw new Error(body.error ?? `${res.status}`)
	return body
}

// ------------------------------------------------------------------ confirmation

/**
 * In-page confirmation instead of window.confirm().
 *
 * Some embedded and in-app browsers auto-dismiss native dialogs: confirm() returns false
 * immediately without ever showing anything, so a destructive action silently does nothing.
 * This never relies on the host's dialogs.
 */
/**
 * An inline "are you sure" in the same bar slot the blend controls use — not a lightbox. The copy is
 * about to be visible on the destination card anyway, so the bar only needs to name the action and
 * offer the two buttons; the card below is the detail.
 */
let askBarActive = null // the in-flight confirm bar's resolver, so a new one can supersede the old

function askBar(title, note, confirmLabel = 'Confirm') {
	// Only one confirm bar can be live. If another somehow still is, cancel it first — resolve it
	// false and drop its key listener — so a later Enter can never resolve a stale, superseded
	// confirmation and fire an unconfirmed copy on top of the current one.
	if (askBarActive) askBarActive(false)
	return new Promise((resolve) => {
		const bar = $('#confirmbar')
		let settled = false
		const done = (v) => {
			if (settled) return
			settled = true
			if (askBarActive === done) askBarActive = null
			bar.hidden = true
			bar.textContent = ''
			document.removeEventListener('keydown', onKey)
			resolve(v)
		}
		const onKey = (e) => {
			// Only the current bar answers keys — a superseded one has already been cancelled above.
			if (askBarActive !== done) return
			if (e.key === 'Escape') done(false)
			if (e.key === 'Enter') done(true)
		}
		askBarActive = done
		bar.hidden = false
		bar.innerHTML = `
			<div class="blendfoot">
				<span class="blendnote"><b class="confirmtitle">${esc(title)}</b>${note ? ` ${esc(note)}` : ''}</span>
				<div class="blendacts"><button class="blendcancel">Cancel</button><button class="primary blendgo">${esc(confirmLabel)}</button></div>
				<span class="blendfootpad"></span>
			</div>`
		bar.querySelector('.blendcancel').onclick = () => done(false)
		bar.querySelector('.blendgo').onclick = () => done(true)
		bar.querySelector('.blendgo').focus()
		document.addEventListener('keydown', onKey)
	})
}

let tourDemo = null // the real state, parked while the tour's sample switcher is on screen
let connectInFlight = false // a real connect is mid-flight — the auto-tour must not start on top of it
let autoTourTimer = null // the pending first-run auto-tour, so a connect can cancel it

const SAMPLE_IP_TEXT = 'sample switcher' // what the tour writes into the address boxes

/** Cancel the pending first-run auto-tour — a real connect has taken over. */
function cancelAutoTour() {
	if (autoTourTimer) clearTimeout(autoTourTimer)
	autoTourTimer = null
}

/** The address a column's box really holds — the tour's placeholder text counts as empty. */
function typedIp(side) {
	const v = panel(side).querySelector('.ip').value.trim()
	return v === SAMPLE_IP_TEXT ? '' : v
}

/**
 * A real connect is arriving while the tour's sample is on screen. End the tour for good — mark the
 * sequence seen so the auto-tour never replays (otherwise it restarts on the next launch, dragging
 * the sample back and disabling Copy on the live connection), hide the coach-mark, and restore the
 * parked columns via exitTourDemo. Any real address the user just typed is preserved across the
 * restore, which would otherwise put the parked (empty) boxes back over it.
 */
function endTourForConnect() {
	if (!tourDemo) return
	const typed = { A: typedIp('A'), B: typedIp('B') }
	Tips.dismiss('seq.first-run-v1')
	Tips.hide()
	exitTourDemo()
	panel('A').querySelector('.ip').value = typed.A
	panel('B').querySelector('.ip').value = typed.B
}

/**
 * A failure the user has to acknowledge, as a lightbox.
 *
 * Reserved for things that stopped working — a request that never ran, a file that would not load.
 * Measured outcomes (a copy that wrote and read back) belong in the outcome band instead; this is
 * for the cases where there is no result to report.
 */
function showError(title, message) {
	const overlay = el('div', 'modal-overlay')
	const box = el('div', 'modal modal-err')
	box.append(el('h3', null, title))
	const detail = el('div', 'modal-detail')
	detail.innerHTML = `<p>${esc(message)}</p>`
	box.append(detail)
	const actions = el('div', 'modal-actions')
	const ok = el('button', 'primary', 'Close')
	actions.append(ok)
	box.append(actions)
	overlay.append(box)
	document.body.append(overlay)
	ok.focus()
	const done = () => {
		document.removeEventListener('keydown', onKey)
		overlay.remove()
	}
	const onKey = (e) => {
		if (e.key === 'Escape' || e.key === 'Enter') done()
	}
	document.addEventListener('keydown', onKey)
	ok.onclick = done
	overlay.onclick = (e) => {
		if (e.target === overlay) done()
	}
}

function askConfirm(title, detailHtml, confirmLabel = 'Confirm') {
	return new Promise((resolve) => {
		const overlay = el('div', 'modal-overlay')
		const box = el('div', 'modal')
		box.append(el('h3', null, title))
		const detail = el('div', 'modal-detail')
		detail.innerHTML = detailHtml
		box.append(detail)

		const actions = el('div', 'modal-actions')
		const cancel = el('button', null, 'Cancel')
		const ok = el('button', 'primary', confirmLabel)
		actions.append(cancel, ok)
		box.append(actions)
		overlay.append(box)
		document.body.append(overlay)
		ok.focus()

		const done = (answer) => {
			document.removeEventListener('keydown', onKey)
			overlay.remove()
			resolve(answer)
		}
		const onKey = (e) => {
			if (e.key === 'Escape') done(false)
			if (e.key === 'Enter') done(true)
		}
		document.addEventListener('keydown', onKey)
		cancel.onclick = () => done(false)
		ok.onclick = () => done(true)
		overlay.onclick = (e) => {
			if (e.target === overlay) done(false)
		}
	})
}

// ------------------------------------------------------------------ logging

function log(html, cls) {
	const box = $('#log')
	const line = el('div', cls)
	line.innerHTML = html
	box.prepend(line)
}
function clearLog() {
	$('#log').textContent = ''
}
/**
 * The blow-by-blow lives in a collapsible drawer. The headline does not: it goes in the outcome
 * banner above the status bar, where the user is already looking. This just opens the drawer.
 */
function showResult() {
	const box = $('#logbox')
	if (box) box.hidden = false
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])

/** Human-readable rendering of one diff row, so a preview is checkable at a glance. */
function fmtField(path, value) {
	if (value === true) return 'on'
	if (value === false) return 'off'
	// frequencyRange first: it is a band selector, not a dB "range" like the expander's.
	if (/frequencyRange/i.test(path)) return FREQ_RANGE[value] ?? value
	if (/gain|threshold|range/i.test(path)) return dB(value)
	if (/attack|hold|release/i.test(path)) return ms(value)
	if (/ratio/i.test(path)) return ratio(value)
	if (/qFactor/i.test(path)) return q(value)
	if (/frequency$/i.test(path) && !/Range/i.test(path)) return hz(value)
	if (/\bshape/i.test(path)) return SHAPE[value] ?? value
	if (/balance/i.test(path)) return pan(value)
	if (/mixOption/i.test(path)) return MIX[value] ?? value
	if (/configuration/i.test(path)) return CONFIG[value] ?? value
	if (/inputLevel/i.test(path)) return LEVEL[value] ?? value
	return String(value)
}

function diffTable(diff) {
	if (!diff.length) return '<em>No differences — the destination already matches.</em>'
	const rows = diff
		.map(
			(d) =>
				`<tr><td>${esc(d.section)}</td><td>${esc(d.path)}</td><td>${esc(fmtField(d.path, d.from))}</td>` +
				`<td class="arrow">→</td><td>${esc(fmtField(d.path, d.to))}</td></tr>`
		)
		.join('')
	return `<table><tr><th>section</th><th>field</th><th>now</th><th></th><th>after</th></tr>${rows}</table>`
}

// ------------------------------------------------------------------ switchers

async function connectSide(side) {
	// A real connect always wins over the tour's sample. Cancel the pending auto-tour and tear the
	// sample down first — reading the boxes below would otherwise pick up the 'sample switcher'
	// placeholder, and the untouched column would keep its fake, copyable channels.
	cancelAutoTour()
	if (tourDemo) endTourForConnect()

	// Two-switcher mode is not a mode the user has to find — it is simply what happens when the
	// destination points somewhere else. Giving the destination its own address turns it on; pointing
	// it back at the source's address turns it off again — reachable now from either Connect button.
	const aIp = panel('A').querySelector('.ip').value.trim()
	const bIp = panel('B').querySelector('.ip').value.trim()
	if (!state.two) {
		// Only the destination taking a different, non-empty address splits the columns apart — and
		// two-switcher mode is committed below, only once that second connect actually succeeds.
		if (!(side === 'B' && bIp && bIp !== aIp)) return connectSingle()
	} else if (bIp && bIp === aIp) {
		state.two = false
		applyMode()
		return connectSingle()
	}

	// Per-side connect (two-switcher). Connect just this column.
	const s = state[side]
	s.ip = panel(side).querySelector('.ip').value.trim()
	if (!s.ip) return
	const dev = panel(side).querySelector('.device')
	dev.innerHTML = `Connecting to ${esc(s.ip)}…`
	connectInFlight = true
	try {
		const body = await api(`/api/switcher?ip=${encodeURIComponent(s.ip)}`)
		// The auto-tour could have slipped in during the await; the real connection wins.
		if (tourDemo) endTourForConnect()
		// The connect worked — only now commit two-switcher mode, so a typo'd address can never latch
		// the app into a split it never actually reached.
		if (!state.two) {
			state.two = true
			applyMode()
		}
		s.device = body.device
		s.channels = body.channels
		s.selection = []
		s.anchor = null
		s.detail = null
		s.error = null
		rememberIp(s.ip)
		localStorage.setItem(`${LS}.ip.${side}`, s.ip)
		dev.innerHTML = deviceLine(body.device)
		renderChannels(side)
		renderDetail(side)
		log(`Connected to ${esc(s.ip)} — ${body.channels.length} audio strips.`, 'ok')
		// Each column's own device row already says it is connected — no need to repeat it below.
		setStatus('')
	} catch (e) {
		if (tourDemo) endTourForConnect()
		s.channels = []
		s.detail = null
		s.error = null
		dev.innerHTML = '<span class="err">●</span> Not connected'
		renderChannels(side)
		renderDetail(side)
		log(`Connect failed for ${esc(s.ip)}: ${esc(e.message)}`, 'err')
		notifyConnectFailure(s.ip, e.message, () => connectSide(side))
	} finally {
		connectInFlight = false
	}
}

/** The "● model — firmware x build y" line, rendered wherever the current mode shows it. */
function deviceLine(device) {
	// A parked side can carry an ip but no device (a first-ever failed two-switcher connect). Never
	// dereference a null device \u2014 that would throw mid-restore and strand the sample switcher.
	if (!device) return '<span class="err">\u25cf</span> Not connected'
	return (
		`<span class="ok">\u25cf</span> ${esc(device.model ?? 'ATEM')} \u2014 ` +
		`firmware ${esc(device.release ?? '?')} build <code>${esc(device.build ?? '?')}</code>`
	)
}

/** Show or hide the second switcher's controls, and relabel everything that depends on mode. */
function applyMode() {
	document.body.classList.toggle('two', state.two)
	for (const side of ['A', 'B']) {
		const p = panel(side)
		p.classList.toggle('lib', isLib(side))
		for (const btn of p.querySelectorAll('.kind')) {
			const on = btn.dataset.kind === state[side].kind
			btn.classList.toggle('on', on)
			btn.setAttribute('aria-pressed', on ? 'true' : 'false')
		}
	}
	// Same controls in both modes; on one switcher the destination column simply follows the
	// source's address instead of taking its own.
	const bIp = panel('B').querySelector('.ip')
	const bConnect = panel('B').querySelector('.connect')
	bIp.disabled = false
	bConnect.disabled = false
	// The destination box shadows the source address on one switcher. But once the user has typed a
	// *different* address there (heading for two-switcher mode, which only commits on B's Connect),
	// leave it alone — mirroring would wipe what they are actively typing.
	if (!state.two) {
		const aVal = panel('A').querySelector('.ip').value
		if (document.activeElement !== bIp && (bIp.value === '' || bIp.value === aVal)) bIp.value = aVal
	}
	bIp.title = state.two ? '' : 'Same switcher — enter a different address to copy across two'
	const bTitle = $('#title-B')
	bTitle.textContent = 'Destination'
	bTitle.title = isLib('B')
		? 'Saving into the preset library'
		: state.two
			? `${MOD} / shift-click for several channels`
			: `Same switcher \u00b7 ${MOD} / shift-click for several channels`
	localStorage.setItem(`${LS}.two`, state.two ? '1' : '0')
	renderRecent()
	updateSummary()
	updateActionUI()
}

/** Single-switcher connect: one fetch, both columns. */
async function connectSingle() {
	const ip = panel('A').querySelector('.ip').value.trim()
	if (!ip) return
	cancelAutoTour()
	// A real switcher always wins over the tour's sample — otherwise the sample's disabled buttons and
	// "not real" badges would be inherited by a live connection.
	if (tourDemo) endTourForConnect()
	connectInFlight = true
	localStorage.setItem(`${LS}.ip.A`, ip)
	const dev = panel('A').querySelector('.device')
	dev.innerHTML = `Connecting to ${esc(ip)}\u2026`
	try {
		const body = await api(`/api/switcher?ip=${encodeURIComponent(ip)}`)
		// The auto-tour could have fired during the await (a connect started inside the first 500ms).
		if (tourDemo) endTourForConnect()
		rememberIp(ip)
		for (const side of ['A', 'B']) {
			const s = state[side]
			s.ip = ip
			s.device = body.device
			panel(side).querySelector('.ip').value = ip
			panel(side).querySelector('.device').innerHTML = deviceLine(body.device)
			if (isLib(side)) {
				// The library column keeps its list, its selected preset and its card — only the
				// underlying address follows along. Clearing selection/detail here (as the old shared
				// reset did, before this guard) left a stale preset card on screen with Copy dead.
				s.channels = []
				continue
			}
			s.channels = body.channels
			s.selection = []
			s.anchor = null
			s.detail = null
			s.error = null
			renderSideAll(side)
		}
		log(`Connected to ${esc(ip)} \u2014 ${body.channels.length} audio strips.`, 'ok')
		setStatus('')
	} catch (e) {
		if (tourDemo) endTourForConnect()
		dev.innerHTML = '<span class="err">\u25cf</span> Not connected'
		for (const side of ['A', 'B']) {
			const s = state[side]
			s.channels = []
			s.detail = null
			s.error = null
			if (!isLib(side)) renderSideAll(side)
		}
		log(`Connect failed for ${esc(ip)}: ${esc(e.message)}`, 'err')
		// One notification for the whole attempt, not one per column.
		notifyConnectFailure(ip, e.message, () => connectSingle())
	} finally {
		connectInFlight = false
	}
}

/** After a write, re-read the destination \u2014 and the source too when they are the same box. */
async function refreshAfterWrite() {
	await refreshSide('B')
	if (!state.two) await refreshSide('A')
	updateActionUI()
}

/** A column shows either its switcher's channels or the preset library. */
function renderList(side) {
	return isLib(side) ? renderLibrary(side) : renderChannels(side)
}

/** Everything a column needs redrawn after it changes what it holds. */
function renderSideAll(side) {
	renderList(side)
	renderSelectionCount(side)
	renderDetail(side)
}

/**
 * Switch a column between its switcher and the preset library.
 *
 * The library can only ever be on one side, so flipping one column into it flips the other back.
 * There is no state in which both sides are presets — copying a preset onto a preset is not an
 * error the user can make.
 */
function setKind(side, kind) {
	if (state[side].kind === kind) return
	if (side === 'B' && kind === 'library') closeBlend()
	const other = side === 'A' ? 'B' : 'A'
	state[side].kind = kind
	if (kind === 'library' && state[other].kind === 'library') {
		state[other].kind = 'atem'
		state[other].selection = []
		state[other].detail = null
	}
	for (const sd of ['A', 'B']) {
		localStorage.setItem(`${LS}.kind.${sd}`, state[sd].kind)
		state[sd].multi = sd === 'B' && !isLib('B')
	}
	state[side].selection = []
	state[side].anchor = null
	state[side].detail = null
	state.library.selectedFile = null
	applyMode()
	renderSideAll('A')
	renderSideAll('B')
}

/** The preset library, grouped, in a channel column. */
function renderLibrary(side) {
	const list = panel(side).querySelector('.channel-list')
	list.textContent = ''
	// The library is a single-select list of presets — never advertise it as multi-select.
	list.setAttribute('aria-multiselectable', 'false')
	panel(side).querySelector('.toggle-minor')?.remove()
	panel(side).querySelector('.libfoot')?.remove()

	const presets = state.library.presets.filter((p) => p.format !== 'atem-audio-snapshot')
	if (!presets.length) return renderLibraryEmpty(side, list)

	// Roving tabindex: exactly one preset row is a tab stop (the selected one, else the first), and
	// the arrow keys move focus between them — the same pattern renderChannels uses.
	const focusFile = state.library.selectedFile ?? presets[0]?.file
	const groups = [...new Set(presets.map((p) => p.group || ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
	for (const g of groups) {
		if (groups.length > 1 || g) {
			const head = el('div', 'grouphead')
			head.append(el('span', 'gname', g || 'Ungrouped'))
			const packBtn = el('button', 'rowbtn', '\u2913')
			packBtn.title = `Export “${g || 'Ungrouped'}” as a shareable pack`
			packBtn.onclick = (e) => {
				e.stopPropagation()
				exportPack({ group: g, name: g || 'Ungrouped presets' })
			}
			head.append(packBtn)
			head.dataset.group = g
			head.ondragover = (e) => e.preventDefault()
			head.ondrop = (e) => dropPreset(e, g, null)
			list.append(head)
		}
		for (const p of presets.filter((x) => (x.group || '') === g)) {
			const row = el('div', `chan preset-row${state.library.selectedFile === p.file ? ' selected' : ''}`)
			row.draggable = true
			row.dataset.file = p.file
			row.setAttribute('role', 'option')
			row.setAttribute('aria-selected', state.library.selectedFile === p.file ? 'true' : 'false')
			row.tabIndex = p.file === focusFile ? 0 : -1
			row.dataset.key = p.file
			// The thumbnail is the preset's own EQ curve — real data, not an icon standing in for it.
			const spark = el('span', 'pspark')
			row.append(spark)
			paintSpark(p.file, spark)
			const words = el('div', 'pwords')
			const name = el('span', 'name', p.name)
			name.title =
				`Double-click to rename\n${[p.mic, p.style].filter(Boolean).join(' \u00b7 ') || (p.meta?.label ?? 'channel')}` +
				`${p.savedAt ? `\n${new Date(p.savedAt).toLocaleString()}` : ''}`
			name.ondblclick = (e) => {
				e.stopPropagation()
				renamePreset(p, name)
			}
			words.append(name)
			const bits = [p.mic, p.style].filter(Boolean).join(' \u00b7 ')
			if (bits) words.append(el('span', 'pmeta2', bits))
			row.append(words)
			const tags = el('div', 'tags')
			tags.append(el('span', `tag${p.summary?.dynActive ? ' on' : ''}`, 'DYN'))
			row.append(tags)
			const del = el('button', 'rowbtn', '×')
			del.title = 'Delete preset'
			del.onclick = async (e) => {
				e.stopPropagation()
				if (!(await askConfirm('Delete preset?', `<p><strong>${esc(p.name)}</strong></p><p class="muted">A copy is kept in presets/_backups/.</p>`, 'Delete'))) return
				await api(`/api/presets/${encodeURIComponent(p.file)}`, { method: 'DELETE' })
				if (state.library.selectedFile === p.file) state.library.selectedFile = null
				await loadPresets()
			}
			row.append(del)
			const save = el('button', 'rowbtn', '\u2913')
			save.title = 'Export this preset to a file'
			save.onclick = async (e) => {
				e.stopPropagation()
				download(p.file, await api(`/api/presets/${encodeURIComponent(p.file)}`))
			}
			row.insertBefore(save, del)
			row.onclick = () => selectPreset(side, p.file)
			row.ondragstart = (e) => e.dataTransfer.setData('text/plain', p.file)
			row.ondragover = (e) => e.preventDefault()
			row.ondrop = (e) => dropPreset(e, g, p.file)
			list.append(row)
		}
	}

	// Whole-library export and import, always reachable — groups are optional, so these cannot
	// live only on group headers. Browsing lives on the header's Community presets button, so it is
	// deliberately not repeated down here.
	const foot = el('div', 'libfoot')
	const all = el('button', null, `Export all ${presets.length}`)
	all.title = 'Bundle every preset into one shareable pack'
	all.onclick = () => exportPack({ name: 'ATEM audio presets' })
	foot.append(all)
	const imp = el('label', 'filebtn small', 'Import a pack')
	const inp = el('input')
	inp.type = 'file'
	inp.accept = 'application/json'
	inp.onchange = (e) => importFile(e)
	imp.append(inp)
	foot.append(imp)
	list.after(foot)
}

/**
 * Bundle presets into one shareable file.
 *
 * A pack is the unit people trade — and, later, the unit they submit to a shared library — so it
 * carries names, groups and default sections, but nothing identifying about the machine that
 * made it beyond the switcher model and firmware build.
 */
async function exportPack({ group, files, name }) {
	try {
		const pack = await api('/api/presets/pack', {
			method: 'POST',
			body: JSON.stringify({ group, files, name }),
		})
		const slug = (name || 'presets').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
		download(`${slug}-pack.json`, pack)
		setStatus(`Exported ${pack.presets.length} preset${pack.presets.length === 1 ? '' : 's'}`, 'ok')
		log(`Exported <strong>${pack.presets.length}</strong> preset${pack.presets.length === 1 ? '' : 's'} as “${esc(pack.name)}”.`, 'ok')
	} catch (e) {
		setStatus(e.message, 'err')
		log(esc(e.message), 'err')
	}
}

/** Drop a dragged preset into a group, before `beforeFile` (or at the end of the group). */
async function dropPreset(e, group, beforeFile) {
	e.preventDefault()
	e.stopPropagation()
	const file = e.dataTransfer.getData('text/plain')
	if (!file || file === beforeFile) return
	const inGroup = state.library.presets.filter((p) => (p.group || '') === group && p.file !== file && p.format !== 'atem-audio-snapshot')
	const at = beforeFile ? inGroup.findIndex((p) => p.file === beforeFile) : inGroup.length
	const ordered = [...inGroup]
	ordered.splice(at < 0 ? ordered.length : at, 0, { file })
	// Renumber the whole group so the order survives a reload.
	await Promise.all(
		ordered.map((p, i) =>
			api(`/api/presets/${encodeURIComponent(p.file)}`, {
				method: 'PATCH',
				body: JSON.stringify(p.file === file ? { group, order: i } : { order: i }),
			})
		)
	)
	await loadPresets()
}

async function renamePreset(p, nameEl) {
	const input = el('input', 'renamebox')
	input.type = 'text'
	input.value = p.name
	nameEl.replaceWith(input)
	input.focus()
	input.select()
	const commit = async (save) => {
		input.onblur = null
		if (!save || !input.value.trim() || input.value.trim() === p.name) return loadPresets()
		await api(`/api/presets/${encodeURIComponent(p.file)}`, { method: 'PATCH', body: JSON.stringify({ name: input.value.trim() }) })
		await loadPresets()
	}
	input.onblur = () => commit(true)
	input.onkeydown = (e) => {
		e.stopPropagation()
		if (e.key === 'Enter') commit(true)
		if (e.key === 'Escape') commit(false)
	}
	input.onclick = (e) => e.stopPropagation()
}

/** Pick a preset: as a source it becomes the thing being copied, as a destination the one to overwrite. */
async function selectPreset(side, file) {
	state.library.selectedFile = file
	if (!state.library.cache[file]) {
		try {
			state.library.cache[file] = await api(`/api/presets/${encodeURIComponent(file)}`)
		} catch (e) {
			setStatus(e.message, 'err')
			return
		}
	}
	const preset = state.library.cache[file]
	state[side].detail = preset.channel ?? null
	// A preset remembers which sections it was saved for; those come back pre-ticked.
	if (side === 'A' && preset.defaultSections) {
		Object.assign(state.sections, preset.defaultSections)
	}
	if (side === 'B') {
		$('#np-name') && ($('#np-name').value = preset.name ?? '')
		$('#np-group') && ($('#np-group').value = preset.group ?? '')
	}
	renderSideAll('A')
	renderSideAll('B')
}

function renderChannels(side) {
	const s = state[side]
	const list = panel(side).querySelector('.channel-list')
	list.textContent = ''
	// Only a genuinely multi-select list should advertise itself as one.
	list.setAttribute('aria-multiselectable', s.multi ? 'true' : 'false')
	const visible = s.channels.filter((c) => s.showMinor || !c.minor)
	// Roving tabindex: the list is one tab stop, and the arrow keys move inside it. The focused row
	// must be one that is actually on screen — falling back to a selected-but-hidden MADI strip would
	// give every rendered row tabIndex -1 and drop the whole list out of the tab order.
	const focusKey = [...s.selection].reverse().find((k) => visible.some((c) => c.key === k)) ?? visible[0]?.key
	for (const c of visible) {
		const on = s.selection.includes(c.key)
		const row = el('div', `chan${c.minor ? ' minor' : ''}${on ? ' selected' : ''}`)
		row.dataset.key = c.key
		row.setAttribute('role', 'option')
		row.setAttribute('aria-selected', on ? 'true' : 'false')
		row.tabIndex = c.key === focusKey ? 0 : -1
		row.append(el('span', 'id', `${c.inputId}${c.leg ? ` ${c.leg}` : ''}`))
		row.append(el('span', 'name', c.label))
		const tags = el('div', 'tags')
		tags.append(el('span', 'tag cfg', c.configurationLabel))
		tags.append(el('span', `tag${c.summary.eqActive ? ' on' : ''}`, `EQ${c.summary.eqBandsOn ? ` ${c.summary.eqBandsOn}` : ''}`))
		tags.append(el('span', `tag${c.summary.dynActive ? ' on' : ''}`, 'DYN'))
		row.append(tags)
		row.onclick = (e) => selectChannel(side, c.key, e)
		list.append(row)
	}
	panel(side).querySelector('.toggle-minor')?.remove()
	panel(side).querySelector('.libfoot')?.remove()
	const hidden = s.channels.filter((c) => c.minor).length
	if (hidden > 0) {
		const btn = el('button', 'toggle-minor')
		btn.setAttribute('aria-expanded', String(Boolean(s.showMinor)))
		const noun = hidden === 1 ? 'MADI strip' : 'MADI strips'
		btn.innerHTML = `<span class="chev" aria-hidden="true">▾</span><span>${s.showMinor ? `Hide ${hidden} ${noun}` : `Show ${hidden} ${noun}`}</span>`
		btn.onclick = () => {
			s.showMinor = !s.showMinor
			renderChannels(side)
		}
		// Inside the list, as its last row — it expands the channels above it, so it belongs to them
		// rather than sitting under the whole column.
		list.append(btn)
	}
}

async function selectChannel(side, key, event) {
	const s = state[side]
	if (isLib(side)) return

	if (s.multi && (event?.metaKey || event?.ctrlKey)) {
		// Toggle one strip in or out of the selection.
		s.selection = s.selection.includes(key) ? s.selection.filter((k) => k !== key) : [...s.selection, key]
		s.anchor = key
	} else if (s.multi && event?.shiftKey && s.anchor) {
		// Extend from the anchor across what's actually on screen, so a range never silently
		// swallows the MADI strips while they're hidden.
		const visible = s.channels.filter((c) => s.showMinor || !c.minor).map((c) => c.key)
		const from = visible.indexOf(s.anchor)
		const to = visible.indexOf(key)
		s.selection = from < 0 || to < 0 ? [key] : visible.slice(Math.min(from, to), Math.max(from, to) + 1)
	} else {
		s.selection = [key]
		s.anchor = key
	}

	renderChannels(side)
	renderSelectionCount(side)
	// Deselecting with \u2318-click leaves the card alone, so the summary has to be refreshed
	// here rather than relying on a re-render of the detail.
	updateSummary()

	// The detail card shows the strip just clicked; for the source side that is also the one
	// that gets copied. A ⌘-click that deselected a strip leaves the previous card alone.
	if (s.selection.includes(key)) await loadDetail(side, key)
	else if (!s.selection.length) {
		s.detail = null
		renderDetail(side)
	}
}

/** Read one strip's full settings into the detail card, without touching the selection. */
async function loadDetail(side, key) {
	const s = state[side]
	const c = channelFor(side, key)
	if (!c) return
	// During the tour the "switcher" is a local fixture, not something on the network. Serve its
	// strip bodies from the parked tour data — a real /api/channel to ip='sample' would hang until it
	// timed out and then blank the card.
	if (tourDemo?.bodies) {
		s.detail = tourDemo.bodies[key] ? JSON.parse(JSON.stringify(tourDemo.bodies[key])) : null
		renderDetail(side)
		if (side === 'A' && isLib('B')) renderDetail('B')
		updateActionUI()
		return
	}
	// Stamp each read so a slow earlier one cannot overwrite the detail for the strip now selected.
	const seq = (s.detailSeq = (s.detailSeq ?? 0) + 1)
	try {
		const body = await api(`/api/channel?ip=${encodeURIComponent(s.ip)}&input=${c.inputId}&source=${encodeURIComponent(c.sourceId)}`)
		if (seq !== s.detailSeq) return
		s.detail = body.channel
	} catch (e) {
		if (seq !== s.detailSeq) return
		s.detail = null
		log(`Could not read ${esc(key)}: ${esc(e.message)}`, 'err')
	}
	renderDetail(side)
	// The save card on a library destination previews this channel — keep it following along.
	if (side === 'A' && isLib('B')) renderDetail('B')
	// Copy and Blend depend on a source channel actually being loaded, which only becomes true
	// here — the click that started this read happened a request ago.
	updateActionUI()
}

/** On the destination side, say plainly how many strips a copy will land on. */
function renderSelectionCount(side) {
	const s = state[side]
	let box = panel(side).querySelector('.selcount')
	if (!box) {
		box = el('div', 'selcount')
		panel(side).querySelector('.detail').before(box)
	}
	const keys = selectedKeys(side)
	if (!s.multi || keys.length < 2) {
		box.textContent = ''
		box.classList.remove('on')
		updateSummary()
		return
	}
	box.classList.add('on')
	box.textContent = `${keys.length} channels selected — ${keys.map((k) => channelFor(side, k)?.label ?? k).join(', ')}`
}

function renderDetail(side) {
	const box = panel(side).querySelector('.detail')
	box.textContent = ''

	// The library on the destination side is not a channel at all — it is the save form.
	if (side === 'B' && isLib('B')) return renderSaveCard(box)

	const d = state[side].detail
	if (!d) {
		renderEmptyCard(side, box)
		updateActionUI()
		renderCardHint(side)
		return
	}
	const cardBox = el('div')
	box.append(cardBox)
	// When several destination channels are selected, the card shows one preview but must not
	// pretend to be a single channel — its header says "Multi-select · N channels" instead.
	const destCount = side === 'B' && !isLib('B') ? selectedKeys('B').length : 1
	renderStripCard(cardBox, d, {
		sections: state.sections,
		// The source card is where sections are picked; the destination card previews the result —
		// the blend ratio when the blend bar is open, otherwise a straight incoming copy.
		source: side === 'A',
		incoming: side === 'B' ? (blendOpen ? blendPreviewFor(d) : sourceChannel()) : null,
		title: destCount > 1 ? { label: 'Multi-select', sub: `${destCount} channels` } : null,
	})
	// A preset is more than its numbers — say what it was made with and for. It sits under the card:
	// the settings are what the user came to read, the provenance is what they check afterwards.
	if (isLib(side) && currentPreset()) box.append(presetHead(currentPreset()))
	renderCardHint(side)
	updateActionUI()
}

/**
 * Saving into the library: a name, an optional group, and the channel exactly as it will be
 * stored. The section ticks do not trim what gets saved — a preset always holds the whole
 * channel — they are remembered as the preset's defaults for next time.
 */
function renderSaveCard(box) {
	const src = sourceChannel()
	const over = currentPreset()
	const groups = [...new Set(state.library.presets.map((p) => p.group).filter(Boolean))]
	const on = Object.entries(state.sections)
		.filter(([, v]) => v)
		.map(([k]) => ({ gain: 'Gain', volume: 'Volume', pan: 'Pan', eq: 'EQ', dynamics: 'Dynamics', inputConfig: 'Input' })[k])

	// Preserve anything already typed here: this whole form is rebuilt on every section toggle on the
	// source card, which would otherwise wipe the name, mic, style and notes the user just entered.
	// Fall back to the overwritten preset's stored values, then to empty. (?? keeps a deliberately
	// cleared field cleared, since only null/undefined fall through.)
	const prev = { name: $('#np-name')?.value, group: $('#np-group')?.value, mic: $('#np-mic')?.value, style: $('#np-style')?.value, notes: $('#np-notes')?.value, sample: $('#np-sample')?.value }
	const val = (k, fallback) => esc(prev[k] ?? fallback ?? '')

	box.innerHTML = `<div class="savecard">
		<div class="saverow">
			<input type="text" id="np-name" placeholder="Preset name" value="${val('name', over?.name ?? (src ? `${src.meta.label}` : ''))}" />
			<input type="text" id="np-group" list="np-groups" placeholder="Group (optional)" value="${val('group', over?.group)}" />
			<datalist id="np-groups">${groups.map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist>
		</div>
		<div class="saverow">
			<input type="text" id="np-mic" list="np-mics" placeholder="Mic or source \u2014 Shure SM7B, lectern gooseneck\u2026" value="${val('mic', over?.mic)}" />
			<input type="text" id="np-style" list="np-styles" placeholder="Style \u2014 Podcast, Live vocal\u2026" value="${val('style', over?.style)}" />
			<datalist id="np-mics">${COMMON_MICS.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
			<datalist id="np-styles">${PRESET_STYLES.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>
		</div>
		<div class="saverow">
			<input type="text" id="np-notes" placeholder="Notes \u2014 what it suits, what to tweak by ear" value="${val('notes', over?.notes)}" />
			<input type="text" id="np-sample" class="half" placeholder="Link to a sample (optional)" value="${val('sample', over?.sampleUrl)}" />
		</div>
		<div class="savenote">${
			over
				? `Overwrites <b>${esc(over.name)}</b> \u2014 the old version is kept in presets/_backups/.`
				: 'Saves a new preset.'
		} Stores the whole channel; ticked sections (${esc(on.join(', ') || 'none')}) become its defaults. Mic and style are how other people will find it \u2014 good ones are worth <a href="${LOOP_URL}" target="_blank" rel="noreferrer">sharing with the community</a> as a pack.</div>
		<div class="savepreview"></div>
	</div>`

	const preview = box.querySelector('.savepreview')
	if (src) renderStripCard(preview, src, { sections: state.sections, source: false, incoming: null })
	else preview.innerHTML = '<span class="off">Pick a channel on the left to save.</span>'

	$('#np-name').oninput = updateActionUI
	updateActionUI()
}

/**
 * The big button and Undo say what they will actually do, which depends on both columns.
 *
 * A button that cannot work is disabled rather than left clickable to throw an error — under time
 * pressure, a dead button that explains itself on hover beats a dialog that has to be dismissed.
 */
function updateActionUI() {
	const btn = $('#apply')
	if (!btn) return
	const anySection = Object.values(state.sections).some(Boolean)
	// The sample switcher exists to be looked at. Nothing may be written to it — there is nothing
	// there to write to.
	if (tourDemo) {
		btn.textContent = 'Copy →'
		btn.disabled = true
		btn.title = 'This is a sample switcher — connect your own to copy for real'
		const blend = $('#blend')
		blend.disabled = true
		blend.title = btn.title
		$('#undo').disabled = true
		$('#redo').disabled = true
		const swapBtn = $('#swap')
		if (swapBtn) swapBtn.style.display = 'none'
		return
	}
	$('#undo').disabled = false
	if (isLib('B')) {
		const over = currentPreset()
		btn.textContent = over ? `Overwrite \u201c${over.name}\u201d` : 'Save preset'
		btn.disabled = !sourceChannel()
		btn.title = btn.disabled ? 'Pick a channel on the left to save as a preset' : ''
	} else {
		const n = selectedKeys('B').length
		btn.textContent = n > 1 ? `Copy \u2192 ${n} channels` : 'Copy \u2192'
		const why = !sourceChannel() ? (isLib('A') ? 'Pick a preset on the left to copy from' : 'Pick a channel on the left to copy from') : !n ? 'Pick one or more channels on the right to copy onto' : !anySection ? 'Click at least one block on the left-hand card — Gain, EQ, Dynamics — to say what travels' : ''
		btn.disabled = Boolean(why)
		btn.title = why
	}
	$('#undo').style.display = isLib('B') ? 'none' : ''
	$('#redo').style.display = isLib('B') ? 'none' : ''
	const blendBtn = $('#blend')
	blendBtn.style.display = isLib('B') ? 'none' : ''
	// A blend mixes against each destination's own values, so several destinations give several
	// different results — and the preview card can only show one of them. One at a time.
	const dests = selectedKeys('B')
	const blendWhy = isLib('B')
		? ''
		: !sourceChannel()
			? isLib('A')
				? 'Pick a preset on the left to blend from'
				: 'Pick a channel on the left to blend from'
			: dests.length > 1
				? 'Blend works on one destination channel at a time — the mix depends on what is already there'
				: !dests.length
					? 'Pick the destination channel to blend with'
					: !anySection
						? 'Click at least one block on the left-hand card to say what blends'
						: ''
	blendBtn.disabled = Boolean(blendWhy)
	blendBtn.title = blendWhy || "Mix the source with each destination's own settings, by how much you choose"
	if (blendWhy) closeBlend()
	// Swapping only means something with two switchers connected; it lives beside the library button
	// now that the footer is brand and actions only.
	const swap = $('#swap')
	if (swap) swap.style.display = isLib('A') || isLib('B') || !state.two ? 'none' : ''
}

/**
 * A short message about the action just attempted.
 *
 * Warnings and failures surface as notifications now, so they cannot be missed at the bottom of the
 * window; the hidden status element stays for assistive technology and for clearing.
 */
function setStatus(text, cls) {
	// #status is an invisible aria-live region now — its only job is to announce to screen readers.
	// Everything visible goes to the top-right notification stack; nothing ever appears "below".
	const box = $('#status')
	if (box) box.textContent = text || ''
	if (text && (cls === 'warn' || cls === 'err')) notify(cls, text)
}

/** The left-hand half of the status bar: what is about to go where. */
function updateSummary() {
	const box = $('#summary')
	if (!box) return
	const names = { gain: 'Gain', volume: 'Volume', pan: 'Pan', eq: 'EQ', dynamics: 'Dynamics', inputConfig: 'Input' }
	const on = Object.entries(state.sections)
		.filter(([, v]) => v)
		.map(([k]) => names[k])
	const secs = on.length ? `<span class="secs">${esc(on.join(', '))}</span>` : '<span class="none">nothing ticked</span>'

	const src = isLib('A')
		? currentPreset()
			? `preset <b>${esc(currentPreset().name)}</b>`
			: null
		: state.A.detail
			? `<b>${esc(state.A.detail.meta.label)}</b>`
			: null

	// Saving into the library: no destination channels, and sections are only defaults.
	if (isLib('B')) {
		const over = currentPreset()
		box.innerHTML = !src
			? 'Pick a channel on the left to save as a preset.'
			: `${src} \u2192 ${over ? `overwrite <b>${esc(over.name)}</b>` : 'new preset'} \u00b7 defaults: ${secs}`
		return
	}

	const dests = selectedKeys('B')
	if (!src || !dests.length) {
		box.innerHTML = !src
			? isLib('A')
				? 'Pick a preset on the left.'
				: 'Pick a channel on the left to copy from.'
			: 'Pick one or more destination channels on the right.'
		return
	}
	const to = dests.length === 1 ? `<b>${esc(channelFor('B', dests[0])?.label ?? '')}</b>` : `<b>${dests.length} channels</b>`
	box.innerHTML = `${src} \u2192 ${to}${state.two ? ` on ${esc(state.B.ip)}` : ''} \u00b7 ` + secs
}

// ------------------------------------------------------------------ copy

function sections() {
	return { ...state.sections }
}

/** Every destination strip the copy will land on — one, or the whole multi-selection. */
function destinations() {
	const s = state.B
	const keys = selectedKeys('B')
	if (!keys.length) throw new Error('Pick one or more destination channels (⌘-click or shift-click for several)')
	return keys.map((k) => {
		const c = channelFor('B', k)
		return { ip: s.ip, input: c.inputId, source: c.sourceId, label: c.label }
	})
}

const describeTarget = (t) => `${t.label} (${t.input}:${t.source})`

/** What is being pasted: the selected preset, or the live left-hand channel. */
function payloadRef() {
	if (isLib('A')) {
		const p = currentPreset()
		if (!p?.channel) throw new Error('Pick a preset in the left column')
		return { payload: p.channel, describe: `preset “${p.name}”` }
	}
	const s = state.A
	const key = selectedKeys('A')[0]
	if (!key) throw new Error('Pick a channel in the left column')
	const c = channelFor('A', key)
	return { from: { ip: s.ip, input: c.inputId, source: c.sourceId }, describe: `${s.ip} ${c.label}` }
}

/** The last successful copy, kept so Redo can replay it after an Undo. Invalidated by any new copy. */
let lastApply = null

async function apply() {
	// Destination decides the verb: a switcher gets a copy, the library gets a save.
	if (isLib('B')) return savePresetFlow()
	const btn = $('#apply')
	// A copy (or its confirmation) is already under way — a second click must not start another.
	if (btn.disabled) return
	// A plain copy replaces outright — it is not a blend, so leave blend mode rather than let the
	// bar sit open over a preview that no longer describes what just happened.
	closeBlend()
	let to, src
	try {
		to = destinations()
		src = payloadRef()
	} catch (e) {
		log(esc(e.message), 'err')
		showResult()
		return
	}
	const list = Object.entries(sections())
		.filter(([, v]) => v)
		.map(([k]) => k)
	if (!list.length) return log('Nothing selected to copy.', 'warn')

	// Hold Copy disabled from here through the whole preview + confirm + write, so a double-click
	// during the preview round-trip cannot launch two overlapping copies.
	btn.disabled = true
	try {
		// Count the changes first, so the confirmation says how much is actually moving.
		let changes = null
		try {
			const pre = await api('/api/preview', { method: 'POST', body: JSON.stringify({ ...src, to, sections: sections() }) })
			changes = pre.results.reduce((n, r) => n + r.diff.length, 0)
		} catch {
			/* preview is a courtesy — if it fails, still offer the copy */
		}
		const ok = await askBar(
			to.length === 1 ? `Copy onto ${to[0].label}?` : `Copy onto ${to.length} channels?`,
			`${list.join(', ')}${changes === null ? '' : ` · ${changes} field${changes === 1 ? '' : 's'} change`} · every destination is backed up first.`,
			to.length === 1 ? 'Copy' : `Copy to ${to.length}`
		)
		if (!ok) return
		await performCopy(src, to, list)
	} finally {
		// performCopy manages the button around the write itself; recompute from state so the button
		// ends up correct whether the user cancelled, the copy ran, or an error was thrown.
		updateActionUI()
	}
}

/** Sends one copy and reports the outcome — shared by a confirmed Copy and by Redo, which replays
 *  the same request without asking again (it already asked, the first time). */
async function performCopy(src, to, list) {
	hideOutcome()
	$('#apply').disabled = true
	const endProgress = showProgress(to, to.length === 1 ? `Copying onto ${to[0].label}` : `Copying onto ${to.length} channels`)
	let wrote = false
	try {
		const body = await api('/api/apply', { method: 'POST', body: JSON.stringify({ ...src, to, sections: sections() }) })
		clearLog()
		// Logged newest-first, so build each destination's block in reverse to read top-down.
		for (const r of [...body.results].reverse()) {
			if (!r.ok) {
				log(`✗ ${esc(describeTarget(r.to))}: ${esc(r.error)}`, 'err')
				continue
			}
			log(`<span class="off">Backup: presets/_backups/${esc(r.backupFile)}</span>`)
			if (r.remaining?.length) {
				log(diffTable(r.remaining))
				log(
					`⚠ ${esc(r.label)}: read-back shows these fields did not take — usually the switcher clamping a value ` +
						`outside what this input accepts (a mic strip's +40 dB gain onto a camera input that stops at +6 dB, say).`,
					'warn'
				)
			} else {
				log(`✓ ${esc(describeTarget(r.to))} — verified by read-back.`, 'ok')
			}
			for (const s of r.skipped) log(`<span class="off">${esc(r.label)}: skipped ${esc(s)}</span>`, 'warn')
			for (const w of r.warnings) log(`⚠ ${esc(r.label)}: ${esc(w)}`, 'warn')
		}
		const good = body.results.filter((r) => r.ok && !r.remaining?.length).length
		const failed = body.results.filter((r) => !r.ok)
		const clamped = body.results.filter((r) => r.ok && r.remaining?.length)
		const n = body.results.length
		log(
			`<strong>Copied</strong> ${esc(src.describe)} → ${esc(to[0].ip)}: ${good}/${n} channel${n === 1 ? '' : 's'} verified.`,
			good === n ? 'ok' : 'warn'
		)
		// Read-back is the whole point of this tool, so the outcome is said in full, in words, above
		// the status bar — the drawer keeps the field-by-field evidence for whoever wants it.
		const secs = list.map((k) => SECTION_NAMES[k]).join(', ')
		if (failed.length) {
			setStatus(`${failed.length} of ${n} failed`, 'err')
			showOutcome('err', `Copy failed on ${failed.length} of ${n} channel${n === 1 ? '' : 's'}`, failed.map((r) => `${r.to.label}: ${r.error}`).join(' · '), { details: true, undo: good > 0 })
		} else if (clamped.length) {
			const fields = clamped.reduce((t, r) => t + r.remaining.length, 0)
			setStatus(`${good}/${n} verified`, 'warn')
			showOutcome(
				'warn',
				`Copied to ${n} channel${n === 1 ? '' : 's'} — ${fields} field${fields === 1 ? '' : 's'} did not take`,
				`${clamped.map((r) => r.label).join(', ')}: the switcher clamped a value this input will not accept. Everything else was read back and matches.`,
				{ details: true, undo: true }
			)
		} else {
			setStatus(`${good}/${n} verified by read-back`, 'ok')
			showOutcome('ok', `Copied to ${n} channel${n === 1 ? '' : 's'} — read back and verified`, `${secs} now match ${src.describe}. Every destination was backed up first.`, { details: true, undo: true, support: true })
		}
		// A fresh copy is what Redo replays next time; a new one replaces whatever it could have redone.
		lastApply = { src, to, list }
		$('#redo').disabled = true
		wrote = true
	} catch (e) {
		log(esc(e.message), 'err')
		setStatus('')
		// Nothing was written, so there is no outcome to report — just a failure to acknowledge.
		showError('The copy did not run', e.message)
	} finally {
		endProgress()
		$('#apply').disabled = false
	}
	// Re-reading the lists is a courtesy that runs AFTER the copy is done and reported. Keep it out of
	// the try above: a transient failure here (someone grabbing the switcher's last control connection
	// in the moment after the write) must not be reported as "the copy did not run" — it succeeded and
	// was read back and verified.
	if (wrote) {
		try {
			await refreshAfterWrite()
		} catch {
			setStatus('Copied and verified, but re-reading the switcher failed — press Connect to refresh the lists', 'warn')
		}
	}
}

/** Replays the last completed copy — what Undo just undid, redone. Available only right after an
 *  Undo of that same copy; a new Copy or a second Redo uses it up. */
async function redo() {
	if (!lastApply || $('#redo').disabled) return
	$('#redo').disabled = true
	await performCopy(lastApply.src, lastApply.to, lastApply.list)
}

// ------------------------------------------------------------------ blend

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const wavg = (av, bv, t) => Math.round(av + (bv - av) * t)

let blendOpen = false
let blendRatio = 50 // 0 = all source, 100 = all destination

/**
 * Mix a with b at ratio t (0 = all a, 1 = all b): every numeric setting in a ticked section
 * becomes the weighted average. On/off state is never averaged — an enable flag has no halfway
 * position, and "which units are on" is what defines the sound the user dialled in — so those
 * always come from the source, at any ratio. Input configuration cannot be blended either — a
 * wiring mode is not a number — so when ticked it behaves like an ordinary copy.
 */
function blendChannel(a, b, sec, t = 0.5) {
	const out = JSON.parse(JSON.stringify(a))
	const mixIf = (oa, ob, key) => (isNum(oa?.[key]) && isNum(ob?.[key]) ? wavg(oa[key], ob[key], t) : oa?.[key])
	if (sec.gain) {
		out.levels.gain = mixIf(a.levels, b.levels, 'gain')
		out.levels.framesDelay = mixIf(a.levels, b.levels, 'framesDelay')
		out.levels.stereoSimulation = mixIf(a.levels, b.levels, 'stereoSimulation')
	}
	if (sec.volume) out.levels.faderGain = mixIf(a.levels, b.levels, 'faderGain')
	if (sec.pan) out.levels.balance = mixIf(a.levels, b.levels, 'balance')
	if (sec.eq) {
		out.eq.gain = mixIf(a.eq, b.eq, 'gain')
		out.eq.enabled = a.eq?.enabled
		const n = Math.min(a.eq?.bands?.length ?? 0, b.eq?.bands?.length ?? 0)
		const destEqLive = Boolean(b.eq?.enabled)
		for (let i = 0; i < n; i++) {
			const ba = a.eq.bands[i]
			const bb = b.eq.bands[i]
			if (!ba || !bb) continue
			// A band the destination isn't using contributes nothing to blend toward — its stored
			// frequency and Q are leftovers. So it counts as 0 dB of gain (flat), and sliding
			// toward the destination pulls the band's lift or cut down to nothing rather than
			// dragging it to a stale setting. Frequency and Q hold the source's, since a band with
			// no gain has no audible frequency to average against.
			const destLive = destEqLive && bb.bandEnabled
			const destGain = destLive ? bb.gain : 0
			out.eq.bands[i] = {
				...ba,
				bandEnabled: ba.bandEnabled,
				frequency: destLive ? mixIf(ba, bb, 'frequency') : ba.frequency,
				gain: isNum(ba.gain) && isNum(destGain) ? wavg(ba.gain, destGain, t) : ba.gain,
				qFactor: destLive ? mixIf(ba, bb, 'qFactor') : ba.qFactor,
			}
		}
	}
	if (sec.dynamics) {
		out.dynamics.makeUpGain = mixIf(a.dynamics, b.dynamics, 'makeUpGain')
		for (const unit of ['compressor', 'limiter', 'expander']) {
			const ua = a.dynamics?.[unit]
			const ub = b.dynamics?.[unit]
			if (!ua || !ub) continue
			const merged = { ...ua }
			for (const k of Object.keys(ua)) {
				// Numbers blend; flags and modes stay as the source has them.
				if (typeof ua[k] === 'number' && typeof ub[k] === 'number') merged[k] = wavg(ua[k], ub[k], t)
			}
			out.dynamics[unit] = merged
		}
	}
	return out
}

/** The live preview shown on the destination card while the blend bar is open: the source mixed
 *  with THIS destination's own values, at the current slider position. */
function blendPreviewFor(destChannel) {
	const src = isLib('A') ? currentPreset()?.channel : state.A.detail
	if (!src || !destChannel) return null
	return blendChannel(src, destChannel, state.sections, blendRatio / 100)
}

function toggleBlend() {
	if (isLib('B')) return setStatus('Blend needs a destination switcher, not the preset library', 'warn')
	blendOpen = !blendOpen
	$('#blend').classList.toggle('on', blendOpen)
	renderBlendBar()
	renderDetail('B')
}

function closeBlend() {
	if (!blendOpen) return
	blendOpen = false
	$('#blend').classList.remove('on')
	renderBlendBar()
	renderDetail('B')
}

/** The bar itself: source ↔ destination slider, a live readout, and Apply/Cancel — no modal, no
 *  separate confirmation step. Seeing the preview change as you drag *is* the confirmation. */
function renderBlendBar() {
	const bar = $('#blendbar')
	if (!bar) return
	if (!blendOpen) {
		bar.hidden = true
		bar.textContent = ''
		return
	}
	bar.hidden = false
	const list = Object.entries(state.sections)
		.filter(([, v]) => v)
		.map(([k]) => SECTION_NAMES[k])
	bar.innerHTML = `
		<div class="blendhead">
			<b>Blend</b>
			<span class="blendsub">Slide toward either side to mix the numbers — the card below previews it live. Which units are on always comes from the source.</span>
			<button class="blendx" aria-label="Close blend, without applying it">×</button>
		</div>
		<div class="blendrow">
			<span class="blendend src">Source</span>
			<input type="range" id="blend-slider" min="0" max="100" step="1" value="${blendRatio}" aria-label="Blend ratio, source to destination" />
			<span class="blendend dst">Destination</span>
		</div>
		<div class="blendfoot">
			<span class="blendnote">${list.length ? `Sections: ${esc(list.join(', '))}` : 'Nothing ticked — pick sections on the source card first.'}${state.sections.inputConfig ? ' · input configuration always comes from the source' : ''}</span>
			<div class="blendacts"><button class="blendcancel">Cancel</button><button class="primary blendgo">Apply blend</button></div>
			<span class="blendfootpad"></span>
		</div>`
	const readout = () => {
		const dst = blendRatio
		const src = 100 - dst
		bar.querySelector('.blendend.src').textContent = `Source ${src}%`
		bar.querySelector('.blendend.dst').textContent = `Destination ${dst}%`
		// The button carries the mix it will apply: source blue at one end, destination red at the
		// other, so the colour alone says which way this blend leans.
		const go = bar.querySelector('.blendgo')
		const t = dst / 100
		const from = [87, 193, 253]
		const to = [255, 61, 46]
		const mix = from.map((c, i) => Math.round(c + (to[i] - c) * t))
		go.style.background = `rgb(${mix.join(',')})`
		go.style.borderColor = `rgb(${mix.join(',')})`
		// Both ends are light enough to need dark text.
		go.style.color = '#0a1016'
	}
	readout()
	const slider = bar.querySelector('#blend-slider')
	slider.oninput = (e) => {
		blendRatio = Number(e.target.value)
		readout()
		renderDetail('B')
	}
	bar.querySelector('.blendx').onclick = closeBlend
	bar.querySelector('.blendcancel').onclick = closeBlend
	bar.querySelector('.blendgo').onclick = applyBlend
}

/** Meet in the middle: mix the source with each destination's own settings at the chosen ratio,
 *  rather than replacing the destination outright. Each destination blends against its own
 *  current values, so this is one /api/apply call per destination even when several are selected. */
async function applyBlend() {
	const srcChannel = isLib('A') ? currentPreset()?.channel : state.A.detail
	if (!srcChannel) return setStatus(isLib('A') ? 'Pick a preset on the left first' : 'Pick a channel on the left first', 'warn')
	let to
	try {
		to = destinations()
	} catch (e) {
		setStatus(e.message, 'warn')
		return
	}
	// A blend mixes against each destination's own values, so several destinations give several
	// different results — and only one /api/apply retains a backup for Undo. The action UI disables
	// Blend for multiple destinations, but that only lands after the selection's read completes, so
	// guard here too: between the ⌘-click and the response the bar is briefly clickable with two.
	if (to.length > 1) return setStatus('Blend works on one destination channel at a time — the mix depends on what is already there.', 'warn')
	const secObj = state.sections
	const list = Object.entries(secObj)
		.filter(([, v]) => v)
		.map(([k]) => k)
	if (!list.length) return setStatus('Tick a section on the source card first.', 'warn')
	const ratio = blendRatio / 100
	const describeSrc = isLib('A') ? `preset “${currentPreset().name}”` : `${state.A.ip} ${srcChannel.meta.label}`

	hideOutcome()
	$('#apply').disabled = true
	$('.blendgo').disabled = true
	const endProgress = showProgress(to, to.length === 1 ? `Blending with ${to[0].label}` : `Blending onto ${to.length} channels`)
	let wrote = false
	try {
		const results = []
		for (const t of to) {
			const destBody = await api(`/api/channel?ip=${encodeURIComponent(t.ip)}&input=${t.input}&source=${encodeURIComponent(t.source)}`)
			const blended = blendChannel(srcChannel, destBody.channel, secObj, ratio)
			const body = await api('/api/apply', { method: 'POST', body: JSON.stringify({ payload: blended, to: t, sections: secObj }) })
			results.push(...body.results)
		}
		clearLog()
		for (const r of [...results].reverse()) {
			if (!r.ok) {
				log(`✗ ${esc(describeTarget(r.to))}: ${esc(r.error)}`, 'err')
				continue
			}
			log(`<span class="off">Backup: presets/_backups/${esc(r.backupFile)}</span>`)
			if (r.remaining?.length) {
				log(diffTable(r.remaining))
				log(`⚠ ${esc(r.label)}: read-back shows these fields did not take.`, 'warn')
			} else {
				log(`✓ ${esc(describeTarget(r.to))} — blended and verified by read-back.`, 'ok')
			}
			for (const s of r.skipped) log(`<span class="off">${esc(r.label)}: skipped ${esc(s)}</span>`, 'warn')
			for (const w of r.warnings) log(`⚠ ${esc(r.label)}: ${esc(w)}`, 'warn')
		}
		const good = results.filter((r) => r.ok && !r.remaining?.length).length
		const failed = results.filter((r) => !r.ok)
		const n = results.length
		log(`<strong>Blended</strong> ${esc(describeSrc)} (${100 - blendRatio}/${blendRatio}) with ${n} channel${n === 1 ? '' : 's'}: ${good}/${n} verified.`, good === n ? 'ok' : 'warn')
		if (failed.length) {
			setStatus(`${failed.length} of ${n} failed`, 'err')
			showOutcome('err', `Blend failed on ${failed.length} of ${n} channel${n === 1 ? '' : 's'}`, failed.map((r) => `${r.to.label}: ${r.error}`).join(' · '), { details: true, undo: good > 0 })
		} else {
			setStatus(`${good}/${n} blended and verified`, 'ok')
			showOutcome('ok', `Blended onto ${n} channel${n === 1 ? '' : 's'}`, `${100 - blendRatio}% source / ${blendRatio}% destination on ${list.map((k) => SECTION_NAMES[k]).join(', ')}.`, { details: true, undo: true })
		}
		lastApply = null
		$('#redo').disabled = true
		closeBlend()
		wrote = true
	} catch (e) {
		log(esc(e.message), 'err')
		setStatus('')
		showError('The blend did not run', e.message)
	} finally {
		endProgress()
		$('#apply').disabled = false
		// Re-enable the blend bar's own button — the failure path leaves the bar open, and nothing
		// else restores it (only closeBlend, which the success path calls, rebuilds the bar).
		const go = $('#blendbar .blendgo')
		if (go) go.disabled = false
	}
	// Refresh outside the try: a failed read-back of the lists must not read as a failed blend.
	if (wrote) {
		try {
			await refreshAfterWrite()
		} catch {
			setStatus('Blended and verified, but re-reading the switcher failed — press Connect to refresh the lists', 'warn')
		}
	}
}

/** Write the current source channel into the library, as a new preset or over an existing one. */
async function savePresetFlow() {
	const src = sourceChannel()
	if (!src) return setStatus('Pick a channel on the left to save', 'warn')
	const name = $('#np-name')?.value.trim()
	if (!name) {
		setStatus('Give the preset a name', 'warn')
		$('#np-name')?.focus()
		return
	}
	const group = $('#np-group')?.value.trim() ?? ''
	// What the preset was made with and for. All optional — but they are what turns a pile of
	// numbers into something another person can find, judge and trust.
	const mic = $('#np-mic')?.value.trim() || null
	const style = $('#np-style')?.value.trim() || null
	const notes = $('#np-notes')?.value.trim() || null
	const sampleUrl = $('#np-sample')?.value.trim() || null
	const over = currentPreset()
	let overFile = over ? state.library.selectedFile : null

	if (overFile) {
		const ok = await askConfirm(
			'Overwrite this preset?',
			`<p><b>${esc(over.name)}</b> will be replaced by <b>${esc(src.meta.label)}</b>.</p>` +
				`<p class="muted">The old version is kept in presets/_backups/.</p>`,
			'Overwrite'
		)
		if (!ok) return
	} else {
		// A brand-new save whose name matches an existing preset would silently replace that file
		// server-side (it derives the same file name). Catch the collision and confirm first — and
		// reuse the existing file so the server overwrites the right one deterministically.
		const clash = state.library.presets.find((p) => (p.name ?? '').trim().toLowerCase() === name.toLowerCase())
		if (clash) {
			const ok = await askConfirm(
				'Replace existing preset?',
				`<p>A preset named <b>${esc(clash.name)}</b> already exists.</p>` +
					`<p class="muted">Saving replaces it — the old version is kept in presets/_backups/.</p>`,
				'Replace'
			)
			if (!ok) return
			overFile = clash.file
		}
	}

	$('#apply').disabled = true
	try {
		// A preset always stores the whole channel; the ticks travel as its defaults.
		const body = await api('/api/presets', {
			method: 'POST',
			body: JSON.stringify({
				name,
				group,
				defaultSections: sections(),
				overwrite: overFile,
				payload: { format: 'atem-audio-preset', version: 1, channel: src, device: state.A.device ?? { ip: state.A.ip }, mic, style, notes, sampleUrl },
			}),
		})
		await loadPresets()
		state.library.selectedFile = body.file
		state.library.cache[body.file] = null
		delete state.library.cache[body.file]
		renderSideAll('B')
		// Echo the name the server actually stored \u2014 safeName may have stripped characters (an
		// apostrophe, say), so the toast must not claim a name the file was not saved under.
		const savedName = body.name ?? name
		setStatus(`\u2713 Saved preset \u201c${savedName}\u201d`, 'ok')
		showOutcome('ok', `Saved “${savedName}”`, `The whole channel is stored. ${Object.entries(sections()).filter(([, v]) => v).map(([k]) => SECTION_NAMES[k]).join(', ') || 'No section'} will come back ticked when you use it.`)
		log(`Saved preset \u201c${esc(savedName)}\u201d from ${esc(src.meta.label)}${group ? ` in group ${esc(group)}` : ''}.`, 'ok')
	} catch (e) {
		setStatus(e.message, 'err')
		log(esc(e.message), 'err')
		showResult()
	} finally {
		$('#apply').disabled = false
	}
}

async function refreshSide(side) {
	const s = state[side]
	if (!s.ip || isLib(side)) return
	// A strip can vanish between reads if the input's configuration changed, so keep only the
	// keys that still exist rather than pointing at a dead source id.
	const keep = s.selection
	const body = await api(`/api/switcher?ip=${encodeURIComponent(s.ip)}`)
	s.channels = body.channels
	s.selection = keep.filter((k) => s.channels.some((c) => c.key === k))
	if (!s.selection.includes(s.anchor)) s.anchor = s.selection[0] ?? null
	renderChannels(side)
	renderSelectionCount(side)
	const last = s.selection[s.selection.length - 1]
	if (last) await loadDetail(side, last)
	else renderDetail(side)
}

async function undo() {
	const s = state.B
	// Route this through setStatus, not a bare log() — the log drawer ships hidden, so a log-only
	// message made Undo with no destination connected look like it did nothing at all.
	if (!s.ip) return setStatus('Connect the destination switcher first', 'err')
	const ok = await askConfirm(
		'Undo the last copy?',
		`<p>Restores the channel on <strong>${esc(s.ip)}</strong> to how it was before the last copy.</p>`,
		'Undo'
	)
	if (!ok) return
	hideOutcome()
	const endProgress = showProgress([{ label: `the last copy on ${s.ip}` }], 'Restoring the backup')
	let restored = false
	try {
		const body = await api('/api/undo', { method: 'POST', body: JSON.stringify({ ip: s.ip }) })
		const names = body.restored.map((m) => `${m.label} (${m.inputId}:${m.sourceId})`)
		setStatus(`\u21b6 Restored ${names.length} channel${names.length === 1 ? '' : 's'}`, 'ok')
		log(`Restored ${names.length} channel${names.length === 1 ? '' : 's'} on ${esc(s.ip)}: ${esc(names.join(', '))}.`, 'ok')
		for (const r of body.results.filter((r) => !r.ok)) log(`✗ ${esc(r.meta.label)}: ${esc(r.error)}`, 'err')
		// The copy this just undid can be redone — but only that one, and only until something else happens.
		$('#redo').disabled = !(lastApply && lastApply.to[0]?.ip === s.ip)
		showOutcome('ok', `Put back ${names.length} channel${names.length === 1 ? '' : 's'}`, `${names.join(', ')} — restored from the backup taken before the copy.`, { details: true })
		restored = true
	} catch (e) {
		log(esc(e.message), 'err')
		showError('Could not undo', e.message)
	} finally {
		endProgress()
	}
	// Refresh outside the try: a failed read-back must not read as "could not undo" after the restore
	// in fact succeeded (which would invite a second undo that fails with "No backup recorded").
	if (restored) {
		try {
			await refreshAfterWrite()
		} catch {
			setStatus('Undone, but re-reading the switcher failed — press Connect to refresh the lists', 'warn')
		}
	}
}

// ------------------------------------------------------------------ presets

async function loadPresets() {
	try {
		const body = await api('/api/presets')
		state.library.presets = body.presets
		// Drop cached bodies for presets that no longer exist.
		for (const f of Object.keys(state.library.cache)) {
			if (!body.presets.some((p) => p.file === f)) delete state.library.cache[f]
		}
		if (state.library.selectedFile && !presetRow(state.library.selectedFile)) state.library.selectedFile = null
	} catch (e) {
		log(`Could not read the preset library: ${esc(e.message)}`, 'err')
	}
	for (const side of ['A', 'B']) if (isLib(side)) renderSideAll(side)
	updateSummary()
	updateActionUI()
}

function download(filename, body) {
	const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })
	const a = document.createElement('a')
	a.href = URL.createObjectURL(blob)
	a.download = filename
	a.click()
	URL.revokeObjectURL(a.href)
}

// ------------------------------------------------------------------ wiring

/**
 * The address box is a typed field with a memory. Not everyone knows their switcher's address by
 * heart, and typing four numbers under time pressure is the first place this app can waste
 * someone's evening — so the ▾ offers what it already knows: addresses used before, the other
 * column's switcher, and the address every ATEM ships with.
 */
function openIpMenu(side) {
	document.querySelector('.ipdrop')?.remove()
	const p = panel(side)
	const btn = p.querySelector('.ipmenu')
	const input = p.querySelector('.ip')
	const other = panel(side === 'A' ? 'B' : 'A').querySelector('.ip').value.trim()
	const drop = el('div', 'ipdrop')

	const closeMenu = () => {
		drop.remove()
		btn.setAttribute('aria-expanded', 'false')
	}
	const pick = (ip) => {
		input.value = ip
		closeMenu()
		connectSide(side)
	}
	const addRow = (cls, main, note, onclick) => {
		const row = el('button', `ipdroprow${cls ? ' ' + cls : ''}`)
		row.innerHTML = `<b>${esc(main)}</b><span>${esc(note)}</span>`
		row.onclick = onclick
		drop.append(row)
		return row
	}

	// A fake switcher to explore with — always available, needs no network.
	addRow('sample', 'Sample switcher', 'a fake ATEM, for trying things out', () => {
		closeMenu()
		if (!tourDemo) enterTourDemo()
	})

	// If this column is on a real switcher, offer to let it go.
	if (state[side].device && state[side].ip && state[side].ip !== 'sample') {
		addRow('disconnectrow', `Disconnect ${state[side].ip}`, 'free the switcher for another app', () => {
			closeMenu()
			disconnectSwitcher(side)
		})
	}

	// Live discovery drops in above the remembered addresses as it finds things.
	const scanning = el('div', 'ipdrophelp scanning', 'Looking for switchers on the network…')
	drop.append(scanning)

	for (const ip of recentIps()) addRow('', ip, 'used before', () => pick(ip))
	if (other && other !== 'sample' && !recentIps().includes(other)) addRow('', other, 'the other column', () => pick(other))
	if (!recentIps().includes('192.168.10.240')) addRow('', '192.168.10.240', 'ATEM factory default', () => pick('192.168.10.240'))
	drop.append(el('div', 'ipdrophelp', 'ATEM Setup lists the address under the switcher’s name.'))

	p.querySelector('.conn').append(drop)
	btn.setAttribute('aria-expanded', 'true')
	const away = (ev) => {
		if (drop.contains(ev.target)) return
		closeMenu()
		document.removeEventListener('click', away)
	}
	setTimeout(() => document.addEventListener('click', away), 0)

	// Ask the server to sweep the network. Found switchers appear at the top; addresses already in
	// the list are not repeated.
	discoverAtems().then((atems) => {
		if (!drop.isConnected) return
		scanning.remove()
		const already = new Set([...drop.querySelectorAll('.ipdroprow b')].map((b) => b.textContent))
		let anchor = drop.querySelector('.disconnectrow') || drop.querySelector('.ipdroprow.sample')
		for (const a of atems) {
			if (already.has(a.ip)) continue
			const row = addRow('found', a.ip, `${a.model}${a.via === 'mdns' || String(a.via).includes('mdns') ? ' · found live' : ' · on the network'}`, () => pick(a.ip))
			anchor.after(row)
			anchor = row
		}
		if (!atems.length) drop.querySelector('.ipdrophelp:last-of-type')?.before(el('div', 'ipdrophelp', 'No switchers found automatically — type the address above.'))
	})
}

/** Ask the server to find ATEMs, seeding the sweep with the addresses this app has used before. */
async function discoverAtems() {
	try {
		const hints = recentIps().join(',')
		const r = await api(`/api/discover?hints=${encodeURIComponent(hints)}`)
		return r.atems ?? []
	} catch {
		return []
	}
}

/** Let a switcher go — the ATEM allows only a few control connections, so freeing one matters. */
async function disconnectSwitcher(side) {
	const ip = state[side].ip
	if (!ip || ip === 'sample') return
	try {
		await api('/api/disconnect', { method: 'POST', body: JSON.stringify({ ip }) })
	} catch {
		/* best-effort — the pool may already be closed */
	}
	// In one-switcher mode both columns share the connection, so reset both.
	for (const s of state.two ? [side] : ['A', 'B']) {
		state[s].device = null
		state[s].channels = []
		state[s].selection = []
		state[s].detail = null
		panel(s).querySelector('.device').innerHTML = '<span class="off">Not connected</span>'
		if (!isLib(s)) renderSideAll(s)
	}
	notify('ok', `Disconnected ${ip}`)
}

for (const side of ['A', 'B']) {
	const p = panel(side)
	const saved = localStorage.getItem(`${LS}.ip.${side}`)
	p.querySelector('.ip').value = saved ?? ''
	p.querySelector('.connect').onclick = () => connectSide(side)
	p.querySelector('.ip').onkeydown = (e) => {
		if (e.key === 'Enter') connectSide(side)
	}
	p.querySelector('.ipmenu').onclick = (e) => {
		e.stopPropagation()
		openIpMenu(side)
	}
	for (const btn of p.querySelectorAll('.kind')) btn.onclick = () => setKind(side, btn.dataset.kind)
	state[side].multi = side === 'B' && !isLib('B')
	renderSideAll(side)
}

applyMode()

$('#swap').onclick = () => {
	const a = panel('A').querySelector('.ip').value
	panel('A').querySelector('.ip').value = panel('B').querySelector('.ip').value
	panel('B').querySelector('.ip').value = a
	connectSide('A')
	connectSide('B')
}
$('#apply').onclick = apply
$('#undo').onclick = undo
$('#redo').onclick = redo
$('#blend').onclick = toggleBlend
async function importFile(e) {
	const input = e.target
	const file = input.files[0]
	if (!file) return
	// A malformed file must fail loudly, not silently: JSON.parse throws on bad JSON and the api()
	// calls can reject. Wrap the whole thing, and reset the input in a finally so re-picking the same
	// file fires change again.
	try {
		const body = JSON.parse(await file.text())
		if (body.format === 'atem-audio-preset-pack' || Array.isArray(body.presets)) {
			const r = await api('/api/presets/import', { method: 'POST', body: JSON.stringify({ pack: body }) })
			await loadPresets()
			setStatus(`Imported ${r.imported.length} preset${r.imported.length === 1 ? '' : 's'}`, 'ok')
			log(`Imported <strong>${r.imported.length}</strong> preset${r.imported.length === 1 ? '' : 's'} from “${esc(body.name ?? file.name)}”.`, 'ok')
			for (const s of r.skipped) log(`Skipped “${esc(s)}” — no channel data.`, 'warn')
		} else if (body.channel) {
			// An imported preset joins the library like any other; it is not a separate mode.
			const name = body.name ?? file.name.replace(/\.json$/, '')
			await api('/api/presets', {
				method: 'POST',
				body: JSON.stringify({ name, group: body.group ?? '', defaultSections: body.defaultSections ?? sections(), payload: body }),
			})
			await loadPresets()
			setStatus(`Imported preset “${name}”`, 'ok')
			log(`Imported “${esc(name)}” into the preset library.`, 'ok')
		} else {
			setStatus('That file is not a preset or a preset pack', 'err')
			log('That file is not a preset or a preset pack.', 'err')
		}
	} catch (err) {
		setStatus('Could not import that file', 'err')
		log(`Could not import that file: ${esc(err.message)}`, 'err')
	} finally {
		input.value = ''
	}
}

$('#help-open').onclick = () => toggleHelp()

const logClose = $('#logclose')
if (logClose)
	logClose.onclick = () => {
		$('#logbox').hidden = true
	}

const loadFileInput = $('#load-file')
if (loadFileInput) loadFileInput.onchange = importFile

// A block *is* the control: click anywhere in one on the source card to include or exclude that
// section from the copy.
document.addEventListener('click', (e) => {
	if (!e.target.closest('#panel-A .stripcard.selectable')) return
	const block = e.target.closest('.block[data-sec]')
	if (!block) return
	const name = block.dataset.sec
	const hadFocus = document.activeElement === block
	state.sections[name] = !state.sections[name]
	renderDetail('A')
	renderDetail('B')
	// The status bar names what travels, so it has to follow the ticks.
	updateSummary()
	// With nothing ticked there is nothing to copy — the buttons say so by going dead.
	updateActionUI()
	if (hadFocus) document.querySelector(`#panel-A .block[data-sec="${name}"]`)?.focus()
})

// Keyboard equivalents. A block is a checkbox, so space and enter toggle it; the channel lists
// are listboxes, so the arrows move through them and enter picks.
document.addEventListener('keydown', (e) => {
	if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
	const block = e.target.closest?.('#panel-A .stripcard.selectable .block[data-sec]')
	if (block && (e.key === 'Enter' || e.key === ' ')) {
		e.preventDefault()
		block.click()
		return
	}
	const row = e.target.closest?.('.chan')
	if (!row) return
	const side = e.target.closest('#panel-B') ? 'B' : 'A'
	const rows = [...panel(side).querySelectorAll('.chan')]
	const i = rows.indexOf(row)
	if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		e.preventDefault()
		const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
		if (!next) return
		for (const r of rows) r.tabIndex = r === next ? 0 : -1
		next.focus()
		return
	}
	e.preventDefault()
	const key = row.dataset.key
	if (!key) return
	// Pass the real KeyboardEvent through so its ⌘/ctrl/shift state reaches selectChannel's
	// multi-select branches — row.click() would synthesise a modifier-less MouseEvent, collapsing
	// every keyboard Enter/Space to a single selection despite aria-multiselectable. Preset rows keep
	// their own click handler (selectChannel bails for the library side).
	if (isLib(side)) row.click()
	else selectChannel(side, key, e)
	// The list is rebuilt by the selection, so put focus back on the same strip.
	setTimeout(() => [...panel(side).querySelectorAll('.chan')].find((r) => r.dataset.key === key)?.focus(), 0)
})

updateSummary()
loadPresets()

/**
 * The ask, in the author's own voice, before the GitHub page.
 *
 * Sending someone straight to a sponsors page asks them to work out what they are looking at and
 * what they are meant to do. This says who made the thing, why it exists, and what to pick when
 * they get there — then hands them over. It is a lightbox rather than a link because the one moment
 * it has is the moment they were already curious enough to click.
 */
function openSupport() {
	const overlay = el('div', 'modal-overlay')
	const box = el('div', 'modal modal-support')
	box.innerHTML =
		'<div class="suphead"><img class="supface" src="ryan-avatar.png" alt="Ryan, who makes this" width="60" height="60" />' +
		'<div><h3>Thanks for asking</h3><p class="supwho">Ryan · Studio Upgrade</p></div></div>' +
		'<div class="modal-detail">' +
		'<p>I’m Ryan. I build studios and tools for small teams at Studio Upgrade, and I write things like this in the evenings, usually because I hit the problem myself, on a studio build, with a switcher and not enough time.</p>' +
		'<p>This one took a lot longer than it looks. The EQ and dynamics curves are real maths, matched against the hardware a dB at a time; every write is read back and checked, because an ATEM will simply ignore a value it does not like. That care is the whole point, and it is also why it is slow to make.</p>' +
		'<p>It is free, and it stays free. Sponsorship is what buys the evenings — it pays for the test hardware, and it decides whether the next thing gets built or stays on the list.</p>' +
		'<p class="supask"><b>If you want to help:</b> <b>$5 a month</b> is the one that actually makes a difference — it is small enough to forget and steady enough to plan around. A one-off tip is very welcome too, if monthly is not your thing.</p>' +
		'<p class="modal-note">The next page is GitHub Sponsors. You will see monthly tiers first; the one-time option is the <em>“Or, pay once”</em> section a little further down. You need a GitHub account, and it takes about a minute.</p>' +
		'<p>Either way — thank you for using it, and for reading this far.</p>' +
		'</div>'
	const actions = el('div', 'modal-actions')
	const later = el('button', null, 'Maybe later')
	const go = el('a', 'primary modal-cta', 'Open GitHub Sponsors')
	go.href = SUPPORT_URL
	go.target = '_blank'
	go.rel = 'noreferrer'
	actions.append(later, go)
	box.append(actions)
	overlay.append(box)
	document.body.append(overlay)
	go.focus()
	const done = () => {
		document.removeEventListener('keydown', onKey)
		overlay.remove()
	}
	const onKey = (e) => {
		if (e.key === 'Escape') done()
	}
	document.addEventListener('keydown', onKey)
	later.onclick = done
	go.onclick = done
	overlay.onclick = (e) => {
		if (e.target === overlay) done()
	}
}

const coffee = $('#coffee')
if (SUPPORT_URL)
	coffee.onclick = (e) => {
		e.preventDefault()
		openSupport()
	}
else coffee.remove()

// ------------------------------------------------------------------ addresses

/** Remember an address that actually worked, so it can be offered instead of retyped. */
function rememberIp(ip) {
	if (!ip) return
	const list = [ip, ...recentIps().filter((x) => x !== ip)].slice(0, 5)
	localStorage.setItem(`${LS}.recent`, JSON.stringify(list))
	renderRecent()
}

function renderRecent() {
	const dl = $('#recent-ips')
	if (!dl) return
	dl.innerHTML = recentIps()
		.map((ip) => `<option value="${esc(ip)}"></option>`)
		.join('')
}

// ------------------------------------------------------------------ hints

/**
 * The three things people miss — clickable blocks, multi-select destinations, and the
 * Switcher | Presets toggle. Shown one at a time as a floating coach-mark (see tips.js) that
 * points at the real control rather than pushing the layout around; each is gone for good once
 * dismissed.
 */
function renderCardHint(side) {
	// The tour owns the coach-mark layer while it runs. A stray hint fired from a re-render (the ghost
	// demo toggles blocks, which re-renders both cards) would replace the running tour step at step 4,
	// orphan the sequence — done() never runs, the seen-flag never sets, the sample switcher is left
	// stranded with Copy disabled — and auto-replay on every launch. So never hint during the tour.
	if (tourDemo) return
	if (side === 'A' && state.A.detail) {
		Tips.show({
			key: 'blocks',
			target: '#panel-A .stripcard.selectable .block[data-sec="gain"]',
			placement: 'right',
			title: "Copy as many settings as you'd like",
			text: 'Click any block on this card to include or leave it out of the copy. A green edge means the copy replaces it.',
		})
		return
	}
	if (side === 'B' && !isLib('B') && state.B.channels.length && selectedKeys('B').length < 2) {
		// One hint at a time: don't let the destination hint stomp the blocks hint before it has been
		// read (both share the single tip slot, and a replacement never marks the old one seen).
		if (state.A.detail && !Tips.isSeen('blocks')) return
		Tips.show({
			key: 'multi',
			target: '#panel-B .channel-list',
			placement: 'right',
			title: 'Copying onto several channels',
			text: `${MOD}-click adds one channel, shift-click takes a whole range.`,
		})
		return
	}
	if (side === 'A' && state.A.channels.length) {
		Tips.show({
			key: 'kinds',
			target: '#panel-A .kinds',
			placement: 'bottom',
			title: 'Switcher or presets, either column',
			text: 'Either column can hold the switcher’s channels or your saved presets — that is what this toggle does.',
		})
	}
}

// ------------------------------------------------------------------ empty and error states

function renderEmptyCard(side, box) {
	// A connect failure is a top-right notification now, not an in-card guide — so nothing special
	// here; the card just falls through to its normal "nothing selected / connect" prompt.
	if (!isLib(side) && !state[side].channels.length) {
		// Connected but nothing listed happens when this column was the library at connect time.
		if (state[side].device) {
			box.innerHTML = '<div class="guide quiet"><p class="glead">Press Connect to list this switcher\u2019s channels again.</p></div>'
			return
		}
		return renderFirstRun(side, box)
	}
	if (isLib(side) && !state.library.presets.filter((p) => p.format !== 'atem-audio-snapshot').length) return renderLibraryGuide(side, box)
	const what = isLib(side)
		? 'Pick a preset in the list on the left.'
		: side === 'A'
			? 'Pick the channel you want to copy from.'
			: `Pick the channels to copy onto — ${MOD}-click or shift-click for several.`
	box.innerHTML = `<div class="guide quiet"><p class="glead">${esc(what)}</p></div>`
}

/**
 * First run. Two empty columns and “Connect a switcher to begin” told a new user nothing about
 * what the app does or where to find an address — both of which fit in the space that was blank.
 */
// ------------------------------------------------------------------ tour sample switcher

/**
 * A pretend switcher, for the tour only.
 *
 * The tour is most useful on the machine that cannot reach a switcher — someone reading up before
 * the shoot, or with the studio network still unplugged. Empty columns make every step abstract, so
 * the tour fills them with a plausible ATEM: real value shapes, real curves, nothing on the
 * network. It is torn down the moment the tour ends, so nobody can mistake it for their own rig or
 * copy from it.
 */
const tourBand = (shape, frequency, gain, qFactor, bandEnabled = true) => ({
	bandEnabled,
	shape,
	frequencyRange: 4,
	frequency,
	gain,
	qFactor,
	supportedShapes: [1, 2, 4, 8, 16, 32],
	supportedFrequencyRanges: [1, 2, 4, 8],
})

function tourChannel(inputId, label, mic) {
	const eq = mic
		? { enabled: true, gain: 0, bands: [tourBand(16, 80, 0, 70), tourBand(4, 240, -350, 120), tourBand(4, 1200, 150, 90), tourBand(4, 3500, 250, 80), tourBand(32, 8000, 200, 70), tourBand(4, 12000, 0, 100, false)] }
		: { enabled: true, gain: 0, bands: [tourBand(4, 100, 0, 100), tourBand(4, 800, 0, 100), tourBand(4, 3000, 0, 100), tourBand(4, 9000, 0, 100)] }
	const dynamics = mic
		? {
				makeUpGain: 1077,
				expander: { expanderEnabled: true, gateEnabled: false, threshold: -4500, range: 2000, ratio: 200, attack: 100, hold: 1000, release: 10000 },
				compressor: { compressorEnabled: true, threshold: -2000, ratio: 300, attack: 200, hold: 1000, release: 12000 },
				limiter: { limiterEnabled: true, threshold: -1550, attack: 10, hold: 200, release: 5000 },
			}
		: {
				makeUpGain: 0,
				expander: { expanderEnabled: false, gateEnabled: false, threshold: -3500, range: 3000, ratio: 200, attack: 100, hold: 1000, release: 10000 },
				compressor: { compressorEnabled: false, threshold: -1500, ratio: 200, attack: 200, hold: 1000, release: 10000 },
				limiter: { limiterEnabled: false, threshold: -900, attack: 10, hold: 200, release: 5000 },
			}
	return {
		meta: {
			inputId,
			sourceId: '-256',
			label,
			inputType: mic ? 2 : 0,
			sourceType: mic ? 0 : 1,
			configuration: mic ? 1 : 2,
			inputLevel: mic ? 1 : 0,
			maxFramesDelay: 8,
			hasStereoSimulation: !mic,
			supportedMixOptions: [1, 2, 4],
			supportedConfigurations: mic ? [1, 2, 4] : [],
			supportedInputLevels: mic ? [1, 2, 4] : [],
		},
		levels: { gain: mic ? 4000 : 0, faderGain: mic ? 0 : -600, balance: 0, framesDelay: 0, stereoSimulation: 0, mixOption: 2 },
		eq,
		dynamics,
	}
}

const TOUR_DEFS = [
	[1001, 'Mic 1', true],
	[1002, 'Mic 2', true],
	[1, 'Camera 1', false],
	[2, 'Camera 2', false],
	[3, 'Camera 3', false],
	[4, 'Lectern', false],
]

function enterTourDemo() {
	if (tourDemo) return
	const channels = TOUR_DEFS.map(([inputId, label, mic]) => ({
		key: `${inputId}:-256`,
		inputId,
		sourceId: '-256',
		label,
		leg: null,
		minor: false,
		configurationLabel: mic ? 'Mono' : 'Stereo',
		summary: { eqActive: mic, eqBandsOn: mic ? 5 : 0, dynActive: mic },
	}))
	const bodies = {}
	for (const [inputId, label, mic] of TOUR_DEFS) bodies[`${inputId}:-256`] = tourChannel(inputId, label, mic)
	const device = { model: 'ATEM Mini Extreme ISO', release: '10.3', build: 'sample', ip: 'sample' }
	// Park the real state — including each column's kind and the typed addresses — plus the sample
	// strip bodies, so clicks on the sample channels can be served locally rather than firing a real
	// /api/channel at ip='sample'.
	tourDemo = { A: { ...state.A }, B: { ...state.B }, ipA: panel('A').querySelector('.ip').value, ipB: panel('B').querySelector('.ip').value, bodies }
	for (const side of ['A', 'B']) {
		const s = state[side]
		// The tour is a walk through the switcher workflow. Force both columns to the switcher so a
		// column left on Presets cannot hide the sample — and step 1's address target — behind the
		// library view. exitTourDemo restores the parked kind.
		s.kind = 'atem'
		s.multi = side === 'B'
		s.ip = 'sample'
		s.device = device
		s.channels = channels
		s.selection = side === 'A' ? ['1001:-256'] : ['1:-256']
		s.anchor = null
		s.error = null
		s.detail = JSON.parse(JSON.stringify(bodies[side === 'A' ? '1001:-256' : '1:-256']))
		panel(side).querySelector('.ip').value = SAMPLE_IP_TEXT
		panel(side).querySelector('.device').innerHTML = '<span class="warn">●</span> <b>Sample switcher</b> — for the tour only. Nothing here is real and nothing can be written.'
		panel(side).classList.add('sample')
	}
	// Reflect the forced kind in the DOM (clears any .lib class and un-presses the Presets toggle)
	// before rendering, so the conn row and channel lists the tour points at are actually visible.
	applyMode()
	for (const side of ['A', 'B']) renderSideAll(side)
	document.body.classList.add('sample-on')
	updateActionUI()
}

function exitTourDemo() {
	removeGhost()
	if (!tourDemo) return
	// Whatever happens in the restore, the tour must always end: clear tourDemo (and refresh the
	// action UI off the real state) in a finally, so a throw mid-restore can never leave the sample
	// latched with Copy disabled.
	try {
		for (const side of ['A', 'B']) {
			Object.assign(state[side], tourDemo[side])
			panel(side).classList.remove('sample')
		}
		// Restore the parked kinds/mode to the DOM (panel .lib class, the Switcher|Presets toggle),
		// then set each device line and redraw from the restored state. Set the ip boxes AFTER
		// applyMode so its single-switcher mirroring can't clobber the values we are restoring.
		applyMode()
		for (const side of ['A', 'B']) {
			panel(side).querySelector('.ip').value = side === 'A' ? tourDemo.ipA : tourDemo.ipB
			// deviceLine is null-safe, but a parked side with an ip and no device should read "Not
			// connected", and a never-touched side stays blank.
			panel(side).querySelector('.device').innerHTML = state[side].ip ? deviceLine(state[side].device) : ''
			renderSideAll(side)
		}
		document.body.classList.remove('sample-on')
	} finally {
		tourDemo = null
		updateActionUI()
	}
}

/**
 * A pointer that drives itself.
 *
 * The clickable-block idea is the one thing users miss most — a block looks like a readout, not a
 * control. Telling them is weaker than showing them, so during the tour a ghost cursor walks to a
 * couple of blocks and toggles them, and the green outline appears and disappears where they can
 * see it. It only runs against the sample switcher, and it puts the ticks back when it is done.
 */
let ghostRun = 0
let ghostSaved = null // the real sections, parked once while the ghost demo toggles them

function ghostCursor() {
	let g = document.querySelector('.ghostcursor')
	if (!g) {
		g = el('div', 'ghostcursor')
		g.setAttribute('aria-hidden', 'true')
		document.body.append(g)
	}
	return g
}

/**
 * Tear the ghost cursor down and, crucially, put the sections back exactly as they were before the
 * demo first ran. Every teardown path funnels through here (Skip, Done, connect, the yourturn step),
 * so the restore can never be skipped — the old per-invocation snapshot could capture a half-toggled
 * state left by a cancelled run and make it permanent, silently excluding EQ or Dynamics from every
 * later copy.
 */
function removeGhost() {
	ghostRun++
	document.querySelector('.ghostcursor')?.remove()
	if (ghostSaved) {
		Object.assign(state.sections, ghostSaved)
		ghostSaved = null
		renderDetail('A')
		renderDetail('B')
		updateSummary()
	}
}

async function demoBlockClicks() {
	const run = ++ghostRun
	const g = ghostCursor()
	// Snapshot the real sections ONCE, on first entry. A re-entry (Back into this step) starts a new
	// run but leaves this snapshot intact, so the baseline is always the pre-demo state, never the
	// half-toggled state a superseded run left behind.
	if (!ghostSaved) ghostSaved = { ...state.sections }
	const wait = (ms) => new Promise((r) => setTimeout(r, ms))
	const moveTo = async (sel) => {
		const t = document.querySelector(sel)
		if (!t) return false
		const r = t.getBoundingClientRect()
		g.style.left = `${r.left + r.width * 0.5}px`
		g.style.top = `${r.top + r.height * 0.55}px`
		g.classList.add('on')
		await wait(620)
		return run === ghostRun
	}
	const clickBlock = async (sec) => {
		if (run !== ghostRun) return false
		g.classList.add('press')
		await wait(150)
		g.classList.remove('press')
		if (run !== ghostRun) return false
		state.sections[sec] = !state.sections[sec]
		renderDetail('A')
		renderDetail('B')
		updateSummary()
		await wait(700)
		return run === ghostRun
	}
	const script = ['eq', 'eq', 'dynamics', 'dynamics']
	for (const sec of script) {
		// A superseded run just stops — the run that replaced it (or a teardown via removeGhost) owns
		// the restore. Restoring here would pull the shared snapshot out from under the newer run.
		if (!(await moveTo(`#panel-A .block[data-sec="${sec}"]`))) return
		if (!(await clickBlock(sec))) return
	}
	if (run !== ghostRun) return
	// Normal completion: removeGhost restores the sections from the single saved snapshot.
	removeGhost()
}

/**
 * The guided tour. Rather than a wall of instructions in the empty column, the app walks through
 * itself: each step spotlights the real control and says what it does. With no switcher connected
 * it runs against a sample one, so every step has something real to point at.
 */
function startTour({ force = false } = {}) {
	// The sample switcher must only appear if the tour is genuinely about to run. Tips.sequence
	// declines silently once the tour has been seen, and a sample left standing after a decline
	// would disable Copy on a real connection forever.
	if (Tips.isSeen('seq.first-run-v1') && !force) return
	// A connect the user already kicked off (a prefilled address + Enter, a recent-IP chip) must win
	// over the auto-tour — dropping the sample on top of an in-flight real connect would latch it.
	if (connectInFlight && !force) return
	const wasEmpty = !state.A.channels?.length
	if (wasEmpty) enterTourDemo()
	Tips.sequence(
		'first-run-v1',
		[
			{
				key: 'tour.address',
				target: '#panel-A .conn',
				placement: 'right',
				title: 'Start with the switcher’s address',
				text: 'Type it here, or press the ▾ to pick one this app has seen before. Out of the box an ATEM is 192.168.10.240; ATEM Setup shows the real one. This machine has to be on the same network.',
			},
			{
				key: 'tour.both',
				target: '#panel-B .list-col',
				placement: 'left',
				title: 'One switcher fills both sides',
				text: 'Connect once and the same switcher appears left and right — that is the normal case, copying between channels on one box. Copying to a switcher in another room? Give this column its own address and press Connect.',
			},
			{
				key: 'tour.pick',
				target: '#panel-A .channel-list',
				placement: 'right',
				title: 'Left is where sound comes from',
				text: 'Pick the channel you already dialled in — the one whose sound you want to copy.',
			},
			{
				key: 'tour.pickdest',
				target: '#panel-B .channel-list',
				placement: 'left',
				title: 'Right is where it lands',
				// Multi-select works only on the destination side, so it is taught pointing at that
				// side — not at the single-select source list.
				text: `Pick where it should go. ${MOD}-click adds another channel and shift-click takes a whole range, so one chain can land on several cameras at once.`,
			},
			{
				key: 'tour.blocks',
				target: '#panel-A .card-col',
				placement: 'right',
				title: 'Click a block to include it',
				text: 'The card breaks into Gain, Volume, Pan, EQ and Dynamics. Clicking anywhere in a block includes or excludes it — the whole block is the checkbox, and a green edge means the copy replaces it. Watch, then try it yourself.',
				before: () => {
					// Not awaited on purpose: the tip appears immediately and the demonstration plays
					// behind it, so nobody is left staring at a frozen step.
					demoBlockClicks()
				},
			},
			{
				key: 'tour.copy',
				target: '#apply',
				placement: 'bottom',
				title: 'Copy writes, then checks',
				text: 'Every destination is backed up first, written, then read back — a switcher silently ignores values it will not take, so this app measures the result instead of assuming it. Undo restores the whole batch.',
			},
			{
				key: 'tour.blend',
				target: '#blend',
				placement: 'bottom',
				title: 'Blend meets in the middle',
				text: 'Instead of replacing outright, slide between the source and whatever the destination already had. On/off state always follows the source; only the numbers mix.',
			},
			{
				key: 'tour.library',
				target: '#browse-open',
				placement: 'bottom',
				title: 'Presets other people made',
				text: 'Chains for real microphones — SM7B, PodMic, lectern goosenecks — with notes on what they are for. To save your own, flip a column to Presets and save it there; the good ones are worth sharing back.',
			},
			{
				key: 'tour.startup',
				target: '#panel-B .card-col',
				placement: 'left',
				title: 'One thing the switcher will not do for you',
				text: 'An ATEM forgets audio settings on a power cycle unless they are saved as its startup state. Once the sound is right, open ATEM Software Control and choose Save Startup State — otherwise the next cold boot brings back the old numbers.',
			},
			{
				key: 'tour.yourturn',
				target: '#panel-A .conn',
				placement: 'right',
				title: 'Now your turn',
				// Only claim the channels were a sample when they actually were — Help runs this tour
				// while connected too, and a live channel list must not be called fake.
				text: wasEmpty
					? 'That was a sample switcher — it disappears when you press Done. Type your own ATEM’s address here and press Connect. Help at the bottom of the window brings all of this back.'
					: 'Type an ATEM’s address here and press Connect whenever you want to point at a different switcher. Help at the bottom of the window brings all of this back.',
				before: () => removeGhost(),
			},
		],
		{
			force,
			onDone: () => {
				exitTourDemo()
				// End where the work starts: the cursor in the address box, ready to be typed into.
				const ip = panel('A').querySelector('.ip')
				if (!ip.value) ip.focus()
			},
		}
	)
}

/**
 * Guidance for a column with nothing in it yet.
 *
 * One line, not a lecture. What the app is and how to find an address live behind Help; how it
 * works is shown by the tour. An empty column's job is to say what to do next.
 */
function renderFirstRun(side, box) {
	if (side === 'B') {
		box.innerHTML =
			'<div class="guide quiet"><b class="ghead">Where the settings land</b>' +
			'<p class="glead">Connect on the left and this side fills with the same switcher — copying between channels on one box is the normal case.</p>' +
			'<p class="glead">Copying to a switcher in another room? Type its address above and press <em>Connect</em>.</p></div>'
		return
	}
	const recents = recentIps()
	box.innerHTML =
		'<div class="guide">' +
		'<b class="ghead">No switcher connected</b>' +
		'<p class="glead">Type your ATEM’s address above and press Connect. Both columns fill with its audio strips.</p>' +
		(recents.length ? `<div class="chips">${recents.map((ip) => `<button class="chip" data-ip="${esc(ip)}">${esc(ip)}</button>`).join('')}</div>` : '') +
		'<div class="gactions"><button id="tour-start">Show me how it works</button></div>' +
		'</div>'
	const tour = box.querySelector('#tour-start')
	if (tour) tour.onclick = () => startTour({ force: true })
	for (const b of box.querySelectorAll('.chip')) {
		b.onclick = () => {
			panel(side).querySelector('.ip').value = b.dataset.ip
			connectSide(side)
		}
	}
}

/** Everything that used to crowd the empty column, in one place someone can go looking for. */
/**
 * The manual.
 *
 * A full-screen document rather than a panel: this is where someone lands when they are stuck, or
 * reading up before a shoot, and the answers are long enough to need room. Sections mirror the way
 * the app is actually used — connect, pick, choose, copy, verify, save, share.
 */
function toggleHelp(force) {
	const box = $('#helppanel')
	const btn = $('#help-open')
	const open = force ?? box.hidden
	box.hidden = !open
	btn.setAttribute('aria-expanded', open ? 'true' : 'false')
	document.body.classList.toggle('help-on', open)
	if (!open) {
		box.textContent = ''
		return
	}
	// Illustrations are drawn from the app's own vocabulary rather than shipped as screenshots —
	// screenshots go stale the first time a colour changes, and this has to work offline.
	const fig = (inner, caption) => `<figure class="helpfig">${inner}<figcaption>${caption}</figcaption></figure>`
	const blocksFig = fig('<div class="figcard" id="fig-card"></div>', 'The real card, shrunk. A green edge means the copy replaces that block — click anywhere in a block to include or exclude it.')
	const flowFig = fig(
		'<div class="figflow"><span class="figcol src">SOURCE<b>Mic 1</b></span><span class="figarrows">▶ ▶ ▶</span><span class="figcol dst">DESTINATION<b>Camera 1, 2, 3</b></span></div>',
		'Left is where the sound comes from; right is where it lands. One source, as many destinations as you select.'
	)
	const blendFig = fig(
		'<div class="figslider"><span>Source 100%</span><i></i><span>Destination 100%</span></div>',
		'Blend mixes the numbers instead of replacing them. On/off state always follows the source.'
	)

	box.innerHTML =
		'<div class="helpdoc">' +
		'<div class="helphead"><div><h2>ATEM Audio Presets</h2><p class="helpsub">Copy a channel’s sound onto other channels — and keep the ones that work.</p></div>' +
		'<button id="helpclose" aria-label="Close help">×</button></div>' +
		'<nav class="helpnav">' +
		'<a href="#h-start">Getting started</a><a href="#h-copy">Copying</a><a href="#h-blend">Blending</a><a href="#h-verify">Did it work</a><a href="#h-presets">Presets</a><a href="#h-share">Sharing</a><a href="#h-trouble">When it goes wrong</a>' +
		'</nav>' +
		'<article class="helpbody">' +
		'<section id="h-start"><h3>Getting started</h3>' +
		'<p>Dial in a good mic chain once, then put it on the other channels — or on the switcher in the other room, or save it for next month. Doing that by hand in Blackmagic’s own software means copying about forty numbers across a dozen panels, per channel.</p>' +
		'<h4>Connecting</h4>' +
		'<p>Type your switcher’s address in the box at the top of the source column and press <em>Connect</em>. The ▾ inside the box offers addresses this app has seen before, plus the one every ATEM ships with.</p>' +
		'<p><b>Finding the address:</b> ATEM Setup, on any machine that can see the switcher, lists it under the switcher’s name. Straight out of the box it is <code>192.168.10.240</code>. This app has to run on a machine on the same network — studio Wi‑Fi and the wired studio network usually are not the same network.</p>' +
		'<h4>One switcher, or two</h4>' +
		'<p>Connecting once fills <em>both</em> columns with the same switcher — that is the normal case, copying between channels on one box. To copy from one switcher to another, type the second address in the destination column and press Connect; that column takes over its own switcher. Pointing it back at the first address collapses to one again.</p>' +
		'<h4>The tour</h4>' +
		'<p>The walkthrough points at each control in turn, using a sample switcher if you have none connected. It runs by itself the first time you open the app.</p>' +
		'<p><button id="help-tour" class="primary">Show me how it works</button></p>' +
		'</section>' +
		`<section id="h-copy"><h3>Copying</h3>${flowFig}` +
		`<p>Pick the channel you already dialled in on the left. On the right, pick where it should go — ${esc(MOD)}-click or shift-click for several at once.</p>` +
		`<h4>Choosing what travels</h4>${blocksFig}` +
		'<p>The card divides into Gain, Volume, Pan, EQ, Dynamics and Input. Clicking anywhere in a block on the source card includes or excludes it — the whole block is the checkbox. Included blocks get a green outline on both cards, and the destination card previews the result: the incoming values drawn live with the channel’s current values ghosted behind, plus <em>was …</em> annotations.</p>' +
		'<p>Then press Copy. If Copy is greyed out, something is missing — hover it and it will say which.</p>' +
		'<h4>What is never copied</h4>' +
		'<p>A channel’s on/off state. It is a live operating control, and pasting it could mute someone mid-show. The app will not copy it or show it.</p>' +
		'</section>' +
		`<section id="h-blend"><h3>Blending</h3>${blendFig}` +
		'<p>Sometimes you do not want to replace what is there — you want to meet it halfway. Press Blend and a slider appears above the two columns: drag it and the destination card previews the mix live.</p>' +
		'<p>Only numbers are mixed. Which units are on — EQ, expander, compressor, limiter — always comes from the source, because an enable flag has no halfway position. A band the destination is not using counts as flat, so sliding toward the destination fades the source’s lift or cut down to nothing rather than toward a stale value.</p>' +
		'<p>Blend works on one destination at a time: the mix depends on what is already there, so several destinations would give several different answers.</p>' +
		'</section>' +
		'<section id="h-verify"><h3>Did it work</h3>' +
		'<p>A switcher silently ignores values it will not take — a camera input will not accept a microphone’s +40 dB of gain. So this app measures instead of assuming: every destination is backed up, written, then <b>read back and compared</b>. The band above the status bar reports what actually landed, and <em>What changed</em> opens the field-by-field detail.</p>' +
		'<p><b>Undo</b> restores the whole batch from those backups. They are kept alongside your presets, in <code class="presetdir">the app’s preset folder</code> — in the desktop app, <em>Help → Show presets folder</em> opens it.</p>' +
		'<h4>Making it survive a power cycle</h4>' +
		'<p>An ATEM forgets audio settings when it loses power unless they are stored as its startup state. Once the sound is right, open ATEM Software Control and choose <em>Save Startup State</em> — otherwise the next cold boot brings back the old numbers. This app cannot do it for you.</p>' +
		'</section>' +
		'<section id="h-presets"><h3>Presets</h3>' +
		'<p>Flip either column from <em>Switcher</em> to <em>Presets</em> and it becomes the preset library. Only one column can hold the library at a time, so you can never copy a preset onto a preset.</p>' +
		'<h4>Saving one</h4>' +
		'<p>Put the library on the destination side and the card becomes a save form. Name it for what it is, and fill in the mic and the style — those are how you and everyone else will find it later. Notes are worth writing: what it suits, what to tweak by ear. The blocks you have ticked become the preset’s default sections.</p>' +
		'<h4>Using one</h4>' +
		'<p>Put the library on the source side, pick a preset, pick destination channels, and copy as usual. A preset is a whole channel, so you can take only the EQ from it if that is all you want.</p>' +
		'<h4>Packs</h4>' +
		'<p>Export all bundles every preset into one file — the unit people trade. Import a pack reads one back in. A pack carries names, groups and default sections, and nothing identifying about the machine that made it beyond the switcher model and firmware.</p>' +
		'</section>' +
		'<section id="h-share"><h3>Sharing</h3>' +
		'<p><em>Community presets</em> at the top opens the shared library: chains for real microphones, with notes on what they are for and who made them. Search by mic or style, read the comments, take what works.</p>' +
		`<p>Presets you have made can be published back the same way. Good ones — a lectern gooseneck that finally stopped booming, a podcast chain that survives a loud laugh — save someone else an evening. Questions, requests and the people doing the same job live in <a href="${LOOP_URL}" target="_blank" rel="noreferrer">the community</a>.</p>` +
		'</section>' +
		'<section id="h-trouble"><h3>When it goes wrong</h3>' +
		'<h4>It will not connect</h4>' +
		'<p>In rough order of likelihood: something else already holds the switcher (an ATEM allows only a handful of control connections — quit ATEM Software Control or Companion), it is off or still starting up (a cold start takes about half a minute), this machine is not on the switcher’s network, or the address is wrong. The app names the likely cause and keeps the raw error under a disclosure.</p>' +
		'<h4>Some values did not take</h4>' +
		'<p>The read-back found the switcher holding something different from what was sent — almost always because the destination cannot accept that value. The detail lists each field and both numbers. Nothing is silently wrong.</p>' +
		'<h4>It sounded right, then the switcher was power-cycled</h4>' +
		'<p>Save Startup State, above. This is the most common surprise.</p>' +
		'</section>' +
		`<footer class="helpend"><b>If this saved you an evening</b>` +
		`<p>I make this on my own time, and it stays free. Two things keep it going, and both take a minute:</p>` +
		`<div class="helpend-acts"><button id="help-say-thanks" class="primary">Say thanks</button>` +
		`<a class="footbtn loop" href="${LOOP_URL}" target="_blank" rel="noreferrer">Join the community</a></div>` +
		`<p class="helpend-why">The community is where the good presets come from, someone has already solved the mic you are fighting with, and it is a friendlier room than most. Sponsors are why the next feature gets built instead of staying on the list. If you use this on paid work, that is the honest nudge.</p>` +
		`<p class="helpend-sig">Thanks for reading this far. \u2014 Ryan, <a href="https://studioupgrade.com" target="_blank" rel="noreferrer">Studio Upgrade</a></p></footer>` +
		'</article></div>'
	box.querySelector('#helpclose').onclick = () => toggleHelp(false)
	// The card figure is the app's own card, not a drawing of one: same renderer, same maths, a sample
	// channel, scaled down. It cannot drift out of date with the real thing.
	const figCard = box.querySelector('#fig-card')
	if (figCard) {
		try {
			renderStripCard(figCard, tourChannel(1001, 'Mic 1', true), {
				sections: { gain: false, volume: false, pan: false, eq: true, dynamics: true, inputConfig: false },
				source: true,
				incoming: null,
			})
		} catch {
			figCard.remove()
		}
	}
	box.querySelector('#help-tour').onclick = () => {
		toggleHelp(false)
		startTour({ force: true })
	}
	const thanks = box.querySelector('#help-say-thanks')
	if (thanks)
		thanks.onclick = () => {
			toggleHelp(false)
			openSupport()
		}
	box.scrollTop = 0
	// The real preset path, rather than a guess: from a clone it is ./presets, but the desktop app
	// keeps it in the per-user application-data folder.
	api('/api/status')
		.then((s) => {
			if (!s?.presetDir) return
			for (const c of box.querySelectorAll('.presetdir')) c.textContent = `${s.presetDir}/_backups/`
		})
		.catch(() => {
			/* the words already read correctly without it */
		})
	// Escape closes it, like every other overlay in the app.
	const onKey = (e) => {
		if (e.key !== 'Escape') return
		toggleHelp(false)
		document.removeEventListener('keydown', onKey)
	}
	document.addEventListener('keydown', onKey)
}

/**
 * Why a connect failed, in words someone can act on.
 *
 * These are the causes that actually happen, in the order they usually turn out to be true. The
 * raw error still ships — under a disclosure, not as the headline.
 */
function connectDiagnosis(ip, message) {
	const m = String(message ?? '')
	const busy = {
		what: 'Something else is already holding the switcher',
		fix: 'An ATEM allows only a handful of control connections. Quit ATEM Software Control or Companion on any machine talking to this switcher, then try again.',
	}
	const power = { what: 'It is switched off, or still starting up', fix: 'Check the switcher is powered and its panel is lit. A cold start takes about half a minute.' }
	const net = {
		what: 'This machine is not on the switcher’s network',
		fix: 'Studio Wi-Fi and the wired studio network are usually not the same network. Join the one the switcher is on — by cable if you can.',
	}
	const typo = { what: 'The address may be wrong', fix: 'ATEM Setup shows the switcher’s IP under its name. Straight from the factory it is 192.168.10.240.' }

	if (/refus/i.test(m)) return { title: `${ip} answered, but refused the connection`, causes: [busy, typo] }
	if (/unreach|ENETUNREACH|EHOSTUNREACH|no route/i.test(m)) return { title: `No route to ${ip}`, causes: [net, typo] }
	if (/invalid|not a valid|ENOTFOUND|EAI_AGAIN/i.test(m)) return { title: `${ip} is not an address this can reach`, causes: [typo, net] }
	return { title: `Nothing answered at ${ip}`, causes: [busy, power, net, typo] }
}

/**
 * A failed connect surfaces in exactly one place: a sticky notification in the top-right stack,
 * carrying the diagnosis and a Retry. Never in a card, never twice, never "below". The full
 * troubleshooting list lives in Help → When it goes wrong.
 */
function notifyConnectFailure(ip, message, retry) {
	const d = connectDiagnosis(ip, message)
	notify('err', d.title, d.causes[0]?.fix, { sticky: true, retry, retryLabel: `Try ${esc(ip)} again` })
}

function renderConnectError(side, box) {
	const { ip, message } = state[side].error
	const d = connectDiagnosis(ip, message)
	// Emit the classes the stylesheet actually defines (.gcause row with its own .gdot, .gwhat/.gfix
	// blocks, and .gactions for the button row) — the old flat <li><b><span> with .gacts matched no
	// rules, so cause and fix ran together and the action row was unstyled.
	box.innerHTML =
		'<div class="guide bad">' +
		`<b class="ghead">${esc(d.title)}</b>` +
		'<p class="glead">Most likely, in this order:</p>' +
		`<ol class="gcauses">${d.causes.map((c) => `<li class="gcause"><span class="gdot"></span><span><b class="gwhat">${esc(c.what)}</b><span class="gfix">${esc(c.fix)}</span></span></li>`).join('')}</ol>` +
		`<div class="gactions"><button class="primary retry">Try ${esc(ip)} again</button><span class="gnote">Nothing was changed on any switcher.</span></div>` +
		`<details class="graw"><summary>Technical detail</summary><code>${esc(message)}</code></details>` +
		'</div>'
	box.querySelector('.retry').onclick = () => connectSide(side)
}

/** An empty library is a dead end unless it says how to fill one. The list column is 200px, so
    it gets the headline and the import button; the how-to goes in the card column beside it. */
function renderLibraryEmpty(side, list) {
	const empty = el('div', 'libempty')
	empty.innerHTML = '<b>No presets yet</b><p>Saved channels appear here.</p>'
	const imp = el('label', 'filebtn small', 'Import file…')
	const inp = el('input')
	inp.type = 'file'
	inp.accept = 'application/json'
	inp.onchange = (e) => importFile(e)
	imp.append(inp)
	empty.append(imp)
	list.append(empty)
}

function renderLibraryGuide(side, box) {
	const other = side === 'A' ? 'right' : 'left'
	box.innerHTML =
		'<div class="guide">' +
		'<b class="ghead">Nothing saved yet</b>' +
		'<p class="glead">A preset is one channel’s whole sound — gain, EQ, dynamics — kept under a name. The mic chain you want back next month, or on the switcher in the other room.</p>' +
		// Package D styles .gsteps (list-style:none suppresses the <ol> marker so the <i> badge is the
		// single number; grid keeps the badge beside the block title/description). Emit the exact
		// markup its contract documents: <li><i>n</i><b>title</b><span>desc</span></li>.
		'<ol class="gsteps">' +
		`<li><i>1</i><b>Put the library on the other side</b><span>Press <em>Presets</em> at the top of the ${other}-hand column. This side goes back to being a switcher.</span></li>` +
		'<li><i>2</i><b>Pick the channel worth keeping</b><span>Its card appears on the left exactly as it will be stored — a preset always holds the whole channel.</span></li>' +
		'<li><i>3</i><b>Name it and save</b><span>The blocks you have ticked become that preset’s defaults, so an EQ-only preset comes back ticked as one.</span></li>' +
		'</ol>' +
		'<p class="glead">Sent a preset by someone else? <em>Import file…</em> in the list beside this adds it to the library.</p>' +
		`<p class="gfoot">Presets other people have dialled in — and the place to share yours — live in <a href="${LOOP_URL}" target="_blank" rel="noreferrer">the Studio Upgrade community</a>.</p>` +
		'</div>'
	const browse = el('button', 'primary')
	browse.textContent = 'Browse community presets'
	browse.onclick = () => openBrowser()
	box.querySelector('.gsteps')?.after(browse)
}

/** What a preset was made with and for, under its card: mic, style, notes, a sample to hear. */
function presetHead(p) {
	const head = el('div', 'presethead')
	const top = el('div', 'phtop')
	top.append(el('b', 'phname', p.name ?? ''))
	if (p.style) top.append(el('span', 'phstyle', p.style))
	head.append(top)
	const meta = [p.mic, p.device?.model, p.savedAt ? new Date(p.savedAt).toLocaleDateString() : null].filter(Boolean)
	if (meta.length) head.append(el('div', 'phmeta', meta.join(' \u00b7 ')))
	if (p.notes) head.append(el('div', 'phnotes', p.notes))
	if (p.sampleUrl && /^https?:\/\//.test(p.sampleUrl)) {
		const a = el('a', 'phsample', 'Hear a sample')
		a.href = p.sampleUrl
		a.target = '_blank'
		a.rel = 'noreferrer'
		head.append(a)
	}
	return head
}

/**
 * Fill a library row's thumbnail. The listing carries no band data, so bodies load lazily — a few
 * at a time, cached where selection already looks, and a row without a thumbnail still works.
 */
function paintSpark(file, box) {
	const draw = (body) => {
		const eq = body?.channel?.eq ?? body?.channel?.equalizer
		if (eq) box.innerHTML = eqSparkline(eq, 52, 28)
	}
	const lib = state.library
	if (lib.cache[file]) return draw(lib.cache[file])
	lib.sparkQ ??= []
	lib.sparkN ??= 0
	lib.sparkQ.push([file, draw])
	const pump = async () => {
		if (lib.sparkN >= 4 || !lib.sparkQ.length) return
		lib.sparkN++
		const [f, cb] = lib.sparkQ.shift()
		try {
			lib.cache[f] = lib.cache[f] ?? (await api(`/api/presets/${encodeURIComponent(f)}`))
			cb(lib.cache[f])
		} catch {
			/* a row without a thumbnail still works */
		}
		lib.sparkN--
		pump()
	}
	pump()
}

// ------------------------------------------------------------------ progress and outcome

/**
 * A copy is three round trips — back up, write, read back — and takes a few seconds. Say what is
 * happening and name the destinations, rather than freezing the button and hoping.
 *
 * The stages are not faked into a progress bar: the server reports once, at the end, so this
 * shows what the request covers and how long it has been going, and nothing it cannot know.
 */
function showProgress(targets, title) {
	const overlay = el('div', 'modal-overlay')
	const boxEl = el('div', 'modal progress')
	boxEl.setAttribute('role', 'dialog')
	boxEl.setAttribute('aria-modal', 'true')
	boxEl.innerHTML =
		`<h3>${esc(title)}<span class="elapsed"></span></h3>` +
		'<div class="bar"><i></i></div>' +
		'<p class="pstages">Backing up each destination, writing the settings, then reading them back to check they took.</p>' +
		`<ul class="ptargets">${targets.map((t) => `<li><span class="dot"></span>${esc(t.label)}</li>`).join('')}</ul>` +
		'<p class="muted">Nothing is final until the read-back agrees — and Undo restores the whole batch.</p>'
	overlay.append(boxEl)
	document.body.append(overlay)
	const t0 = Date.now()
	const tick = setInterval(() => {
		const s = Math.round((Date.now() - t0) / 1000)
		const e = boxEl.querySelector('.elapsed')
		if (e) e.textContent = s >= 2 ? ` · ${s}s` : ''
	}, 250)
	return () => {
		clearInterval(tick)
		overlay.remove()
	}
}

/**
 * Notifications: one stack, top right, floating over everything.
 *
 * Everything the app has to say after an action lands here — a copy that worked, a preset that
 * published, a warning that something is missing. Successes clear themselves; anything that failed,
 * or that offers an Undo, stays until it is dismissed, because those are the ones worth reading.
 */
const TOAST_LIFE = { ok: 8000, warn: 11000, err: 0 }

function notify(kind, headline, detail, opts = {}) {
	const stack = $('#toasts')
	if (!stack) return

	// Group identical messages the way macOS does: a repeat bumps a count on the existing card
	// rather than stacking a second copy — no more "Could not reach X" twice.
	const key = `${kind} ${headline} ${detail ?? ''}`
	const twin = [...stack.querySelectorAll('.toast')].find((c) => c.dataset.key === key && !c.classList.contains('out'))
	if (twin) {
		twin.__bump()
		return twin
	}

	const card = el('div', `toast ${kind}`)
	card.dataset.key = key
	card.append(el('span', 'odot'))
	const words = el('div', 'owords')
	const head = el('div', 'ohead')
	head.append(document.createTextNode(headline))
	const badge = el('span', 'ocount')
	head.append(badge)
	words.append(head)
	if (detail) words.append(el('div', 'odetail', detail))
	card.append(words)

	const acts = el('div', 'oacts')
	if (opts.retry) {
		const b = el('button', null, opts.retryLabel || 'Try again')
		b.onclick = () => {
			close()
			opts.retry()
		}
		acts.append(b)
	}
	if (opts.undo) {
		const b = el('button', null, 'Undo')
		b.onclick = () => {
			close()
			undo()
		}
		acts.append(b)
	}
	if (opts.details) {
		const b = el('button', null, 'What changed')
		b.onclick = showResult
		acts.append(b)
	}
	if (acts.children.length) words.append(acts)

	// The moment something just worked is the honest moment to ask — quietly, as a link.
	if (opts.support && SUPPORT_URL) {
		const a = el('a', 'osupport', 'Useful? Say thanks')
		a.href = SUPPORT_URL
		a.onclick = (ev) => {
			ev.preventDefault()
			openSupport()
		}
		words.append(a)
	}

	const x = el('button', 'oclose', '×')
	x.title = 'Dismiss'
	x.setAttribute('aria-label', 'Dismiss this message')
	card.append(x)

	let timer = null
	const close = () => {
		clearTimeout(timer)
		card.classList.add('out')
		setTimeout(() => {
			card.remove()
			syncClearAll()
		}, 160)
	}
	x.onclick = close

	// A sticky toast (an error, a retry offer, or one carrying an Undo) never expires on its own — so
	// it must not be silently evicted by a burst of successes either. Mark it, so trimming skips it.
	const life = opts.sticky || opts.undo || opts.retry ? 0 : (TOAST_LIFE[kind] ?? 8000)
	if (!life) card.dataset.sticky = '1'

	// A grouped repeat: raise the count, un-expire, restart the clock.
	let count = 1
	card.__bump = () => {
		badge.textContent = String(++count)
		badge.classList.add('on')
		card.classList.remove('out')
		if (life) {
			clearTimeout(timer)
			timer = setTimeout(close, life)
		}
	}

	// Newest at the top, and never more than a screenful — but keep the sticky ones and drop the
	// oldest auto-dismissing toast instead. If every toast is sticky, keep them all rather than lose
	// an unread error.
	stack.prepend(card)
	while (stack.querySelectorAll('.toast').length > 5) {
		const victims = [...stack.querySelectorAll('.toast')].filter((c) => c !== card && !c.dataset.sticky)
		if (!victims.length) break
		victims[victims.length - 1].remove()
	}
	requestAnimationFrame(() => card.classList.add('in'))

	if (life) {
		timer = setTimeout(close, life)
		// Reading it should not race the clock.
		card.onmouseenter = () => clearTimeout(timer)
		card.onmouseleave = () => {
			timer = setTimeout(close, 2500)
		}
	}
	syncClearAll()
	return card
}

/** A "Clear all" control sits over the stack once more than one message is showing, as on macOS. */
function syncClearAll() {
	const stack = $('#toasts')
	if (!stack) return
	const n = stack.querySelectorAll('.toast').length
	let bar = stack.querySelector('.toasts-clear')
	if (n > 1 && !bar) {
		bar = el('button', 'toasts-clear', 'Clear all')
		bar.onclick = () => {
			for (const c of stack.querySelectorAll('.toast')) c.remove()
			syncClearAll()
		}
		stack.prepend(bar)
	} else if (n <= 1 && bar) {
		bar.remove()
	} else if (bar) {
		stack.prepend(bar) // keep it above the newest toast
	}
}

/** Kept for every existing caller — an outcome is just a notification with actions. */
function showOutcome(kind, headline, detail, opts = {}) {
	return notify(kind, headline, detail, opts)
}

function hideOutcome() {
	const stack = $('#toasts')
	if (stack) stack.textContent = ''
}

// The flow divider is a plain sibling of the two columns, so it has no natural height — track the
// taller column so it spans exactly the panels, not the empty space below them. Arrows are real
// elements rather than a tiled background, so a whole number of them always fits and none is ever
// clipped mid-triangle; the row centres whatever fits.
function sizeFlowDivider() {
	const div = $('.flowdiv')
	if (!div) return
	const arrow = 14
	const gap = 42
	// Below the stacking breakpoint the columns sit one above the other, so the divider runs
	// horizontally and takes its length from its own width instead of the panels' height.
	const stacked = window.matchMedia('(max-width: 1100px)').matches
	let usable
	if (stacked) {
		div.style.height = ''
		usable = div.clientWidth - 28
	} else {
		const h = Math.max(panel('A').offsetHeight, panel('B').offsetHeight)
		div.style.height = h > 0 ? `${h}px` : ''
		usable = h - 28
	}
	const count = usable > 0 ? Math.max(1, Math.floor((usable + gap) / (arrow + gap))) : 0
	if (div.children.length === count) return
	div.textContent = ''
	for (let i = 0; i < count; i++) div.append(el('span', 'flowarrow'))
}
if (window.ResizeObserver) {
	const flowRO = new ResizeObserver(sizeFlowDivider)
	flowRO.observe(panel('A'))
	flowRO.observe(panel('B'))
}
window.addEventListener('resize', sizeFlowDivider)
sizeFlowDivider()

// First ever load with nothing connected: the tour introduces itself rather than waiting to be
// found. Tips.sequence's own seen-flag means it happens once. The timer is tracked so a connect the
// user starts inside the first 500ms can cancel it, rather than firing the sample over a live connect.
window.addEventListener('load', () => {
	if (!state.A.channels?.length)
		autoTourTimer = setTimeout(() => {
			autoTourTimer = null
			startTour()
		}, 500)
})

renderRecent()
