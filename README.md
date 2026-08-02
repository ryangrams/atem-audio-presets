# ATEM Audio Presets

Save, load and copy **Fairlight audio settings** — input gain, fader, pan, delay, the full 6-band
EQ, and gate/expander, compressor, limiter and make-up gain — between channels on an ATEM, between
two ATEMs, and as named presets you can group and reuse.

Built for the case the switcher itself makes tedious: you dialled in a mic on one box and now want
that exact chain on three cameras, or on a second switcher, or saved for the next shoot.

## Download

Grab the app for your platform from the
[latest release](https://github.com/ryangrams/atem-audio-presets/releases/latest) — a `.dmg` for
macOS, an installer for Windows. Double-click, and it opens. No terminal, no Node, no browser
tab to remember.

Run it on a machine on the same network as the switcher — your laptop, the studio Mac — and it
will find the ATEMs you point it at.

> **Before the app is signed:** downloads are not yet code-signed, so the first launch needs one
> extra step. On **macOS**, right-click the app and choose *Open*, then *Open* again (double-
> clicking shows "cannot be opened" instead). On **Windows**, SmartScreen shows "Windows
> protected your PC" — choose *More info* → *Run anyway*. Both go away once the app is signed.

### Or run it from source

```bash
git clone https://github.com/ryangrams/atem-audio-presets.git
cd atem-audio-presets
npm install
npm start
```

Then open <http://127.0.0.1:8730>. Node 18 or newer; two runtime dependencies, no build step.

## Why it runs on your machine, not on a web page

The ATEM's control protocol is **UDP port 9910**, and browsers have no UDP API — none, by design.
So a page on its own can never talk to a switcher, whoever hosts it. This project is a small local
Node server that speaks 9910 (via
[`atem-connection`](https://github.com/Sofie-Automation/sofie-atem-connection), the same library
Bitfocus Companion's `bmd-atem` module uses) with a browser UI on top of it.

That also means it can't be hosted on GitHub Pages or anywhere else: static hosting has no process
to run the socket, an `https://` page can't reach a `192.168.x.x` device, and the switcher speaks
no protocol a browser understands. Run it on a machine on the same network as the ATEM — your
laptop, the studio Mac, a Raspberry Pi — and reach the UI from there.

The server binds to `127.0.0.1` only. It has no auth, and neither does an ATEM — keep both on a
trusted LAN. Set `PORT` to move it off 8730.

## Using it

Each column holds either a **switcher** or the **preset library** — the `Switcher | Presets`
toggle in its header. Everything else works the same either way: pick something on the left, pick
somewhere on the right, press the button. The library can only ever be on one side, so copying a
preset onto a preset is not a mistake you can make.

### Copying between channels

1. Enter a switcher's address in the left column and hit **Connect**. Both lists fill with that
   switcher's audio strips. Copying between channels on one switcher is the common job, so it is
   the default; the right column simply follows the same address. Press **Add second switcher**
   to give the right column its own.
2. Click a channel on each side. They do not have to match — mic 1 onto camera 3 is the normal
   case. On the destination side you can pick **several at once**: ⌘-click (ctrl-click on
   Windows) to add or remove one, shift-click to take a range.
3. **Click a block on the source card to include or exclude it.** The three blocks are the strip
   (levels), the equalizer and the dynamics — there are no checkboxes, the block itself is the
   control. Included blocks carry a green edge, excluded ones dim out. Input configuration keeps
   its own checkbox, since it is the setting that renumbers source ids.
4. **The destination card is the preview**: every block being copied shows what it is about to
   receive, tagged `PREVIEW`, with the current curve behind as a dashed ghost and `was …` under
   any number that changes.
5. Press **Copy →**. Each destination is backed up first and re-read afterwards; the status bar
   reports the outcome and **Undo** puts the whole batch back.

### Saving a preset

Flip the **right** column to `Presets`. The left stays a channel; the right becomes a save form —
a name, an optional group, and the channel exactly as it will be stored. The button reads **Save
preset**, or **Overwrite “name”** if you select an existing one first (the old version is kept in
`presets/_backups/`).

A preset always stores the **whole** channel. The blocks you have ticked at save time are
remembered as that preset's *defaults* and come back pre-ticked when you use it — so an "EQ-only
preset" behaves like one without ever being half-empty.

### Loading a preset

Flip the **left** column to `Presets`. Pick one and it becomes the source: its card renders like
any channel, its remembered sections tick themselves, and the right-hand card previews the result
on whichever destination channels you select. The button still reads **Copy →**, because that is
still what is happening — a preset is just another thing to copy from.

In the library list: double-click a name to rename, drag rows to reorder or move them between
groups, `×` to delete (backed up first). New groups are created by typing one into the save
form's group field. **Import file…** in the snapshots drawer adds a downloaded preset to the
library; whole-switcher snapshots stay in that drawer, since they are a different animal.

### The card

Both cards are a compact version of the switcher's own Fairlight view: the strip with its gain
knob, fader and pan dial, the **EQ response curve** with numbered band handles, and the
**dynamics transfer curve** with threshold markers. The switcher stores filter parameters rather
than curves, so the EQ response is computed here (standard RBJ biquads at 48 kHz, including the
EQ output gain, which is what ATEM Software Control draws too) — a faithful picture of the
settings, not a measurement of the audio. The dynamics curve applies the units in the switcher's
order — expander/gate, compressor, limiter, then make-up gain as the output stage — which is why
a −15.5 dB limiter with +10.77 dB of make-up puts the ceiling at −4.7 dB.

## What copies

| Section | Fields |
|---|---|
| Levels | input gain, fader, pan, frames of delay, stereo simulation |
| EQ | EQ enable, EQ gain, and all six bands: enable, shape, frequency range, frequency, gain, Q |
| Dynamics | make-up gain, expander/gate, compressor, limiter — every parameter of each |
| Input config | mono/stereo/dual-mono and mic/consumer/pro line. **Off by default** — see below |

**A channel's on / off / AFV state is never copied.** It is a live operating control, not part of
how a channel sounds — pasting a preset must not mute a channel or put one on air. The card shows
it, greyed, outside the levels block.

Anything the destination cannot take is skipped and reported rather than sent blindly: a mix option
it doesn't support, a delay past its maximum, an EQ shape that band doesn't offer.

## Things worth knowing

- **Input config changes source ids.** An input's audio configuration determines the ids of the
  strips underneath it, so switching an input from stereo to dual-mono makes the strip you were
  looking at cease to exist under its old id. That's why the section is off by default, and why the
  channel pickers are always bound to live enumerated strips instead of typed-in ids. If you do
  change it, re-connect before copying again.
- **A rejected value is silent.** The switcher does not error on a value it won't take; the setting
  simply doesn't move. That's why every copy is verified by reading the strip back and diffing it —
  if something didn't take, the result panel says so. The usual cause is range: a mic strip's
  +40 dB input gain onto a camera input that stops at +6 dB comes back clamped, and gets reported
  rather than passing silently.
- **Firmware build, not version.** Both panels show the build hash from the admin API next to the
  version, because "10.3" ships as more than one build. Presets record it too.
- **Connection budget.** An ATEM allows only a handful of simultaneous control connections. This
  tool holds one per switcher and reuses it; if ATEM Software Control and Companion are both
  already on a box, close one before wondering why a connect times out.
- Values in preset files are the switcher's own raw integers (dB and Q ×100, frequency in Hz,
  attack/hold/release in ms ×100). They are never rescaled — a preset round-trips byte-for-byte.
  The browser converts only for display.

## API

The browser page is a client of a plain HTTP API; anything here is scriptable from `curl`.

| Endpoint | Does |
|---|---|
| `GET /api/switcher?ip=` | connect and list every audio strip |
| `GET /api/channel?ip=&input=&source=` | one strip's full settings |
| `POST /api/preview` | `{from\|payload, to, sections}` → the diff that a copy would make |
| `POST /api/apply` | same body; backs up, copies, verifies by read-back |
| `POST /api/undo` | `{ip}` → restore that switcher's last pre-copy batch |
| `GET/POST/DELETE /api/presets` | the preset library; `POST` takes `{name, group, defaultSections, overwrite?}` |
| `PATCH /api/presets/:file` | rename, regroup or reorder without touching what it stores |
| `GET /api/snapshot?ip=` | every strip on a switcher, as one file |
| `POST /api/restore` | `{ip, snapshot, sections}` → push a snapshot back |

`to` is one destination or an array of them (all on the same switcher). Either way the response
carries a `results` array with one entry per destination — what was sent, what was skipped, and
what the read-back still shows as different.

```bash
# copy mic 1 on one switcher onto mic 2 on another, EQ and dynamics only
curl -s -X POST http://127.0.0.1:8730/api/apply -H 'Content-Type: application/json' -d '{
  "from": {"ip": "192.168.43.20", "input": 1001, "source": "-256"},
  "to":   {"ip": "192.168.8.20",  "input": 1002, "source": "-256"},
  "sections": {"eq": true, "dynamics": true}
}'
```

## Building the apps

```bash
npm run app          # run the desktop shell against your working tree
npm run dist:mac     # .dmg (arm64 + x64)
npm run dist:win     # Windows installer
npm run icon         # regenerate build/icon.png
```

Pushing a `v*` tag builds both on GitHub Actions and attaches them to a release, so neither build
needs you to own that platform.

Presets live beside the app when run from source (`./presets`), and in the per-user application
data folder when run as the packaged app — *Help → Show presets folder* opens it.

## Support

ATEM Audio Presets is free and open source. If it saves you time in the studio, you can
[**support its development on GitHub Sponsors ☕**](https://github.com/sponsors/ryangrams).
Bug reports, ideas and shares help just as much.

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with, endorsed by, or supported by Blackmagic Design. "ATEM" and "Fairlight" are
their trademarks, used here only to say what this talks to.
