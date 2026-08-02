// Draws build/icon.png — a 1024×1024 app icon of the EQ curve the app is built around.
//
// Written by hand with zlib and a small PNG encoder rather than an image library: the icon is a
// handful of shapes, and this keeps the repo free of a build-only dependency. Run with
// `npm run icon` after changing anything here.

import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')
const SIZE = 1024
const SS = 2 // supersample factor, averaged down at the end for smooth edges
const W = SIZE * SS

const BG = [31, 31, 31]
const EDGE = [58, 58, 58]
const CYAN = [42, 201, 230]
const GRID = [46, 46, 46]

const buf = new Float32Array(W * W * 4)

function blend(x, y, [r, g, b], a) {
	if (x < 0 || y < 0 || x >= W || y >= W || a <= 0) return
	const i = (y * W + x) * 4
	const inv = 1 - a
	buf[i] = buf[i] * inv + r * a
	buf[i + 1] = buf[i + 1] * inv + g * a
	buf[i + 2] = buf[i + 2] * inv + b * a
	buf[i + 3] = Math.min(255, buf[i + 3] * inv + 255 * a)
}

/** Squircle-ish rounded square, the shape macOS and Windows both expect. */
function roundedRect(x0, y0, x1, y1, radius, colour, alpha = 1) {
	for (let y = Math.floor(y0); y < y1; y++) {
		for (let x = Math.floor(x0); x < x1; x++) {
			const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius))
			const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius))
			if (Math.hypot(dx, dy) <= radius) blend(x, y, colour, alpha)
		}
	}
}

const smoothstep = (a, b, t) => {
	const u = Math.max(0, Math.min(1, (t - a) / (b - a)))
	return u * u * (3 - 2 * u)
}
const gauss = (t, mu, sigma) => Math.exp(-((t - mu) ** 2) / (2 * sigma ** 2))

/** The response of a vocal chain: high-pass, presence bell, a notch, and a gentle top roll-off. */
function responseDb(t) {
	return (
		9 * gauss(t, 0.34, 0.1) -
		8 * gauss(t, 0.76, 0.05) -
		20 * (1 - smoothstep(0.02, 0.22, t)) -
		12 * smoothstep(0.86, 1.02, t)
	)
}

const inset = W * 0.085
const plotTop = W * 0.3
const plotBottom = W * 0.74
const curveY = (t) => {
	const mid = (plotTop + plotBottom) / 2
	return mid - (Math.max(-20, Math.min(20, responseDb(t))) / 20) * ((plotBottom - plotTop) / 2)
}

// Backplate.
roundedRect(inset, inset, W - inset, W - inset, W * 0.2, BG)
roundedRect(inset, inset, W - inset, W - inset, W * 0.2, EDGE, 0.0) // reserved for a future rim

// Baseline and two guide lines, faint, so it reads as a plot rather than a squiggle.
const guides = [plotTop + (plotBottom - plotTop) * 0.25, (plotTop + plotBottom) / 2, plotBottom - (plotBottom - plotTop) * 0.25]
for (const gy of guides) {
	for (let x = inset + W * 0.06; x < W - inset - W * 0.06; x++) {
		for (let y = Math.round(gy); y < Math.round(gy) + SS * 2; y++) blend(x, y, GRID, 1)
	}
}

// Fill under the curve, then the curve itself.
const x0 = inset + W * 0.06
const x1 = W - inset - W * 0.06
const zero = (plotTop + plotBottom) / 2
const half = W * 0.019

for (let x = Math.round(x0); x < x1; x++) {
	const t = (x - x0) / (x1 - x0)
	const y = curveY(t)
	const from = Math.round(Math.min(y, zero))
	const to = Math.round(Math.max(y, zero))
	for (let fy = from; fy < to; fy++) blend(x, fy, CYAN, 0.16)
}

for (let x = Math.round(x0); x < x1; x++) {
	const t = (x - x0) / (x1 - x0)
	const y = curveY(t)
	// Sample the neighbours so steep sections stay the same visual thickness.
	const slope = Math.abs(curveY(t + 0.001) - y) / (0.001 * (x1 - x0))
	const thick = half * Math.sqrt(1 + slope * slope)
	for (let fy = Math.round(y - thick); fy <= Math.round(y + thick); fy++) {
		const d = Math.abs(fy - y)
		blend(x, fy, CYAN, Math.max(0, Math.min(1, (thick - d) / (SS * 1.5))))
	}
}

// ---- downsample and encode ----

const px = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		let r = 0,
			g = 0,
			b = 0,
			a = 0
		for (let sy = 0; sy < SS; sy++) {
			for (let sx = 0; sx < SS; sx++) {
				const i = ((y * SS + sy) * W + (x * SS + sx)) * 4
				r += buf[i]
				g += buf[i + 1]
				b += buf[i + 2]
				a += buf[i + 3]
			}
		}
		const n = SS * SS
		const o = (y * SIZE + x) * 4
		px[o] = Math.round(r / n)
		px[o + 1] = Math.round(g / n)
		px[o + 2] = Math.round(b / n)
		px[o + 3] = Math.round(a / n)
	}
}

const CRC = (() => {
	const t = new Int32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		t[n] = c
	}
	return (b) => {
		let c = -1
		for (const byte of b) c = t[(c ^ byte) & 0xff] ^ (c >>> 8)
		return (c ^ -1) >>> 0
	}
})()

function chunk(type, data) {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(CRC(body))
	return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
// Each scanline is prefixed with its filter type; 0 (none) keeps this encoder simple.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
	raw[y * (SIZE * 4 + 1)] = 0
	px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(
	OUT,
	Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	])
)
console.log(`wrote ${OUT} (${SIZE}×${SIZE})`)
