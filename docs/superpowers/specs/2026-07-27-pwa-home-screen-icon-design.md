# PWA Home Screen Icon

**Date**: 2026-07-27
**Status**: Approved, not yet implemented

## Problem

Outwatch is used mostly from a phone — it already has a phone-optimized layout —
but reaching it means opening a browser and finding the tab or the bookmark. It
has no icon of its own anywhere: no favicon in the tab strip, and nothing to add
to a home screen. Saving it from Safari today produces a screenshot-of-the-page
thumbnail labeled with the page title, and tapping it opens a normal browser tab
with the address bar and toolbar eating vertical space.

Everything needed to fix that is declarative — a web app manifest, a handful of
icon sizes, and a few `<head>` tags. None of it exists yet.

## Solution

Make the site installable: a real icon, a real app name, and a standalone launch
with no browser chrome. Nothing more.

Specifically, **no service worker**. The obvious next step after "installable"
is caching, and it is the wrong step here. Outwatch is a live shared tracker
whose entire value is showing what the other people in the group have done; a
cache that renders a stale board is worse than a spinner. Caching would also
have to be taught to recognize and never store the Cloudflare Access login
redirect, which is a subtle failure mode in exchange for saving one round trip
on launch. Every load continues to hit the network.

## Scope

In scope:

- A web app manifest, so the app installs with a name and icons.
- Icon PNGs at the sizes iOS, Android, and the browser tab each need.
- `<head>` tags wiring those up, including the ones iOS reads instead of the
  manifest.
- A favicon, which the site currently lacks.
- A documented, reproducible way to regenerate the icons from the source image.

Out of scope:

- Service worker, offline support, and any caching.
- Install prompts, `beforeinstallprompt` handling, or in-app "add to home
  screen" nudges.
- Push notifications, share targets, shortcuts, screenshots.
- `viewport-fit=cover` and safe-area handling (see Decisions).

## Known limitation: Access and the standalone cookie jar

An installed PWA on iOS gets its own cookie storage, separate from Safari's. The
first launch from the home screen therefore runs the Cloudflare Access login
flow again, and that flow may bounce out to Safari and back before landing in
the app.

This is inherent to putting an Access-protected origin in a standalone webview.
No manifest setting changes it. It is a one-time cost per install, and it is
documented in the README so it does not read as a bug later.

## Files

All new files live in `public/` and are **committed**. `.gitignore` excludes
only the four build outputs (`public/script.js`, `public/script.js.map`,
`public/styles.css`, `public/styles.css.map`), so tracked assets can sit
alongside them.

| File                    | Size    | Purpose                                                   |
| ----------------------- | ------- | --------------------------------------------------------- |
| `icon-source.png`       | ≥512²   | The original artwork, kept so the rest can be regenerated |
| `icon-512.png`          | 512×512 | Manifest icon, `purpose: "any"`                           |
| `icon-192.png`          | 192×192 | Manifest icon, `purpose: "any"`                           |
| `icon-maskable-512.png` | 512×512 | Manifest icon, `purpose: "maskable"` — art padded to ~80% |
| `apple-touch-icon.png`  | 180×180 | What iOS uses for Add to Home Screen                      |
| `favicon-32.png`        | 32×32   | Browser tab icon                                          |
| `manifest.json`         | —       | The web app manifest                                      |

The source image is supplied by the user and must be square and at least
512×512; 1024×1024 is preferred so every downscale is clean.

### manifest.json

```json
{
    "name": "Outwatch",
    "short_name": "Outwatch",
    "id": "/",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "background_color": "#f5f5f5",
    "theme_color": "#f5f5f5",
    "icons": [
        { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
        { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
        {
            "src": "/icon-maskable-512.png",
            "sizes": "512x512",
            "type": "image/png",
            "purpose": "maskable"
        }
    ]
}
```

`start_url` is `/`, not a hash route: the app's hash routes (`#/season/N`) are a
detail of where you navigate after launch, and launching into a specific season
would be wrong.

Both colors come from the light theme's `--bg` (`#f5f5f5`). A manifest carries a
single `theme_color`, so it cannot follow the light/dark toggle; the `<meta>`
tags below do that instead, and are what iOS and Chrome actually apply to the
status bar in a live document.

### public/index.html

Added to `<head>`:

```html
<link rel="manifest" href="/manifest.json" crossorigin="use-credentials" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="icon" href="/favicon-32.png" sizes="32x32" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="Outwatch" />
<meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#111111" media="(prefers-color-scheme: dark)" />
```

Nothing else in `index.html` changes. The existing inline theme script and the
`viewport` meta stay exactly as they are.

## Decisions

**`crossorigin="use-credentials"` on the manifest link is load-bearing.** A
manifest is fetched without credentials by default. Behind Cloudflare Access an
uncredentialed request is redirected to a login page, so the browser would parse
HTML as JSON, discard the manifest, and silently never offer the install. The
attribute makes the browser send the `CF_Authorization` cookie with the fetch.
Do not drop it.

**`manifest.json`, not `manifest.webmanifest`.** Prettier and the pre-commit
JSON hook both glob `.json`, so the repo's existing tooling formats and
syntax-checks the file for free; a `.webmanifest` extension is invisible to
both. Browsers do not enforce the `application/manifest+json` content type, and
Cloudflare's asset server sends `application/json` for `.json`, which they
accept.

**No `viewport-fit=cover`.** Left at the default, iOS insets a standalone app
clear of the notch and the home indicator on its own. Opting into `cover` means
drawing underneath both and threading `env(safe-area-inset-*)` padding through
`styles.css` — real cost, and no benefit for a table-and-checkboxes layout that
wants no edge-to-edge artwork.

**A separate maskable icon, rather than declaring the plain icon maskable.**
Android crops adaptive icons to a circle, cutting roughly 20% off each edge.
Declaring full-bleed art as maskable would clip it. The maskable variant is the
art shrunk to 80% and padded back out to 512² on the background color, so the
crop only ever removes padding.

**`sips` at author time, not a build step.** The icons are generated once and
committed, so CI never needs an image toolchain and the frontend build is
untouched. `build.js` and `wrangler.toml` do not change.

## Icon generation

Run from the repo root once `public/icon-source.png` is in place. These commands
go in the README so regenerating is documented rather than folklore.

```sh
sips -s format png -Z 512 public/icon-source.png --out public/icon-512.png
sips -s format png -Z 192 public/icon-source.png --out public/icon-192.png
sips -s format png -Z 180 public/icon-source.png --out public/apple-touch-icon.png
sips -s format png -Z 32  public/icon-source.png --out public/favicon-32.png

# maskable: shrink to 80%, then pad back out, so Android's circular crop
# only ever removes padding
sips -s format png -Z 410 public/icon-source.png --out /tmp/icon-410.png
sips --padToHeightWidth 512 512 --padColor F5F5F5 /tmp/icon-410.png --out public/icon-maskable-512.png
```

`sips` ships with macOS. On another platform, any equivalent resizer producing
the same filenames and pixel dimensions is fine.

## Testing

**No automated tests are added, deliberately.** The change is static files plus
declarative `<head>` markup; no JavaScript logic is added or moved, so there is
no behavior to assert. Two concrete obstacles reinforce this:

- Worker tests mock the `ASSETS` binding (`test/worker/index.test.js` stubs it
  with a fixed `Response`), so they cannot exercise asset serving.
- All Vitest suites run in the Workers pool, which has no filesystem, so a test
  cannot check that the manifest's icon paths resolve to real files of the right
  dimensions — the one check that would have caught a real mistake.

What is left — asserting `manifest.json`'s literal contents — restates the file
rather than testing it.

The alternative, considered and rejected: a second Vitest project running in the
Node pool purely to read `public/` off disk and validate the manifest against
it. That is new build machinery for one file that changes approximately never.

### Verification instead

1. `npm run build && npm test && npm run lint && npm run format:check` — all
   pass. (The existing suites must stay green; none should be affected.)
2. `npm run dev`, then in devtools → Application → Manifest: it parses with no
   errors and every icon loads.
3. After deploy, Add to Home Screen on a phone: the icon is the artwork (not a
   page thumbnail), the label reads `Outwatch`, and launching it shows no
   browser chrome.

Step 3 is the only one that verifies the actual feature, and it is manual. That
is the same posture the mobile layout already takes — CLAUDE.md notes it is
verified with an ad-hoc script, not CI.

## Documentation

- **README** — a "Home screen icon" section: what installing gets you, the
  `sips` commands above, and the Access cookie-jar caveat about the first
  launch.
- **CLAUDE.md** — the `public/` entry in the repository-structure list gains the
  manifest and icon files, noting they are committed, unlike `script.js` and
  `styles.css` which are build output.
