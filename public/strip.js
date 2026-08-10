'use strict'

// A compact read-only version of the Fairlight channel view from ATEM Software Control: the
// strip (gain knob, fader, pan dial), the EQ response curve, and the dynamics transfer curve.
//
// The switcher stores no curves — only filter parameters — so the EQ response is computed here
// with the standard RBJ biquad formulas at 48 kHz, and the dynamics curve from the
// expander/compressor/limiter parameters. Both are a faithful picture of the settings, not a
// measurement of the audio.
//
// On the destination card the same renderer doubles as the preview: for each section being
// copied it draws the *incoming* values, with the channel's current ones behind as a dim ghost.

const FS = 48000
const SHAPE_NAME = { 1: 'Low shelf', 2: 'Low pass', 4: 'Bell', 8: 'Notch', 16: 'High pass', 32: 'High shelf' }
const SHAPE_ABBR = { 1: 'LS', 2: 'LP', 4: 'Bell', 8: 'Notch', 16: 'HP', 32: 'HS' }

/** RBJ cookbook coefficients. Gain arrives in hundredths of a dB, Q in hundredths. */
function biquad(shape, freq, gainDb, qFactor) {
	const w0 = (2 * Math.PI * freq) / FS
	const cos = Math.cos(w0)
	const sin = Math.sin(w0)
	const Q = Math.max(0.05, qFactor)
	const alpha = sin / (2 * Q)
	const A = Math.pow(10, gainDb / 40)
	const sq = 2 * Math.sqrt(A) * alpha

	switch (Number(shape)) {
		case 4: // bell / peaking
			return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A]
		case 1: // low shelf
			return [
				A * (A + 1 - (A - 1) * cos + sq),
				2 * A * (A - 1 - (A + 1) * cos),
				A * (A + 1 - (A - 1) * cos - sq),
				A + 1 + (A - 1) * cos + sq,
				-2 * (A - 1 + (A + 1) * cos),
				A + 1 + (A - 1) * cos - sq,
			]
		case 32: // high shelf
			return [
				A * (A + 1 + (A - 1) * cos + sq),
				-2 * A * (A - 1 + (A + 1) * cos),
				A * (A + 1 + (A - 1) * cos - sq),
				A + 1 - (A - 1) * cos + sq,
				2 * (A - 1 - (A + 1) * cos),
				A + 1 - (A - 1) * cos - sq,
			]
		case 2: // low pass
			return [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]
		case 16: // high pass
			return [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]
		case 8: // notch
			return [1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha]
		default:
			return null
	}
}

/** Magnitude of one biquad at a frequency, in dB. */
function bandGainAt(band, freq) {
	const c = biquad(band.shape, band.frequency, band.gain / 100, band.qFactor / 100)
	if (!c) return 0
	const [b0, b1, b2, a0, a1, a2] = c
	const w = (2 * Math.PI * freq) / FS
	const cw = Math.cos(w)
	const sw = Math.sin(w)
	const c2w = Math.cos(2 * w)
	const s2w = Math.sin(2 * w)
	const numRe = b0 + b1 * cw + b2 * c2w
	const numIm = -(b1 * sw + b2 * s2w)
	const denRe = a0 + a1 * cw + a2 * c2w
	const denIm = -(a1 * sw + a2 * s2w)
	const mag = Math.hypot(numRe, numIm) / Math.hypot(denRe, denIm)
	return 20 * Math.log10(Math.max(mag, 1e-6))
}

const enabledBands = (eq) => (eq?.bands ?? []).filter((b) => b?.bandEnabled)

/**
 * Composite response, including the EQ's own output gain — the switcher draws it into the curve
 * too, so a channel with +5 dB of EQ gain shows a mid-band plateau at +5 rather than at unity.
 */
function eqResponseAt(eq, freq) {
	return enabledBands(eq).reduce((sum, b) => sum + bandGainAt(b, freq), (eq?.gain ?? 0) / 100)
}

// ---------------------------------------------------------------- EQ graph

const EQ_W = 340
const EQ_H = 128
const F_MIN = 20
const F_MAX = 20000
const EQ_RANGE = 20 // ±dB shown

const fx = (f) => (Math.log10(f / F_MIN) / Math.log10(F_MAX / F_MIN)) * EQ_W
const fy = (db) => EQ_H / 2 - (Math.max(-EQ_RANGE, Math.min(EQ_RANGE, db)) / EQ_RANGE) * (EQ_H / 2)

function eqPath(eq, live) {
	const pts = []
	for (let i = 0; i <= 160; i++) {
		const f = F_MIN * Math.pow(F_MAX / F_MIN, i / 160)
		pts.push([fx(f), fy(live ? eqResponseAt(eq, f) : 0)])
	}
	return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
}

const eqLive = (eq) => Boolean(eq?.enabled && enabledBands(eq).length)

function eqGraph(eq, ghost) {
	const on = eqLive(eq)
	const line = eqPath(eq, on)
	const fill = `${line} L${EQ_W} ${fy(0)} L0 ${fy(0)} Z`

	const grid = [
		...[100, 1000, 10000].map((f) => `<line class="g" x1="${fx(f)}" y1="0" x2="${fx(f)}" y2="${EQ_H}" />`),
		...[10, -10].map((d) => `<line class="g" x1="0" y1="${fy(d)}" x2="${EQ_W}" y2="${fy(d)}" />`),
		`<line class="g0" x1="0" y1="${fy(0)}" x2="${EQ_W}" y2="${fy(0)}" />`,
	].join('')

	// Numbered handles ride the composite curve at each band's frequency, as they do in the
	// switcher's own EQ window.
	const handles = (eq?.bands ?? [])
		.map((b, i) => {
			if (!b?.bandEnabled) return ''
			const f = Math.max(F_MIN, Math.min(F_MAX, b.frequency))
			const x = fx(f)
			const y = fy(on ? eqResponseAt(eq, f) : 0)
			return `<circle class="h" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" /><text class="hn" x="${x.toFixed(1)}" y="${(y + 2.6).toFixed(1)}">${i + 1}</text>`
		})
		.join('')

	const labels =
		[
			[100, '100'],
			[1000, '1k'],
			[10000, '10k'],
		]
			.map(([f, t]) => `<text class="ax" x="${fx(f)}" y="${EQ_H - 3}" text-anchor="middle">${t}</text>`)
			.join('') +
		[
			[10, '+10'],
			[-10, '-10'],
		]
			.map(([d, t]) => `<text class="ax" x="3" y="${fy(d) - 2}">${t}</text>`)
			.join('')

	const ghostPath = ghost ? `<path class="ghost" d="${eqPath(ghost, eqLive(ghost))}" />` : ''

	return `<svg class="curve eq${on ? '' : ' bypassed'}" viewBox="0 0 ${EQ_W} ${EQ_H}">
		${grid}${ghostPath}<path class="fill" d="${fill}" /><path class="line" d="${line}" />${handles}${labels}
	</svg>`
}

// ---------------------------------------------------------------- dynamics graph

const DY = 128
const DB_MIN = -100

const dx = (db) => ((Math.max(DB_MIN, Math.min(0, db)) - DB_MIN) / -DB_MIN) * DY
const dy = (db) => DY - ((Math.max(DB_MIN, Math.min(0, db)) - DB_MIN) / -DB_MIN) * DY

/**
 * Input level → output level, in the order the switcher applies them: expander or gate below its
 * threshold, compressor above its, the limiter ceiling, then make-up gain as the output stage.
 */
function transfer(input, dyn) {
	const exp = dyn?.expander
	const comp = dyn?.compressor
	const lim = dyn?.limiter
	let out = input

	if (exp && (exp.expanderEnabled || exp.gateEnabled)) {
		const thr = exp.threshold / 100
		if (input < thr) {
			const ratio = exp.gateEnabled ? 100 : Math.max(1, exp.ratio / 100)
			const reduction = Math.min((thr - input) * (ratio - 1), exp.range / 100)
			out -= reduction
		}
	}
	if (comp?.compressorEnabled) {
		const thr = comp.threshold / 100
		const ratio = Math.max(1, comp.ratio / 100)
		if (out > thr) out = thr + (out - thr) / ratio
	}
	if (lim?.limiterEnabled) out = Math.min(out, lim.threshold / 100)
	// Make-up is the output stage, after the limiter — which is why a -15.5 dB limiter with
	// +10.77 dB of make-up puts the ceiling at -4.7 dB on the output axis, not at -15.5.
	return out + (dyn?.makeUpGain ?? 0) / 100
}

const dynLive = (dyn) =>
	Boolean(
		dyn?.compressor?.compressorEnabled ||
			dyn?.limiter?.limiterEnabled ||
			dyn?.expander?.expanderEnabled ||
			dyn?.expander?.gateEnabled ||
			(dyn?.makeUpGain ?? 0) !== 0
	)

function dynPath(dyn, live) {
	const pts = []
	for (let i = 0; i <= 100; i++) {
		const inDb = DB_MIN + (i / 100) * -DB_MIN
		pts.push([dx(inDb), dy(live ? transfer(inDb, dyn) : inDb)])
	}
	return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
}

function dynamicsGraph(dyn, ghost) {
	const active = dynLive(dyn)
	const line = dynPath(dyn, active)

	// Threshold markers, matching the blue guides in the switcher's dynamics window.
	const marks = []
	if (dyn?.expander && (dyn.expander.expanderEnabled || dyn.expander.gateEnabled)) {
		const x = dx(dyn.expander.threshold / 100)
		marks.push(`<line class="thr exp" x1="${x}" y1="0" x2="${x}" y2="${DY}" />`)
	}
	if (dyn?.compressor?.compressorEnabled) {
		const x = dx(dyn.compressor.threshold / 100)
		marks.push(`<line class="thr comp" x1="${x}" y1="0" x2="${x}" y2="${DY}" />`)
	}
	if (dyn?.limiter?.limiterEnabled) {
		const y = dy(dyn.limiter.threshold / 100 + (dyn.makeUpGain ?? 0) / 100)
		marks.push(`<line class="thr lim" x1="0" y1="${y}" x2="${DY}" y2="${y}" />`)
	}

	const grid = [-20, -40, -60, -80]
		.flatMap((d) => [
			`<line class="g" x1="${dx(d)}" y1="0" x2="${dx(d)}" y2="${DY}" />`,
			`<line class="g" x1="0" y1="${dy(d)}" x2="${DY}" y2="${dy(d)}" />`,
		])
		.join('')

	const ghostPath = ghost ? `<path class="ghost" d="${dynPath(ghost, dynLive(ghost))}" />` : ''

	return `<svg class="curve dyn${active ? '' : ' bypassed'}" viewBox="0 0 ${DY} ${DY}">
		${grid}<line class="unity" x1="0" y1="${DY}" x2="${DY}" y2="0" />${marks.join('')}${ghostPath}<path class="line" d="${line}" />
	</svg>`
}

// ---------------------------------------------------------------- strip controls

const clamp01 = (v) => Math.max(0, Math.min(1, v))

/**
 * A rotary control drawn the way ASC draws them: 270° of travel, a coloured arc showing the
 * value and a pointer on the cap. `arcFrom` is where the arc starts — 0 for a gain knob that
 * fills from the bottom, 0.5 for a pan dial that fills out from the centre.
 */
function knob(frac, arcFrom, colour) {
	const f = clamp01(frac)
	const ang = (t) => ((-135 + t * 270) * Math.PI) / 180
	const at = (t, r) => [24 + r * Math.sin(ang(t)), 24 - r * Math.cos(ang(t))]
	const [ax, ay] = at(arcFrom, 19)
	const [bx, by] = at(f, 19)
	const [px, py] = at(f, 11)
	const arc =
		Math.abs(f - arcFrom) < 0.005
			? ''
			: `<path class="arc" style="stroke:${colour}" d="M${ax.toFixed(1)} ${ay.toFixed(1)} A19 19 0 ${Math.abs(f - arcFrom) > 0.5 ? 1 : 0} ${f > arcFrom ? 1 : 0} ${bx.toFixed(1)} ${by.toFixed(1)}" />`
	return `<svg class="knob" viewBox="0 0 48 48">
		<path class="track" d="M${at(0, 19)[0].toFixed(1)} ${at(0, 19)[1].toFixed(1)} A19 19 0 1 1 ${at(1, 19)[0].toFixed(1)} ${at(1, 19)[1].toFixed(1)}" />
		${arc}
		<circle class="cap" cx="24" cy="24" r="13" />
		<line class="ptr" x1="24" y1="24" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" />
	</svg>`
}

/**
 * The channel fader. ASC's scale is not linear — 0 dB sits about a quarter down, with the long
 * tail below it — so the mapping is piecewise to match.
 */
function fader(db) {
	const top = 5
	const bottom = 78
	const zero = top + 0.24 * (bottom - top)
	const y = db >= 0 ? zero - clamp01(db / 10) * (zero - top) : zero + clamp01(-db / 60) * (bottom - zero)
	const ticks = [0, -10, -20, -30, -50]
		.map((d) => {
			const ty = d >= 0 ? zero : zero + clamp01(-d / 60) * (bottom - zero)
			return `<line class="tick" x1="13" y1="${ty.toFixed(1)}" x2="17" y2="${ty.toFixed(1)}" />`
		})
		.join('')
	return `<svg class="fader" viewBox="0 0 26 84">
		<line class="track" x1="9" y1="${top}" x2="9" y2="${bottom}" />
		<line class="fill" x1="9" y1="${bottom}" x2="9" y2="${y.toFixed(1)}" />
		${ticks}
		<rect class="cap" x="1" y="${(y - 4).toFixed(1)}" width="16" height="8" rx="2" />
		<line class="capline" x1="1" y1="${y.toFixed(1)}" x2="17" y2="${y.toFixed(1)}" />
	</svg>`
}

// ---------------------------------------------------------------- the card

const fdB = (v) => `${(v / 100).toFixed(2)}`
const f1 = (v) => `${(v / 100).toFixed(1)}`
const fHz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2).replace(/\.?0+$/, '')}k` : `${v}`)
const panText = (v) => (v === 0 ? 'C' : `${v > 0 ? 'R' : 'L'}${Math.abs(v / 100).toFixed(0)}`)

/**
 * ATEM's own strips carry short, all-caps labels on the hardware and in the compact Fairlight
 * view — "CAM 1", "MIC 1", "MP 1" — not the fuller names the audio-in list shows. This mirrors
 * that convention rather than showing the long label, which the title attribute still carries.
 */
const SHORT_WORD = { CAMERA: 'CAM', MICROPHONE: 'MIC', 'MEDIA PLAYER': 'MP', PLAYER: 'PLR', OVERHEAD: 'OVHD', LECTERN: 'LECT', WIRELESS: 'WL' }
function shortLabel(label) {
	let s = String(label ?? '').toUpperCase()
	for (const [word, abbr] of Object.entries(SHORT_WORD)) s = s.replace(word, abbr)
	return s.length > 10 ? s.slice(0, 10) : s
}

/**
 * A ≤5-character title for a channel that has no switcher-provided short name (a preset, or the
 * demo). Keeps the source casing — no uppercasing — and never needs an ellipsis: a trailing number
 * is preserved ("Camera 1" → "Cam1"), otherwise the first word is clipped ("Lectern" → "Lecte").
 */
function deriveShort(label) {
	const s = String(label ?? '').trim()
	if (s.length <= 5) return s
	const m = s.match(/^(.*?)(\d+)\s*$/)
	if (m) return m[1].replace(/\s+/g, '').slice(0, Math.max(1, 4 - m[2].length)) + m[2]
	return s.split(/\s+/)[0].slice(0, 5)
}

/**
 * Render one channel. `d` is an /api/channel payload.
 *
 * opts.sections  which sections are part of the copy
 * opts.source    this is the "copy from" card: blocks are clickable and show selection
 * opts.incoming  the channel being pasted; on the destination card the selected sections are
 *                drawn from this instead, with the current values ghosted behind
 */
function renderStripCard(box, d, opts = {}) {
	const sec = opts.sections ?? {}
	const inc = opts.incoming
	// On the destination, a section that is being copied is drawn from the incoming channel.
	const use = (name) => (!opts.source && inc && sec[name] ? inc : d)
	const ghostOf = (name) => (!opts.source && inc && sec[name] ? d : null)

	// Gain, volume and pan are copied independently, so each is its own block. They share one
	// underlying `levels` payload; which fields travel is decided per section.
	const gainL = use('gain').levels ?? {}
	const volL = use('volume').levels ?? {}
	const panL = use('pan').levels ?? {}
	const now = d.levels ?? {}
	const eq = use('eq').equalizer ?? use('eq').eq
	const dyn = use('dynamics').dynamics ?? {}
	const cfg = use('inputConfig').meta ?? {}
	const eqGhost = ghostOf('eq') ? (ghostOf('eq').equalizer ?? ghostOf('eq').eq) : null
	const dynGhost = ghostOf('dynamics')?.dynamics ?? null

	// Green marks every block this copy touches — on both cards, so the pairing is obvious.
	const cls = (name) => (sec[name] ? ' sel' : opts.source ? ' unsel' : '')
	const was = (name, current, next, fmt) =>
		!opts.source && inc && sec[name] && current !== next ? `<em class="was">was ${fmt(current)}</em>` : ''

	// On the source card a block *is* the checkbox, so it has to be one to a keyboard and a screen
	// reader too. On the destination card nothing is announced unless it is actually changing.
	const a11y = (name, label) => {
		if (opts.source)
			return ` role="checkbox" tabindex="0" aria-checked="${sec[name] ? 'true' : 'false'}" aria-label="${label}, ${sec[name] ? 'included in the copy' : 'left out of the copy'}"`
		if (inc && sec[name]) return ` aria-label="${label}, showing the incoming values — this will be replaced"`
		return ''
	}

	// The destination card shows one channel's preview, but several may be selected — so its header
	// can be overridden (opts.title = {label, sub}) to say "Multi-select" instead of naming just one.
	const strip = `<div class="strip">
		${
			opts.title
				? `<div class="strip-name multi" title="${opts.title.label}">${opts.title.label}<span class="subname">${opts.title.sub}</span></div>`
				: // The switcher's own short name (≤4 chars, its own casing) — it always fits, so no
					// uppercasing and no ellipsis. When none was captured (a preset, or the demo), derive
					// an equally short one rather than ellipsising the full label.
					`<div class="strip-name" title="${d.meta.label}">${d.meta.shortName || deriveShort(d.meta.label)}</div>`
		}
		<div class="ctrl block${cls('gain')}" data-sec="gain"${a11y('gain', 'Gain')}>
			<b>Gain</b>
			${knob(((gainL.gain ?? 0) / 100 + 60) / 66, 0, '#3ec97a')}
			<span class="val">${fdB(gainL.gain)}</span><em>dB</em>
			${was('gain', now.gain, gainL.gain, fdB)}
			<div class="delay ${gainL.framesDelay ? 'on' : ''}">⇢ ${gainL.framesDelay ?? 0} frame${gainL.framesDelay === 1 ? '' : 's'}</div>
		</div>
		<div class="ctrl block${cls('volume')}" data-sec="volume"${a11y('volume', 'Volume')}>
			<b>Volume</b>
			${fader((volL.faderGain ?? 0) / 100)}
			<span class="val">${fdB(volL.faderGain)}</span><em>dB</em>
			${was('volume', now.faderGain, volL.faderGain, fdB)}
		</div>
		<div class="ctrl block${cls('pan')}" data-sec="pan"${a11y('pan', 'Pan')}>
			<b>Pan</b>
			${knob(((panL.balance ?? 0) + 10000) / 20000, 0.5, '#4a90d9')}
			<span class="val">${panText(panL.balance ?? 0)}</span><em>L – R</em>
			${was('pan', now.balance, panL.balance, panText)}
		</div>
	</div>`

	const bands = (eq?.bands ?? [])
		.map(
			(b, i) => `<div class="band ${b?.bandEnabled ? '' : 'off'}">
			<b>${i + 1}</b> ${b ? SHAPE_ABBR[b.shape] ?? b.shape : '—'}
			<span>${b ? fHz(b.frequency) : ''}</span>
			${b && [1, 4, 32].includes(Number(b.shape)) ? `<span>${b.gain > 0 ? '+' : ''}${f1(b.gain)}</span><span>Q${(b.qFactor / 100).toFixed(1)}</span>` : ''}
		</div>`
		)
		.join('')

	const unit = (name, on, fields) =>
		`<div class="unit ${on ? '' : 'off'}"><b>${name}</b>${fields.map(([k, v]) => `<span><em>${k}</em>${v}</span>`).join('')}</div>`

	const e = dyn.expander
	const c = dyn.compressor
	const l = dyn.limiter
	const dynUnits =
		(e
			? unit(e.gateEnabled ? 'Gate' : 'Expander', e.expanderEnabled || e.gateEnabled, [
					['thr', f1(e.threshold)],
					['range', f1(e.range)],
					['ratio', `${(e.ratio / 100).toFixed(1)}:1`],
					['att', f1(e.attack)],
					['hold', f1(e.hold)],
					['rel', f1(e.release)],
				])
			: '') +
		(c
			? unit('Compressor', c.compressorEnabled, [
					['thr', f1(c.threshold)],
					['ratio', `${(c.ratio / 100).toFixed(1)}:1`],
					['att', f1(c.attack)],
					['hold', f1(c.hold)],
					['rel', f1(c.release)],
				])
			: '') +
		(l
			? unit('Limiter', l.limiterEnabled, [
					['thr', f1(l.threshold)],
					['att', f1(l.attack)],
					['hold', f1(l.hold)],
					['rel', f1(l.release)],
				])
			: '')

	box.innerHTML = `<div class="stripcard${opts.source ? ' selectable' : ''}">
		<div class="stripwrap">${strip}</div>
		<div class="graphs">
			<div class="gblock block${cls('eq')}" data-sec="eq"${a11y('eq', 'Equalizer')}>
				<div class="glabel">Equalizer ${eq?.enabled ? '' : '<span class="byp">bypassed</span>'}<span class="gval">${eq?.gain ? `${eq.gain > 0 ? '+' : ''}${fdB(eq.gain)} dB` : ''}</span></div>
				${eqGraph(eq, eqGhost)}
				<div class="bands">${bands}</div>
			</div>
			<div class="gblock block${cls('dynamics')}" data-sec="dynamics"${a11y('dynamics', 'Dynamics')}>
				<div class="glabel">Dynamics<span class="gval">in → out dB</span></div>
				<div class="dynrow">${dynamicsGraph(dyn, dynGhost)}${makeUpFader(dyn.makeUpGain ?? 0)}<div class="units">${dynUnits}</div></div>
			</div>
			<div class="gblock block${cls('inputConfig')}" data-sec="inputConfig"${a11y('inputConfig', 'Input configuration')}>
				<div class="glabel">Input</div>
				${inputConfig(cfg, d.meta, Boolean(opts.incoming) && sec.inputConfig)}
			</div>
		</div>
	</div>`
}

const CONFIG_NAME = { 1: 'Mono', 2: 'Stereo', 4: 'Dual mono' }
const LEVEL_NAME = { 1: 'Mic', 2: 'Consumer', 4: 'Pro line' }

/**
 * How the physical input is wired up: channel layout and analogue level.
 *
 * Drawn as two segmented rows so it reads like the switcher's own picker. Only the options this
 * input actually supports are shown — a camera input has no mic/line choice, and offering one
 * would imply a setting that does not exist.
 */
function inputConfig(shown, own, incoming) {
	const row = (label, options, active, names) => {
		if (!options?.length) return ''
		return `<div class="cfgrow"><em>${label}</em><div class="segs">${options
			.map((o) => `<span class="seg${o === active ? ' on' : ''}">${names[o] ?? o}</span>`)
			.join('')}</div></div>`
	}
	const layout = row('Channels', own.supportedConfigurations, shown.configuration, CONFIG_NAME)
	const level = row('Level', own.supportedInputLevels, shown.inputLevel, LEVEL_NAME)
	if (!layout && !level) {
		// The block can be ticked while the destination has no such setting at all — a camera input
		// cannot be told it is a microphone. Say that, rather than leaving a green outline next to a
		// line claiming there is nothing here.
		return incoming
			? '<div class="cfgnone">This input has no channel or level setting, so the wiring cannot be copied onto it. Everything else still copies.</div>'
			: '<div class="cfgnone">Fixed — nothing to configure on this input.</div>'
	}
	return `<div class="cfg">${layout}${level}</div>`
}

/**
 * The Make Up column from the switcher's dynamics window: a thin 0…+20 dB fader line with a
 * grabber, not a wide filled bar.
 */
function makeUpFader(makeUpGain) {
	const db = makeUpGain / 100
	const pct = Math.max(0, Math.min(100, (db / 20) * 100))
	return `<div class="makeup">
		<em>Make up</em>
		<div class="mu-track">
			<div class="mu-fill" style="height:${pct.toFixed(1)}%"><div class="mu-grab"></div></div>
		</div>
		<span class="${db > 0 ? 'on' : ''}">${fdB(makeUpGain)}</span>
	</div>`
}

window.renderStripCard = renderStripCard
window.SHAPE_NAME = SHAPE_NAME
window.shortLabel = shortLabel

/**
 * A small picture of one preset's EQ response — the library's thumbnail. Same maths as the big
 * curve, so the thumbnail is real data rather than an icon pretending to be.
 */
/**
 * A preset's EQ as a thumbnail.
 *
 * Scaled to ±8 dB rather than the card's ±15: a mic chain rarely moves more than three or four, so
 * the wider range flattened every curve into the same straight line. Anything beyond ±8 clamps,
 * which reads as "a lot" — the point of a thumbnail is to tell two presets apart at a glance.
 */
function eqSparkline(eq, w = 52, h = 28) {
	const live = eqLive(eq)
	const pts = []
	const span = 8
	for (let i = 0; i <= 56; i++) {
		const f = F_MIN * Math.pow(F_MAX / F_MIN, i / 56)
		const db = live ? eqResponseAt(eq, f) : 0
		const y = h / 2 - (Math.max(-span, Math.min(span, db)) / span) * (h / 2 - 2.5)
		pts.push(`${i ? 'L' : 'M'}${((i / 56) * w).toFixed(1)} ${y.toFixed(1)}`)
	}
	return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><line class="sz" x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" /><path class="sl${live ? '' : ' off'}" d="${pts.join(' ')}" /></svg>`
}
window.eqSparkline = eqSparkline
