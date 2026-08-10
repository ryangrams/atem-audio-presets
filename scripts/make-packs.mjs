// Bundle the Studio Upgrade starter presets into catalogue packs for the community library.
// Reads the self-contained preset JSON from ./presets-seed and writes fully self-contained packs
// into the sibling atem-preset-library/packs — CI in that repo has no access to this one, so the
// preset data must be embedded, not referenced. Run:  node scripts/make-packs.mjs  then, in the
// library repo:  node scripts/build-index.mjs  to revalidate and rebuild site/index.json.
// Override the library location with ATEM_LIBRARY_DIR if the repos are not siblings.

import fs from 'node:fs'
import path from 'node:path'

const SEED = path.join(import.meta.dirname, '..', 'presets-seed')
const LIB = process.env.ATEM_LIBRARY_DIR || path.join(import.meta.dirname, '..', '..', 'atem-preset-library')
const PACKS = path.join(LIB, 'packs')
if (!fs.existsSync(LIB)) {
	console.error(`Library repo not found at ${LIB} — set ATEM_LIBRARY_DIR to its path.`)
	process.exit(1)
}
const CREATED = '2026-08-09T00:00:00.000Z' // fixed so checksums/index are reproducible

const load = (f) => JSON.parse(fs.readFileSync(path.join(SEED, f + '.json'), 'utf8'))
const presets = (names) => names.map(load)

const PACKS_DEF = [
	{
		file: 'su-broadcast-voices',
		name: 'Broadcast & podcast voices',
		description:
			'Starting-point chains for the mics people actually reach for on camera and behind a podcast — the Shure SM7B, Rode PodMic, Shure SM58 and Audio-Technica AT2020 — plus a flat "safety net" for a channel you have not had time to tune. Each is EQ + dynamics only, so copying one keeps the input gain and fader you already set. Tune to taste; a preset is a head start, not a verdict.',
		tags: ['broadcast', 'podcast', 'voice', 'sm7b', 'podmic', 'sm58', 'condenser'],
		names: ['sm7b-broadcast-voice', 'podmic-warm-read', 'sm58-stage-vocal', 'at2020-voiceover', 'voice-safety-net'],
	},
	{
		file: 'su-speech-reinforcement',
		name: 'Speech reinforcement',
		description:
			'For the spoken word in a live room — a lectern gooseneck and a body-worn lav/headset. Both lean on a firmer gate and a high-pass for feedback margin, and restore the intelligibility these mics lose off-axis. Aimed at houses of worship, conference AV and stage announcers.',
		tags: ['speech', 'lectern', 'lavalier', 'church', 'av', 'live'],
		names: ['lectern-gooseneck-speech', 'lav-headset-clarity'],
	},
	{
		file: 'su-creative-fx',
		name: 'Creative FX',
		description:
			'Stylised voices for effect: telephone, AM radio, megaphone and a deep movie-trailer announcer. Heads up — the ATEM has no distortion or saturation, so the telephone/AM/megaphone chains are the band-limiting and the honk only, not the grit. Each preset says so in its notes. Great fun on a caller, remote guest or announcer channel.',
		tags: ['fx', 'creative', 'telephone', 'lofi', 'megaphone', 'trailer'],
		names: ['telephone', 'am-radio', 'megaphone', 'movie-trailer'],
	},
]

fs.mkdirSync(PACKS, { recursive: true })
for (const def of PACKS_DEF) {
	const pack = {
		format: 'atem-audio-preset-pack',
		version: 1,
		name: def.name,
		description: def.description,
		author: 'Studio Upgrade',
		tags: def.tags,
		createdAt: CREATED,
		presets: presets(def.names),
	}
	fs.writeFileSync(path.join(PACKS, def.file + '.json'), JSON.stringify(pack, null, 2) + '\n')
	console.log(`wrote packs/${def.file}.json (${def.names.length} presets)`)
}
