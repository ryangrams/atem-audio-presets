// Generates the first-run seed presets for presets-seed/.
// Studio Upgrade starter chains — authored, sourced, honest. Values are the switcher's own raw
// encoding: dB and Q ×100, frequency in Hz, ms ×100, ratio ×100. Shapes: 1 LowShelf 2 LowPass
// 4 Bell 8 Notch 16 HighPass 32 HighShelf. Each preset defaults to EQ + dynamics only, never levels
// — a shared "sound" must not overwrite the room-set gain/fader/pan the operator dialled in.
//
// A note carried on the kitsch presets: the ATEM has no saturation/distortion, so "telephone" and
// "AM radio" here are the EQ+dynamics half of those effects — the band-limiting and the honk, not
// the grit. Said plainly in each preset's notes rather than pretended around.

import fs from 'node:fs'
import path from 'node:path'

// Regenerate with:  node scripts/gen-seed.mjs   (paths resolve relative to this file, so it runs
// from anywhere). Edit a preset below, re-run, and commit the changed presets-seed/*.json.
const OUT = path.join(import.meta.dirname, '..', 'presets-seed')
fs.mkdirSync(OUT, { recursive: true })

const rangeOf = (f) => (f < 200 ? 1 : f < 2000 ? 2 : f < 8000 ? 4 : 8)
const SHAPES = [1, 2, 4, 8, 16, 32]
const RANGES = [1, 2, 4, 8]
const band = (shape, frequency, gain, qFactor, bandEnabled = true) => ({
	bandEnabled,
	shape,
	frequencyRange: rangeOf(frequency),
	frequency,
	gain,
	qFactor,
	supportedShapes: SHAPES,
	supportedFrequencyRanges: RANGES,
})

const meta = (label, shortName) => ({
	inputId: 1001,
	sourceId: '-256',
	label,
	shortName,
	inputType: 2,
	sourceType: 0,
	configuration: 1,
	inputLevel: 1,
	maxFramesDelay: 8,
	hasStereoSimulation: false,
	supportedMixOptions: [1, 2],
	supportedConfigurations: [1],
	supportedInputLevels: [1, 4],
})

const flatLevels = { gain: 0, faderGain: 0, balance: 0, framesDelay: 0, stereoSimulation: 0 }
const comp = (threshold, ratio, attack, hold, release) => ({ compressorEnabled: true, threshold, ratio, attack, hold, release })
const compOff = { compressorEnabled: false, threshold: -2000, ratio: 300, attack: 200, hold: 0, release: 12000 }
const gate = (threshold, range, ratio, attack, hold, release) => ({ expanderEnabled: true, gateEnabled: false, threshold, range, ratio, attack, hold, release })
const gateOff = { expanderEnabled: false, gateEnabled: false, threshold: -4500, range: 2000, ratio: 200, attack: 100, hold: 1000, release: 10000 }
const lim = (threshold, attack, hold, release) => ({ limiterEnabled: true, threshold, attack, hold, release })

const P = []

// ---------------------------------------------------------------- broadcast & podcast mics
P.push({
	file: 'sm7b-broadcast-voice', name: 'SM7B broadcast voice', short: 'SM7B', group: 'Broadcast mics',
	mic: 'Shure SM7B', style: 'Broadcast voice',
	notes: 'Close-talked, pop filter on. 80 Hz high-pass clears desk rumble; a small 250 Hz dip removes boxiness; the 3.5 kHz presence lift cuts through camera audio — pull band 4 back if it reads harsh. Comp is a gentle 3:1 catching a few dB on speech. Set your own input gain (the SM7B wants a lot; a Cloudlifter helps). Based on common SM7B broadcast practice (80 Hz LC, 3–5 kHz presence, 3:1 ~-18 dB).',
	bands: [band(16, 80, 0, 71), band(4, 250, -200, 100), band(4, 1200, 100, 90), band(4, 3500, 300, 80), band(32, 10000, 200, 71), band(4, 12000, 0, 100, false)],
	dyn: { makeUpGain: 400, expander: gate(-4500, 2000, 200, 100, 1000, 12000), compressor: comp(-1800, 300, 300, 0, 12000), limiter: lim(-1200, 71, 0, 9300) },
})
P.push({
	file: 'podmic-warm-read', name: 'PodMic warm read', short: 'PodM', group: 'Broadcast mics',
	mic: 'Rode PodMic', style: 'Podcast voice',
	notes: 'Warmer, closer podcast read. 75 Hz high-pass, a touch of 200 Hz reduction so it does not get muddy up close, a modest 4 kHz presence lift and a little 8 kHz air. Comp 3:1 for an even, produced read. Set your own input gain.',
	bands: [band(16, 75, 0, 71), band(4, 200, -150, 90), band(4, 900, 100, 90), band(4, 4000, 250, 90), band(32, 8000, 150, 71), band(4, 12000, 0, 100, false)],
	dyn: { makeUpGain: 350, expander: gate(-4500, 1800, 200, 100, 1000, 12000), compressor: comp(-1600, 300, 300, 0, 11000), limiter: lim(-1200, 71, 0, 9300) },
})
P.push({
	file: 'sm58-stage-vocal', name: 'SM58 stage vocal', short: 'SM58', group: 'Broadcast mics',
	mic: 'Shure SM58', style: 'Live vocal',
	notes: 'Handheld SM58 for a live or run-and-gun vocal. 100 Hz high-pass to hold off handling and proximity boom, a small 400 Hz cut for cupped-mic mud, a presence lift at 4 kHz for cut through a PA. Firmer 4:1 comp for handheld level swings. The 58 rolls off its own top, so no air band.',
	bands: [band(16, 100, 0, 71), band(4, 400, -150, 90), band(4, 1500, 50, 90), band(4, 4000, 300, 90), band(32, 9000, 100, 71), band(4, 12000, 0, 100, false)],
	dyn: { makeUpGain: 400, expander: gate(-4000, 2000, 200, 80, 800, 9000), compressor: comp(-1800, 400, 200, 0, 10000), limiter: lim(-1000, 50, 0, 6000) },
})
P.push({
	file: 'at2020-voiceover', name: 'AT2020 voiceover', short: 'VO', group: 'Broadcast mics',
	mic: 'Audio-Technica AT2020', style: 'Voiceover',
	notes: 'Large-diaphragm condenser for a treated-room voiceover. 90 Hz high-pass, a gentle 300 Hz scoop for a cleaner low-mid, a broad 3 kHz presence and an air shelf at 12 kHz. A condenser hears the whole room, so the gate is a touch firmer. Smooth 3:1. Best in a quiet space.',
	bands: [band(16, 90, 0, 71), band(4, 300, -150, 90), band(4, 1000, 50, 90), band(4, 3000, 200, 100), band(32, 12000, 200, 71), band(4, 14000, 0, 100, false)],
	dyn: { makeUpGain: 350, expander: gate(-4200, 2200, 250, 80, 900, 10000), compressor: comp(-1800, 300, 300, 0, 11000), limiter: lim(-1200, 71, 0, 9300) },
})

// ---------------------------------------------------------------- speech reinforcement
P.push({
	file: 'lectern-gooseneck-speech', name: 'Lectern gooseneck speech', short: 'Lect', group: 'Speech reinforcement',
	mic: 'Gooseneck condenser', style: 'Speech clarity',
	notes: 'Podium / lectern gooseneck in a live room. 100 Hz high-pass buys feedback margin against the room PA; a 300 Hz cut for the boxy lectern cavity; a modest 3 kHz lift for intelligibility, kept from ringing. A firmer gate rejects the open room between sentences. Comp ~2.5:1. From church/AV speech-reinforcement practice.',
	bands: [band(16, 100, 0, 71), band(4, 300, -200, 120), band(4, 900, 50, 90), band(4, 3000, 200, 90), band(32, 9000, 100, 71), band(4, 12000, 0, 100, false)],
	dyn: { makeUpGain: 300, expander: gate(-3800, 2500, 300, 60, 800, 9000), compressor: comp(-1800, 250, 400, 0, 10000), limiter: lim(-1200, 71, 0, 9300) },
})
P.push({
	file: 'lav-headset-clarity', name: 'Lav / headset clarity', short: 'Lav', group: 'Speech reinforcement',
	mic: 'Lavalier / headset', style: 'Lav clarity',
	notes: 'Body-worn lav or headset, which tend to sound dull and chesty. 90 Hz high-pass, a small 500 Hz reduction for the chest resonance, a firmer 5 kHz presence lift to restore the intelligibility a lav loses off-axis, plus a little air. Comp 3:1 to even out the level as the head turns.',
	bands: [band(16, 90, 0, 71), band(4, 500, -150, 100), band(4, 1500, 50, 90), band(4, 5000, 300, 100), band(32, 10000, 150, 71), band(4, 12000, 0, 100, false)],
	dyn: { makeUpGain: 350, expander: gate(-4500, 1800, 200, 80, 1000, 10000), compressor: comp(-1600, 300, 250, 0, 11000), limiter: lim(-1200, 71, 0, 9300) },
})

// ---------------------------------------------------------------- creative / kitsch
// The ATEM has no distortion, so these are the EQ + dynamics half of the classic effects.
P.push({
	file: 'telephone', name: 'Telephone', short: 'Tel', group: 'Creative',
	mic: 'Any mic', style: 'Effect',
	notes: 'The classic phone-line voice: a 300 Hz–3.4 kHz band-pass with a 1 kHz honk. Brutal high-pass and low-pass squeeze everything into the telephone band; the 1 kHz bell adds the nasal "honk"; heavy 6:1 comp flattens it. Note: the ATEM cannot add the light distortion a real telephone effect also uses — this is the band-limiting only. Copy it onto a caller/remote-guest channel for a stylised look.',
	bands: [band(16, 300, 0, 100), band(4, 500, -300, 100), band(4, 1000, 600, 71), band(4, 2000, 200, 100), band(4, 3000, 100, 100), band(2, 3400, 0, 100)],
	dyn: { makeUpGain: 300, expander: gateOff, compressor: comp(-2000, 600, 100, 0, 8000), limiter: lim(-800, 30, 0, 4000) },
})
P.push({
	file: 'am-radio', name: 'AM radio', short: 'AM', group: 'Creative',
	mic: 'Any mic', style: 'Effect',
	notes: 'A vintage AM-broadcast voice — a little fuller than the telephone. Band-pass roughly 400 Hz–4.5 kHz, a presence honk around 1.8 kHz, and hard compression for that pumped, level-crushed radio sound. Like the telephone preset, the ATEM supplies the band-limiting and squash but not the analogue crunch. Fun on an announcer channel.',
	bands: [band(16, 400, 0, 100), band(4, 800, -200, 100), band(4, 1800, 500, 90), band(4, 3000, 200, 100), band(32, 4000, -300, 71), band(2, 4500, 0, 100)],
	dyn: { makeUpGain: 350, expander: gateOff, compressor: comp(-2200, 500, 100, 0, 7000), limiter: lim(-800, 30, 0, 4000) },
})
P.push({
	file: 'megaphone', name: 'Megaphone', short: 'Mega', group: 'Creative',
	mic: 'Any mic', style: 'Effect',
	notes: 'Bullhorn / PA-horn honk: a big midrange bump around 1.2 kHz, everything below 400 Hz and above 4 kHz thrown away, and heavy compression so it barks at a constant level. The ATEM does the tone and the squash; the fizzy distortion of a real horn is beyond it. A stylised "announcement" voice.',
	bands: [band(16, 400, 0, 71), band(4, 700, -200, 90), band(4, 1200, 700, 100), band(4, 2500, 300, 100), band(32, 4000, -400, 71), band(2, 4000, 0, 100)],
	dyn: { makeUpGain: 300, expander: gateOff, compressor: comp(-2200, 500, 100, 0, 6000), limiter: lim(-800, 30, 0, 4000) },
})
P.push({
	file: 'movie-trailer', name: 'Movie-trailer voice', short: 'Epic', group: 'Creative',
	mic: 'Any mic', style: 'Effect',
	notes: '"In a world…" — a big, deep announcer voice. A low-shelf lift under 120 Hz for chest and weight, a small 400 Hz cut to keep it from getting muddy, a controlled 3 kHz presence for diction, and slow, deep compression that never lets go. Works best on an already-deep voice on a good mic; it flatters, it does not manufacture.',
	bands: [band(1, 120, 400, 71), band(4, 400, -150, 90), band(4, 1000, 50, 90), band(4, 3000, 200, 100), band(32, 10000, 100, 71), band(4, 12000, 0, 100, false)],
	dyn: { makeUpGain: 500, expander: gate(-5000, 1500, 150, 100, 1200, 12000), compressor: comp(-2400, 400, 500, 0, 15000), limiter: lim(-1000, 100, 0, 9000) },
})

// ---------------------------------------------------------------- utility
P.push({
	file: 'voice-safety-net', name: 'Voice safety net', short: 'Safe', group: 'Utility',
	mic: 'Any mic', style: 'Safety net',
	notes: 'No tone-shaping at all — the honest flat one. Every EQ band is off. It adds only a gentle gate to close the mic between sentences and a brake limiter to catch peaks before they clip. Copy this onto a channel you have not had time to tune: it will not colour the sound, it just keeps it safe.',
	bands: [band(16, 80, 0, 71, false), band(4, 250, 0, 100, false), band(4, 1000, 0, 100, false), band(4, 3500, 0, 100, false), band(32, 10000, 0, 71, false), band(4, 12000, 0, 100, false)],
	dyn: { makeUpGain: 0, expander: gate(-5000, 1500, 200, 100, 1500, 10000), compressor: compOff, limiter: lim(-1000, 50, 0, 5000) },
})

for (const p of P) {
	const doc = {
		format: 'atem-audio-preset',
		version: 1,
		name: p.name,
		group: p.group,
		mic: p.mic,
		style: p.style,
		notes: p.notes,
		author: 'Studio Upgrade',
		defaultSections: { gain: false, volume: false, pan: false, eq: true, dynamics: true, inputConfig: false },
		device: { model: 'ATEM Mini Extreme ISO', release: '10.3', build: null },
		channel: {
			meta: meta(p.name, p.short),
			levels: { ...flatLevels },
			eq: { enabled: true, gain: 0, bands: p.bands },
			dynamics: p.dyn,
		},
	}
	fs.writeFileSync(path.join(OUT, `${p.file}.json`), JSON.stringify(doc, null, 2) + '\n')
}
console.log(`wrote ${P.length} seed presets`)
