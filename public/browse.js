'use strict'

// The preset browser: the community half of this app.
//
// Copying between two channels is a tool. A catalogue of chains other people dialled in — for the
// mic you actually own, with the notes explaining what to tweak — is the reason to open the app on
// a day you are not copying anything. So it gets a full surface rather than a list in a column:
// search, filters, one card per preset with its own EQ curve as the artwork, a detail page with
// the real channel card, what other people said, and one button that puts it in your library.
//
// Everything here talks to /api/community/*, which the local server proxies to the catalogue at
// presets.studioupgrade.com. No network, no catalogue: the browser says so plainly and the rest
// of the app carries on working. Nothing in here can write to a switcher.

const CAT = {
	open: false,
	q: '',
	mic: '',
	style: '',
	sort: 'top',
	items: null,
	facets: { mics: [], styles: [] },
	total: 0,
	error: null,
	sel: null,
	detail: null,
	busy: false,
	installed: new Set(JSON.parse(localStorage.getItem('atem-audio-presets.installed') ?? '[]')),
	publish: null,
	config: null,
	replyTo: null,
}

const SORTS = [
	['top', 'Top rated'],
	['installs', 'Most used'],
	['rating', 'Highest rated'],
	['new', 'Newest'],
]

/** Server config (catalogue repo for pull requests, Turnstile site key). Fetched once, then cached. */
async function ensureConfig() {
	if (CAT.config) return CAT.config
	try {
		CAT.config = await api('/api/status')
	} catch {
		CAT.config = {}
	}
	return CAT.config
}

// A preset's stable community id, minted client-side for a fork: ps_ + ULID (48-bit ms + 80-bit
// random, Crockford base32, lowercased). Matches the server's lib/id.js exactly.
function mintPresetId() {
	const CB32 = '0123456789abcdefghjkmnpqrstvwxyz'
	const enc = (num, len) => {
		let s = ''
		for (let i = len - 1; i >= 0; i--) {
			s = CB32[Number(num % 32n)] + s
			num /= 32n
		}
		return s
	}
	const rnd = crypto.getRandomValues(new Uint8Array(10))
	let r = 0n
	for (const b of rnd) r = (r << 8n) | BigInt(b)
	return 'ps_' + enc(BigInt(Date.now()), 10) + enc(r, 16)
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'preset'

// ---- Turnstile (only loaded when the comment composer appears) --------------------------------
let turnstileReady = null
function loadTurnstile() {
	if (window.turnstile) return Promise.resolve(window.turnstile)
	if (turnstileReady) return turnstileReady
	turnstileReady = new Promise((resolve, reject) => {
		const s = document.createElement('script')
		s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
		s.async = true
		s.defer = true
		s.onload = () => resolve(window.turnstile)
		s.onerror = () => {
			turnstileReady = null
			reject(new Error('Could not load the human-check'))
		}
		document.head.append(s)
	})
	return turnstileReady
}

const timeAgo = (iso) => {
	const d = (Date.now() - new Date(iso).getTime()) / 1000
	if (!Number.isFinite(d)) return ''
	const steps = [
		[31536000, 'y'],
		[2592000, 'mo'],
		[604800, 'w'],
		[86400, 'd'],
		[3600, 'h'],
		[60, 'm'],
	]
	for (const [s, u] of steps) if (d >= s) return `${Math.floor(d / s)}${u} ago`
	return 'just now'
}

/** Five stars, drawn rather than typed — the value is the average, the number beside it the count. */
function stars(value, count, size = 11) {
	const pct = Math.max(0, Math.min(100, ((value ?? 0) / 5) * 100))
	const path =
		'M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 11.9 3.8 14.2l.8-4.7L1.2 6.2l4.7-.7z'
	const one = (cls) => `<path class="${cls}" d="${path}" />`
	const row = (cls) => `<svg viewBox="0 0 80 16" width="${size * 5}" height="${size}" aria-hidden="true">${[0, 1, 2, 3, 4]
		.map((i) => `<g transform="translate(${i * 16} 0)">${one(cls)}</g>`)
		.join('')}</svg>`
	return (
		`<span class="stars" role="img" aria-label="${(value ?? 0).toFixed(1)} out of 5${count ? `, ${count} ratings` : ''}">` +
		`<span class="sback">${row('sempty')}</span><span class="sfront" style="width:${pct}%">${row('sfull')}</span>` +
		`</span>` +
		(count === undefined ? '' : `<span class="scount">${count}</span>`)
	)
}

// ------------------------------------------------------------------ shell

function openBrowser() {
	if (CAT.open) return
	CAT.open = true
	document.body.classList.add('browsing')
	ensureConfig()
	renderBrowser()
	loadCatalogue()
	document.addEventListener('keydown', browserKeys)
	setTimeout(() => $('#cat-q')?.focus(), 30)
}

function closeBrowser() {
	CAT.open = false
	CAT.sel = null
	CAT.detail = null
	CAT.publish = null
	CAT.replyTo = null
	document.body.classList.remove('browsing')
	$('#browse').textContent = ''
	$('#browse').hidden = true
	document.removeEventListener('keydown', browserKeys)
}

function browserKeys(e) {
	if (e.key !== 'Escape') return
	if (CAT.publish) {
		CAT.publish = null
		renderBrowser()
	} else if (CAT.sel) {
		CAT.sel = null
		CAT.detail = null
		renderBrowser()
	} else closeBrowser()
}

async function loadCatalogue() {
	CAT.items = null
	CAT.error = null
	renderBrowser()
	try {
		const qs = new URLSearchParams({ q: CAT.q, mic: CAT.mic, style: CAT.style, sort: CAT.sort })
		const body = await api(`/api/community/presets?${qs}`)
		CAT.items = body.presets
		CAT.total = body.total ?? body.presets.length
		if (body.facets) CAT.facets = body.facets
	} catch (e) {
		CAT.items = []
		CAT.error = e.message
	}
	renderBrowser()
}

async function openPreset(id) {
	CAT.sel = id
	CAT.detail = null
	CAT.publish = null
	CAT.replyTo = null
	renderBrowser()
	try {
		CAT.detail = await api(`/api/community/presets/${encodeURIComponent(id)}`)
	} catch (e) {
		CAT.error = e.message
	}
	renderBrowser()
}

function renderBrowser() {
	const root = $('#browse')
	if (!root) return
	root.hidden = !CAT.open
	if (!CAT.open) return
	root.textContent = ''

	const sheet = el('div', 'cat')
	sheet.setAttribute('role', 'dialog')
	sheet.setAttribute('aria-modal', 'true')
	sheet.setAttribute('aria-label', 'Preset browser')
	sheet.append(catHead())
	sheet.append(CAT.publish ? catPublish() : CAT.sel ? catDetail() : catList())
	root.append(sheet)
}

function catHead() {
	const head = el('div', 'cathead')
	const left = el('div', 'catleft')
	const back = el('button', 'catback', CAT.sel || CAT.publish ? '← All presets' : '')
	if (CAT.sel || CAT.publish) {
		back.onclick = () => {
			CAT.sel = null
			CAT.detail = null
			CAT.publish = null
			renderBrowser()
		}
		left.append(back)
	} else {
		left.append(el('b', 'cattitle', 'Preset browser'))
		left.append(el('span', 'catsub', 'Chains other people dialled in, for the mics people actually own'))
	}
	head.append(left)

	const acts = el('div', 'catacts')
	const share = el('button', null, 'Share one of yours')
	share.onclick = startPublish
	acts.append(share)
	const x = el('button', 'catclose', '×')
	x.title = 'Close (Esc)'
	x.setAttribute('aria-label', 'Close the preset browser')
	x.onclick = closeBrowser
	acts.append(x)
	head.append(acts)
	return head
}

// ------------------------------------------------------------------ list

function catList() {
	const wrap = el('div', 'catbody')

	const bar = el('div', 'catbar')
	const search = el('input', 'catsearch')
	search.id = 'cat-q'
	search.type = 'search'
	search.placeholder = 'Search a mic, a style, a name — “SM7B”, “lectern”, “gate”'
	search.value = CAT.q
	search.setAttribute('aria-label', 'Search presets')
	let t
	search.oninput = () => {
		clearTimeout(t)
		CAT.q = search.value
		t = setTimeout(loadCatalogue, 220)
	}
	bar.append(search)

	const sorts = el('div', 'catsorts')
	sorts.setAttribute('role', 'group')
	sorts.setAttribute('aria-label', 'Sort')
	for (const [key, label] of SORTS) {
		const b = el('button', `catsort${CAT.sort === key ? ' on' : ''}`, label)
		b.setAttribute('aria-pressed', CAT.sort === key ? 'true' : 'false')
		b.onclick = () => {
			CAT.sort = key
			loadCatalogue()
		}
		sorts.append(b)
	}
	bar.append(sorts)
	wrap.append(bar)

	const cols = el('div', 'catcols')
	cols.append(catFacets())

	const main = el('div', 'catmain')
	if (CAT.items === null) {
		main.append(el('div', 'catnote', 'Loading the catalogue…'))
	} else if (CAT.error) {
		main.append(catOffline())
	} else if (!CAT.items.length) {
		const none = el('div', 'catempty')
		none.innerHTML =
			`<b>Nothing matches ${esc(CAT.q || 'that filter')}</b>` +
			'<p>Try the mic on its own — “SM58” finds more than “Shure SM58 stage”. Or clear the filters and browse.</p>'
		const clear = el('button', null, 'Clear filters')
		clear.onclick = () => {
			CAT.q = ''
			CAT.mic = ''
			CAT.style = ''
			loadCatalogue()
		}
		none.append(clear)
		main.append(none)
	} else {
		const count = el('div', 'catcount', `${CAT.total} preset${CAT.total === 1 ? '' : 's'}${CAT.mic ? ` for ${CAT.mic}` : ''}`)
		main.append(count)
		const grid = el('div', 'catgrid')
		for (const p of CAT.items) grid.append(catCard(p))
		main.append(grid)
	}
	cols.append(main)
	wrap.append(cols)
	return wrap
}

function catFacets() {
	const rail = el('div', 'catrail')
	const group = (label, key, values) => {
		if (!values?.length) return
		rail.append(el('div', 'facethead', label))
		const list = el('div', 'facetlist')
		const all = el('button', `facet${CAT[key] ? '' : ' on'}`, 'All')
		all.onclick = () => {
			CAT[key] = ''
			loadCatalogue()
		}
		list.append(all)
		for (const v of values) {
			const b = el('button', `facet${CAT[key] === v.name ? ' on' : ''}`, v.name)
			b.append(el('span', 'fcount', String(v.count)))
			b.onclick = () => {
				CAT[key] = CAT[key] === v.name ? '' : v.name
				loadCatalogue()
			}
			list.append(b)
		}
		rail.append(list)
	}
	group('Mic', 'mic', CAT.facets.mics)
	group('Style', 'style', CAT.facets.styles)
	return rail
}

/** One preset, App Store shelf style: its own curve as the artwork, then the words that matter. */
function catCard(p) {
	const card = el('button', 'catcard')
	card.onclick = () => openPreset(p.id)
	const art = el('div', 'catart')
	art.innerHTML = eqSparkline(p.eq ?? p.channel?.eq, 300, 84)
	if (p.style) art.append(el('span', 'catchip', p.style))
	card.append(art)
	if (p.variantOf) art.append(el('span', 'catforkflag', 'Variant'))
	const words = el('div', 'catwords')
	words.append(el('b', 'catname', p.name))
	words.append(el('div', 'catmic', p.mic ?? 'Any mic'))
	const foot = el('div', 'catfoot')
	const rate = el('span', 'catrate')
	rate.innerHTML = stars(p.rating, p.ratings)
	foot.append(rate)
	if (p.hearts) foot.append(el('span', 'catheartn', `♥ ${p.hearts}`))
	foot.append(el('span', 'catinstalls', `${p.installs ?? 0} used`))
	words.append(foot)
	const tags = el('div', 'cattags')
	if (p.variantCount) tags.append(el('span', 'catvariants', `${p.variantCount} variant${p.variantCount === 1 ? '' : 's'}`))
	if (CAT.installed.has(p.id)) tags.append(el('span', 'catowned', 'In your library'))
	if (tags.children.length) words.append(tags)
	card.append(words)
	return card
}

function catOffline() {
	const box = el('div', 'catempty')
	box.innerHTML =
		'<b>Can’t reach the preset catalogue</b>' +
		'<p>This is the one part of the app that needs the internet. Everything else — connecting, copying, your own saved presets — works without it.</p>' +
		`<p class="muted">${esc(CAT.error ?? '')}</p>`
	const retry = el('button', 'primary', 'Try again')
	retry.onclick = loadCatalogue
	box.append(retry)
	return box
}

// ------------------------------------------------------------------ detail

function catDetail() {
	const wrap = el('div', 'catbody detail')
	const p = CAT.detail
	if (!p) {
		wrap.append(el('div', 'catnote', 'Loading…'))
		return wrap
	}

	const hero = el('div', 'cathero')
	const words = el('div', 'herowords')
	words.append(el('b', 'heroname', p.name))
	const meta = el('div', 'herometa')
	meta.innerHTML =
		`${p.mic ? `<span>${esc(p.mic)}</span>` : ''}${p.style ? `<span class="hstyle">${esc(p.style)}</span>` : ''}` +
		`<span>by ${esc(p.author ?? 'anonymous')}</span>${p.createdAt ? `<span>${esc(timeAgo(p.createdAt))}</span>` : ''}`
	words.append(meta)

	// A fork wears its lineage plainly: the original, who changed it, what changed, the licence.
	if (p.variantOf) words.append(catAttribution(p))

	const rate = el('div', 'herorate')
	rate.innerHTML = `${stars(p.rating, p.ratings, 13)}<span class="hinstalls">${p.installs ?? 0} people use this</span>`
	words.append(rate)
	if (p.notes) words.append(el('p', 'heronotes', p.notes))
	if (p.device?.model) words.append(el('div', 'herodev', `Captured on ${p.device.model}${p.device.release ? ` · firmware ${p.device.release}` : ''}`))
	hero.append(words)

	const acts = el('div', 'heroacts')
	const owned = CAT.installed.has(p.id)
	const add = el('button', `primary big${owned ? ' owned' : ''}`, owned ? 'In your library' : 'Add to my library')
	add.disabled = CAT.busy
	add.onclick = () => installPreset(p)
	acts.append(add)

	// Favorite — affinity, deliberately separate from the star rating (quality): its own toggle, its
	// own copy, so a heart never reads as a verdict on how good the chain is.
	const heart = el('button', `heroheart${p.youHearted ? ' on' : ''}`)
	heart.setAttribute('aria-pressed', p.youHearted ? 'true' : 'false')
	heart.setAttribute('aria-label', p.youHearted ? 'Remove from favourites' : 'Save to favourites')
	heart.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 14S2 10 2 5.6A3.1 3.1 0 0 1 8 4a3.1 3.1 0 0 1 6 1.6C14 10 8 14 8 14z"/></svg><span>${p.hearts ?? 0}</span>`
	heart.onclick = () => sendHeart(p)
	acts.append(heart)

	// Make a variant — start your own version, credited to this one, shared as a pull request.
	const fork = el('button', 'herofork', 'Make a variant')
	fork.title = 'Start your own version, credited to this preset'
	fork.onclick = () => startVariant(p)
	acts.append(fork)

	if (p.sampleUrl) {
		const a = el('a', 'herosample', 'Hear it')
		a.href = p.sampleUrl
		a.target = '_blank'
		a.rel = 'noreferrer'
		acts.append(a)
	}
	acts.append(el('p', 'heronote', 'Adding copies it into your own library. Nothing is written to a switcher until you press Copy.'))
	hero.append(acts)
	wrap.append(hero)

	// The real channel card — the same renderer the app uses, so what you see is what you get.
	const card = el('div', 'catcard-full')
	card.append(el('div', 'catsec', 'What it does'))
	const cardBox = el('div')
	if (p.channel) renderStripCard(cardBox, p.channel, { sections: {}, source: false, incoming: null })
	card.append(cardBox)
	wrap.append(card)

	wrap.append(catRate(p))
	if (p.variants?.length) wrap.append(catVariants(p))
	wrap.append(catComments(p))
	return wrap
}

/** The lineage block on a fork: what it came from, who made it, what changed, under what licence. */
function catAttribution(p) {
	const box = el('div', 'heroattr')
	const orig = p.originalAuthor?.name || p.originalAuthor?.handle || (typeof p.originalAuthor === 'string' ? p.originalAuthor : null) || p.parent?.author || 'the original author'
	const line = el('div', 'attrline')
	line.append(el('span', 'attrlead', 'Variant of '))
	const link = el('button', 'attrparent', p.parent ? p.parent.name : 'the original')
	if (p.parent) link.onclick = () => openPreset(p.parent.id)
	else link.disabled = true
	line.append(link)
	line.append(el('span', 'attrby', ` by ${orig}`))
	box.append(line)
	if (p.author) box.append(el('div', 'attrmod', `Modified by ${p.author}`))
	if (p.changeNote) box.append(el('p', 'attrnote', p.changeNote))
	box.append(el('span', 'attrlic', `${p.license || 'MIT'} · free to use and re-share`))
	return box
}

/** The Variants section — the forks people tagged onto this preset, each its own rateable preset. */
function catVariants(p) {
	const box = el('div', 'catvarbox')
	box.append(el('div', 'catsec', `Variants · ${p.variants.length}`))
	box.append(el('p', 'catvarintro', 'Tweaks other people made to this one. Each is its own preset — open it to see what changed, rate it, or add it to your library.'))
	const grid = el('div', 'catgrid')
	for (const v of p.variants) grid.append(catCard(v))
	box.append(grid)
	return box
}

function catRate(p) {
	const box = el('div', 'catratebox')
	box.append(el('div', 'catsec', p.yourRating ? 'You rated this' : 'Used it? Rate it'))
	const row = el('div', 'ratestars')
	for (let i = 1; i <= 5; i++) {
		const b = el('button', `ratestar${(p.yourRating ?? 0) >= i ? ' on' : ''}`)
		b.setAttribute('aria-label', `${i} star${i === 1 ? '' : 's'}`)
		b.innerHTML = '<svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true"><path d="M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 11.9 3.8 14.2l.8-4.7L1.2 6.2l4.7-.7z" /></svg>'
		b.onclick = () => sendRating(p, i)
		row.append(b)
	}
	box.append(row)
	box.append(el('span', 'ratehint', 'Ratings are what push a good chain to the top of the list.'))
	return box
}

function catComments(p) {
	const box = el('div', 'catcomments')
	const list = p.comments ?? []
	const total = list.reduce((n, c) => n + 1 + (c.replies?.length || 0), 0)
	box.append(el('div', 'catsec', total ? `${total} note${total === 1 ? '' : 's'} from people who used it` : 'No notes yet — be the first'))

	box.append(commentComposer(p, { parentId: null, placeholder: 'What worked, what you changed, what mic and room — the useful kind of comment', withRating: true }))
	for (const c of list) box.append(renderComment(p, c, false))
	return box
}

/** The comment box. A top-level one can double as a review (optional star). Replies cannot. */
function commentComposer(p, { parentId, placeholder, withRating }) {
	const form = el('div', parentId ? 'commentform reply' : 'commentform')
	const input = el('textarea', 'commentbox')
	input.rows = 2
	input.placeholder = placeholder
	input.setAttribute('aria-label', parentId ? 'Write a reply' : 'Add a note')
	form.append(input)

	// A review-rating that lives entirely in the DOM (no re-render) so the draft text is never lost.
	let rating = 0
	if (withRating) {
		const rrow = el('div', 'reviewstars')
		rrow.append(el('span', 'reviewlab', 'Rate it too?'))
		for (let i = 1; i <= 5; i++) {
			const b = el('button', 'reviewstar')
			b.type = 'button'
			b.setAttribute('aria-label', `${i} star${i === 1 ? '' : 's'}`)
			b.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 11.9 3.8 14.2l.8-4.7L1.2 6.2l4.7-.7z"/></svg>'
			b.onclick = () => {
				rating = rating === i ? 0 : i
				;[...rrow.querySelectorAll('.reviewstar')].forEach((s, j) => s.classList.toggle('on', j < rating))
			}
			rrow.append(b)
		}
		form.append(rrow)
	}

	const actions = el('div', 'commentactions')
	const send = el('button', 'primary', parentId ? 'Reply' : 'Post')
	send.onclick = async () => {
		const text = input.value.trim()
		if (!text) return input.focus()
		send.disabled = true
		send.textContent = 'Verifying…'
		await postComment(p, { text, rating: withRating ? rating || null : null, parentId })
	}
	actions.append(send)
	if (parentId) {
		const cancel = el('button', 'ghost', 'Cancel')
		cancel.onclick = () => {
			CAT.replyTo = null
			renderBrowser()
		}
		actions.append(cancel)
	}
	form.append(actions)
	form.append(el('span', 'commenthint', 'A quick human check runs when you post. Comments are public — be kind and useful.'))
	return form
}

/** One comment, depth-1: top-level rows carry their replies; a reply renders flat with a "to @name". */
function renderComment(p, c, isReply) {
	const row = el('div', isReply ? 'comment reply' : 'comment')
	const head = el('div', 'chead')
	head.append(el('b', 'cauthor', c.author ?? 'anonymous'))
	if (c.replyToName) head.append(el('span', 'creplyto', `to ${c.replyToName}`))
	if (c.rating) {
		const s = el('span', 'crate')
		s.innerHTML = stars(c.rating, undefined, 9)
		head.append(s)
	}
	head.append(el('span', 'cwhen', timeAgo(c.at)))
	row.append(head)
	row.append(el('p', 'cbody', c.body))

	const bar = el('div', 'cbar')
	const up = el('button', `cup${c.youHelpful ? ' on' : ''}`, `Helpful${c.helpful ? ` · ${c.helpful}` : ''}`)
	up.onclick = () => toggleHelpful(p, c)
	bar.append(up)
	if (!isReply) {
		const rep = el('button', 'creply', 'Reply')
		rep.onclick = () => {
			CAT.replyTo = CAT.replyTo === c.id ? null : c.id
			renderBrowser()
		}
		bar.append(rep)
	}
	row.append(bar)

	if (!isReply && c.replies?.length) {
		const kids = el('div', 'creplies')
		for (const r of c.replies) kids.append(renderComment(p, r, true))
		row.append(kids)
	}
	if (!isReply && CAT.replyTo === c.id) row.append(commentComposer(p, { parentId: c.id, placeholder: `Reply to ${c.author ?? 'anonymous'}…`, withRating: false }))
	return row
}

async function installPreset(p) {
	if (CAT.busy || CAT.installed.has(p.id)) return
	CAT.busy = true
	renderBrowser()
	try {
		await api('/api/presets', {
			method: 'POST',
			body: JSON.stringify({
				name: p.name,
				group: p.style || 'Community',
				defaultSections: p.defaultSections ?? { gain: true, volume: false, pan: false, eq: true, dynamics: true, inputConfig: false },
				payload: {
					format: 'atem-audio-preset',
					version: 1,
					channel: p.channel,
					device: p.device ?? null,
					mic: p.mic ?? null,
					style: p.style ?? null,
					notes: p.notes ?? null,
					license: p.license ?? 'MIT',
					sampleUrl: p.sampleUrl ?? null,
				},
			}),
		})
		CAT.installed.add(p.id)
		localStorage.setItem('atem-audio-presets.installed', JSON.stringify([...CAT.installed]))
		// Count the adoption on the catalogue (one per person, best-effort — never blocks the add).
		api(`/api/community/presets/${encodeURIComponent(p.id)}/install`, { method: 'POST', body: '{}' })
			.then((r) => {
				p.installs = r.installs
				renderBrowser()
			})
			.catch(() => {})
		await loadPresets()
		setStatus(`Added “${p.name}” to your library`, 'ok')
		showOutcome('ok', `“${p.name}” is in your library`, `Filed under ${esc(p.style || 'Community')}. Flip a column to Presets to use it.`)
	} catch (e) {
		setStatus(e.message, 'err')
	}
	CAT.busy = false
	renderBrowser()
}

async function sendRating(p, rating) {
	p.yourRating = rating
	renderBrowser()
	try {
		const body = await api(`/api/community/presets/${encodeURIComponent(p.id)}/rate`, { method: 'POST', body: JSON.stringify({ rating }) })
		Object.assign(p, body)
	} catch {
		/* the local mark stands; the catalogue will catch up */
	}
	renderBrowser()
}

async function sendHeart(p) {
	const prev = p.youHearted
	const prevN = p.hearts ?? 0
	p.youHearted = !prev // optimistic
	p.hearts = prevN + (prev ? -1 : 1)
	renderBrowser()
	try {
		const body = await api(`/api/community/presets/${encodeURIComponent(p.id)}/heart`, { method: 'POST', body: '{}' })
		p.hearts = body.hearts
		p.youHearted = body.youHearted
	} catch {
		p.youHearted = prev
		p.hearts = prevN
	}
	renderBrowser()
}

// ------------------------------------------------------------------ forks / pull-request publish

/**
 * Build the GitHub "new file → pull request" deep link that carries a one-preset pack. No server
 * secret: the user is signed in to GitHub already, and GitHub auto-forks the repo if they lack write
 * access. The pack file is a few KB, well under the practical URL limit.
 */
function buildPrUrl(repo, preset, { title, body }) {
	const pack = {
		format: 'atem-audio-preset-pack',
		version: 1,
		name: preset.name,
		author: preset.author || '',
		createdAt: new Date().toISOString(),
		presets: [preset],
	}
	const filename = `packs/${slugify(preset.name)}--${preset.id.slice(-8)}.json`
	const value = JSON.stringify(pack, null, 2)
	const qs = new URLSearchParams({ filename, value, message: title })
	if (body) qs.set('description', body)
	return `https://github.com/${repo}/new/main?${qs.toString()}`
}

/** Assemble the variant preset from a parent and hand off to the shared publish form in fork mode. */
async function startVariant(parent) {
	await ensureConfig()
	CAT.publish = {
		mode: 'variant',
		parent,
		sending: false,
		edits: {
			name: `${parent.name} (variant)`,
			mic: parent.mic ?? '',
			style: parent.style ?? '',
			notes: parent.notes ?? '',
			changeNote: '',
			sampleUrl: '',
			author: localStorage.getItem('atem-audio-presets.author') ?? '',
		},
	}
	CAT.sel = null
	CAT.detail = null
	renderBrowser()
}

async function postComment(p, { text, rating, parentId }) {
	const cfg = await ensureConfig()
	let token
	try {
		token = await getTurnstileToken(cfg.turnstileSiteKey)
	} catch {
		setStatus('Could not verify you are human. Please try again.', 'err')
		renderBrowser()
		return
	}
	try {
		const author = (localStorage.getItem('atem-audio-presets.author') || '').trim() || null
		const body = await api(`/api/community/presets/${encodeURIComponent(p.id)}/comments`, {
			method: 'POST',
			body: JSON.stringify({ body: text, rating: rating ?? null, parentId: parentId ?? null, author, turnstileToken: token }),
		})
		p.comments = body.comments
		if (rating) p.yourRating = rating
		CAT.replyTo = null
	} catch (e) {
		setStatus(e.message, 'err')
	}
	renderBrowser()
}

async function toggleHelpful(p, c) {
	const prev = c.youHelpful
	const prevN = c.helpful ?? 0
	c.youHelpful = !prev
	c.helpful = prevN + (prev ? -1 : 1)
	renderBrowser()
	try {
		const body = await api(`/api/community/comments/${encodeURIComponent(c.id)}/helpful`, { method: 'POST', body: '{}' })
		c.helpful = body.helpful
		c.youHelpful = body.youHelpful
	} catch {
		c.youHelpful = prev
		c.helpful = prevN
	}
	renderBrowser()
}

/**
 * Get one Turnstile token on demand: mount an invisible widget offscreen, execute it, resolve with
 * the token (or reject). Cloudflare shows its own centred modal if a challenge is actually needed.
 */
async function getTurnstileToken(siteKey) {
	if (!siteKey) throw new Error('No human-check configured')
	await loadTurnstile()
	return new Promise((resolve, reject) => {
		const holder = document.createElement('div')
		holder.style.position = 'fixed'
		holder.style.left = '-9999px'
		holder.style.top = '0'
		document.body.append(holder)
		let done = false
		const finish = (fn, val) => {
			if (done) return
			done = true
			try {
				window.turnstile.remove(id)
			} catch {
				/* already gone */
			}
			holder.remove()
			fn(val)
		}
		// Invisibility comes from the widget's own mode (set when the widget is created), not a render
		// param. A managed widget auto-solves and calls back; an invisible one needs execute(); either
		// way Cloudflare shows its own centred modal if a real challenge is required.
		const id = window.turnstile.render(holder, {
			sitekey: siteKey,
			callback: (t) => finish(resolve, t),
			'error-callback': () => finish(reject, new Error('turnstile-error')),
			'timeout-callback': () => finish(reject, new Error('turnstile-timeout')),
		})
		try {
			window.turnstile.execute(id)
		} catch {
			/* execute only applies to invisible-mode widgets; a no-op otherwise */
		}
		setTimeout(() => finish(reject, new Error('turnstile-timeout')), 15000)
	})
}

// ------------------------------------------------------------------ publish

function startPublish() {
	const local = state.library.presets.filter((p) => p.format !== 'atem-audio-snapshot')
	CAT.publish = { mode: 'share', file: local[0]?.file ?? null, sending: false, edits: null }
	loadPublishEdits(local[0])
	renderBrowser()
}

/** The publish form edits a copy, not the saved preset — sharing should never rewrite your library. */
function loadPublishEdits(p) {
	if (!CAT.publish) return
	CAT.publish.edits = {
		mic: p?.mic ?? '',
		style: p?.style ?? '',
		notes: p?.notes ?? '',
		sampleUrl: p?.sampleUrl ?? '',
		author: localStorage.getItem('atem-audio-presets.author') ?? '',
	}
}

const okSampleUrl = (v) => !v || /^https?:\/\/\S+\.\S+/i.test(v)
const PRESET_ID_RE = /^ps_[0-9a-z]{26}$/

function catPublish() {
	const isVariant = CAT.publish.mode === 'variant'
	const wrap = el('div', 'catbody publish')
	wrap.append(el('div', 'catsec', isVariant ? `Make a variant of “${CAT.publish.parent.name}”` : 'Share a preset'))

	let chosen = null
	if (isVariant) {
		const info = el('p', 'pubvarinfo')
		info.textContent = `Your version starts from the original’s settings, credits ${CAT.publish.parent.author || 'the original author'}, and is opened as a pull request on GitHub. Tweak the details, say what you changed, then open the request.`
		wrap.append(info)
	} else {
		const local = state.library.presets.filter((p) => p.format !== 'atem-audio-snapshot')
		if (!local.length) {
			const none = el('div', 'catempty')
			none.innerHTML =
				'<b>Save one first</b>' +
				'<p>Sharing starts from your own library: dial a channel in, flip a column to Presets, and save it. Then it can be shared from here.</p>'
			wrap.append(none)
			return wrap
		}
		const pick = el('div', 'pubpick')
		for (const p of local) {
			const b = el('button', `pubrow${CAT.publish.file === p.file ? ' on' : ''}`)
			const spark = el('span', 'pspark')
			b.append(spark)
			paintSpark(p.file, spark)
			const w = el('div', 'pwords')
			w.append(el('span', 'name', p.name))
			const bits = [p.mic, p.style].filter(Boolean).join(' · ')
			w.append(el('span', 'pmeta2', bits || 'No mic or style set'))
			b.append(w)
			b.onclick = () => {
				CAT.publish.file = p.file
				loadPublishEdits(p)
				renderBrowser()
			}
			pick.append(b)
		}
		wrap.append(pick)
		chosen = local.find((p) => p.file === CAT.publish.file)
	}

	const e = CAT.publish.edits ?? {}

	// Everything that will be public, editable here. A preset saved in a hurry usually has a name
	// and nothing else; making people go back to the save form to add a mic is how good presets end
	// up unshared.
	const form = el('div', 'pubform')
	const field = (key, label, placeholder, hint, long) => {
		const row = el('label', `pubfield${long ? ' long' : ''}`)
		row.append(el('span', 'publabel', label))
		const input = el(long ? 'textarea' : 'input', 'pubinput')
		if (!long) input.type = 'text'
		input.placeholder = placeholder
		input.value = e[key] ?? ''
		if (long) input.rows = 3
		input.oninput = () => {
			CAT.publish.edits[key] = input.value
			refreshPublishState() // live, because the button's enabled state depends on the fields
		}
		row.append(input)
		if (hint) row.append(el('span', 'pubhint', hint))
		form.append(row)
		return input
	}
	if (isVariant) field('name', 'Variant name', `${CAT.publish.parent.name} (variant)`, 'What to call your version.')
	field('mic', 'Microphone or source', 'Shure SM7B, lectern gooseneck, Rode PodMic…', 'Required — this is how people find it.')
	field('style', 'Style', 'Podcast, Broadcast voice, Live vocal…', 'Required.')
	if (isVariant) field('changeNote', 'What did you change?', 'Opened the low-pass, eased the 1 kHz honk…', 'Required — the whole point of a variant.', true)
	field('notes', 'Notes', 'What it suits, what to tweak by ear, what it assumes about the room.', 'The most useful part for the next person.', true)
	const sample = field('sampleUrl', 'Link to a sample', 'https://…', 'Optional. A short clip of this chain in use is worth more than any description.')
	field('author', 'Your name or handle', 'Optional — credited as “shared by”', 'Leave blank to share anonymously.')
	wrap.append(form)

	const note = el('div', 'pubnote')
	wrap.append(note)
	const go = el('button', 'primary big', 'Open a pull request')
	wrap.append(go)

	function refreshPublishState() {
		const d = CAT.publish.edits
		const missing = !d.mic?.trim() || !d.style?.trim() || (isVariant && !d.changeNote?.trim())
		const badUrl = !okSampleUrl(d.sampleUrl?.trim())
		sample.classList.toggle('bad', badUrl)
		note.innerHTML = missing
			? `<b>Add a mic and a style${isVariant ? ', and say what you changed' : ''}.</b> Those are how anyone finds and trusts this preset.`
			: badUrl
				? '<b>That sample link does not look like a URL.</b> It should start with http:// or https://.'
				: '<b>Ready.</b> This opens a pre-filled pull request on GitHub — review it there and submit. It goes live once it’s merged. Nothing about your switcher or network travels except the model and firmware build.'
		go.disabled = missing || badUrl
	}
	refreshPublishState()

	go.onclick = async () => {
		const d = CAT.publish.edits
		const cfg = await ensureConfig()
		const repo = cfg.libraryRepo || 'ryangrams/atem-preset-library'
		localStorage.setItem('atem-audio-presets.author', (d.author || '').trim())
		let preset
		let title
		let prBody
		try {
			if (isVariant) {
				const parent = CAT.publish.parent
				preset = {
					format: 'atem-audio-preset',
					version: 1,
					id: mintPresetId(),
					name: (d.name || '').trim() || `${parent.name} (variant)`,
					mic: d.mic.trim(),
					style: d.style.trim(),
					notes: d.notes.trim() || null,
					author: d.author.trim() || null,
					license: parent.license || 'MIT',
					defaultSections: parent.defaultSections ?? null,
					device: parent.device ?? null,
					channel: parent.channel,
					sampleUrl: d.sampleUrl.trim() || null,
					forkedFrom: { id: parent.id, packId: parent.packId ?? null, version: parent.contentHash ?? 'sha256:unknown' },
					lineageRoot: parent.lineageRoot || parent.id,
					originalAuthor: parent.originalAuthor || { name: parent.author || 'anonymous' },
					attribution: [...(parent.attribution || []), parent.author || 'anonymous'].filter(Boolean),
					changeNote: d.changeNote.trim(),
				}
				title = `Add variant: ${preset.name}`
				prBody = `Variant of "${parent.name}" (id ${parent.id})${parent.author ? ` by ${parent.author}` : ''}.\n\nWhat changed: ${preset.changeNote}\n\nLicence: ${preset.license} (preserved from the original).`
			} else {
				const body = await api(`/api/presets/${encodeURIComponent(chosen.file)}`)
				preset = {
					format: 'atem-audio-preset',
					version: 1,
					id: PRESET_ID_RE.test(body.id) ? body.id : mintPresetId(),
					name: chosen.name,
					mic: d.mic.trim(),
					style: d.style.trim(),
					notes: d.notes.trim() || null,
					author: d.author.trim() || null,
					license: body.license || 'MIT',
					defaultSections: body.defaultSections ?? null,
					device: body.device ?? null,
					channel: body.channel,
					sampleUrl: d.sampleUrl.trim() || null,
				}
				title = `Add preset: ${preset.name}`
				prBody = `New preset for ${preset.mic} — ${preset.style}.\n\nLicence: ${preset.license}.`
			}
			const url = buildPrUrl(repo, preset, { title, body: prBody })
			window.open(url, '_blank', 'noopener')
			CAT.publish = null
			renderBrowser()
			showOutcome(
				'ok',
				isVariant ? 'Your variant is opening on GitHub' : `“${preset.name}” is opening on GitHub`,
				'Review the pull request there and submit it. Once it’s merged it shows up in the browser — with its own ratings, favourites and comments.',
			)
		} catch (err) {
			setStatus(err.message, 'err')
			renderBrowser()
		}
	}
	wrap.append(el('p', 'heronote', 'Presets are shared under the MIT licence, like the app. Anything shared can be downloaded, changed and re-shared — a variant always credits the original.'))
	return wrap
}

$('#browse-open')?.addEventListener('click', openBrowser)
