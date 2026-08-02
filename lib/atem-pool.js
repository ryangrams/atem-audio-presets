// One live 9910 connection per switcher, kept open and reused.
//
// An ATEM has a small, per-switcher budget of simultaneous control connections (ATEM Software
// Control, Companion, and this tool all draw from it), so the pool never opens a second
// connection to an address it already holds.

import { Atem } from 'atem-connection'

const CONNECT_TIMEOUT_MS = 12000

/** @type {Map<string, {atem: import('atem-connection').Atem, ready: Promise<void>, connected: boolean, lastError: string|null, log: string[]}>} */
const pool = new Map()

function record(entry, message) {
	entry.log.push(`${new Date().toISOString()} ${message}`)
	if (entry.log.length > 50) entry.log.shift()
}

export async function connect(ip) {
	const existing = pool.get(ip)
	if (existing) {
		await existing.ready
		if (existing.connected) return existing.atem
		pool.delete(ip)
		try {
			await existing.atem.disconnect()
		} catch {
			/* already gone */
		}
	}

	const atem = new Atem({ disableMultithreaded: true })
	const entry = { atem, connected: false, lastError: null, log: [], ready: null }
	pool.set(ip, entry)

	atem.on('error', (e) => {
		entry.lastError = String(e)
		record(entry, `error: ${e}`)
	})
	atem.on('disconnected', () => {
		entry.connected = false
		record(entry, 'disconnected')
	})
	atem.on('connected', () => {
		entry.connected = true
		record(entry, 'connected')
	})

	entry.ready = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`Timed out connecting to ${ip} on UDP 9910 after ${CONNECT_TIMEOUT_MS / 1000}s`))
		}, CONNECT_TIMEOUT_MS)
		atem.once('connected', () => {
			clearTimeout(timer)
			// The switcher dumps its whole state right after the handshake; give it a beat to land
			// before anyone reads Fairlight out of it.
			setTimeout(resolve, 900)
		})
		atem.connect(ip).catch((e) => {
			clearTimeout(timer)
			reject(e)
		})
	})

	try {
		await entry.ready
	} catch (e) {
		pool.delete(ip)
		try {
			await atem.disconnect()
		} catch {
			/* nothing to close */
		}
		throw e
	}
	return atem
}

export async function disconnect(ip) {
	const entry = pool.get(ip)
	if (!entry) return false
	pool.delete(ip)
	try {
		await entry.atem.disconnect()
	} catch {
		/* already gone */
	}
	return true
}

export async function disconnectAll() {
	await Promise.all([...pool.keys()].map((ip) => disconnect(ip)))
}

export function status() {
	return [...pool.entries()].map(([ip, e]) => ({
		ip,
		connected: e.connected,
		lastError: e.lastError,
		model: e.atem.state?.info?.productIdentifier ?? null,
	}))
}

/**
 * Firmware identity from the admin API (port 80), which is a different plane entirely.
 * Two switchers can both report "10.3" and be different builds — the build hash is the real id,
 * so it goes on every preset we write. See reference/gotchas.md #1.
 */
export async function firmwareInfo(ip) {
	try {
		const ctrl = AbortSignal.timeout(2500)
		const res = await fetch(`http://${ip}/admin/api/v1/firmware/info`, { signal: ctrl })
		if (!res.ok) return null
		const body = await res.json()
		const r = body?.response ?? {}
		return {
			build: r['software version'] ?? null,
			release: r['release version'] ?? null,
			productId: r['product id'] ?? null,
			uniqueId: r['unique id'] ?? null,
		}
	} catch {
		// Not fatal: the Mini line serves this, older/other models may not.
		return null
	}
}
