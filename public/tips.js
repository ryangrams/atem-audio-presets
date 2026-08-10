'use strict'

// Tips: a lightbox-style coach-mark system.
//
// The old approach inserted a dismissible sentence into the layout above whatever it was
// explaining — which meant it pushed the card down every time it appeared, and moved everything
// back up when it closed. This replaces that: a tip floats in its own fixed-position layer,
// spotlighting the real element (a soft scrim everywhere else, a highlight ring on the target)
// and pointing an arrow at it from a callout bubble. Nothing in the page's own layout ever moves.
//
// Self-contained on purpose — no dependency on app.js's helpers — so it loads first and anything
// later (app.js, browse.js, or a future onboarding sequence) can call it.
//
// API:
//   Tips.show({ key, target, text, title, placement }) — target is a CSS selector, re-queried
//     live, so it survives the app's habit of rebuilding a panel's innerHTML on every render.
//     Calling show() again with the same key just repositions/updates it — safe to call on every
//     render. A key is shown at most once ever (localStorage), then show() is a no-op.
//   Tips.hide() — dismiss whatever is showing, without marking it seen.
//   Tips.dismiss(key) — mark a key seen without needing an active tip (e.g. "don't show again").
//   Tips.reset(key?) — clear one key's or every key's seen state. Console/debug use.
//   Tips.sequence(name, steps) — chains several {key, target, text, title, placement} tips with
//     Next/Back and a step counter, remembered as one seen-flag for the whole sequence. Nothing
//     calls this yet — it exists so a first-run tour can be authored later without new plumbing.

const Tips = (() => {
	const PREFIX = 'atem-audio-presets.tip.'
	const seen = (key) => localStorage.getItem(PREFIX + key) === '1'
	const markSeen = (key) => localStorage.setItem(PREFIX + key, '1')

	let dom = null
	let cur = null // { key, target, text, title, placement, seqCtl }
	let raf = null
	let placeRetry = 0 // bounded retries for scroll-into-view / first-paint 0×0 geometry

	function build() {
		if (dom) return dom
		const layer = document.createElement('div')
		layer.className = 'tiplayer'
		const spot = document.createElement('div')
		spot.className = 'tip-spotlight'
		const callout = document.createElement('div')
		callout.className = 'tip-callout'
		callout.setAttribute('role', 'note')
		const arrow = document.createElement('div')
		arrow.className = 'tip-arrow'
		arrow.innerHTML = '<span class="edge"></span><span class="fill"></span>'
		callout.appendChild(arrow)
		const body = document.createElement('div')
		body.className = 'tip-body'
		callout.appendChild(body)
		layer.append(spot, callout)
		document.body.appendChild(layer)
		dom = { layer, spot, callout, arrow, body }
		window.addEventListener('resize', schedule)
		window.addEventListener('scroll', schedule, true)
		// The layer writes to its own style/class every place() pass. Ignore mutations that are all
		// inside it — reacting to them would re-schedule place() forever, a rAF loop of forced reflows.
		new MutationObserver((records) => {
			if (dom && records.every((r) => dom.layer.contains(r.target))) return
			schedule()
		}).observe(document.body, { childList: true, subtree: true, attributes: true })
		return dom
	}

	function schedule() {
		if (!cur || raf) return
		raf = requestAnimationFrame(() => {
			raf = null
			place()
		})
	}

	function visible(elm) {
		if (!elm || !elm.isConnected) return false
		const r = elm.getBoundingClientRect()
		if (r.width <= 0 && r.height <= 0) return false
		return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth
	}

	/** Centre the callout with no spotlight — for a sequence step whose target cannot be shown, so
	 *  Next/Back/Skip stay reachable rather than the whole tour vanishing. */
	function placeCentered() {
		const { spot, callout, arrow, layer } = build()
		spot.style.width = '0px'
		spot.style.height = '0px'
		callout.style.left = '-9999px'
		callout.style.top = '0px'
		layer.classList.add('on')
		const cw = callout.offsetWidth
		const ch = callout.offsetHeight
		callout.style.left = `${Math.max(14, (window.innerWidth - cw) / 2)}px`
		callout.style.top = `${Math.max(14, (window.innerHeight - ch) / 2)}px`
		arrow.className = 'tip-arrow' // nothing to point at
	}

	function place() {
		if (!cur) return
		const { spot, callout, arrow, layer } = build()
		const targetEl = document.querySelector(cur.target)

		// First paint (and the embedded browser pane) can report the viewport as 0×0. Treat that as
		// "not yet" and try again next frame rather than mis-placing — bounded, so it cannot spin.
		if ((window.innerWidth <= 0 || window.innerHeight <= 0) && placeRetry < 10) {
			placeRetry++
			schedule()
			return
		}

		// Connected but scrolled out of view (the columns stack and scroll on narrow windows). Bring
		// it into view and re-measure instead of hiding the whole tour — the callout carries Next/Skip.
		if (targetEl?.isConnected && !visible(targetEl) && placeRetry < 10) {
			placeRetry++
			targetEl.scrollIntoView({ block: 'center', inline: 'nearest' })
			schedule()
			return
		}

		if (!visible(targetEl)) {
			placeRetry = 0
			// A lone tip with no usable target just means "not now" — hide it. But a sequence step must
			// never strand the user: keep its callout and navigation on screen, centred, spotlight-less.
			if (cur.seqCtl) return placeCentered()
			layer.classList.remove('on')
			return
		}
		placeRetry = 0
		const pad = 6
		const r = targetEl.getBoundingClientRect()
		const radius = Math.min(12, Math.max(4, parseFloat(getComputedStyle(targetEl).borderRadius) || 6) + pad)
		spot.style.left = `${r.left - pad}px`
		spot.style.top = `${r.top - pad}px`
		spot.style.width = `${r.width + pad * 2}px`
		spot.style.height = `${r.height + pad * 2}px`
		spot.style.borderRadius = `${radius}px`

		// Measure the callout off-screen first — its size depends on the text just set.
		callout.style.left = '-9999px'
		callout.style.top = '0px'
		layer.classList.add('on')
		const cw = callout.offsetWidth
		const ch = callout.offsetHeight
		const margin = 14
		const vw = window.innerWidth
		const vh = window.innerHeight

		const space = {
			bottom: vh - r.bottom,
			top: r.top,
			right: vw - r.right,
			left: r.left,
		}
		let placement = cur.placement && cur.placement !== 'auto' ? cur.placement : null
		if (!placement) {
			placement = Object.entries(space).sort((a, b) => b[1] - a[1])[0][0]
			if ((placement === 'bottom' && space.bottom < ch + margin) || (placement === 'top' && space.top < ch + margin)) {
				placement = space.right >= space.left ? 'right' : 'left'
			}
		}

		let left, top, arrowSide, arrowPos
		if (placement === 'bottom' || placement === 'top') {
			left = r.left + r.width / 2 - cw / 2
			left = Math.max(margin, Math.min(vw - cw - margin, left))
			top = placement === 'bottom' ? r.bottom + margin : r.top - ch - margin
			top = Math.max(margin, Math.min(vh - ch - margin, top))
			arrowSide = placement === 'bottom' ? 'up' : 'down'
			arrowPos = { axis: 'left', v: Math.max(14, Math.min(cw - 14, r.left + r.width / 2 - left)) }
		} else {
			top = r.top + r.height / 2 - ch / 2
			top = Math.max(margin, Math.min(vh - ch - margin, top))
			left = placement === 'right' ? r.right + margin : r.left - cw - margin
			left = Math.max(margin, Math.min(vw - cw - margin, left))
			arrowSide = placement === 'right' ? 'left' : 'right'
			arrowPos = { axis: 'top', v: Math.max(14, Math.min(ch - 14, r.top + r.height / 2 - top)) }
		}
		callout.style.left = `${left}px`
		callout.style.top = `${top}px`
		arrow.className = `tip-arrow point-${arrowSide}`
		arrow.style.left = arrowPos.axis === 'left' ? `${arrowPos.v}px` : ''
		arrow.style.top = arrowPos.axis === 'top' ? `${arrowPos.v}px` : ''
	}

	function renderBody(step) {
		const { body } = build()
		body.textContent = ''
		if (step.title) {
			const t = document.createElement('b')
			t.className = 'tip-title'
			t.textContent = step.title
			body.appendChild(t)
		}
		const p = document.createElement('p')
		p.className = 'tip-text'
		p.textContent = step.text
		body.appendChild(p)
		const actions = document.createElement('div')
		actions.className = 'tip-actions'
		if (step.seqCtl) {
			const { index, total, onBack, onNext, onSkip } = step.seqCtl
			const dots = document.createElement('span')
			dots.className = 'tip-step'
			dots.textContent = `${index + 1} of ${total}`
			actions.appendChild(dots)
			const btns = document.createElement('span')
			btns.className = 'tip-btns'
			const skip = document.createElement('button')
			skip.className = 'tip-skip'
			skip.textContent = 'Skip'
			skip.onclick = onSkip
			btns.appendChild(skip)
			if (index > 0) {
				const back = document.createElement('button')
				back.textContent = 'Back'
				back.onclick = onBack
				btns.appendChild(back)
			}
			const next = document.createElement('button')
			next.className = 'primary'
			next.textContent = index === total - 1 ? 'Done' : 'Next'
			next.onclick = onNext
			btns.appendChild(next)
			actions.appendChild(btns)
		} else {
			const ok = document.createElement('button')
			ok.className = 'tip-got-it'
			ok.textContent = 'Got it'
			ok.onclick = () => {
				markSeen(step.key)
				step.onDismiss?.()
				hide()
			}
			actions.appendChild(ok)
		}
		body.appendChild(actions)
	}

	function show(opts) {
		if (!opts?.key || !opts?.target) return
		// A running sequence step owns the layer. A stray non-sequence tip (a coach-mark fired by a
		// re-render) must not replace it — that would orphan the tour's Next/Back/Done and strand the
		// user. Sequence steps replace each other freely; only outside tips are refused.
		if (cur?.seqCtl && !opts.seqCtl) return
		if (!opts.seqCtl && seen(opts.key)) return
		const same = cur && cur.key === opts.key
		cur = opts
		placeRetry = 0
		renderBody(opts)
		if (!same) {
			build().callout.style.opacity = '0'
			requestAnimationFrame(() => {
				place()
				build().callout.style.opacity = ''
			})
		} else {
			place()
		}
	}

	function hide() {
		cur = null
		placeRetry = 0
		if (dom) dom.layer.classList.remove('on')
	}

	function dismiss(key) {
		markSeen(key)
		if (cur?.key === key) hide()
	}

	function reset(key) {
		if (key) localStorage.removeItem(PREFIX + key)
		else {
			for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k)
		}
	}

	/**
	 * Chain several tips into a guided sequence. Steps may carry a `before()` hook to put the app
	 * into the state the step describes. The whole sequence shares one seen-flag, keyed by `name`;
	 * pass `{ force: true }` to replay it on demand.
	 */
	function sequence(name, steps, opts = {}) {
		const seqKey = `seq.${name}`
		if ((seen(seqKey) && !opts.force) || !steps?.length) return
		let i = 0
		const done = () => {
			markSeen(seqKey)
			hide()
			opts.onDone?.()
		}
		const showStep = async () => {
			const step = steps[i]
			// A step may need the app in a particular state before it can point at anything — filling
			// the address box, opening a column, selecting a channel. It runs before the tip appears.
			if (step.before) {
				try {
					await step.before()
				} catch {
					/* a step that cannot set itself up still gets to explain itself */
				}
			}
			show({
				...step,
				seqCtl: {
					index: i,
					total: steps.length,
					onBack: () => {
						i = Math.max(0, i - 1)
						showStep()
					},
					onNext: () => {
						if (i === steps.length - 1) return done()
						i++
						showStep()
					},
					onSkip: done,
				},
			})
		}
		showStep()
	}

	return { show, hide, dismiss, reset, sequence, isSeen: seen }
})()

window.Tips = Tips
