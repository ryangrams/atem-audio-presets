// Mint a fresh stable preset id: ps_<ulid>. ULID = 48-bit ms timestamp + 80-bit randomness in
// Crockford base32 (lowercased), so ids sort by creation time and effectively never collide.
//
//   node scripts/mint-id.mjs            → print one id
//   node scripts/mint-id.mjs <slug>     → also record it in seed-ids.json under <slug>
//
// The app mints its own ids the same way when it creates a preset to publish; this is for authoring
// the shipped seeds by hand.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ENC = '0123456789abcdefghjkmnpqrstvwxyz' // Crockford base32, lowercase
function enc(num, len) {
	let s = ''
	for (let i = len - 1; i >= 0; i--) {
		s = ENC[Number(num % 32n)] + s
		num /= 32n
	}
	return s
}
export function mintId(tsMs = Date.now()) {
	const rnd = crypto.randomBytes(10)
	let r = 0n
	for (const b of rnd) r = (r << 8n) | BigInt(b)
	return 'ps_' + enc(BigInt(tsMs), 10) + enc(r, 16)
}

// Run directly, not imported.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	const id = mintId()
	const slug = process.argv[2]
	if (slug) {
		const file = path.join(import.meta.dirname, 'seed-ids.json')
		const map = JSON.parse(fs.readFileSync(file, 'utf8'))
		if (map[slug]) {
			console.error(`"${slug}" already has an id: ${map[slug]} (not overwriting)`)
			process.exit(1)
		}
		map[slug] = id
		fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n')
		console.log(`${slug} → ${id}  (recorded in seed-ids.json)`)
	} else {
		console.log(id)
	}
}
