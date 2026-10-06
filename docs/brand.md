# Serv brand values (v2.1 step 5)

Every value below comes from servtech.co, fetched on 2026-10-05. No value was picked by eye. A value marked **derived** is a tint of a Serv value, used for an app surface that Serv's site does not define, and the source value is named.

Sources:
- Homepage: `https://servtech.co/`
- Stylesheet: `https://servtech.co/assets/styles-C7wTIyxe.css` (102 KB, built with Lovable, Tailwind v4 and shadcn tokens)
- Logo: `https://servtech.co/__l5e/assets-v1/28b9c2b8-d83f-48f8-a1d7-8b96dfb4eb05/serv-logo-white.png` (644 x 204, white on transparent)
- Favicon: `https://servtech.co/favicon.png` (64 x 64)
- Fonts: `https://fonts.googleapis.com/css2?family=Inter...` and `https://api.fontshare.com/v2/css?f[]=general-sans@200,...,700`

## What the site defines

The stylesheet has three sets of colors:

1. **Landing page** (the dark page visitors see). These are Tailwind classes compiled to hex:

| Class | Value | Where it shows |
|---|---|---|
| `bg-landing-bg` | `#0a0a0c` | Page background |
| `text-landing-fg` | `#e8e8e8` | Body text |
| `bg-landing-accent` | `#132a49` | Navy buttons ("Book a demo") |
| `hover:bg-landing-accent-hover` | `#1e3f6b` | Button hover |
| `text-accent-bright` | `#5a7fae` | Blue headline text ("Know the customer.") |
| `.hairline-b` | `#ffffff26` | Hairline borders |
| `.landing-font` | `General Sans, ui-sans-serif, system-ui, sans-serif` | Landing type |

2. **`:root`**: Serv's own light tokens (customized; not shadcn defaults).
   - `--background: oklch(96.8% .006 250)`
   - `--foreground: oklch(18% .03 260)`
   - `--card: oklch(100% 0 0)`
   - `--primary: oklch(24% .07 260)`, which is also `--serv-navy`
   - `--primary-foreground: oklch(99% .003 250)`
   - `--muted: oklch(96.5% .008 250)`
   - `--muted-foreground: oklch(50% .03 258)`
   - `--accent: oklch(55% .16 250)`, which is also `--ljs-blue` and `--ring`
   - `--destructive: oklch(58% .22 27)`
   - `--success: oklch(62% .16 150)`
   - `--warning: oklch(75% .15 75)`
   - `--border: oklch(92% .01 255)`
   - `--serv-navy-soft: oklch(32% .07 260)`
   - `--sidebar: oklch(98.4% .003 247.858)`
   - `--radius: .25rem`

3. **`.dark`**: shadcn's stock slate dark theme, unmodified, so I did not treat it as brand. The one exception is `--destructive: oklch(70.4% .191 22.216)`, kept for error text in the dark theme.

Fonts:
- `--default-font-family` is `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. Inter is a Google font.
- The landing page uses **General Sans** from Fontshare.

## How the app uses them

Everything lives in `apps/web/app/globals.css`, in the `--c-*` palette that shadcn's tokens map onto. Components use tokens only (no hex in components). Dark is the default, matching the site; light is kept. The choice is remembered per browser (sidebar toggle, `data-theme` on `<html>`).

| App token | Dark (default) | Light |
|---|---|---|
| Window (`--c-window`) | `#0a0a0c` landing-bg | `:root --background` |
| Text (`--c-ink`) | `#e8e8e8` landing-fg | `:root --foreground` |
| Muted text | derived: landing-fg at 62% | `:root --muted-foreground` |
| Lines | `#ffffff26` hairline | `:root --border` |
| Cards (`--c-raised`) | derived: landing-bg lifted 3.5% toward white | `:root --card` |
| Sidebar | `bg-landing-bg/80` (the site's nav) | `:root --sidebar` |
| Brand accent: links, icons, active state (`--c-accent`) | `#5a7fae` accent-bright | derived: `--ljs-blue` at L 51% (Serv's is 55%), for 4.5:1 text contrast |
| Primary buttons (`--c-primary`) | `#132a49` landing-accent, hover `#1e3f6b` | `--serv-navy`, hover `--serv-navy-soft` |
| Primary button text | `#e8e8e8` | `:root --primary-foreground` |
| Errors (`--c-destructive`) | `.dark --destructive` | derived: `:root --destructive` at L 55% (Serv's is 58%), for 4.5:1 |
| Radius | `--radius: .25rem` | same |
| Cover art gradients (`--art-0a` to `--art-5b`) | Pairs of `#132a49`, `#1e3f6b`, `#5a7fae`, `#0a0a0c`, `--serv-navy`, `--serv-navy-soft`, `--ljs-blue` | same |

**Not brand colors (unchanged on purpose):**
- Status badges (completed, abandoned, undetermined, review, failed, running) keep their own emerald, orange, violet, amber, rose and sky tints. A status never depends on the brand color.
- Speaker role colors (crew, customer) are functional too.

**Logo:** `public/serv-logo-white.png`, as downloaded, beside the text "Audio to Orders" in the sidebar. The site has no dark version for light backgrounds, so the light theme shows the same file with `filter: brightness(0)` (black). The favicon is `app/icon.png`, as downloaded. This is an internal tool; the logo is not used anywhere public.

**Font:** Inter, Serv's default family, self-hosted by `next/font/google` at build time, with the site's own fallback stack.

General Sans (the landing headline face) is free under Fontshare's ITF Free Font License, but it is not on Google Fonts. Bundling it means committing its font files to this repo, and I did not want to decide that license question for you. If you want it, say so: `next/font/local` can load it for headings, and nothing else changes.

## Contrast (WCAG AA)

`apps/web/e2e/brand.spec.ts` resolves each token in the browser and measures it in both themes. Every pair is at least 4.5:1:
- text on the page background
- muted text on the page background and on cards
- primary button text on primary
- brand accent on the page background and on cards
- error text on the page background
- sidebar text

Three Serv values were just under 4.5:1 as text, so they use the derived tints above:
- `#5a7fae` on 5% cards: 4.49
- `--ljs-blue` on the light background: 4.40
- `--destructive` on the light background: 4.36

## Screenshots

- servtech.co: `docs/brand/site-servtech.png`
- The app, dark: `docs/brand/app-runs-dark.png`
- The app, light: `docs/brand/app-run-light.png`

Screenshots of every page in both themes go on the release PR.
