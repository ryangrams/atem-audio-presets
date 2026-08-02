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
import { applyChannel, diffChannel, extractChannel, extractSwitcher, listChannels, summarizeChannel } from './lib/fairlight.js'

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

app.get('/api/status', (_req, res) => res.json({ connections: status() }))

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
		levels: Boolean(sections?.levels),
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
		const restored = []
		for (const entry of batch) {
			try {
				const result = await applyChannel(
					atem,
					{ inputId: entry.to.input, sourceId: entry.to.source },
					entry.backup.channel,
					// Restore everything the strip had, regardless of which sections were copied.
					{ levels: true, eq: true, dynamics: true, inputConfig: false }
				)
				restored.push({ meta: entry.backup.channel.meta, ok: true, ...result })
			} catch (e) {
				restored.push({ meta: entry.backup.channel.meta, ok: false, error: e.message })
			}
		}
		lastBackup.delete(ip)
		res.json({ restored: restored.map((r) => r.meta), results: restored })
	})
)

// ---------------------------------------------------------------- presets on disk

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
		const file = overwrite ?? `${name.replace(/\s+/g, '-')}.json`
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

// ---------------------------------------------------------------- whole-switcher snapshots

app.get(
	'/api/snapshot',
	wrap(async (req, res) => {
		const ip = requireIp(req)
		const atem = await connect(ip)
		res.json(extractSwitcher(atem.state, await deviceInfo(ip, atem)))
	})
)

app.post(
	'/api/restore',
	wrap(async (req, res) => {
		const ip = requireIp(req)
		const sections = normalizeSections(req.body.sections)
		const snapshot = req.body.snapshot
		if (!Array.isArray(snapshot?.channels)) throw new HttpError(400, 'That file is not a switcher snapshot')
		const atem = await connect(ip)

		const results = []
		for (const channel of snapshot.channels) {
			const key = `${channel.meta.inputId}:${channel.meta.sourceId}`
			try {
				const out = await applyChannel(atem, { inputId: channel.meta.inputId, sourceId: channel.meta.sourceId }, channel, sections)
				results.push({ key, label: channel.meta.label, ok: true, ...out })
			} catch (e) {
				// A snapshot taken under a different input configuration will name strips that no
				// longer exist. Skip them by name rather than aborting the whole restore.
				results.push({ key, label: channel.meta.label, ok: false, error: e.message })
			}
		}
		res.json({ results })
	})
)

const server = app.listen(PORT, '127.0.0.1', () => {
	console.log(`\n  ATEM Audio Presets  →  http://127.0.0.1:${PORT}\n`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, async () => {
		server.close()
		await disconnectAll()
		process.exit(0)
	})
}
