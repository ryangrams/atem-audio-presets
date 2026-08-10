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
	const hintSubnets = []
	for (const h of hints) {
		const m = String(h).match(/^(\d+\.\d+\.\d+)\.\d+$/)
		if (m) hintSubnets.push(m[1])
	}
	const local = []
	for (const list of Object.values(os.networkInterfaces())) {
		for (const ni of list ?? []) {
			if (ni.family !== 'IPv4' || ni.internal) continue
			const m = ni.address.match(/^(\d+\.\d+\.\d+)\.\d+$/)
			// Only private ranges — never sweep a public /24.
			if (m && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(ni.address)) local.push(m[1])
		}
	}
	// A consumer ATEM ships on 192.168.x, so sweep those first; then 172.16–31; then 10.x, which is
	// also every ZeroTier/VPN overlay (a /24 of dead hosts that would otherwise waste the budget).
	// Hints — addresses the user has actually connected to — always lead.
	const rank = (s) => (s.startsWith('192.168.') ? 0 : /^172\./.test(s) ? 1 : 2)
	local.sort((a, b) => rank(a) - rank(b))
	const ordered = []
	for (const s of [...hintSubnets, ...local]) if (!ordered.includes(s)) ordered.push(s)
	return ordered
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
	// Interleave hosts across subnets — .1 of every subnet, then .2 of every subnet, and so on — so a
	// switcher on a later /24 is still probed in the first moments. Walking one whole subnet before
	// the next lets a couple of dead VPN ranges swept first burn the entire deadline before the real
	// LAN is reached (the switcher answers in ~20 ms, but only once it is finally probed).
	const hosts = []
	for (let i = 1; i <= 254; i++) for (const s of subnets) hosts.push(`${s}.${i}`)
	const found = []
	let cursor = 0
	const CONCURRENCY = 128
	async function worker() {
		while (cursor < hosts.length && Date.now() < deadline) {
			const ip = hosts[cursor++]
			// A reachable host on a LAN answers in tens of ms; a short timeout fails the dead ones fast
			// so the sweep covers far more hosts inside the deadline.
			const controller = AbortSignal.timeout(Math.min(500, Math.max(50, deadline - Date.now())))
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
export async function discover({ hints = [], timeoutMs = 5000 } = {}) {
	const deadline = Date.now() + timeoutMs
	// Hint subnets (where the user's switchers have been) come first and are always swept; cap the
	// rest so a machine on a dozen ZeroTier /24s does not spend the whole budget on empty networks.
	// Interleaved probing (see sweep) means more subnets no longer delays finding a reachable switcher.
	const subnets = candidateSubnets(hints).slice(0, 8)
	const [byMdns, byScan] = await Promise.all([mdns(deadline), sweep(subnets, deadline)])

	const merged = new Map()
	for (const a of [...byScan, ...byMdns]) {
		const prev = merged.get(a.ip)
		if (!prev) merged.set(a.ip, a)
		else merged.set(a.ip, { ...prev, name: prev.name ?? a.name, model: prev.model !== 'ATEM' ? prev.model : a.model, via: `${prev.via}+${a.via}` })
	}
	return { atems: [...merged.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true })), subnets }
}
