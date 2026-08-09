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
}

const SORTS = [
	['top', 'Top rated'],
	['installs', 'Most used'],
	['new', 'Newest'],
]

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
	const words = el('div', 'catwords')
	words.append(el('b', 'catname', p.name))
	words.append(el('div', 'catmic', p.mic ?? 'Any mic'))
	const foot = el('div', 'catfoot')
	const rate = el('span', 'catrate')
	rate.innerHTML = stars(p.rating, p.ratings)
	foot.append(rate)
	foot.append(el('span', 'catinstalls', `${p.installs ?? 0} used`))
	words.append(foot)
	if (CAT.installed.has(p.id)) words.append(el('span', 'catowned', 'In your library'))
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
	wrap.append(catComments(p))
	return wrap
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
	box.append(el('div', 'catsec', list.length ? `${list.length} note${list.length === 1 ? '' : 's'} from people who used it` : 'No notes yet'))

	const form = el('div', 'commentform')
	const input = el('textarea', 'commentbox')
	input.rows = 2
	input.placeholder = 'What worked, what you changed, what mic and room — the useful kind of comment'
	input.setAttribute('aria-label', 'Add a note')
	form.append(input)
	const send = el('button', null, 'Post')
	send.onclick = () => sendComment(p, input)
	form.append(send)
	box.append(form)

	for (const c of list) {
		const row = el('div', 'comment')
		const head = el('div', 'chead')
		head.append(el('b', null, c.author ?? 'anonymous'))
		if (c.rating) {
			const s = el('span', 'crate')
			s.innerHTML = stars(c.rating, undefined, 9)
			head.append(s)
		}
		head.append(el('span', 'cwhen', timeAgo(c.at)))
		row.append(head)
		row.append(el('p', 'cbody', c.body))
		const up = el('button', 'cup', `Helpful · ${c.votes ?? 0}`)
		up.onclick = () => {
			c.votes = (c.votes ?? 0) + 1
			renderBrowser()
		}
		row.append(up)
		box.append(row)
	}
	return box
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
					sampleUrl: p.sampleUrl ?? null,
				},
			}),
		})
		CAT.installed.add(p.id)
		localStorage.setItem('atem-audio-presets.installed', JSON.stringify([...CAT.installed]))
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

async function sendComment(p, input) {
	const text = input.value.trim()
	if (!text) return input.focus()
	input.value = ''
	try {
		const body = await api(`/api/community/presets/${encodeURIComponent(p.id)}/comments`, { method: 'POST', body: JSON.stringify({ body: text, rating: p.yourRating ?? null }) })
		p.comments = body.comments
	} catch (e) {
		setStatus(e.message, 'err')
	}
	renderBrowser()
}

// ------------------------------------------------------------------ publish

function startPublish() {
	const local = state.library.presets.filter((p) => p.format !== 'atem-audio-snapshot')
	CAT.publish = { file: local[0]?.file ?? null, sending: false, edits: null }
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

function catPublish() {
	const wrap = el('div', 'catbody publish')
	const local = state.library.presets.filter((p) => p.format !== 'atem-audio-snapshot')
	wrap.append(el('div', 'catsec', 'Share a preset'))

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

	const chosen = local.find((p) => p.file === CAT.publish.file)
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
			// Live, because the Publish button's enabled state depends on mic and style.
			refreshPublishState()
		}
		row.append(input)
		if (hint) row.append(el('span', 'pubhint', hint))
		form.append(row)
		return input
	}
	field('mic', 'Microphone or source', 'Shure SM7B, lectern gooseneck, Rode PodMic…', 'Required — this is how people find it.')
	field('style', 'Style', 'Podcast, Broadcast voice, Live vocal…', 'Required.')
	field('notes', 'Notes', 'What it suits, what to tweak by ear, what it assumes about the room.', 'The most useful part for the next person.', true)
	const sample = field('sampleUrl', 'Link to a sample', 'https://…', 'Optional. A short clip of this chain in use is worth more than any description.')
	field('author', 'Your name or handle', 'Optional — published as “shared by”', 'Leave blank to publish anonymously.')
	wrap.append(form)

	const note = el('div', 'pubnote')
	wrap.append(note)

	const go = el('button', 'primary big', 'Publish to the community')
	wrap.append(go)

	function refreshPublishState() {
		const d = CAT.publish.edits
		const missing = !d.mic?.trim() || !d.style?.trim()
		const badUrl = !okSampleUrl(d.sampleUrl?.trim())
		sample.classList.toggle('bad', badUrl)
		note.innerHTML = missing
			? '<b>Add a mic and a style.</b> Everything else is optional, but those two are how anyone finds this preset.'
			: badUrl
				? '<b>That sample link does not look like a URL.</b> It should start with http:// or https://.'
				: '<b>Ready to share.</b> The settings, the words above and your name go up. Nothing about your switcher or network travels except the model and firmware build.'
		go.disabled = missing || badUrl || CAT.publish.sending
		go.textContent = CAT.publish.sending ? 'Publishing…' : 'Publish to the community'
	}
	refreshPublishState()

	go.onclick = async () => {
		const d = CAT.publish.edits
		CAT.publish.sending = true
		refreshPublishState()
		try {
			const body = await api(`/api/presets/${encodeURIComponent(chosen.file)}`)
			localStorage.setItem('atem-audio-presets.author', d.author.trim())
			await api('/api/community/presets', {
				method: 'POST',
				body: JSON.stringify({
					author: d.author.trim() || null,
					// The shared copy carries the words typed here, not whatever the local file happens
					// to hold — the two are allowed to differ.
					preset: { ...body, mic: d.mic.trim(), style: d.style.trim(), notes: d.notes.trim() || null, sampleUrl: d.sampleUrl.trim() || null },
				}),
			})
			CAT.publish = null
			CAT.q = ''
			CAT.sort = 'new'
			await loadCatalogue()
			showOutcome('ok', `“${chosen.name}” is published`, 'It is in the browser now, newest first. Ratings and notes from other people will show up on its page.')
		} catch (err) {
			CAT.publish.sending = false
			setStatus(err.message, 'err')
			renderBrowser()
		}
	}
	wrap.append(el('p', 'heronote', 'Presets are shared under the same MIT licence as the app. Anything you publish can be downloaded, changed and re-shared.'))
	return wrap
}

$('#browse-open')?.addEventListener('click', openBrowser)
