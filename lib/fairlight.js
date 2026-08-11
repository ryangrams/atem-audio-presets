// Fairlight audio: read a channel out of switcher state, write one back, diff two.
//
// Every value here is the switcher's own raw integer (dB and Q are ×100, frequency is Hz,
// attack/hold/release are ms ×100). atem-connection neither scales on read nor on write, so a
// value round-trips byte-for-byte between switchers. Scaling happens only in the browser, for
// display. Don't "helpfully" convert in here.

import { Enums } from 'atem-connection'

/** Sections of a channel that can be copied independently. */
export const SECTIONS = ['gain', 'volume', 'pan', 'eq', 'dynamics', 'inputConfig']

const INPUT_TYPE = { 0: 'Video input', 1: 'Media player', 2: 'Audio in', 4: 'MADI' }
const CONFIGURATION = { 1: 'Mono', 2: 'Stereo', 4: 'Dual mono' }
const INPUT_LEVEL = { 0: '—', 1: 'Mic', 2: 'Consumer line', 4: 'Pro line' }

/**
 * Fairlight input ids that carry no audio anyone wants to copy. MADI (1501–1516) is 16 more
 * strips of nothing on a box with no MADI card attached; hiding them keeps the picker readable.
 * Nothing filters them out of a snapshot — this is a UI hint only.
 */
export function isMinorChannel(inputId) {
	return inputId >= 1501 && inputId <= 1599
}

/**
 * Which "Mic N" an analog audio input is. The analog inputs read "Mic 1"/"Mic 2" in ATEM Software
 * Control, but their Fairlight input ids are model-specific (1301/1302 on the ATEM Mini Extreme ISO,
 * verified; other models differ) — so number them by their order among the AudioIn inputs, the way
 * the switcher itself does, rather than by any hard-coded id range.
 */
function micNumber(state, inputId) {
	const ids = Object.entries(state?.fairlight?.inputs ?? {})
		.filter(([, inp]) => inp?.properties?.inputType === 2) // FairlightInputType.AudioIn
		.map(([id]) => Number(id))
		.sort((a, b) => a - b)
	const idx = ids.indexOf(Number(inputId))
	return idx >= 0 ? idx + 1 : null
}

/**
 * Fairlight input ids are not video input ids past the HDMI/SDI range: the analog inputs are the mic
 * strips and 2001/2002 are the media players. Only embedded-with-video strips may borrow the video
 * input's name — otherwise the mixer ends up showing a mic strip called "Color 1".
 */
function labelFor(state, inputId, inputType) {
	if (inputType === undefined || inputType === 0) {
		return state.inputs?.[inputId]?.longName || `Input ${inputId}`
	}
	if (inputType === 2) {
		const n = micNumber(state, inputId)
		return n ? `Mic ${n}` : `Audio in ${inputId}`
	}
	if (inputType === 1) return { 2001: 'Media Player 1', 2002: 'Media Player 2' }[inputId] ?? `Media player (${inputId})`
	if (inputType === 4) return `MADI ${inputId - 1500}`
	return `Input ${inputId}`
}

/**
 * The switcher's own short name for an input — the ≤4-character label it shows on the multiviewer
 * (Cam Left → "CamL", Mac mini → "Macm"), in the switcher's own casing. The channel card uses this
 * for its big title: it always fits, never needs an ellipsis, and matches what the operator sees
 * on the switcher. Audio-only inputs (mic, media player, MADI) have no video short name, so those
 * are synthesised to something equally short.
 */
function shortLabelFor(state, inputId, inputType) {
	const sn = state.inputs?.[inputId]?.shortName?.trim()
	if (sn) return sn
	if (inputType === 2) {
		const n = micNumber(state, inputId)
		return n ? `Mic${n}` : `In${inputId}`
	}
	if (inputType === 1) return { 2001: 'MP1', 2002: 'MP2' }[inputId] ?? 'MP'
	if (inputType === 4) return `MD${inputId - 1500}`
	// No short name on record — take the first word, kept in its own casing.
	return labelFor(state, inputId, inputType).split(/\s+/)[0].slice(0, 6)
}

/**
 * Does this channel actually do anything to the audio?
 *
 * "Active" has to mean audible, not merely switched on: the factory default is EQ enabled with
 * four flat bells, which would otherwise light up every strip in the list. A band counts when it
 * has gain, or when its shape filters at 0 dB (low pass / notch / high pass).
 *
 * Takes the same {eq, dynamics} shape that both live state and a saved preset use, so the
 * channel list and the preset library can share one definition.
 */
export function summarizeChannel({ eq, dynamics } = {}) {
	const bands = eq?.bands ?? []
	const dyn = dynamics ?? {}
	return {
		eqActive: Boolean(eq?.enabled && bands.some((b) => b?.bandEnabled && (b.gain !== 0 || [2, 8, 16].includes(b.shape)))),
		eqBandsOn: bands.filter((b) => b?.bandEnabled).length,
		dynActive: Boolean(
			dyn.compressor?.compressorEnabled ||
				dyn.limiter?.limiterEnabled ||
				dyn.expander?.expanderEnabled ||
				dyn.expander?.gateEnabled
		),
	}
}

/**
 * A source is one strip in the Fairlight mixer. A stereo/mono input has one; a dual-mono input
 * has two (left and right, with separate ids). The id is an opaque int64 the switcher assigns
 * from its *current* input configuration — never persist it as though it were stable, and never
 * let a user type one in. See reference/ATEM-SDK-FIELD-NOTES.md §7.
 */
export function listChannels(state) {
	const out = []
	const inputs = state?.fairlight?.inputs ?? {}
	for (const [inputIdStr, input] of Object.entries(inputs)) {
		const inputId = Number(inputIdStr)
		const sourceIds = Object.keys(input?.sources ?? {})
		for (const sourceId of sourceIds) {
			const source = input.sources[sourceId]
			if (!source) continue
			const props = source.properties ?? {}
			const eq = source.equalizer ?? {}
			const dyn = source.dynamics ?? {}
			const bands = eq.bands ?? []
			out.push({
				key: `${inputId}:${sourceId}`,
				inputId,
				sourceId,
				label: labelFor(state, inputId, input?.properties?.inputType),
				// Dual-mono inputs produce two strips; tag them so they're tellable apart.
				leg: sourceIds.length > 1 ? (sourceIds.indexOf(sourceId) === 0 ? 'L' : 'R') : null,
				minor: isMinorChannel(inputId),
				inputType: input.properties?.inputType,
				inputTypeLabel: INPUT_TYPE[input.properties?.inputType] ?? '?',
				configuration: input.properties?.activeConfiguration,
				configurationLabel: CONFIGURATION[input.properties?.activeConfiguration] ?? '?',
				inputLevel: input.properties?.activeInputLevel,
				inputLevelLabel: INPUT_LEVEL[input.properties?.activeInputLevel] ?? '—',
				sourceType: props.sourceType,
				sourceTypeLabel: props.sourceType === Enums.FairlightAudioSourceType.Stereo ? 'Stereo' : 'Mono',
				bandCount: bands.length,
				// At-a-glance markers so the interesting channels stand out in the list.
				summary: {
					gain: props.gain,
					faderGain: props.faderGain,
					balance: props.balance,
					mixOption: props.mixOption,
					...summarizeChannel({ eq, dynamics: dyn }),
					compressor: Boolean(dyn.compressor?.compressorEnabled),
					limiter: Boolean(dyn.limiter?.limiterEnabled),
					expander: Boolean(dyn.expander?.expanderEnabled),
					gate: Boolean(dyn.expander?.gateEnabled),
				},
			})
		}
	}
	// Source ids are negative int64s, so sort them numerically — string order would put the
	// right leg of a dual-mono input above the left.
	return out.sort((a, b) => a.inputId - b.inputId || Number(a.sourceId) - Number(b.sourceId))
}

export function getSource(state, inputId, sourceId) {
	return state?.fairlight?.inputs?.[inputId]?.sources?.[String(sourceId)]
}

/** Everything about one strip, in a shape that survives a round trip through JSON and back. */
export function extractChannel(state, inputId, sourceId) {
	const input = state?.fairlight?.inputs?.[inputId]
	const source = getSource(state, inputId, sourceId)
	if (!source) return null
	const props = source.properties ?? {}
	const eq = source.equalizer ?? {}
	const dyn = source.dynamics ?? {}
	return {
		meta: {
			inputId: Number(inputId),
			sourceId: String(sourceId),
			label: labelFor(state, inputId, input?.properties?.inputType),
			shortName: shortLabelFor(state, inputId, input?.properties?.inputType),
			inputType: input?.properties?.inputType,
			sourceType: props.sourceType,
			configuration: input?.properties?.activeConfiguration,
			inputLevel: input?.properties?.activeInputLevel,
			maxFramesDelay: props.maxFramesDelay,
			hasStereoSimulation: props.hasStereoSimulation,
			supportedMixOptions: props.supportedMixOptions ?? [],
			supportedConfigurations: input?.properties?.supportedConfigurations ?? [],
			supportedInputLevels: input?.properties?.supportedInputLevels ?? [],
		},
		levels: {
			gain: props.gain,
			faderGain: props.faderGain,
			balance: props.balance,
			framesDelay: props.framesDelay,
			stereoSimulation: props.stereoSimulation,
			mixOption: props.mixOption,
		},
		eq: {
			enabled: eq.enabled,
			gain: eq.gain,
			bands: (eq.bands ?? []).map((b) =>
				b
					? {
							bandEnabled: b.bandEnabled,
							shape: b.shape,
							frequencyRange: b.frequencyRange,
							frequency: b.frequency,
							gain: b.gain,
							qFactor: b.qFactor,
							supportedShapes: b.supportedShapes ?? [],
							supportedFrequencyRanges: b.supportedFrequencyRanges ?? [],
						}
					: null
			),
		},
		dynamics: {
			makeUpGain: dyn.makeUpGain,
			compressor: dyn.compressor ? { ...dyn.compressor } : null,
			limiter: dyn.limiter ? { ...dyn.limiter } : null,
			expander: dyn.expander ? { ...dyn.expander } : null,
		},
	}
}

/** Every strip on the switcher, for a whole-console snapshot. */
export function extractSwitcher(state, info = {}) {
	return {
		format: 'atem-audio-snapshot',
		version: 1,
		savedAt: new Date().toISOString(),
		device: info,
		channels: listChannels(state).map((c) => extractChannel(state, c.inputId, c.sourceId)),
	}
}

const num = (v) => typeof v === 'number' && Number.isFinite(v)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * Write a channel payload onto a destination strip.
 *
 * Anything the destination cannot accept is skipped and reported rather than sent: an
 * unsupported mix option, a frames-delay past the destination's maximum, an EQ shape this band
 * does not offer. The switcher's failure mode for a bad value is silence, not an error, so the
 * check has to happen here.
 */
export async function applyChannel(atem, dest, payload, sections) {
	const inputId = Number(dest.inputId)
	const sourceId = String(dest.sourceId)
	const state = atem.state
	const destInput = state?.fairlight?.inputs?.[inputId]
	const destSource = getSource(state, inputId, sourceId)
	if (!destSource) {
		throw new Error(
			`Destination ${inputId}:${sourceId} does not exist on this switcher. ` +
				`Source ids change with the input's audio configuration — re-read the switcher and pick again.`
		)
	}

	const applied = []
	const skipped = []
	const warnings = []
	const destProps = destSource.properties ?? {}

	if (payload.meta && destProps.sourceType !== payload.meta.sourceType) {
		warnings.push(
			`Source strip is ${payload.meta.sourceType === 1 ? 'stereo' : 'mono'} and the destination is ` +
				`${destProps.sourceType === 1 ? 'stereo' : 'mono'}. Settings still copy, but check the result by ear.`
		)
	}

	// gain / fader / pan / EQ master / dynamics make-up all live in one command (CFSP), so
	// collect them across sections and send once.
	const cfsp = {}

	// Input gain and the input-stage extras that travel with it.
	if (sections.gain) {
		const l = payload.levels ?? {}
		if (num(l.gain)) cfsp.gain = l.gain
		if (num(l.framesDelay)) {
			const max = destProps.maxFramesDelay ?? 0
			cfsp.framesDelay = clamp(l.framesDelay, 0, max)
			if (cfsp.framesDelay !== l.framesDelay)
				warnings.push(`Frames delay ${l.framesDelay} clamped to ${cfsp.framesDelay} (destination max ${max}).`)
		}
		if (num(l.stereoSimulation)) {
			if (destProps.hasStereoSimulation) cfsp.stereoSimulation = l.stereoSimulation
			else skipped.push('stereo simulation (destination has none)')
		}
	}

	if (sections.volume && num(payload.levels?.faderGain)) cfsp.faderGain = payload.levels.faderGain

	if (sections.pan && num(payload.levels?.balance)) cfsp.balance = payload.levels.balance

	// mixOption — the channel's on / off / audio-follow-video state — is deliberately never
	// copied. It is a live operating control, not part of a channel's sound: pasting a preset
	// must not mute a channel or put it on air.

	if (sections.eq) {
		const e = payload.eq ?? {}
		if (typeof e.enabled === 'boolean') cfsp.equalizerEnabled = e.enabled
		if (num(e.gain)) cfsp.equalizerGain = e.gain
	}

	if (sections.dynamics && num(payload.dynamics?.makeUpGain)) {
		cfsp.makeUpGain = payload.dynamics.makeUpGain
	}

	if (Object.keys(cfsp).length) {
		await atem.setFairlightAudioMixerSourceProps(inputId, sourceId, cfsp)
		applied.push(`source properties (${Object.keys(cfsp).join(', ')})`)
	}

	if (sections.eq) {
		const destBands = destSource.equalizer?.bands ?? []
		const srcBands = payload.eq?.bands ?? []
		if (srcBands.length !== destBands.length && srcBands.length && destBands.length) {
			warnings.push(`Preset has ${srcBands.length} EQ bands, destination has ${destBands.length}. Copying the overlap.`)
		}
		for (let i = 0; i < Math.min(srcBands.length, destBands.length); i++) {
			const b = srcBands[i]
			const d = destBands[i]
			if (!b || !d) continue
			const band = {}
			if (typeof b.bandEnabled === 'boolean') band.bandEnabled = b.bandEnabled
			if (num(b.frequency)) band.frequency = b.frequency
			if (num(b.gain)) band.gain = b.gain
			if (num(b.qFactor)) band.qFactor = b.qFactor
			if (num(b.shape)) {
				if ((d.supportedShapes ?? []).includes(b.shape)) band.shape = b.shape
				else skipped.push(`band ${i + 1} shape ${b.shape} (unsupported on this band)`)
			}
			if (num(b.frequencyRange)) {
				if ((d.supportedFrequencyRanges ?? []).includes(b.frequencyRange)) band.frequencyRange = b.frequencyRange
				else skipped.push(`band ${i + 1} frequency range ${b.frequencyRange} (unsupported on this band)`)
			}
			if (Object.keys(band).length) {
				await atem.setFairlightAudioMixerSourceEqualizerBandProps(inputId, sourceId, i, band)
				applied.push(`EQ band ${i + 1}`)
			}
		}
	}

	if (sections.dynamics) {
		const d = payload.dynamics ?? {}
		if (d.compressor && destSource.dynamics?.compressor) {
			await atem.setFairlightAudioMixerSourceCompressorProps(inputId, sourceId, { ...d.compressor })
			applied.push('compressor')
		} else if (d.compressor) skipped.push('compressor (destination has none)')

		if (d.limiter && destSource.dynamics?.limiter) {
			await atem.setFairlightAudioMixerSourceLimiterProps(inputId, sourceId, { ...d.limiter })
			applied.push('limiter')
		} else if (d.limiter) skipped.push('limiter (destination has none)')

		if (d.expander && destSource.dynamics?.expander) {
			await atem.setFairlightAudioMixerSourceExpanderProps(inputId, sourceId, { ...d.expander })
			applied.push('expander/gate')
		} else if (d.expander) skipped.push('expander/gate (destination has none)')
	}

	// Off by default in the UI: changing an input's configuration makes the switcher re-enumerate
	// its source ids, so the strip you were just editing can cease to exist under that id.
	if (sections.inputConfig) {
		const cfg = {}
		const m = payload.meta ?? {}
		const supportedCfg = destInput?.properties?.supportedConfigurations ?? []
		const supportedLvl = destInput?.properties?.supportedInputLevels ?? []
		if (num(m.configuration) && supportedCfg.includes(m.configuration)) cfg.activeConfiguration = m.configuration
		else if (num(m.configuration)) skipped.push(`input configuration ${m.configuration} (unsupported)`)
		if (num(m.inputLevel) && supportedLvl.includes(m.inputLevel)) cfg.activeInputLevel = m.inputLevel
		else if (num(m.inputLevel) && m.inputLevel !== 0) skipped.push(`input level ${m.inputLevel} (unsupported)`)
		if (Object.keys(cfg).length) {
			await atem.setFairlightAudioMixerInputProps(inputId, cfg)
			applied.push(`input configuration (${Object.keys(cfg).join(', ')})`)
			warnings.push('Input configuration changed — the switcher re-enumerates source ids. Re-read the switcher before copying again.')
		}
	}

	return { applied, skipped, warnings }
}

/** Field-by-field comparison, used both for the pre-flight preview and the post-apply verify. */
export function diffChannel(current, incoming, sections) {
	const out = []
	const push = (section, path, from, to) => {
		if (from === to) return
		if (from === undefined || to === undefined) return
		out.push({ section, path, from, to })
	}

	// mixOption is excluded here as well as in applyChannel: a field that is never sent must
	// never show up as a pending change or as a failed read-back.
	if (sections.gain) {
		for (const k of ['gain', 'framesDelay', 'stereoSimulation']) {
			push('gain', k, current?.levels?.[k], incoming?.levels?.[k])
		}
	}
	if (sections.volume) push('volume', 'faderGain', current?.levels?.faderGain, incoming?.levels?.faderGain)
	if (sections.pan) push('pan', 'balance', current?.levels?.balance, incoming?.levels?.balance)
	if (sections.eq) {
		push('eq', 'enabled', current?.eq?.enabled, incoming?.eq?.enabled)
		push('eq', 'gain', current?.eq?.gain, incoming?.eq?.gain)
		const n = Math.min(current?.eq?.bands?.length ?? 0, incoming?.eq?.bands?.length ?? 0)
		for (let i = 0; i < n; i++) {
			const a = current.eq.bands[i]
			const b = incoming.eq.bands[i]
			if (!a || !b) continue
			for (const k of ['bandEnabled', 'shape', 'frequencyRange', 'frequency', 'gain', 'qFactor']) {
				push('eq', `band ${i + 1}.${k}`, a[k], b[k])
			}
		}
	}
	if (sections.dynamics) {
		push('dynamics', 'makeUpGain', current?.dynamics?.makeUpGain, incoming?.dynamics?.makeUpGain)
		for (const unit of ['compressor', 'limiter', 'expander']) {
			const a = current?.dynamics?.[unit]
			const b = incoming?.dynamics?.[unit]
			if (!a || !b) continue
			for (const k of Object.keys(b)) push('dynamics', `${unit}.${k}`, a[k], b[k])
		}
	}
	if (sections.inputConfig) {
		push('inputConfig', 'configuration', current?.meta?.configuration, incoming?.meta?.configuration)
		push('inputConfig', 'inputLevel', current?.meta?.inputLevel, incoming?.meta?.inputLevel)
	}
	return out
}
