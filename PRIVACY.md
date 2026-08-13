# Privacy

**This app runs on your computer, and almost nothing leaves it.** There are no accounts, no logins,
no analytics, no tracking, no advertising, and no cookies. A few optional features talk to the
internet — here is exactly what each one sends, and to whom.

## Stays on your computer

- Your saved presets and library.
- The switchers you connect to, and everything you copy.
- Your settings and recent addresses (in your browser's local storage).

We never see any of it.

## Leaves your computer only when you choose to

- **Browsing, rating, favouriting or installing community presets.** To stop one person voting
  twice, we store a one-way *salted hash* of your IP address — not the address itself, and nothing
  that identifies you. It cannot be reversed back to you.
- **Comments.** The text you write, and a display name if you add one, are **public**. Don't put
  anything private in a comment.
- **Sending feedback.** Your message, your device details (app version, operating system, and the
  ATEM model and firmware if you're connected), and — only if you tick the box — a screenshot of the
  app, are sent to open a ticket on our **public** GitHub issue tracker. The screenshot is opt-in and
  previewed, so you see exactly what is sent. An email, if you give one, is kept **private** (only we
  can see it) so we can reply.
- **Publishing a preset.** This opens a pull request on *your own* GitHub account; it goes wherever
  you send it.
- **Human check.** Community actions run Cloudflare Turnstile, a privacy-preserving check that
  confirms you are not a bot without tracking you.

## Who processes this

- **Cloudflare** — hosts the community catalogue, runs Turnstile, and stores feedback screenshots.
  [Their policy](https://www.cloudflare.com/privacypolicy/).
- **GitHub** — holds community presets and feedback tickets.
  [Their policy](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

## How long things are kept

- Feedback screenshots are deleted automatically after about 45 days.
- Salted-IP hashes are kept so vote counts stay honest.
- Comments and published presets are public and stay until removed.

## Your choices

Don't use the community or feedback features and nothing leaves your machine. Anything you post or
publish is yours to decide on — to have a comment, preset or feedback ticket you sent taken down,
reach us with the in-app **Feedback** button or at [studioupgrade.com](https://studioupgrade.com)
and we'll remove it.

---

Not affiliated with Blackmagic Design. Last updated August 2026.
