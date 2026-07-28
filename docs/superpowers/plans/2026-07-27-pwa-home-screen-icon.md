# PWA Home Screen Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Outwatch installable to a phone home screen with its own icon and name, launching standalone with no browser chrome.

**Architecture:** Entirely static and declarative — a web app manifest, five icon PNGs generated once from a committed source image, and a handful of `<head>` tags. No JavaScript is added or changed, no service worker, no build-step change. `build.js` and `wrangler.toml` are untouched.

**Tech Stack:** Cloudflare Workers static assets (`[assets]` → `public/`), macOS `sips` for one-time image resizing.

**Spec:** `docs/superpowers/specs/2026-07-27-pwa-home-screen-icon-design.md`

## Global Constraints

- Work on the existing branch `pwa-home-screen-icon`. Do not commit to `main`.
- Before every commit run `npm run build`, `npm test`, `npm run lint`, and `npm run format:check` and confirm all four pass.
- Never use `--no-verify`. If a hook modifies files, restage and run a fresh `git commit` — never amend.
- **No service worker, no caching, no offline support.** Explicitly out of scope; do not add one opportunistically.
- **No automated tests are added.** The spec's Testing section explains why: worker tests mock the `ASSETS` binding, and all Vitest suites run in the Workers pool with no filesystem, so the one worthwhile assertion (manifest icon paths resolve to real files of the right size) is not expressible there. Verification is by shell command and by eye, and every task below spells out the exact commands and expected output. Do not add a second Vitest project to work around this.
- Edit frontend sources under `frontend/`. Never edit `public/script.js` or `public/styles.css`; they are build output.
- `public/icon-source.png` already exists (1254×1254 PNG, black background). Do not regenerate, overwrite, or resize it.
- The maskable pad color is `000000` and `background_color` is `#111111` — both match the artwork's black field. This is a deliberate deviation from the spec's `F5F5F5`/`#f5f5f5`, agreed after seeing the artwork. `theme_color` stays `#f5f5f5`.

---

### Task 1: Generate the icon PNGs

Produces every raster size the manifest and the `<head>` tags will reference. Nothing consumes them yet, so this task stands alone and is reviewable purely on whether the images are correct.

**Files:**

- Create: `public/icon-512.png`, `public/icon-192.png`, `public/apple-touch-icon.png`, `public/favicon-32.png`, `public/icon-maskable-512.png`
- Modify: nothing
- Test: none (see Global Constraints); verification is Steps 5 and 6

**Interfaces:**

- Consumes: `public/icon-source.png`, a 1254×1254 PNG that already exists in the working tree.
- Produces: five PNGs at exactly these paths and pixel dimensions. Task 2's `manifest.json` and `index.html` reference these paths verbatim, so do not rename them.

| Path                           | Dimensions |
| ------------------------------ | ---------- |
| `public/icon-512.png`          | 512×512    |
| `public/icon-192.png`          | 192×192    |
| `public/apple-touch-icon.png`  | 180×180    |
| `public/favicon-32.png`        | 32×32      |
| `public/icon-maskable-512.png` | 512×512    |

- [ ] **Step 1: Confirm the source image is present and square**

Run:

```bash
sips -g pixelWidth -g pixelHeight -g format public/icon-source.png
```

Expected: `pixelWidth: 1254`, `pixelHeight: 1254`, `format: png`.

If this errors with "not a valid file", stop — the source image is missing and nothing below will work. Do not substitute a placeholder image.

- [ ] **Step 2: Confirm the outputs do not exist yet**

Run:

```bash
ls public/icon-512.png public/icon-192.png public/apple-touch-icon.png public/favicon-32.png public/icon-maskable-512.png
```

Expected: `No such file or directory` for all five. This is the "test fails first" state.

- [ ] **Step 3: Generate the four plain sizes**

`-Z` resamples so the longest side hits the given size, preserving aspect ratio. The source is square, so each output is square at exactly that size.

```bash
sips -s format png -Z 512 public/icon-source.png --out public/icon-512.png
sips -s format png -Z 192 public/icon-source.png --out public/icon-192.png
sips -s format png -Z 180 public/icon-source.png --out public/apple-touch-icon.png
sips -s format png -Z 32  public/icon-source.png --out public/favicon-32.png
```

- [ ] **Step 4: Generate the maskable variant**

Android crops adaptive icons to a circle, removing roughly 20% from each edge. Shrinking the art to 80% and padding back out to 512² means the crop only ever eats padding. The pad color is black to match the artwork's own background — a light pad would ring the icon in a bright square.

```bash
sips -s format png -Z 410 public/icon-source.png --out /tmp/icon-410.png
sips --padToHeightWidth 512 512 --padColor 000000 /tmp/icon-410.png --out public/icon-maskable-512.png
```

- [ ] **Step 5: Verify every output's dimensions**

Run:

```bash
for f in icon-512 icon-192 apple-touch-icon favicon-32 icon-maskable-512; do
  echo -n "$f: "
  sips -g pixelWidth -g pixelHeight "public/$f.png" | tr '\n' ' '
  echo
done
```

Expected, exactly:

- `icon-512`: pixelWidth 512, pixelHeight 512
- `icon-192`: pixelWidth 192, pixelHeight 192
- `apple-touch-icon`: pixelWidth 180, pixelHeight 180
- `favicon-32`: pixelWidth 32, pixelHeight 32
- `icon-maskable-512`: pixelWidth 512, pixelHeight 512

If `icon-maskable-512` comes back 410×410, the pad step silently failed — re-run Step 4 rather than shipping an undersized icon.

- [ ] **Step 6: Look at the maskable icon**

Open `public/icon-maskable-512.png` and confirm the medallion is centered with visible black margin on all four sides, and that the pad blends into the artwork's own background rather than showing as a distinct band. This is the one check no command can make.

- [ ] **Step 7: Commit**

```bash
git add public/icon-source.png public/icon-512.png public/icon-192.png public/apple-touch-icon.png public/favicon-32.png public/icon-maskable-512.png
git commit -m "feat: add app icon assets generated from the source artwork"
```

Note `icon-source.png` is staged here too — it is untracked until this commit.

---

### Task 2: Manifest and head tags

Turns the assets from Task 1 into an actual install. This is the task that makes the feature work.

**Files:**

- Create: `public/manifest.json`
- Modify: `public/index.html`
- Test: none (see Global Constraints); verification is Steps 3, 5, and 6

**Interfaces:**

- Consumes: the five PNG paths produced by Task 1, referenced verbatim.
- Produces: `/manifest.json`, served from `public/` by the `[assets]` binding via the Worker's catch-all (`src/index.js:640`). Task 3 documents it; nothing else consumes it.

- [ ] **Step 1: Confirm the current state**

Run:

```bash
grep -c "manifest\|apple-touch-icon\|theme-color" public/index.html
```

Expected: `0`. The page currently declares none of this.

- [ ] **Step 2: Create the manifest**

Create `public/manifest.json` with exactly this content:

```json
{
    "name": "Outwatch",
    "short_name": "Outwatch",
    "id": "/",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "background_color": "#111111",
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

Three things here are deliberate and should not be "tidied":

- `start_url` is `/`, not a hash route. The app's `#/season/N` routes describe where you navigate after launch; launching into one specific season would be wrong.
- `background_color` (`#111111`) is the splash field the icon sits on while the app loads, so it matches the artwork's black. `theme_color` (`#f5f5f5`) is UI chrome, so it matches the app's light default. They differ on purpose.
- The file is `.json`, not `.webmanifest`, so Prettier and the pre-commit JSON hook both pick it up. Browsers do not enforce the `application/manifest+json` content type.

- [ ] **Step 3: Verify the manifest parses and its icons exist**

Run:

```bash
node -e '
const m = JSON.parse(require("fs").readFileSync("public/manifest.json", "utf8"));
for (const i of m.icons) {
  const p = "public" + i.src;
  console.log(i.src, require("fs").existsSync(p) ? "OK" : "MISSING");
}
'
```

Expected: three lines, each ending `OK`. A `MISSING` means Task 1 did not run or a filename was typo'd.

- [ ] **Step 4: Add the head tags**

Modify `public/index.html`. Insert these eight lines after the existing `<link rel="stylesheet" href="styles.css" />` line, so the whole `<head>` reads:

```html
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Outwatch</title>
    <script>
        const t = localStorage.getItem('theme');
        if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    </script>
    <link rel="stylesheet" href="styles.css" />
    <link rel="manifest" href="/manifest.json" crossorigin="use-credentials" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="icon" href="/favicon-32.png" sizes="32x32" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="Outwatch" />
    <meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#111111" media="(prefers-color-scheme: dark)" />
</head>
```

Do not touch the inline theme script or the `viewport` meta. In particular do **not** add `viewport-fit=cover`: left at its default, iOS insets a standalone app clear of the notch and home indicator on its own, and opting into `cover` would require threading `env(safe-area-inset-*)` padding through `styles.css` for no benefit.

`crossorigin="use-credentials"` is load-bearing. A manifest is fetched without credentials by default; behind Cloudflare Access an uncredentialed request is redirected to a login page, so the browser would try to parse HTML as JSON, discard the manifest, and silently never offer the install. Do not drop the attribute.

- [ ] **Step 5: Run the full check suite**

```bash
npm run build && npm test && npm run lint && npm run format:check
```

Expected: all four pass. None of the existing suites touch these files, so any failure is unrelated to this change and should be investigated before continuing.

- [ ] **Step 6: Verify in a browser**

```bash
npm run dev
```

Open the dev server, then devtools → Application → Manifest. Expected: it parses with no errors or warnings, `Outwatch` shows as both name and short name, and all three icons render in the icon list rather than showing broken-image placeholders.

- [ ] **Step 7: Commit**

```bash
git add public/manifest.json public/index.html
git commit -m "feat: make the site installable to a home screen"
```

---

### Task 3: Documentation

Records what installing gets you, how to regenerate the icons, and the Access caveat that would otherwise read as a bug later.

**Files:**

- Modify: `README.md`, `CLAUDE.md`
- Test: none; verification is Step 4

**Interfaces:**

- Consumes: the filenames from Task 1 and the manifest from Task 2.
- Produces: nothing other tasks depend on. This is the last task.

- [ ] **Step 1: Add a README feature bullet**

In `README.md`, in the `## Features` list, add this bullet immediately after the `Light/dark theme toggle` line:

```markdown
- Installs to a phone home screen as a standalone app, with its own icon
```

- [ ] **Step 2: Add the README section**

In `README.md`, add a new top-level section immediately before `## Stack`:

````markdown
## Home Screen Icon

The site is installable: add it to a phone's home screen and it launches
standalone, with its own icon and no browser chrome. There is deliberately no
service worker — every load still hits the network, because a cached, stale
board is worse than a spinner for a tracker whose whole point is showing what
everyone else has done.

One caveat, inherent to Cloudflare Access rather than to the manifest: an
installed app on iOS gets its own cookie storage, separate from Safari's. The
first launch from the home screen therefore runs the Access login flow again,
and may bounce out to Safari and back before landing in the app. It is a
one-time cost per install.

### Regenerating the icons

`public/icon-source.png` is the original artwork; every other icon is derived
from it with macOS's built-in `sips` and committed. Regenerate only if the
artwork changes:

```bash
sips -s format png -Z 512 public/icon-source.png --out public/icon-512.png
sips -s format png -Z 192 public/icon-source.png --out public/icon-192.png
sips -s format png -Z 180 public/icon-source.png --out public/apple-touch-icon.png
sips -s format png -Z 32  public/icon-source.png --out public/favicon-32.png

# maskable: shrink to 80%, then pad back out, so Android's circular crop only
# ever removes padding. The pad matches the artwork's black background.
sips -s format png -Z 410 public/icon-source.png --out /tmp/icon-410.png
sips --padToHeightWidth 512 512 --padColor 000000 /tmp/icon-410.png --out public/icon-maskable-512.png
```

There is no build step for this — the icons are committed, so CI never needs an
image toolchain.
````

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md`, replace the `public/` block in the Repository Structure list:

```markdown
- `public/` — Served static assets
    - `index.html` — App shell that loads the bundled script
    - `script.js`, `script.js.map`, `styles.css`, `styles.css.map` — build output (gitignored)
```

with:

```markdown
- `public/` — Served static assets
    - `index.html` — App shell that loads the bundled script
    - `manifest.json` — Web app manifest; makes the site installable to a home screen
    - `icon-source.png` — Original icon artwork, kept so the rest can be regenerated
    - `icon-512.png`, `icon-192.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `favicon-32.png` — icons generated from `icon-source.png` by `sips` (see README) and committed, unlike the build output below
    - `script.js`, `script.js.map`, `styles.css`, `styles.css.map` — build output (gitignored)
```

Then, in the `### Frontend` section of Architecture Notes, add this bullet at the end of the list:

```markdown
- The manifest link in `index.html` carries `crossorigin="use-credentials"`,
  which is load-bearing behind Cloudflare Access: a manifest is fetched without
  credentials by default, so Access would redirect it to a login page, the
  browser would fail to parse HTML as JSON, and the install would silently
  never be offered. There is deliberately no service worker — a cached board is
  a stale board — and deliberately no `viewport-fit=cover`, since iOS insets a
  standalone app clear of the notch on its own and opting in would mean
  threading `env(safe-area-inset-*)` through `styles.css` for nothing.
```

- [ ] **Step 4: Verify formatting**

```bash
npm run format:check
```

Expected: pass. If Prettier reflows the Markdown, run `npm run format` and restage rather than hand-fixing.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document the home screen icon and how to regenerate it"
```

---

## Final verification

After all three tasks, and after deploying:

```bash
npx wrangler d1 migrations apply outwatch   # no-op here; no migrations added
npm run deploy
```

Then on a phone: Add to Home Screen. Confirm the icon is the artwork rather than a page thumbnail, the label reads `Outwatch`, and launching shows no address bar or toolbar. Expect the Access login flow on that first launch — that is the documented caveat, not a failure.

This on-device check is the only step that verifies the actual feature, and it is manual. That matches the posture the mobile layout already takes.
