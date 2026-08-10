// Find ATEMs on the network, two ways at once, because neither is reliable alone:
//
//  1. mDNS/Bonjour — ATEMs advertise `_blackmagic._tcp` with a TXT `class=AtemSwitcher`. This is
//     how ATEM Software Control finds them, and it is instant — but multicast does not cross VLANs
//     or most routed studio networks, so it finds nothing when the switcher is a hop away.
//  2. An admin-API sweep of chosen /24s — probe `GET /admin/api/v1/firmware/info` on each host.
//     Slower, but it works wherever the machine can *route* to the switcher, which is exactly the
//     case mDNS misses. The subnets to sweep come from the addresses the user has used before, so
//     it looks where their switchers actually are.
//
// Results from both are merged by IP. Everything is time-boxed: whatever answered by the deadline
// is returned, so the dropdown never hangs.

import os from 'node:os'
import { Bonjour } from 'bonjour-service'

const PRODUCT = { BEFE: 'ATEM Mini Extreme ISO G2', BE7C: 'ATEM Mini Extreme', BE55: 'ATEM Mini Pro' }

/** The private /24s worth sweeping: the machine's own, plus one per hint address the caller passed. */
function candidateSubnets(hints = []) {
	const set = new Set()
	for (const h of hints) {
		const m = String(h).match(/^(\d+\.\d+\.\d+)\.\d+$/)
		if (m) set.add(m[1])
	}
	for (const list of Object.values(os.networkInterfaces())) {
		for (const ni of list ?? []) {
			if (ni.family !== 'IPv4' || ni.internal) continue
			const m = ni.address.match(/^(\d+\.\d+\.\d+)\.\d+$/)
			// Only private ranges — never sweep a public /24.
			if (m && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(ni.address)) set.add(m[1])
		}
	}
	return [...set]
}

async function probeAdmin(ip, signal) {
	try {
		const res = await fetch(`http://${ip}/admin/api/v1/firmware/info`, { signal })
		if (!res.ok) return null
		const body = await res.json()
		const r = body?.response ?? {}
		const pid = String(r['product id'] ?? '').toUpperCase()
		return { ip, name: null, model: PRODUCT[pid] ?? 'ATEM', release: r['release version'] ?? null, uniqueId: r['unique id'] ?? null, via: 'scan' }
	} catch {
		return null // refused, timed out, or not an ATEM — silence is the normal case here.
	}
}

/** Sweep a set of /24s for the admin API, capped concurrency, hard deadline. */
async function sweep(subnets, deadline) {
	const hosts = []
	for (const s of subnets) for (let i = 1; i <= 254; i++) hosts.push(`${s}.${i}`)
	const found = []
	let cursor = 0
	const CONCURRENCY = 80
	async function worker() {
		while (cursor < hosts.length && Date.now() < deadline) {
			const ip = hosts[cursor++]
			const controller = AbortSignal.timeout(Math.min(900, Math.max(50, deadline - Date.now())))
			const hit = await probeAdmin(ip, controller)
			if (hit) found.push(hit)
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, worker))
	return found
}

async function mdns(deadline) {
	const found = []
	let bonjour
	try {
		bonjour = new Bonjour()
	} catch {
		return found
	}
	bonjour.find({ type: 'blackmagic' }, (svc) => {
		const ip = (svc.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
		// The service type is shared across Blackmagic products; the TXT class marks a switcher.
		const isSwitcher = !svc.txt || /atemswitcher/i.test(JSON.stringify(svc.txt))
		if (ip && isSwitcher) found.push({ ip, name: svc.name ?? null, model: 'ATEM', release: null, via: 'mdns' })
	})
	await new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))
	try {
		bonjour.destroy()
	} catch {
		/* already gone */
	}
	return found
}

/**
 * Discover ATEMs. `hints` are addresses the user has used before (their /24s get swept). Returns a
 * de-duplicated list, mDNS names preferred, admin-API models preferred.
 */
export async function discover({ hints = [], timeoutMs = 4000 } = {}) {
	const deadline = Date.now() + timeoutMs
	// Hint subnets (where the user's switchers have been) come first and are always swept; cap the
	// rest so a machine on a dozen ZeroTier /24s does not spend the whole budget on empty networks.
	const subnets = candidateSubnets(hints).slice(0, 5)
	const [byMdns, byScan] = await Promise.all([mdns(deadline), sweep(subnets, deadline)])

	const merged = new Map()
	for (const a of [...byScan, ...byMdns]) {
		const prev = merged.get(a.ip)
		if (!prev) merged.set(a.ip, a)
		else merged.set(a.ip, { ...prev, name: prev.name ?? a.name, model: prev.model !== 'ATEM' ? prev.model : a.model, via: `${prev.via}+${a.via}` })
	}
	return { atems: [...merged.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true })), subnets }
}
