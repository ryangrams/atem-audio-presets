'use strict'

// The switcher stores dB, Q, ratio and dynamics times as integers scaled ×100, and frequency as
// plain Hz. Everything below is display-only — raw values are what get copied.
const dB = (v) => (v === undefined || v === null ? '—' : `${(v / 100).toFixed(2)} dB`)
const ms = (v) => (v === undefined || v === null ? '—' : `${(v / 100).toFixed(2)} ms`)
const ratio = (v) => (v === undefined || v === null ? '—' : `${(v / 100).toFixed(2)}:1`)
const q = (v) => (v === undefined || v === null ? '—' : (v / 100).toFixed(2))
const hz = (v) => (v === undefined || v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v} Hz`)
const pan = (v) => (v === undefined || v === null ? '—' : v === 0 ? 'centre' : `${v > 0 ? 'R' : 'L'} ${Math.abs(v / 100).toFixed(0)}`)

const SHAPE = { 1: 'Low shelf', 2: 'Low pass', 4: 'Band pass', 8: 'Notch', 16: 'High pass', 32: 'High shelf' }
const FREQ_RANGE = { 1: 'Low', 2: 'Mid-low', 4: 'Mid-high', 8: 'High' }
const MIX = { 1: 'Off', 2: 'On', 4: 'AFV' }
const CONFIG = { 1: 'Mono', 2: 'Stereo', 4: 'Dual mono' }
const LEVEL = { 0: '', 1: 'Mic', 2: 'Consumer', 4: 'Pro line' }

// `selection` is a list of channel keys. The source side only ever holds one; the destination
// side is multi-select (⌘/ctrl-click toggles, shift-click extends from the anchor), because
// pasting one strip onto four cameras at once is the common job.
/** localStorage namespace — one place, so the stored keys track the app name. */
const LS = 'atem-audio-presets'

// Where the "buy me a coffee" link points. Empty means there is nowhere to send people yet, and
// the link removes itself rather than shipping as a dead ☕.
const SUPPORT_URL = ''

// A column holds either a switcher or the preset library. Only one side can be the library at a
// time, which is what makes preset-into-preset impossible rather than merely disallowed.
const state = {
	A: { kind: localStorage.getItem(`${LS}.kind.A`) ?? 'atem', ip: '', device: null, channels: [], selection: [], anchor: null, detail: null, showMinor: false, multi: false },
	B: { kind: localStorage.getItem(`${LS}.kind.B`) ?? 'atem', ip: '', device: null, channels: [], selection: [], anchor: null, detail: null, showMinor: false, multi: true },
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
/** The result lives in a collapsible drawer — open it and scroll to the top of the newest entry. */
function showResult() {
	const drawer = $('#drawer-log')
	if (drawer) drawer.open = true
	$('#log')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
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
	if (!state.two) return connectSingle()
	const s = state[side]
	s.ip = panel(side).querySelector('.ip').value.trim()
	if (!s.ip) return
	localStorage.setItem(`${LS}.ip.${side}`, s.ip)
	const dev = panel(side).querySelector('.device')
	dev.innerHTML = `Connecting to ${esc(s.ip)}…`
	try {
		const body = await api(`/api/switcher?ip=${encodeURIComponent(s.ip)}`)
		s.device = body.device
		s.channels = body.channels
		s.selection = []
		s.anchor = null
		s.detail = null
		dev.innerHTML = deviceLine(body.device)
		renderChannels(side)
		renderDetail(side)
		log(`Connected to ${esc(s.ip)} — ${body.channels.length} audio strips.`, 'ok')
	} catch (e) {
		dev.innerHTML = `<span class="err">●</span> ${esc(e.message)}`
		log(`Connect failed for ${esc(s.ip)}: ${esc(e.message)}`, 'err')
	}
}

/** The "● model — firmware x build y" line, rendered wherever the current mode shows it. */
function deviceLine(device) {
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
		for (const btn of p.querySelectorAll('.kind')) btn.classList.toggle('on', btn.dataset.kind === state[side].kind)
	}
	$('#mode-toggle').textContent = state.two ? 'Use one switcher' : 'Add second switcher'
	// Same controls in both modes; on one switcher the destination column simply follows the
	// source's address instead of taking its own.
	const bIp = panel('B').querySelector('.ip')
	const bConnect = panel('B').querySelector('.connect')
	bIp.disabled = !state.two
	bConnect.disabled = !state.two
	if (!state.two) bIp.value = panel('A').querySelector('.ip').value
	bIp.title = state.two ? '' : 'Same switcher — press “Add second switcher” to copy across two'
	const bTitle = panel('B').querySelector('.col-title')
	bTitle.textContent = 'Destination'
	bTitle.title = isLib('B')
		? 'Saving into the preset library'
		: state.two
			? '\u2318 / shift-click for several channels'
			: 'Same switcher \u00b7 \u2318 / shift-click for several channels'
	const snapA = $('#snapshot-A')
	if (snapA) snapA.textContent = state.two ? 'Snapshot (from)' : 'Download snapshot'
	localStorage.setItem(`${LS}.two`, state.two ? '1' : '0')
	updateSummary()
	updateActionUI()
}

/** Single-switcher connect: one fetch, both columns. */
async function connectSingle() {
	const ip = panel('A').querySelector('.ip').value.trim()
	if (!ip) return
	localStorage.setItem(`${LS}.ip.A`, ip)
	const dev = panel('A').querySelector('.device')
	dev.innerHTML = `Connecting to ${esc(ip)}\u2026`
	try {
		const body = await api(`/api/switcher?ip=${encodeURIComponent(ip)}`)
		for (const side of ['A', 'B']) {
			const s = state[side]
			s.ip = ip
			s.device = body.device
			s.channels = body.channels
			s.selection = []
			s.anchor = null
			s.detail = null
			panel(side).querySelector('.ip').value = ip
			panel(side).querySelector('.device').innerHTML = deviceLine(body.device)
			if (isLib(side)) {
				// The library column keeps its list; only its underlying address follows along.
				s.channels = []
				continue
			}
			renderSideAll(side)
		}
		log(`Connected to ${esc(ip)} \u2014 ${body.channels.length} audio strips.`, 'ok')
		setStatus(`Connected \u2014 ${body.channels.length} audio strips`, 'ok')
	} catch (e) {
		dev.innerHTML = `<span class="err">\u25cf</span> ${esc(e.message)}`
		log(`Connect failed for ${esc(ip)}: ${esc(e.message)}`, 'err')
		setStatus(`Could not reach ${ip}`, 'err')
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
	panel(side).querySelector('.toggle-minor')?.remove()

	const presets = state.library.presets.filter((p) => p.format !== 'atem-audio-snapshot')
	if (!presets.length) {
		list.innerHTML =
			'<div class="libempty">No presets yet.<br />Put the library on the right and save a channel into it.</div>'
		return
	}

	const groups = [...new Set(presets.map((p) => p.group || ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
	for (const g of groups) {
		if (groups.length > 1 || g) {
			const head = el('div', 'grouphead', g || 'Ungrouped')
			head.dataset.group = g
			head.ondragover = (e) => e.preventDefault()
			head.ondrop = (e) => dropPreset(e, g, null)
			list.append(head)
		}
		for (const p of presets.filter((x) => (x.group || '') === g)) {
			const row = el('div', `chan preset-row${state.library.selectedFile === p.file ? ' selected' : ''}`)
			row.draggable = true
			row.dataset.file = p.file
			const name = el('span', 'name', p.name)
			name.title =
				`Double-click to rename\n${p.meta?.label ?? 'channel'}` +
				`${p.device?.ip ? ` from ${p.device.ip}` : ''}` +
				`${p.savedAt ? `\n${new Date(p.savedAt).toLocaleString()}` : ''}`
			name.ondblclick = (e) => {
				e.stopPropagation()
				renamePreset(p, name)
			}
			row.append(name)
			const tags = el('div', 'tags')
			tags.append(el('span', `tag${p.summary?.eqActive ? ' on' : ''}`, 'EQ'))
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
			row.onclick = () => selectPreset(side, p.file)
			row.ondragstart = (e) => e.dataTransfer.setData('text/plain', p.file)
			row.ondragover = (e) => e.preventDefault()
			row.ondrop = (e) => dropPreset(e, g, p.file)
			list.append(row)
		}
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
	const visible = s.channels.filter((c) => s.showMinor || !c.minor)
	for (const c of visible) {
		const row = el('div', `chan${c.minor ? ' minor' : ''}${s.selection.includes(c.key) ? ' selected' : ''}`)
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
	const hidden = s.channels.filter((c) => c.minor).length
	if (hidden > 0) {
		const btn = el('button', 'toggle-minor', s.showMinor ? `Hide ${hidden} MADI strips` : `Show ${hidden} MADI strips`)
		btn.onclick = () => {
			s.showMinor = !s.showMinor
			renderChannels(side)
		}
		list.after(btn)
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
	try {
		const body = await api(`/api/channel?ip=${encodeURIComponent(s.ip)}&input=${c.inputId}&source=${encodeURIComponent(c.sourceId)}`)
		s.detail = body.channel
	} catch (e) {
		s.detail = null
		log(`Could not read ${esc(key)}: ${esc(e.message)}`, 'err')
	}
	renderDetail(side)
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
		box.innerHTML = `<span class="off">${
			isLib(side)
				? 'Pick a preset on the left.'
				: `Select a channel${state[side].multi ? ' \u2014 \u2318-click or shift-click for several' : ''}.`
		}</span>`
		updateActionUI()
		return
	}
	renderStripCard(box, d, {
		sections: state.sections,
		// The source card is where sections are picked; the destination card previews the result.
		source: side === 'A',
		incoming: side === 'B' ? sourceChannel() : null,
	})
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

	box.innerHTML = `<div class="savecard">
		<div class="saverow">
			<input type="text" id="np-name" placeholder="Preset name" value="${esc(over?.name ?? (src ? `${src.meta.label}` : ''))}" />
			<input type="text" id="np-group" list="np-groups" placeholder="Group (optional)" value="${esc(over?.group ?? '')}" />
			<datalist id="np-groups">${groups.map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist>
		</div>
		<div class="savenote">${
			over
				? `Overwrites <b>${esc(over.name)}</b> \u2014 the old version is kept in presets/_backups/.`
				: 'Saves a new preset.'
		} Stores the whole channel; ticked sections (${esc(on.join(', ') || 'none')}) become its defaults.</div>
		<div class="savepreview"></div>
	</div>`

	const preview = box.querySelector('.savepreview')
	if (src) renderStripCard(preview, src, { sections: state.sections, source: false, incoming: null })
	else preview.innerHTML = '<span class="off">Pick a channel on the left to save.</span>'

	$('#np-name').oninput = updateActionUI
	updateActionUI()
}

/** The big button and Undo say what they will actually do, which depends on both columns. */
function updateActionUI() {
	const btn = $('#apply')
	if (!btn) return
	if (isLib('B')) {
		const over = currentPreset()
		btn.textContent = over ? `Overwrite \u201c${over.name}\u201d` : 'Save preset'
		btn.disabled = !sourceChannel()
	} else {
		const n = selectedKeys('B').length
		btn.textContent = n > 1 ? `Copy \u2192 ${n} channels` : 'Copy \u2192'
		btn.disabled = false
	}
	$('#undo').style.display = isLib('B') ? 'none' : ''
	$('#swap').style.display = isLib('A') || isLib('B') || !state.two ? 'none' : ''
}

/** The right-hand half of the status bar: the outcome of the last thing that happened. */
function setStatus(text, cls) {
	const box = $('#status')
	if (!box) return
	box.className = `status${cls ? ' ' + cls : ''}`
	box.textContent = text
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

async function apply() {
	// Destination decides the verb: a switcher gets a copy, the library gets a save.
	if (isLib('B')) return savePresetFlow()
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

	// Count the changes first, so the confirmation says how much is actually moving.
	let changes = null
	try {
		const pre = await api('/api/preview', { method: 'POST', body: JSON.stringify({ ...src, to, sections: sections() }) })
		changes = pre.results.reduce((n, r) => n + r.diff.length, 0)
	} catch {
		/* preview is a courtesy — if it fails, still offer the copy */
	}
	const ok = await askConfirm(
		to.length === 1 ? 'Copy audio settings?' : `Copy audio settings onto ${to.length} channels?`,
		`<p><strong>${esc(src.describe)}</strong><br />→ <strong>${esc(to[0].ip)}</strong></p>` +
			`<ul class="modal-list">${to.map((t) => `<li>${esc(describeTarget(t))}</li>`).join('')}</ul>` +
			`<p>Sections: ${esc(list.join(', '))}${changes === null ? '' : ` · <strong>${changes}</strong> field${changes === 1 ? '' : 's'} will change`}</p>` +
			`<p class="muted">Every destination channel is backed up first, and Undo restores the whole batch.</p>`,
		to.length === 1 ? 'Copy' : `Copy to ${to.length}`
	)
	if (!ok) return

	$('#apply').disabled = true
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
		log(
			`<strong>Copied</strong> ${esc(src.describe)} → ${esc(to[0].ip)}: ${good}/${body.results.length} channel${body.results.length === 1 ? '' : 's'} verified.`,
			good === body.results.length ? 'ok' : 'warn'
		)
		showResult()
		await refreshAfterWrite()
	} catch (e) {
		log(esc(e.message), 'err')
		setStatus(e.message, 'err')
		showResult()
	} finally {
		$('#apply').disabled = false
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
	const over = currentPreset()
	const overFile = over ? state.library.selectedFile : null

	if (overFile) {
		const ok = await askConfirm(
			'Overwrite this preset?',
			`<p><b>${esc(over.name)}</b> will be replaced by <b>${esc(src.meta.label)}</b>.</p>` +
				`<p class="muted">The old version is kept in presets/_backups/.</p>`,
			'Overwrite'
		)
		if (!ok) return
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
				payload: { format: 'atem-audio-preset', version: 1, channel: src, device: state.A.device ?? { ip: state.A.ip } },
			}),
		})
		await loadPresets()
		state.library.selectedFile = body.file
		state.library.cache[body.file] = null
		delete state.library.cache[body.file]
		renderSideAll('B')
		setStatus(`\u2713 Saved preset \u201c${name}\u201d`, 'ok')
		log(`Saved preset \u201c${esc(name)}\u201d from ${esc(src.meta.label)}${group ? ` in group ${esc(group)}` : ''}.`, 'ok')
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
	if (!s.ip) return log('Connect the destination switcher first.', 'err')
	const ok = await askConfirm(
		'Undo the last copy?',
		`<p>Restores the channel on <strong>${esc(s.ip)}</strong> to how it was before the last copy.</p>`,
		'Undo'
	)
	if (!ok) return
	try {
		const body = await api('/api/undo', { method: 'POST', body: JSON.stringify({ ip: s.ip }) })
		const names = body.restored.map((m) => `${m.label} (${m.inputId}:${m.sourceId})`)
		setStatus(`\u21b6 Restored ${names.length} channel${names.length === 1 ? '' : 's'}`, 'ok')
		log(`Restored ${names.length} channel${names.length === 1 ? '' : 's'} on ${esc(s.ip)}: ${esc(names.join(', '))}.`, 'ok')
		for (const r of body.results.filter((r) => !r.ok)) log(`✗ ${esc(r.meta.label)}: ${esc(r.error)}`, 'err')
		showResult()
		await refreshAfterWrite()
	} catch (e) {
		log(esc(e.message), 'err')
		showResult()
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

async function restoreSnapshot(snapshot) {
	const s = state.B
	if (!s.ip) return log('Connect the destination switcher first.', 'err')
	const list = Object.entries(sections())
		.filter(([, v]) => v)
		.map(([k]) => k)
	const ok = await askConfirm(
		'Restore a whole switcher?',
		`<p>Push <strong>${snapshot.channels.length}</strong> strips (${esc(list.join(', '))}) onto <strong>${esc(s.ip)}</strong>.</p>` +
			`<p class="muted">This overwrites every channel the snapshot can match. Only the last single-channel copy is undoable.</p>`,
		'Restore all'
	)
	if (!ok) return
	try {
		const body = await api('/api/restore', { method: 'POST', body: JSON.stringify({ ip: s.ip, snapshot, sections: sections() }) })
		clearLog()
		const ok = body.results.filter((r) => r.ok)
		log(`Restored ${ok.length}/${body.results.length} strips onto ${esc(s.ip)}.`, 'ok')
		for (const r of body.results.filter((r) => !r.ok)) log(`✗ ${esc(r.key)} ${esc(r.label)}: ${esc(r.error)}`, 'err')
		showResult()
		await refreshAfterWrite()
	} catch (e) {
		log(esc(e.message), 'err')
		showResult()
	}
}

function download(filename, body) {
	const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })
	const a = document.createElement('a')
	a.href = URL.createObjectURL(blob)
	a.download = filename
	a.click()
	URL.revokeObjectURL(a.href)
}

async function snapshot(side) {
	const s = state[side]
	if (!s.ip) return log('Connect that switcher first.', 'err')
	const body = await api(`/api/snapshot?ip=${encodeURIComponent(s.ip)}`)
	download(`atem-audio-${s.ip}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`, body)
	log(`Downloaded a snapshot of all ${body.channels.length} strips on ${esc(s.ip)}.`, 'ok')
}

// ------------------------------------------------------------------ wiring

for (const side of ['A', 'B']) {
	const p = panel(side)
	const saved = localStorage.getItem(`${LS}.ip.${side}`)
	p.querySelector('.ip').value = saved ?? ''
	p.querySelector('.connect').onclick = () => connectSide(side)
	p.querySelector('.ip').onkeydown = (e) => {
		if (e.key === 'Enter') connectSide(side)
	}
	for (const btn of p.querySelectorAll('.kind')) btn.onclick = () => setKind(side, btn.dataset.kind)
	state[side].multi = side === 'B' && !isLib('B')
	renderSideAll(side)
}

$('#mode-toggle').onclick = async () => {
	state.two = !state.two
	applyMode()
	if (state.two) {
		// The right-hand column becomes the new, empty half; the left keeps its switcher.
		const known = state.A.ip
		const savedB = localStorage.getItem(`${LS}.ip.B`)
		panel('B').querySelector('.ip').value = savedB && savedB !== known ? savedB : ''
		panel('B').querySelector('.ip').focus()
		setStatus('Enter the second switcher\u2019s address on the right, then Connect', 'warn')
	} else {
		// Collapse back onto whichever box the source column was using.
		await connectSingle()
	}
}
applyMode()

$('#swap').onclick = () => {
	const a = panel('A').querySelector('.ip').value
	panel('A').querySelector('.ip').value = panel('B').querySelector('.ip').value
	panel('B').querySelector('.ip').value = a
	connectSide('A')
	connectSide('B')
}
// The section checkboxes are rendered inside the source card, which is rebuilt on every
// selection, so bind by delegation rather than to the elements themselves.
document.addEventListener('change', (e) => {
	const input = e.target.closest('input[data-sec]')
	if (!input) return
	state.sections[input.dataset.sec] = input.checked
	renderDetail('A')
	renderDetail('B')
})

$('#apply').onclick = apply
$('#undo').onclick = undo
$('#snapshot-A').onclick = () => snapshot('A')
$('#snapshot-B').onclick = () => snapshot('B')
$('#load-file').onchange = async (e) => {
	const file = e.target.files[0]
	if (!file) return
	const body = JSON.parse(await file.text())
	if (body.format === 'atem-audio-snapshot') {
		await restoreSnapshot(body)
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
		log('That file is neither a channel preset nor a switcher snapshot.', 'err')
	}
	e.target.value = ''
}

// A block *is* the control: click anywhere in one on the source card to include or exclude that
// section from the copy.
document.addEventListener('click', (e) => {
	if (!e.target.closest('#panel-A .stripcard.selectable')) return
	const block = e.target.closest('.block[data-sec]')
	if (!block) return
	const name = block.dataset.sec
	state.sections[name] = !state.sections[name]
	renderDetail('A')
	renderDetail('B')
})

updateSummary()
loadPresets()

const coffee = $('#coffee')
if (SUPPORT_URL) coffee.href = SUPPORT_URL
else coffee.remove()
