'use strict'

// The in-app Feedback button. A report is a bug or an idea, an optional line of contact, and an
// opt-in screenshot of the view you were on — filed straight into GitHub as a labelled issue by the
// catalogue backend, so the reporter needs no GitHub account. Reuses browse.js's config + Turnstile
// helpers (ensureConfig, getTurnstileToken) and app.js's el/esc/api/showOutcome.

const FB = { open: false, kind: 'bug', shot: null, includeShot: true, capturing: false, sending: false, done: null, error: null }

// ------------------------------------------------------------------ screenshot capture (html2canvas)
let h2cPromise = null
function loadHtml2Canvas() {
	if (window.html2canvas) return Promise.resolve(window.html2canvas)
	if (h2cPromise) return h2cPromise
	h2cPromise = new Promise((resolve, reject) => {
		const s = document.createElement('script')
		s.src = 'vendor/html2canvas.min.js'
		s.onload = () => resolve(window.html2canvas)
		s.onerror = () => {
			h2cPromise = null
			reject(new Error('capture unavailable'))
		}
		document.head.append(s)
	})
	return h2cPromise
}

/** Capture the app view — ignoring the feedback panel itself — and return a compact JPEG data URL. */
async function captureView() {
	const h2c = await loadHtml2Canvas()
	const canvas = await h2c(document.body, {
		backgroundColor: getComputedStyle(document.body).backgroundColor || '#141414',
		ignoreElements: (n) => n.id === 'feedback', // never shoot the feedback panel/backdrop
		scale: Math.min(window.devicePixelRatio || 1, 1.5),
		logging: false,
		useCORS: true,
	})
	// Cap the width so the upload stays small, then export as JPEG.
	const maxW = 1600
	let out = canvas
	if (canvas.width > maxW) {
		const scale = maxW / canvas.width
		const c2 = document.createElement('canvas')
		c2.width = maxW
		c2.height = Math.round(canvas.height * scale)
		c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height)
		out = c2
	}
	return out.toDataURL('image/jpeg', 0.82)
}

// ------------------------------------------------------------------ context

function gatherContext() {
	const cfg = (typeof CAT !== 'undefined' && CAT.config) || {}
	let atem = 'not connected'
	try {
		const dev = state?.A?.device || state?.B?.device
		if (dev) atem = `${dev.model || 'ATEM'}${dev.release ? ' · fw ' + dev.release : ''}`
	} catch {
		/* state not ready */
	}
	const view = document.body.classList.contains('browsing') ? 'Community browser' : 'Main'
	return {
		appVersion: cfg.version || 'unknown',
		platform: (navigator.platform || '') + ' · ' + (navigator.userAgent.match(/(Electron|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] || navigator.userAgent.slice(0, 40)),
		atem,
		view,
	}
}

// ------------------------------------------------------------------ open / close / render

async function openFeedback() {
	if (FB.open) return
	Object.assign(FB, { open: true, kind: 'bug', shot: null, includeShot: true, capturing: true, sending: false, done: null, error: null })
	renderFeedback()
	document.addEventListener('keydown', feedbackKeys)
	setTimeout(() => $('#fb-message')?.focus(), 40)
	// Capture the clean view behind the panel; fill the preview when it lands.
	try {
		FB.shot = await captureView()
	} catch {
		FB.shot = null
	}
	FB.capturing = false
	if (FB.open) renderFeedback()
}

function closeFeedback() {
	FB.open = false
	document.removeEventListener('keydown', feedbackKeys)
	const root = $('#feedback')
	root.textContent = ''
	root.hidden = true
}

function feedbackKeys(e) {
	if (e.key === 'Escape') closeFeedback()
}

function renderFeedback() {
	const root = $('#feedback')
	if (!root) return
	root.hidden = !FB.open
	if (!FB.open) return
	root.textContent = ''

	const back = el('div', 'fbback')
	back.onclick = closeFeedback
	root.append(back)

	const card = el('div', 'fbcard')
	card.setAttribute('role', 'dialog')
	card.setAttribute('aria-modal', 'true')
	card.setAttribute('aria-label', 'Send feedback')

	const head = el('div', 'fbhead')
	head.append(el('b', 'fbtitle', 'Send feedback'))
	const x = el('button', 'fbclose', '×')
	x.title = 'Close (Esc)'
	x.setAttribute('aria-label', 'Close')
	x.onclick = closeFeedback
	head.append(x)
	card.append(head)

	if (FB.done) {
		card.append(feedbackDone())
		root.append(card)
		return
	}

	// Bug / Idea
	const seg = el('div', 'fbseg')
	seg.setAttribute('role', 'group')
	seg.setAttribute('aria-label', 'What kind of feedback')
	for (const [k, label, sub] of [
		['bug', 'Report a bug', 'Something is broken or wrong'],
		['idea', 'Suggest an idea', 'Something you wish it did'],
	]) {
		const b = el('button', `fbkind${FB.kind === k ? ' on' : ''}`)
		b.innerHTML = `<b>${label}</b><span>${sub}</span>`
		b.setAttribute('aria-pressed', FB.kind === k ? 'true' : 'false')
		b.onclick = () => {
			FB.kind = k
			renderFeedback()
		}
		seg.append(b)
	}
	card.append(seg)

	const ta = el('textarea', 'fbmessage')
	ta.id = 'fb-message'
	ta.rows = 5
	ta.placeholder = FB.kind === 'bug' ? 'What happened, and what did you expect? Steps to reproduce help a lot.' : 'What would make this better?'
	ta.setAttribute('aria-label', 'Your feedback')
	card.append(ta)

	// Screenshot
	const shotBox = el('div', 'fbshot')
	if (FB.capturing) {
		shotBox.append(el('div', 'fbshotnote', 'Capturing what you’re looking at…'))
	} else if (FB.shot) {
		const row = el('label', 'fbshotrow')
		const cb = el('input', 'fbshotcb')
		cb.type = 'checkbox'
		cb.checked = FB.includeShot
		cb.onchange = () => {
			FB.includeShot = cb.checked
			img.classList.toggle('off', !cb.checked)
		}
		row.append(cb)
		row.append(el('span', null, 'Include a screenshot of the app'))
		shotBox.append(row)
		const img = el('img', `fbshotimg${FB.includeShot ? '' : ' off'}`)
		img.src = FB.shot
		img.alt = 'Screenshot preview'
		shotBox.append(img)
		shotBox.append(el('div', 'fbshotnote', 'This is exactly what will be attached — it becomes part of a public ticket, so uncheck it if anything on screen is private.'))
	} else {
		shotBox.append(el('div', 'fbshotnote', 'Screenshot could not be captured — your report will still send.'))
	}
	card.append(shotBox)

	const email = el('input', 'fbemail')
	email.id = 'fb-email'
	email.type = 'email'
	email.placeholder = 'Your email (optional) — only so we can follow up'
	email.setAttribute('aria-label', 'Your email, optional')
	card.append(email)

	const note = el('div', 'fbnote')
	if (FB.error) note.innerHTML = `<span class="fberr">${esc(FB.error)}</span>`
	card.append(note)

	const send = el('button', 'primary big', FB.sending ? 'Sending…' : FB.kind === 'bug' ? 'Send bug report' : 'Send idea')
	send.disabled = FB.sending
	send.onclick = submitFeedback
	card.append(send)

	card.append(el('p', 'fbfoot', 'A quick human-check runs when you send. Your report opens a public ticket we can track; an email, if you add one, stays private. Thank you.'))
	root.append(card)
}

function feedbackDone() {
	const box = el('div', 'fbdone')
	box.append(el('div', 'fbcheck', '✓'))
	box.append(el('b', null, 'Thank you — got it.'))
	box.append(el('p', null, FB.done.number ? `Filed as ticket #${FB.done.number}. We read every one.` : 'We read every one.'))
	if (FB.done.url) {
		const a = el('a', 'fbtrack', 'Track it on GitHub →')
		a.href = FB.done.url
		a.target = '_blank'
		a.rel = 'noreferrer'
		box.append(a)
	}
	const done = el('button', 'primary', 'Done')
	done.onclick = closeFeedback
	box.append(done)
	return box
}

// ------------------------------------------------------------------ submit

async function submitFeedback() {
	const message = $('#fb-message')?.value.trim() || ''
	if (!message) {
		$('#fb-message')?.focus()
		return
	}
	const email = $('#fb-email')?.value.trim() || ''
	FB.sending = true
	FB.error = null
	renderFeedback()

	const cfg = await ensureConfig()
	let token
	try {
		token = await getTurnstileToken(cfg.turnstileSiteKey)
	} catch {
		FB.sending = false
		FB.error = 'Could not verify you are human. Please try again.'
		renderFeedback()
		return
	}

	try {
		const body = await api('/api/community/feedback', {
			method: 'POST',
			body: JSON.stringify({
				kind: FB.kind,
				message,
				email: email || null,
				screenshot: FB.includeShot ? FB.shot : null,
				context: gatherContext(),
				turnstileToken: token,
			}),
		})
		FB.done = { url: body.url, number: body.number }
	} catch (e) {
		FB.error = e.message || 'Could not send just now. Please try again.'
	}
	FB.sending = false
	renderFeedback()
}

$('#feedback-open')?.addEventListener('click', openFeedback)
