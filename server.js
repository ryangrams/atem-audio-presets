#!/usr/bin/env node
// ATEM Audio Presets — save, load and copy Fairlight audio settings between ATEM channels,
// between switchers, and as named presets.
//
// The browser talks to this server over HTTP; the server talks to the switchers over UDP 9910
// via atem-connection (the same library Companion's bmd-atem module uses). Browsers cannot speak
// 9910 themselves, which is the whole reason this process exists.

import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, disconnect, disconnectAll, firmwareInfo, status } from './lib/atem-pool.js'
import { applyChannel, diffChannel, extractChannel, listChannels, summarizeChannel } from './lib/fairlight.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8730)

/**
 * Where presets and pre-write backups live.
 *
 * Running from a clone this is just ./presets. Inside a packaged desktop app the program
 * directory is read-only, so the Electron main process passes a writable per-user path
 * (ATEM_PRESET_DIR) instead.
 */
const PRESET_DIR = process.env.ATEM_PRESET_DIR || path.join(__dirname, 'presets')
const BACKUP_DIR = path.join(PRESET_DIR, '_backups')

const app = express()
app.use(express.json({ limit: '4mb' }))
app.use(express.static(path.join(__dirname, 'public')))

/** Most recent pre-apply backup per switcher, so the UI can offer a one-click undo. */
const lastBackup = new Map()

const IP_RE = /^[a-zA-Z0-9.\-]+$/
function requireIp(req) {
	const ip = String(req.query.ip ?? req.body?.ip ?? '').trim()
	if (!ip || !IP_RE.test(ip)) throw new HttpError(400, 'A switcher address is required')
	return ip
}

class HttpError extends Error {
	constructor(status, message) {
		super(message)
		this.status = status
	}
}

const wrap = (fn) => (req, res) => {
	Promise.resolve(fn(req, res)).catch((e) => {
		res.status(e.status ?? 500).json({ error: e.message ?? String(e) })
	})
}

async function deviceInfo(ip, atem) {
	const fw = await firmwareInfo(ip)
	return {
		ip,
		model: atem.state?.info?.productIdentifier ?? null,
		build: fw?.build ?? null,
		release: fw?.release ?? null,
		uniqueId: fw?.uniqueId ?? null,
	}
}

// ---------------------------------------------------------------- switchers

app.get(
	'/api/switcher',
	wrap(async (req, res) => {
		const ip = requireIp(req)
		const atem = await connect(ip)
		res.json({
			device: await deviceInfo(ip, atem),
			channels: listChannels(atem.state),
		})
	})
)

app.get(
	'/api/channel',
	wrap(async (req, res) => {
		const ip = requireIp(req)
		const atem = await connect(ip)
		const channel = extractChannel(atem.state, Number(req.query.input), String(req.query.source))
		if (!channel) throw new HttpError(404, `No such channel ${req.query.input}:${req.query.source} on ${ip}`)
		res.json({ device: await deviceInfo(ip, atem), channel })
	})
)

app.post(
	'/api/disconnect',
	wrap(async (req, res) => {
		res.json({ disconnected: await disconnect(requireIp(req)) })
	})
)

// The UI has to be able to tell the user where their presets and backups actually are: from a clone
// that is ./presets, but the packaged app passes a per-user directory instead.
app.get('/api/status', (_req, res) => res.json({ connections: status(), presetDir: PRESET_DIR }))

// ---------------------------------------------------------------- copy / apply

/** The thing being pasted: either a live channel on another switcher, or a saved preset body. */
async function resolvePayload(body) {
	if (body.payload) return body.payload
	if (body.from?.ip) {
		const atem = await connect(body.from.ip)
		const channel = extractChannel(atem.state, Number(body.from.input), String(body.from.source))
		if (!channel) throw new HttpError(404, `Source channel ${body.from.input}:${body.from.source} not found`)
		return channel
	}
	throw new HttpError(400, 'Nothing to copy: provide either `from` or `payload`')
}

function normalizeSections(sections) {
	return {
		gain: Boolean(sections?.gain),
		volume: Boolean(sections?.volume),
		pan: Boolean(sections?.pan),
		eq: Boolean(sections?.eq),
		dynamics: Boolean(sections?.dynamics),
		inputConfig: Boolean(sections?.inputConfig),
	}
}

async function destinationChannel(to) {
	if (!to?.ip) throw new HttpError(400, 'A destination switcher is required')
	const atem = await connect(to.ip)
	const channel = extractChannel(atem.state, Number(to.input), String(to.source))
	if (!channel) throw new HttpError(404, `Destination channel ${to.input}:${to.source} not found on ${to.ip}`)
	return { atem, channel }
}

/**
 * `to` is one destination or several. Multiple destinations must live on the same switcher —
 * they come from one multi-select list, and keeping them together is what lets a single Undo
 * put the whole batch back.
 */
function normalizeTargets(to) {
	const list = (Array.isArray(to) ? to : [to]).filter(Boolean)
	if (!list.length) throw new HttpError(400, 'A destination channel is required')
	if (list.some((t) => t.ip !== list[0].ip)) throw new HttpError(400, 'All destinations must be on the same switcher')
	return list
}

app.post(
	'/api/preview',
	wrap(async (req, res) => {
		const sections = normalizeSections(req.body.sections)
		const payload = await resolvePayload(req.body)
		const results = []
		for (const to of normalizeTargets(req.body.to)) {
			const { channel } = await destinationChannel(to)
			results.push({ to, label: channel.meta.label, diff: diffChannel(channel, payload, sections), destination: channel })
		}
		res.json({
			results,
			incoming: payload,
			// Single-destination shape, kept so one-off `curl` calls stay simple.
			diff: results[0]?.diff ?? [],
			destination: results[0]?.destination ?? null,
		})
	})
)

app.post(
	'/api/apply',
	wrap(async (req, res) => {
		const sections = normalizeSections(req.body.sections)
		const payload = await resolvePayload(req.body)
		const targets = normalizeTargets(req.body.to)
		await fs.mkdir(BACKUP_DIR, { recursive: true })

		const batch = []
		const results = []
		for (const to of targets) {
			const { atem, channel: before } = await destinationChannel(to)

			// Snapshot the destination first, always. An apply is a one-way write to live
			// hardware; without this there is nothing to go back to.
			const backup = {
				format: 'atem-audio-preset',
				version: 1,
				savedAt: new Date().toISOString(),
				note: `Automatic backup before copy onto ${to.ip} ${to.input}:${to.source}`,
				device: await deviceInfo(to.ip, atem),
				channel: before,
			}
			const backupFile = `backup-${to.ip.replace(/[^0-9a-zA-Z]/g, '_')}-${before.meta.inputId}-${Date.now()}-${results.length}.json`
			await fs.writeFile(path.join(BACKUP_DIR, backupFile), JSON.stringify(backup, null, 2))
			batch.push({ file: backupFile, backup, to })

			try {
				const result = await applyChannel(atem, { inputId: to.input, sourceId: to.source }, payload, sections)
				results.push({ to, label: before.meta.label, ok: true, backupFile, before, ...result })
			} catch (e) {
				// One bad destination must not abandon the rest of the batch half-copied.
				results.push({ to, label: before.meta.label, ok: false, backupFile, error: e.message, applied: [], skipped: [], warnings: [] })
			}
		}
		lastBackup.set(targets[0].ip, batch)

		// Read the strips back and diff them against what we sent. A rejected value on an ATEM is
		// silent — no error, the setting simply doesn't take — so "did it work" has to be measured.
		await new Promise((r) => setTimeout(r, 700))
		for (const r of results) {
			if (!r.ok) continue
			const atem = await connect(r.to.ip)
			r.after = extractChannel(atem.state, Number(r.to.input), String(r.to.source))
			r.remaining = diffChannel(r.after, payload, sections)
		}

		const first = results[0] ?? {}
		res.json({
			results,
			// Single-destination shape, unchanged for existing callers.
			applied: first.applied ?? [],
			skipped: first.skipped ?? [],
			warnings: first.warnings ?? [],
			remaining: first.remaining ?? [],
			backupFile: first.backupFile ?? null,
			before: first.before ?? null,
			after: first.after ?? null,
		})
	})
)

app.post(
	'/api/undo',
	wrap(async (req, res) => {
		const ip = requireIp(req)
		const batch = lastBackup.get(ip)
		if (!batch?.length) throw new HttpError(404, `No backup recorded for ${ip} in this session`)
		const atem = await connect(ip)
		// Restore every level, EQ and dynamics field the strip had, regardless of which sections the
		// copy carried. applyChannel gates the level writes on `gain`/`volume`/`pan` — a bare
		// `levels: true` matches none of them, silently leaving gain/fader/pan on the copied values.
		// normalizeSections emits exactly the keys applyChannel reads. inputConfig stays off: changing
		// a configuration re-enumerates source ids, which would break the very strip being restored.
		const undoSections = normalizeSections({ gain: true, volume: true, pan: true, eq: true, dynamics: true, inputConfig: false })
		const restored = []
		for (const entry of batch) {
			try {
				const result = await applyChannel(atem, { inputId: entry.to.input, sourceId: entry.to.source }, entry.backup.channel, undoSections)
				restored.push({ entry, meta: entry.backup.channel.meta, ok: true, ...result })
			} catch (e) {
				restored.push({ entry, meta: entry.backup.channel.meta, ok: false, error: e.message })
			}
		}

		// Read the strips back and diff them against the backup we just wrote — undo honesty has to
		// match copy honesty (house rule 2). A field that did not restore shows up in `remaining`
		// rather than being assumed good, exactly as /api/apply does.
		await new Promise((r) => setTimeout(r, 700))
		for (const r of restored) {
			if (!r.ok) continue
			r.after = extractChannel(atem.state, Number(r.entry.to.input), String(r.entry.to.source))
			r.remaining = diffChannel(r.after, r.entry.backup.channel, undoSections)
		}

		lastBackup.delete(ip)
		res.json({ restored: restored.map((r) => r.meta), results: restored.map(({ entry, ...r }) => r) })
	})
)

// ---------------------------------------------------------------- presets on disk

/**
 * A preset's file name. Derived from its display name but stripped to something that cannot
 * traverse, hide itself with a leading dot, or collide with the backups directory.
 */
const fileNameFor = (name) => {
	const base = safeName(name).replace(/\s+/g, '-').replace(/\.+/g, '.').replace(/^[.\-]+|[.\-]+$/g, '')
	return `${base || 'preset'}.json`
}

const safeName = (name) =>
	String(name ?? '')
		.trim()
		.replace(/[^0-9a-zA-Z \-_.]/g, '')
		.slice(0, 80)

app.get(
	'/api/presets',
	wrap(async (_req, res) => {
		await fs.mkdir(PRESET_DIR, { recursive: true })
		const files = (await fs.readdir(PRESET_DIR)).filter((f) => f.endsWith('.json'))
		const presets = []
		for (const file of files) {
			try {
				const body = JSON.parse(await fs.readFile(path.join(PRESET_DIR, file), 'utf8'))
				presets.push({
					file,
					name: body.name ?? file.replace(/\.json$/, ''),
					format: body.format,
					savedAt: body.savedAt,
					device: body.device,
					meta: body.channel?.meta ?? null,
					channelCount: body.channels?.length ?? null,
					// Library metadata lives in the preset file itself — no index to fall out of sync.
					group: body.group ?? '',
					order: typeof body.order === 'number' ? body.order : 0,
					defaultSections: body.defaultSections ?? null,
					// What the preset was made with and for — the fields the library list shows.
					mic: body.mic ?? null,
					style: body.style ?? null,
					summary: body.channel ? summarizeChannel(body.channel) : null,
				})
			} catch {
				presets.push({ file, name: file, error: 'unreadable' })
			}
		}
		// Library order first, then newest — a preset that has never been dragged still lands
		// somewhere sensible.
		presets.sort(
			(a, b) =>
				String(a.group).localeCompare(String(b.group)) ||
				a.order - b.order ||
				String(b.savedAt).localeCompare(String(a.savedAt))
		)
		res.json({ presets })
	})
)

app.get(
	'/api/presets/:file',
	wrap(async (req, res) => {
		const file = safeName(req.params.file)
		if (!file.endsWith('.json')) throw new HttpError(400, 'Bad preset name')
		res.json(JSON.parse(await fs.readFile(path.join(PRESET_DIR, file), 'utf8')))
	})
)

/** Keep a copy of a preset file before it is overwritten or deleted. */
async function backupPreset(file) {
	try {
		const body = await fs.readFile(path.join(PRESET_DIR, file), 'utf8')
		await fs.mkdir(BACKUP_DIR, { recursive: true })
		await fs.writeFile(path.join(BACKUP_DIR, `preset-${file.replace(/\.json$/, '')}-${Date.now()}.json`), body)
		return true
	} catch {
		// Nothing there to keep.
		return false
	}
}

app.post(
	'/api/presets',
	wrap(async (req, res) => {
		const name = safeName(req.body.name)
		if (!name) throw new HttpError(400, 'A preset name is required')
		let body = req.body.payload
		if (!body && req.body.from?.ip) {
			const atem = await connect(req.body.from.ip)
			const channel = extractChannel(atem.state, Number(req.body.from.input), String(req.body.from.source))
			if (!channel) throw new HttpError(404, 'Source channel not found')
			body = {
				format: 'atem-audio-preset',
				version: 1,
				channel,
				device: await deviceInfo(req.body.from.ip, atem),
			}
		}
		if (!body) throw new HttpError(400, 'Nothing to save')
		body.name = name
		body.savedAt = new Date().toISOString()
		body.group = safeName(req.body.group ?? '')
		// A preset always holds the whole channel; the sections chosen at save time are only its
		// defaults, pre-ticked the next time it is used as a source.
		body.defaultSections = normalizeSections(req.body.defaultSections)
		if (typeof req.body.order === 'number') body.order = req.body.order

		await fs.mkdir(PRESET_DIR, { recursive: true })
		// Overwriting keeps the original file name (it is the id) and stashes the old contents.
		const overwrite = req.body.overwrite ? safeName(req.body.overwrite) : null
		if (overwrite && !overwrite.endsWith('.json')) throw new HttpError(400, 'Bad preset file')
		const file = overwrite ?? fileNameFor(name)
		const backedUp = await backupPreset(file)
		await fs.writeFile(path.join(PRESET_DIR, file), JSON.stringify(body, null, 2))
		res.json({ file, name, overwritten: backedUp })
	})
)

/** Rename, regroup or reorder a preset without touching what it stores. */
app.patch(
	'/api/presets/:file',
	wrap(async (req, res) => {
		const file = safeName(req.params.file)
		if (!file.endsWith('.json')) throw new HttpError(400, 'Bad preset name')
		const full = path.join(PRESET_DIR, file)
		const body = JSON.parse(await fs.readFile(full, 'utf8'))
		if (req.body.name !== undefined) {
			const name = safeName(req.body.name)
			if (!name) throw new HttpError(400, 'A preset name is required')
			body.name = name
		}
		if (req.body.group !== undefined) body.group = safeName(req.body.group)
		if (req.body.order !== undefined) body.order = Number(req.body.order) || 0
		if (req.body.defaultSections !== undefined) body.defaultSections = normalizeSections(req.body.defaultSections)
		await fs.writeFile(full, JSON.stringify(body, null, 2))
		res.json({ file, name: body.name, group: body.group ?? '', order: body.order ?? 0 })
	})
)

/**
 * A pack is one file holding many presets — the unit people share.
 *
 * It carries only what a preset needs to be re-applied: name, group, default sections and the
 * channel itself. Nothing about the machine that exported it travels except the switcher model
 * and firmware build, which are useful when judging whether a preset suits your hardware.
 */
app.post(
	'/api/presets/pack',
	wrap(async (req, res) => {
		await fs.mkdir(PRESET_DIR, { recursive: true })
		const wanted = Array.isArray(req.body.files) ? req.body.files.map(safeName) : null
		const group = req.body.group

		const presets = []
		for (const file of (await fs.readdir(PRESET_DIR)).filter((f) => f.endsWith('.json'))) {
			if (wanted && !wanted.includes(file)) continue
			let body
			try {
				body = JSON.parse(await fs.readFile(path.join(PRESET_DIR, file), 'utf8'))
			} catch {
				continue
			}
			if (body.format !== 'atem-audio-preset' || !body.channel) continue
			if (group !== undefined && (body.group ?? '') !== group) continue
			presets.push({
				name: body.name ?? file.replace(/\.json$/, ''),
				group: body.group ?? '',
				defaultSections: body.defaultSections ?? null,
				device: body.device ? { model: body.device.model ?? null, release: body.device.release ?? null, build: body.device.build ?? null } : null,
				// The community fields travel with the preset — a pack without them is just numbers.
				mic: body.mic ?? null,
				style: body.style ?? null,
				notes: body.notes ?? null,
				sampleUrl: body.sampleUrl ?? null,
				channel: body.channel,
			})
		}
		if (!presets.length) throw new HttpError(404, 'No presets matched — nothing to export')

		res.json({
			format: 'atem-audio-preset-pack',
			version: 1,
			name: String(req.body.name ?? 'ATEM audio presets').slice(0, 120),
			description: String(req.body.description ?? '').slice(0, 2000),
			author: String(req.body.author ?? '').slice(0, 120),
			createdAt: new Date().toISOString(),
			presets,
		})
	})
)

/**
 * Unpack a shared pack into the library.
 *
 * Everything here arrived from someone else, so only known fields are kept and a preset that
 * does not carry a channel is skipped rather than trusted. Existing names are suffixed instead
 * of overwritten — importing should never cost you a preset you already had.
 */
app.post(
	'/api/presets/import',
	wrap(async (req, res) => {
		const pack = req.body.pack
		if (!Array.isArray(pack?.presets)) throw new HttpError(400, 'That file is not a preset pack')
		await fs.mkdir(PRESET_DIR, { recursive: true })
		const existing = new Set((await fs.readdir(PRESET_DIR)).filter((f) => f.endsWith('.json')))

		const imported = []
		const skipped = []
		for (const entry of pack.presets) {
			const name = safeName(entry?.name)
			if (!name || !entry?.channel?.meta) {
				skipped.push(entry?.name ?? '(unnamed)')
				continue
			}
			let file = fileNameFor(name)
			let n = 2
			while (existing.has(file)) file = fileNameFor(`${name}-${n++}`)
			existing.add(file)

			const body = {
				format: 'atem-audio-preset',
				version: 1,
				name,
				group: safeName(entry.group ?? req.body.group ?? pack.name ?? ''),
				defaultSections: normalizeSections(entry.defaultSections),
				savedAt: new Date().toISOString(),
				importedFrom: String(pack.name ?? '').slice(0, 120) || null,
				device: entry.device ?? null,
				// Same whitelist idea as everything else in an import: known fields, clamped.
				mic: entry.mic ? String(entry.mic).slice(0, 120) : null,
				style: entry.style ? String(entry.style).slice(0, 60) : null,
				notes: entry.notes ? String(entry.notes).slice(0, 2000) : null,
				sampleUrl: typeof entry.sampleUrl === 'string' && /^https?:\/\//.test(entry.sampleUrl) ? entry.sampleUrl.slice(0, 300) : null,
				channel: entry.channel,
			}
			await fs.writeFile(path.join(PRESET_DIR, file), JSON.stringify(body, null, 2))
			imported.push({ file, name, group: body.group })
		}
		res.json({ imported, skipped })
	})
)

app.delete(
	'/api/presets/:file',
	wrap(async (req, res) => {
		const file = safeName(req.params.file)
		if (!file.endsWith('.json')) throw new HttpError(400, 'Bad preset name')
		// Deleting is the one preset action with no undo in the UI, so keep the file.
		await backupPreset(file)
		await fs.unlink(path.join(PRESET_DIR, file))
		res.json({ deleted: file })
	})
)

// ---------------------------------------------------------------- community catalogue

/**
 * The preset browser is a client of a catalogue that lives on the internet, not on this machine.
 *
 * It is proxied through here for three reasons: the page is served from 127.0.0.1 and would need
 * CORS otherwise; the desktop app has no guarantee of a browser's cookie jar; and a single choke
 * point means one place to time out, one place to fail politely, and one place to change when the
 * catalogue moves. Nothing here can reach a switcher — it is reads, ratings and comments only.
 */
const CATALOGUE = process.env.ATEM_CATALOGUE_URL || 'https://presets.studioupgrade.com/api'

app.use(
	'/api/community',
	wrap(async (req, res) => {
		const url = `${CATALOGUE}${req.path}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`
		const ctrl = new AbortController()
		// A studio LAN with no route out should fail in seconds, not hang the browser.
		const timer = setTimeout(() => ctrl.abort(), 8000)
		try {
			const upstream = await fetch(url, {
				method: req.method,
				headers: { 'Content-Type': 'application/json', 'User-Agent': 'atem-audio-presets' },
				body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
				signal: ctrl.signal,
			})
			const text = await upstream.text()
			res.status(upstream.status).type('application/json').send(text)
		} catch (e) {
			throw new HttpError(503, e.name === 'AbortError' ? 'The preset catalogue did not answer' : `Cannot reach the preset catalogue: ${e.message}`)
		} finally {
			clearTimeout(timer)
		}
	})
)

let httpServer = null

/**
 * Start listening. Port 0 asks the OS for a free port, which is what the desktop app uses so a
 * second copy — or anything else already on 8730 — cannot collide.
 */
export function start({ port = PORT, host = '127.0.0.1' } = {}) {
	return new Promise((resolve, reject) => {
		const s = app.listen(port, host, () => {
			httpServer = s
			const actual = s.address().port
			resolve({ server: s, port: actual, url: `http://${host}:${actual}` })
		})
		s.on('error', reject)
	})
}

/** Close the listener and drop every switcher connection. */
export async function stop() {
	httpServer?.close()
	httpServer = null
	await disconnectAll()
}

export { app }

// Run directly (`npm start`, `npx atem-audio-presets`) rather than imported by the desktop app.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { url } = await start()
	console.log(`\n  ATEM Audio Presets  →  ${url}\n`)
	for (const sig of ['SIGINT', 'SIGTERM']) {
		process.on(sig, async () => {
			await stop()
			process.exit(0)
		})
	}
}
