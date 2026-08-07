# Design pass brief — ATEM Audio Presets

Paste this whole file as your first message. Everything you need is here.

**Decide, don't ask.** Make the judgment calls yourself and state what you chose and why in your
final summary. Only stop and ask if something would be destructive or genuinely irreversible.
Do not open with clarifying questions.

---

## What this is

A desktop app for copying audio settings between channels on a Blackmagic ATEM video switcher.
Live and shipping.

- App: `~/SUDev/atem-audio-presets` — https://github.com/ryangrams/atem-audio-presets
- Library site: `~/SUDev/atem-preset-library` — https://presets.studioupgrade.com
- From **Studio Upgrade** (studioupgrade.com), which builds tools for small video studios.

**Who uses it:** camera operators, podcasters, worship-tech volunteers, one-person studios. They
know audio (gain, EQ, compression) but are *not* technical. Many have never used a terminal. They
are often setting up under time pressure before a shoot, sometimes on a laptop balanced on a road
case. Assume interruption, low light, and no patience for reading.

**The job it does:** you dial in a good mic chain on one channel, and you want it on three other
channels, or on the switcher in the other room, or saved for next month. Doing that by hand in
Blackmagic's own software means copying ~40 numbers across a dozen panels, per channel.

## Your job

One round of design improvements to make this feel genuinely great. Focus on the experience:
first-run, empty states, error states, feedback during actions, discoverability, visual polish,
accessibility. Ship real changes to the code, not a document of recommendations.

**Do not reinvent what already works.** Much of the current design is deliberate and hard-won.
Read "Deliberate decisions" below before changing anything visual.

## Run it

```bash
cd ~/SUDev/atem-audio-presets
npm start          # then open http://127.0.0.1:8730
npm run app        # or the desktop shell (Electron)
```

Files — 4,000 lines total, plain JS, no framework, no build step:

| File | Lines | What |
|---|---|---|
| `public/app.js` | 1086 | state, columns, selection, copy flow, preset library |
| `public/strip.js` | 462 | the channel card: knobs, fader, EQ curve, dynamics curve |
| `public/style.css` | 1142 | all styling |
| `public/index.html` | 100 | page skeleton |
| `server.js` | 568 | HTTP API |
| `lib/fairlight.js` | 388 | read/write/diff a channel |

**No switcher on the network?** Almost certainly true — the hardware lives at a studio. Drive the
UI with synthesized state instead, which exercises every visual path:

```js
// In the browser console. state.A is the source column, state.B the destination.
state.A.detail = { meta: {...}, levels: {...}, eq: {...}, dynamics: {...} }
renderDetail('A')
```

Look at `lib/fairlight.js` → `extractChannel()` for the exact shape, and
`presets/Starter-Pod-Mic-Settings.json` for a real captured channel to copy from. The app also
runs fine with no switcher at all — that *is* the first-run experience, and it needs work.

## How it works, in one pass

Two columns. **Source** on the left, **Destination** on the right. Each column holds either a
switcher (a list of its audio channels) or the preset library — chosen by a `Switcher | Presets`
toggle in the column header. Only one column can hold the library, so you can never copy a preset
onto a preset.

Selecting a channel renders a **card**: a strip (gain knob, volume fader, pan dial), an EQ
response curve, and a dynamics transfer curve. The card is divided into **blocks** — Gain, Volume,
Pan, EQ, Dynamics, Input. Clicking a block on the source card includes or excludes it from the
copy. Included blocks get a green outline **on both cards**, and the destination card previews the
result: incoming values drawn live with the channel's current values ghosted behind, plus
`was …` annotations.

Then the big green **Copy** button. Every destination is backed up first; **Undo** restores the
whole batch.

## Deliberate decisions — do not undo these

Each of these was arrived at by testing against the real hardware and the real app. Changing them
would be a regression.

1. **The card mimics ATEM Software Control's Fairlight panels** — same cyan EQ curve, same
   yellow-green dynamics curve, cyan/blue threshold markers, neutral grey panels. Users are
   switching between the two apps. Familiarity beats originality here.
2. **Both columns read the same way left-to-right** (list → strip → graphs). They were briefly
   mirrored and it was actively disliked.
3. **The whole block is the checkbox.** Clicking anywhere in a block toggles it. There are no
   checkbox widgets on the card, and no "preview" labels — the green outline says it.
4. **The green outline means "this will be replaced."** Green is used for nothing else.
5. **A channel's on/off state is never copied and never displayed.** It is a live operating
   control; pasting it could mute someone mid-show. This is enforced in the server and the
   library validator. Don't reintroduce it anywhere.
6. **The curves are computed, not decorative.** EQ is real RBJ biquads at 48 kHz including the EQ
   output gain; dynamics applies expander → compressor → limiter → make-up in the switcher's
   actual order. They match ASC's own drawing to within a dB. Restyle freely; don't touch the
   maths in `strip.js`.
7. **Every write is verified by reading back.** The switcher silently ignores values it won't
   take, so "did it work" is measured, not assumed. Keep that visible in whatever you design.

## Known rough edges — good places to start

Not exhaustive, and not a checklist. Use your own judgment about what matters most.

- **First run is bleak.** Two empty columns and "Connect a switcher to begin." No hint of what
  the app does, what to type in the address box, or how to find a switcher's address.
- **Failure to connect** is the single most common thing that will happen to a new user — wrong
  address, switcher off, wrong network, or ATEM Software Control already holding the connection.
  Right now it's a red dot and a raw error string.
- **Discoverability.** Multi-select on the destination (⌘/shift-click), the section blocks being
  clickable, and the `Switcher | Presets` toggle are all learnable-but-invisible. One user missed
  a collapsed list toggle entirely.
- **A copy takes a few seconds** (write, settle, read back) with no progress feedback.
- **The result of a copy** lands in a small status bar and a collapsed drawer. It's the moment
  the user most wants reassurance, and it's the quietest thing on screen.
- **Empty preset library** — no guidance on how to get anything into it.
- **Accessibility** — contrast, focus states, keyboard operation have had no attention.
- **The library site** (`~/SUDev/atem-preset-library/site/index.html`) is functional and plain.
  It's the public face; it has no favicon and no real identity.

## Constraints

- **Plain JS, no framework, no build step.** Adding React/Tailwind/a bundler is out of scope.
- Vanilla CSS in `public/style.css`. The colour variables at the top are the palette.
- The app must keep working **in a normal browser** as well as in Electron.
- No new runtime dependencies without a clear reason.
- Keep the code style: tabs, no semicolons, comments that explain *why* not *what*.
- Don't touch `server.js` or `lib/` except where the UI genuinely needs it.
- Assets must be local — the desktop app has no internet guarantee. No CDN fonts.

## Definition of done

- Changes are committed with clear messages (no AI attribution in commits — house rule).
- You've actually looked at every state you changed, in a browser. Screenshots to verify.
- The existing flows still work: connect, select, toggle sections, copy, undo, save/load presets,
  export/import packs.
- A short summary of what you changed and why, and anything you deliberately left alone.

An honest "I improved these six things and left the rest, here's why" is worth far more than a
sweeping restyle that breaks the ATEM familiarity or the verification story.
