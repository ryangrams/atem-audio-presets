// A preset's stable community id: ps_<ulid>. ULID = 48-bit ms timestamp + 80-bit randomness in
// Crockford base32 (lowercased), so ids sort by creation time and effectively never collide. Minted
// once, when a preset is first saved, and then only ever read — a rename or re-group keeps the id,
// so the preset's ratings, favourites and comments stay attached to it.

import crypto from 'node:crypto'

const CB32 = '0123456789abcdefghjkmnpqrstvwxyz'
function enc32(num, len) {
	let s = ''
	for (let i = len - 1; i >= 0; i--) {
		s = CB32[Number(num % 32n)] + s
		num /= 32n
	}
	return s
}

export function mintId(prefix = 'ps_') {
	const t = enc32(BigInt(Date.now()), 10)
	const rnd = crypto.randomBytes(10)
	let r = 0n
	for (const b of rnd) r = (r << 8n) | BigInt(b)
	return prefix + t + enc32(r, 16)
}

export const PRESET_ID = /^ps_[0-9a-z]{26}$/
