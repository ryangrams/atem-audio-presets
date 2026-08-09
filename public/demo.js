'use strict'

// Demo harness. The switcher lives at the studio, so every visual path in this app is otherwise
// unreachable at a desk: first run, a failed connect, a copy in flight, a copy that came back
// clamped. This stubs the HTTP API with synthesized state so all of them can be opened and
// looked at in a browser.
//
// It never runs in the real app: the server binds 127.0.0.1, so a page served from there gets
// the real API. Opening index.html from a file, a static host, or with ?demo=1 turns it on.

;(function () {
	const params = new URLSearchParams(location.search)
	const forced = params.has('demo')
	const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)
	if (!forced && local) return

	const SCENARIOS = {
		'first-run': 'First run — nothing connected',
		'connect-fail': 'Connect failed — switcher busy',
		connected: 'Connected — one channel to one',
		multi: 'Connected — one channel to three',
		copying: 'Copy in progress',
		clamped: 'Copy finished — a value was clamped',
		'library-empty': 'Preset library — empty',
		library: 'Preset library — in use',
		browse: 'Preset browser — shelf',
		'browse-detail': 'Preset browser — one preset',
		'browse-publish': 'Preset browser — share yours',
		'catalogue-offline': 'Preset browser — no internet',
	}
	let scenario = params.get('demo') || 'connected'
	if (!SCENARIOS[scenario]) scenario = 'connected'

	// ---------------------------------------------------------------- synthesized switcher

	const band = (shape, frequency, gain, qFactor, bandEnabled = true) => ({
		bandEnabled,
		shape,
		frequencyRange: frequency < 200 ? 1 : frequency < 2000 ? 2 : frequency < 8000 ? 4 : 8,
		frequency,
		gain,
		qFactor,
		supportedShapes: [1, 2, 4, 8, 16, 32],
		supportedFrequencyRanges: [1, 2, 4, 8],
	})

	const micChain = () => ({
		eq: {
			enabled: true,
			gain: 0,
			bands: [
				band(16, 80, 0, 70),
				band(4, 240, -350, 120),
				band(4, 1200, 150, 90),
				band(4, 3500, 250, 80),
				band(32, 8000, 200, 70),
				band(4, 12000, 0, 100, false),
			],
		},
		dynamics: {
			makeUpGain: 1077,
			expander: { expanderEnabled: true, gateEnabled: false, threshold: -4500, range: 2000, ratio: 200, attack: 100, hold: 1000, release: 10000 },
			compressor: { compressorEnabled: true, threshold: -2000, ratio: 300, attack: 200, hold: 1000, release: 12000 },
			limiter: { limiterEnabled: true, threshold: -1550, attack: 10, hold: 200, release: 5000 },
		},
	})

	const flatChain = () => ({
		eq: {
			enabled: true,
			gain: 0,
			bands: [band(4, 100, 0, 100), band(4, 800, 0, 100), band(4, 3000, 0, 100), band(4, 9000, 0, 100)],
		},
		dynamics: {
			makeUpGain: 0,
			expander: { expanderEnabled: false, gateEnabled: false, threshold: -3500, range: 3000, ratio: 200, attack: 100, hold: 1000, release: 10000 },
			compressor: { compressorEnabled: false, threshold: -1500, ratio: 200, attack: 200, hold: 1000, release: 10000 },
			limiter: { limiterEnabled: false, threshold: -900, attack: 10, hold: 200, release: 5000 },
		},
	})

	const DEFS = [
		{ inputId: 1001, label: 'Mic 1', type: 2, mic: true, chain: micChain },
		{ inputId: 1002, label: 'Mic 2', type: 2, mic: true, chain: flatChain },
		{ inputId: 1, label: 'Camera 1', type: 0, chain: flatChain },
		{ inputId: 2, label: 'Camera 2', type: 0, chain: flatChain },
		{ inputId: 3, label: 'Camera 3', type: 0, chain: flatChain },
		{ inputId: 4, label: 'Lectern', type: 0, chain: flatChain },
		{ inputId: 5, label: 'Overhead', type: 0, chain: flatChain },
		{ inputId: 2001, label: 'Media Player 1', type: 1, chain: flatChain },
	]
	for (let i = 1; i <= 16; i++) DEFS.push({ inputId: 1500 + i, label: `MADI ${i}`, type: 4, minor: true, chain: flatChain })

	// The switcher's live state, mutated by /api/apply so a copy really does change something.
	const box = {}
	for (const d of DEFS) {
		const chain = d.chain()
		box[`${d.inputId}:-256`] = {
			meta: {
				inputId: d.inputId,
				sourceId: '-256',
				label: d.label,
				inputType: d.type,
				sourceType: d.mic ? 0 : 1,
				configuration: d.mic ? 1 : 2,
				inputLevel: d.mic ? 1 : 0,
				maxFramesDelay: 8,
				hasStereoSimulation: !d.mic,
				supportedMixOptions: [1, 2, 4],
				supportedConfigurations: d.mic ? [1, 2, 4] : [],
				supportedInputLevels: d.mic ? [1, 2, 4] : [],
			},
			levels: {
				gain: d.mic ? 4000 : 0,
				faderGain: d.mic ? 0 : -600,
				balance: 0,
				framesDelay: 0,
				stereoSimulation: 0,
				mixOption: 2,
			},
			...chain,
		}
	}

	const clone = (v) => JSON.parse(JSON.stringify(v))

	const summarize = (c) => ({
		eqActive: Boolean(c.eq.enabled && c.eq.bands.some((b) => b?.bandEnabled && (b.gain !== 0 || [2, 8, 16].includes(b.shape)))),
		eqBandsOn: c.eq.bands.filter((b) => b?.bandEnabled).length,
		dynActive: Boolean(c.dynamics.compressor?.compressorEnabled || c.dynamics.limiter?.limiterEnabled || c.dynamics.expander?.expanderEnabled),
	})

	const channelList = () =>
		DEFS.map((d) => {
			const c = box[`${d.inputId}:-256`]
			return {
				key: `${d.inputId}:-256`,
				inputId: d.inputId,
				sourceId: '-256',
				label: d.label,
				leg: null,
				minor: Boolean(d.minor),
				configurationLabel: d.mic ? 'Mono' : 'Stereo',
				summary: summarize(c),
			}
		})

	const DEVICE = { model: 'ATEM Mini Extreme ISO', release: '10.3', build: 'b7f2c19', ip: '192.168.8.20' }

	// ---------------------------------------------------------------- preset library

	const lecternChain = () => ({
		eq: { enabled: true, gain: 0, bands: [band(16, 120, 0, 70), band(4, 250, -300, 140), band(4, 2800, 250, 120), band(32, 10000, 150, 70), band(4, 6000, 0, 100, false), band(4, 12000, 0, 100, false)] },
		dynamics: {
			makeUpGain: 400,
			expander: { expanderEnabled: true, gateEnabled: false, threshold: -4200, range: 2400, ratio: 250, attack: 100, hold: 1500, release: 20000 },
			compressor: { compressorEnabled: true, threshold: -2000, ratio: 300, attack: 300, hold: 1000, release: 15000 },
			limiter: { limiterEnabled: true, threshold: -500, attack: 10, hold: 200, release: 5000 },
		},
	})
	const safetyChain = () => ({
		eq: { enabled: false, gain: 0, bands: [band(4, 100, 0, 100, false), band(4, 800, 0, 100, false), band(4, 3000, 0, 100, false), band(4, 9000, 0, 100, false)] },
		dynamics: {
			makeUpGain: 200,
			expander: { expanderEnabled: false, gateEnabled: false, threshold: -3500, range: 3000, ratio: 200, attack: 100, hold: 1000, release: 10000 },
			compressor: { compressorEnabled: true, threshold: -1400, ratio: 200, attack: 800, hold: 1000, release: 20000 },
			limiter: { limiterEnabled: true, threshold: -300, attack: 10, hold: 200, release: 5000 },
		},
	})

	const PRESET_DEFS = [
		{ file: 'sm7b-broadcast-voice.json', name: 'SM7B broadcast voice', group: 'Dynamic mics', order: 0, mic: 'Shure SM7B', style: 'Broadcast voice', notes: 'Close-talked, pop filter on. Presence lift at 3.2 kHz — pull band 4 back if it reads harsh in your room.', sampleUrl: 'https://loop.studioupgrade.com', chain: micChain },
		{ file: 'podmic-podcast.json', name: 'PodMic podcast', group: 'Dynamic mics', order: 1, mic: 'Rode PodMic', style: 'Podcast', notes: 'Warm conversational read at a hand-width off the grille.', chain: micChain },
		{ file: 'lectern-gooseneck.json', name: 'Lectern gooseneck', group: 'Condensers', order: 0, mic: 'Gooseneck condenser', style: 'Speech clarity', notes: 'Gate opens for the speaker, not the room. Raise the high-pass if the lectern thumps.', chain: lecternChain },
		{ file: 'voice-safety-net.json', name: 'Voice safety net', group: 'Utility', order: 0, style: 'Safety net', notes: 'No EQ — a gentle 2:1 with a hard ceiling. The “do not embarrass me” preset.', chain: safetyChain },
	]
	let presets = scenario === 'library-empty' ? [] : PRESET_DEFS.map(({ chain, notes, sampleUrl, ...row }) => ({ ...row }))
	/** Bodies saved during the demo session, so a save round-trips like the real thing. */
	const savedBodies = {}
	const presetBody = (file) => {
		if (savedBodies[file]) return clone(savedBodies[file])
		const def = PRESET_DEFS.find((d) => d.file === file)
		const row = presets.find((p) => p.file === file)
		const ch = clone(box['1001:-256'])
		if (def?.chain) Object.assign(ch, def.chain())
		ch.meta.label = def?.mic ?? def?.name ?? row?.name ?? 'Channel'
		return {
			format: 'atem-audio-preset',
			version: 1,
			name: def?.name ?? row?.name ?? file,
			group: def?.group ?? row?.group ?? '',
			savedAt: '2026-05-14T18:20:00.000Z',
			device: DEVICE,
			mic: def?.mic ?? row?.mic ?? null,
			style: def?.style ?? row?.style ?? null,
			notes: def?.notes ?? null,
			sampleUrl: def?.sampleUrl ?? null,
			defaultSections: { gain: true, volume: false, pan: false, eq: true, dynamics: true, inputConfig: false },
			channel: ch,
		}
	}
	for (const p of presets) {
		const c = presetBody(p.file).channel
		p.summary = summarize(c)
		p.meta = { label: c.meta.label }
		p.device = DEVICE
		p.savedAt = '2026-05-14T18:20:00.000Z'
	}

	// ---------------------------------------------------------------- community catalogue

	const cat = (id, name, author, mic, style, rating, ratings, installs, days, notes, chain, comments = [], sampleUrl = null) => ({
		id,
		name,
		author,
		mic,
		style,
		notes,
		sampleUrl,
		rating,
		ratings,
		installs,
		createdAt: new Date(Date.now() - days * 86400000).toISOString(),
		device: DEVICE,
		defaultSections: { gain: true, volume: false, pan: false, eq: true, dynamics: true, inputConfig: false },
		channel: (() => {
			const ch = clone(box['1001:-256'])
			Object.assign(ch, chain())
			ch.meta.label = mic ?? name
			return ch
		})(),
		comments: comments.map((c, i) => ({ author: c[0], at: new Date(Date.now() - (i + 1) * 3.5 * 86400000).toISOString(), body: c[1], rating: c[2], votes: c[3] })),
	})

	const CATALOGUE = [
		cat('sm7b-broadcast', 'SM7B broadcast voice', 'ryangrams', 'Shure SM7B', 'Broadcast voice', 4.8, 214, 1842, 96, 'Close-talked with the pop filter on. The 3.2 kHz lift is what cuts through camera audio — pull it back if it reads harsh in your room. Gain assumes a quiet room and a Cloudlifter; without one you will need more.', micChain, [
			['podcastdad', 'Straight onto two SM7Bs for a weekly two-hander. Only change: I took band 2 down to −2 dB, our room is already dry.', 5, 34],
			['kmiller.av', 'The gate threshold was letting HVAC through in our space. Moved it to −40 and it is perfect. Everything else untouched.', 4, 21],
			['LiveFromTheGarage', 'Been looking for this for two years. Sounds like a real radio chain instead of a switcher.', 5, 12],
		]),
		cat('lectern-speech', 'Lectern gooseneck speech', 'stcatherines.tech', 'Gooseneck condenser', 'Speech clarity', 4.6, 88, 903, 61, 'Intelligibility first: firm high-pass, proximity cut at 250, presence lift at 2.8k. The expander opens for the speaker, not the room — raise its threshold if it chatters between sentences.', lecternChain, [
			['worshiptech_dan', 'Volunteer-proof. I set this on all four lectern channels and stopped getting Sunday texts.', 5, 41],
			['avforhire', 'Great starting point. In a live room I add another dB of cut at 250.', 4, 9],
		]),
		cat('sm58-stage', 'SM58 stage vocal', 'ryangrams', 'Shure SM58', 'Live vocal', 4.4, 63, 512, 44, 'Cuts the 400 Hz box, small presence lift. The expander is set for stage bleed — deepen its range if the drums are loud.', micChain, [['fohcarl', 'Solid. Add your own high-pass sweep to taste per singer.', 4, 7]]),
		cat('wireless-go-lav', 'Wireless GO lav fix', 'onepersonstudio', 'Rode Wireless GO II', 'Lav / headset', 4.5, 71, 640, 30, 'Counters a chest-mounted lav: thins the chest resonance at 700, lifts the clothing-muffled top. Gain is low because the receiver output is hot — check your meters before you trust it.', flatChain, [
			['tinyroomvideo', 'This is the one that made lavs usable for me. The 700 cut is the whole trick.', 5, 28],
		]),
		cat('podmic-warm', 'PodMic warm read', 'thebasementpod', 'Rode PodMic', 'Podcast', 4.3, 52, 447, 21, 'Warm conversational read at a hand-width off the grille. Built-in pop shield does the rest.', micChain, [['nightshiftnick', 'Warmer than I expected in a good way. I dropped the make-up 2 dB.', 4, 5]]),
		cat('headset-worship', 'Headset, loud room', 'worshiptech_dan', 'Headset mic', 'Lav / headset', 4.7, 96, 738, 12, 'For a headset in front of loudspeakers: the narrow 315 Hz cut sits where these mics ring first. Made for speech, not singing — it will strangle a vocal.', lecternChain, [
			['stcatherines.tech', 'Killed our feedback problem outright. Should be the default for anyone with wedges.', 5, 52],
			['sundaymorningsound', 'Works. Be honest with yourself about mic placement first though.', 4, 11],
		]),
		cat('safety-net', 'Voice safety net', 'ryangrams', null, 'Safety net', 4.9, 168, 2210, 88, 'No EQ — a gentle 2:1 and a hard ceiling, for any voice on any mic. The “do not embarrass me” preset. Ticks only Dynamics, so it lands on a channel without touching your EQ.', safetyChain, [
			['everyonesfirstshow', 'If you install one thing from here, install this. It has saved two of our streams.', 5, 96],
			['kmiller.av', 'Put it on every channel of a rental switcher before handing it over.', 5, 44],
		]),
		cat('at2020-vo', 'AT2020 voiceover', 'quietcorner', 'Audio-Technica AT2020', 'Broadcast voice', 4.1, 39, 288, 7, 'A condenser hears the room — this assumes a treated or at least soft one. Raise the high-pass to 100 Hz on a boomy desk.', micChain, [['firstmicever', 'Helped a lot. My room is the problem, not the preset.', 4, 6]]),
		cat('flat-reset', 'Flat reset', 'ryangrams', null, 'Utility', 4.6, 74, 1104, 88, 'Puts a channel back to zero: unity gain, fader at 0, pan centred, EQ flat, dynamics off. The known-good starting point when someone has been “helping”.', flatChain, [['avforhire', 'The undo button for people who did not use undo.', 5, 30]]),
		cat('choir-overheads', 'Choir overheads', 'stcatherines.tech', 'Small-diaphragm pair', 'Music', 4.2, 28, 196, 3, 'Gentle, mostly a high-pass and a small air lift. Compression kept light on purpose — choirs breathe and squashing that sounds wrong.', flatChain, []),
	]

	// ---------------------------------------------------------------- fake transport

	const delay = (ms) => new Promise((r) => setTimeout(r, ms))
	const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
	const fail = (message, status = 502) => new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } })

	const diffFor = (from, to, sections) => {
		const out = []
		const push = (section, path, a, b) => {
			if (a !== b && a !== undefined && b !== undefined) out.push({ section, path, from: a, to: b })
		}
		if (sections.gain) push('gain', 'gain', to.levels.gain, from.levels.gain)
		if (sections.volume) push('volume', 'faderGain', to.levels.faderGain, from.levels.faderGain)
		if (sections.pan) push('pan', 'balance', to.levels.balance, from.levels.balance)
		if (sections.eq) {
			push('eq', 'enabled', to.eq.enabled, from.eq.enabled)
			push('eq', 'gain', to.eq.gain, from.eq.gain)
			const n = Math.min(to.eq.bands.length, from.eq.bands.length)
			for (let i = 0; i < n; i++) {
				for (const k of ['bandEnabled', 'shape', 'frequency', 'gain', 'qFactor']) {
					push('eq', `band ${i + 1}.${k}`, to.eq.bands[i][k], from.eq.bands[i][k])
				}
			}
		}
		if (sections.dynamics) {
			push('dynamics', 'makeUpGain', to.dynamics.makeUpGain, from.dynamics.makeUpGain)
			for (const unit of ['compressor', 'limiter', 'expander']) {
				for (const k of Object.keys(from.dynamics[unit] ?? {})) {
					push('dynamics', `${unit}.${k}`, to.dynamics[unit]?.[k], from.dynamics[unit][k])
				}
			}
		}
		return out
	}

	const real = window.fetch.bind(window)

	window.fetch = async function (input, options) {
		const url = typeof input === 'string' ? input : input.url
		if (!/^\/api\//.test(url)) return real(input, options)
		const body = options?.body ? JSON.parse(options.body) : null
		const path = url.split('?')[0]
		const qs = new URLSearchParams(url.split('?')[1] ?? '')

		await delay(80)

		if (path === '/api/switcher') {
			if (scenario === 'connect-fail') {
				await delay(700)
				return fail('Timed out after 5000ms — the switcher did not answer. It may already have a control connection open.')
			}
			return json({ device: { ...DEVICE, ip: qs.get('ip') }, channels: channelList() })
		}

		if (path === '/api/channel') {
			const c = box[`${qs.get('input')}:${qs.get('source')}`]
			return c ? json({ channel: clone(c) }) : fail('No such strip', 404)
		}

		if (path === '/api/preview' || path === '/api/apply') {
			const from = body.payload ?? box[`${body.from.input}:${body.from.source}`]
			const to = Array.isArray(body.to) ? body.to : [body.to]
			if (path === '/api/apply') await delay(scenario === 'copying' ? 60000 : 1800)
			const results = to.map((t) => {
				const key = `${t.input}:${t.source}`
				const cur = box[key]
				const diff = diffFor(from, cur, body.sections)
				if (path === '/api/preview') return { ok: true, to: t, label: cur.meta.label, diff }
				// Apply for real, so the cards afterwards show what actually happened.
				if (body.sections.gain) cur.levels.gain = from.levels.gain
				if (body.sections.volume) cur.levels.faderGain = from.levels.faderGain
				if (body.sections.pan) cur.levels.balance = from.levels.balance
				if (body.sections.eq) cur.eq = clone(from.eq)
				if (body.sections.dynamics) cur.dynamics = clone(from.dynamics)
				// One destination refuses the mic's +40 dB, exactly as a camera input would.
				const remaining = []
				if (scenario === 'clamped' && body.sections.gain && cur.meta.inputType === 0 && from.levels.gain > 600) {
					cur.levels.gain = 600
					remaining.push({ section: 'gain', path: 'gain', from: 600, to: from.levels.gain })
				}
				return {
					ok: true,
					to: t,
					label: cur.meta.label,
					backupFile: `${cur.meta.label.toLowerCase().replace(/\W+/g, '-')}-20260514-1820.json`,
					diff,
					remaining,
					skipped: scenario === 'clamped' && cur.meta.inputType === 0 ? ['stereo simulation (destination has none)'] : [],
					warnings: [],
				}
			})
			return json({ results })
		}

		if (path === '/api/undo') {
			await delay(600)
			return json({
				restored: [{ label: 'Camera 1', inputId: 1, sourceId: '-256' }],
				results: [{ ok: true, meta: { label: 'Camera 1' } }],
			})
		}

		if (path === '/api/presets/pack') return json({ name: body.name ?? 'presets', presets })
		if (path === '/api/presets/import') return json({ imported: presets.map((p) => p.name), skipped: [] })
		if (path === '/api/presets') {
			if (options?.method === 'POST') {
				const file = `${body.name.toLowerCase().replace(/\W+/g, '-')}.json`
				savedBodies[file] = { ...body.payload, name: body.name, group: body.group, defaultSections: body.defaultSections, savedAt: new Date().toISOString() }
				presets = [...presets.filter((p) => p.file !== file), { file, name: body.name, group: body.group, order: presets.length, summary: summarize(body.payload.channel), meta: { label: body.payload.channel.meta.label }, mic: body.payload.mic ?? null, style: body.payload.style ?? null, device: DEVICE, savedAt: new Date().toISOString() }]
				return json({ file })
			}
			return json({ presets })
		}
		if (/^\/api\/presets\//.test(path)) {
			const file = decodeURIComponent(path.split('/').pop())
			if (options?.method === 'DELETE') {
				presets = presets.filter((p) => p.file !== file)
				return json({ ok: true })
			}
			if (options?.method === 'PATCH') {
				const p = presets.find((x) => x.file === file)
				if (p) Object.assign(p, body)
				return json({ ok: true })
			}
			return json(presetBody(file))
		}
		if (path === '/api/snapshot') return json({ channels: channelList().map((c) => box[c.key]) })
		if (path === '/api/restore') return json({ results: channelList().map((c) => ({ ok: true, key: c.key, label: c.label })) })

		// ---- community catalogue ----
		if (path === '/api/community/presets' && options?.method !== 'POST') {
			await delay(320)
			if (scenario === 'catalogue-offline') return fail('Cannot reach the preset catalogue: getaddrinfo ENOTFOUND presets.studioupgrade.com', 503)
			const q = (qs.get('q') ?? '').toLowerCase()
			const mic = qs.get('mic') ?? ''
			const style = qs.get('style') ?? ''
			let list = CATALOGUE.filter(
				(p) =>
					(!mic || p.mic === mic) &&
					(!style || p.style === style) &&
					(!q || `${p.name} ${p.mic} ${p.style} ${p.notes} ${p.author}`.toLowerCase().includes(q))
			)
			const sort = qs.get('sort')
			list = [...list].sort((a, b) =>
				sort === 'new' ? b.createdAt.localeCompare(a.createdAt) : sort === 'installs' ? b.installs - a.installs : b.rating - a.rating || b.ratings - a.ratings
			)
			const tally = (key) => {
				const m = new Map()
				for (const p of CATALOGUE) if (p[key]) m.set(p[key], (m.get(p[key]) ?? 0) + 1)
				return [...m].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
			}
			return json({
				presets: list.map(({ comments, channel, ...rest }) => ({ ...rest, eq: channel.eq })),
				total: list.length,
				facets: { mics: tally('mic'), styles: tally('style') },
			})
		}
		if (path === '/api/community/presets' && options?.method === 'POST') {
			await delay(700)
			const p = body.preset
			CATALOGUE.unshift({
				id: `you-${Date.now()}`,
				name: p.name,
				author: body.author || 'you',
				mic: p.mic ?? null,
				style: p.style ?? 'Utility',
				notes: p.notes ?? '',
				sampleUrl: p.sampleUrl ?? null,
				rating: 0,
				ratings: 0,
				installs: 0,
				createdAt: new Date().toISOString(),
				device: p.device ?? DEVICE,
				defaultSections: p.defaultSections,
				channel: p.channel,
				comments: [],
			})
			return json({ ok: true })
		}
		const cm = path.match(/^\/api\/community\/presets\/([^/]+)(\/rate|\/comments)?$/)
		if (cm) {
			const p = CATALOGUE.find((x) => x.id === decodeURIComponent(cm[1]))
			if (!p) return fail('No such preset', 404)
			if (cm[2] === '/rate') {
				p.rating = (p.rating * p.ratings + body.rating) / (p.ratings + 1)
				p.ratings++
				return json({ rating: p.rating, ratings: p.ratings, yourRating: body.rating })
			}
			if (cm[2] === '/comments') {
				p.comments.unshift({ author: 'you', at: new Date().toISOString(), body: body.body, rating: body.rating, votes: 0 })
				return json({ comments: p.comments })
			}
			await delay(200)
			return json(p)
		}

		return fail(`No demo route for ${path}`, 404)
	}

	// ---------------------------------------------------------------- scenario driver

	const pick = (side, key, extra) => {
		const row = document.querySelector(`#panel-${side} .chan[data-key="${key}"]`)
		if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, ...extra }))
	}

	async function drive() {
		if (scenario === 'first-run') return
		if (scenario.startsWith('browse') || scenario === 'catalogue-offline') {
			document.querySelector('#panel-A .ip').value = '192.168.8.20'
			await connectSingle()
			openBrowser()
			if (scenario === 'browse-detail') {
				await new Promise((r) => setTimeout(r, 550))
				openPreset('sm7b-broadcast')
			}
			if (scenario === 'browse-publish') {
				await new Promise((r) => setTimeout(r, 550))
				startPublish()
			}
			return
		}
		if (scenario === 'library-empty' || scenario === 'library') {
			if (scenario === 'library') {
				document.querySelector('#panel-A .ip').value = '192.168.8.20'
				await connectSingle()
			}
			setKind('A', 'library')
			if (scenario === 'library') {
				await new Promise((r) => setTimeout(r, 250))
				await selectPreset('A', 'sm7b-broadcast-voice.json')
				pick('B', '1:-256')
			}
			return
		}
		document.querySelector('#panel-A .ip').value = '192.168.8.20'
		await connectSingle()
		if (scenario === 'connect-fail') return
		await new Promise((r) => setTimeout(r, 150))
		pick('A', '1001:-256')
		pick('B', '1:-256')
		if (scenario === 'multi' || scenario === 'copying' || scenario === 'clamped') {
			await new Promise((r) => setTimeout(r, 150))
			pick('B', '2:-256', { metaKey: true })
			pick('B', '3:-256', { metaKey: true })
		}
	}

	function chip() {
		const wrap = document.createElement('div')
		wrap.className = 'demochip'
		const grip = document.createElement('span')
		grip.className = 'demogrip'
		grip.title = 'Drag to move these controls'
		const label = document.createElement('span')
		label.textContent = 'Demo'
		const sel = document.createElement('select')
		sel.setAttribute('aria-label', 'Demo scenario')
		for (const [k, v] of Object.entries(SCENARIOS)) {
			const o = document.createElement('option')
			o.value = k
			o.textContent = v
			if (k === scenario) o.selected = true
			sel.append(o)
		}
		sel.value = scenario
		sel.onchange = () => {
			location.search = `?demo=${sel.value}`
		}
		wrap.append(grip, label, sel)
		document.body.append(wrap)

		// The chip floats over the app, so wherever it sits by default it will eventually cover
		// something someone needs to read. Let it be dragged, and remember where it was put.
		const saved = localStorage.getItem('atem-demo-chip-pos')
		if (saved) {
			try {
				const { x, y } = JSON.parse(saved)
				place(x, y)
			} catch {
				/* a corrupt position just means the default one */
			}
		}
		function place(x, y) {
			const r = wrap.getBoundingClientRect()
			const cx = Math.min(Math.max(x, 4), window.innerWidth - r.width - 4)
			const cy = Math.min(Math.max(y, 4), window.innerHeight - r.height - 4)
			wrap.classList.add('dragged')
			wrap.style.left = `${cx}px`
			wrap.style.top = `${cy}px`
			wrap.style.bottom = 'auto'
		}
		grip.addEventListener('pointerdown', (e) => {
			const r = wrap.getBoundingClientRect()
			const dx = e.clientX - r.left
			const dy = e.clientY - r.top
			wrap.classList.add('dragging')
			grip.setPointerCapture(e.pointerId)
			const move = (ev) => place(ev.clientX - dx, ev.clientY - dy)
			const up = () => {
				wrap.classList.remove('dragging')
				grip.removeEventListener('pointermove', move)
				grip.removeEventListener('pointerup', up)
				const box = wrap.getBoundingClientRect()
				localStorage.setItem('atem-demo-chip-pos', JSON.stringify({ x: box.left, y: box.top }))
			}
			grip.addEventListener('pointermove', move)
			grip.addEventListener('pointerup', up)
			e.preventDefault()
		})
	}

	window.addEventListener('load', () => {
		chip()
		drive()
	})
})()
