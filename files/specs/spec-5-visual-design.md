# Spec 5 — Visual Design System

**Source PRD:** None — Phase 6 was scoped directly against a live audit of the current web app's
CSS (2026-07-20), not a pre-existing component PRD like Specs 1–4.
**Siblings:** Spec 1 (Mobile Capture & Review) · Spec 4 (Backend Platform) · `phases.md`
**Status:** Scoped, not yet implemented — 2026-07-20.
**Phase tags:** `[P6]` — all of this spec is Phase 6 scope; nothing here is required for Phases 1–5.

## 1. Overview & Scope

RecipeCart has never had a dedicated visual design pass. Every screen's CSS was written
ad-hoc, screen-by-screen, to fix functional/usability bugs (including Phase 5's own UI polish
work) — none of it was a considered design system. A concrete audit of `web/src/**/*.css` and
`*.tsx` (not a vague impression) found:

- **Color drift**: 3 different "error" reds (`#8a1f11`, `#b3261e`, `#b91c1c`) and 3 different
  "success" greens (`#1a7f37`, `#1a5c1a`, `#1e7e34`) for the identical semantic role, split
  across screen CSS files and one inline JS color map (`ConfidenceBadge.tsx`). Two near-duplicate
  error backgrounds (`#fdecea` / `#fdeaea`) and error borders (`#f5c2bc` / `#f3c8c5`) too.
- **Zero shared tokens**: no `:root` CSS custom properties, no base/reset stylesheet, no
  `main.tsx` global CSS import at all. Every screen's CSS independently redeclares
  `font-family: system-ui, -apple-system, "Segoe UI", sans-serif`.
- **No dark mode**: no `prefers-color-scheme`, no `data-theme`, no CSS variables — confirmed
  fully absent, not just unused.
- **Type-scale drift**: `Review.css` uses `em` for every size while every other screen's CSS
  uses `rem` for the same visual sizes — the same "small text" renders as `0.85em` in one
  screen and `0.85rem` in another. No shared type scale; font sizes sprawl across 8+ ad-hoc
  values (`1.1rem`, `1.05rem`, `0.95rem`, `0.9rem`, `0.85rem`, `0.8rem`, `0.78rem`, ...).
- **Spacing drift**: roughly a 0.25rem-grid intent, broken by off-grid one-offs (`0.6rem`,
  `1.1rem`, `0.35rem`, `0.15rem`, plus `em`-unit spacing in `Review.css`).
- **Two screens ship with zero CSS at all**: `ConnectKroger` and `FailureCard` — currently
  raw, unstyled HTML.
- **Branding is placeholder-grade**: the PWA icons (`apple-touch-icon.png`, `pwa-icon-192.png`,
  `pwa-icon-512.png`) are 574–2800 bytes — near-empty. No `<link rel="icon">`, no
  `<meta name="description">`. "RecipeCart" appears only as plain text, never a styled
  wordmark or logotype.
- **No UI framework/library** of any kind — `web/package.json` runtime deps are only `react`,
  `react-dom`, `react-router-dom`. This is genuinely greenfield token/system work, not a
  library migration or a rip-and-replace of an existing design system.

**Goal of this phase**: replace that ad-hoc styling with one deliberate design system, and
take one grounded design risk, rather than leaving the app looking like an unstyled internal
tool. Per explicit decisions made when scoping this phase:

- **Dark mode is in scope** (not deferred) — built into the token system from day one.
- **A real display/body font pairing** (not system-fonts-only) for genuine typographic
  personality.
- **One grounded, domain-specific signature moment**, confined to a single screen (the Cart
  Result confirmation) — not spread thin across the whole app.
- **A typographic wordmark only** — no illustrated logo/icon mark. Lower-risk, lower-lift
  branding investment, matched to a utility app's register.

This spec is deliberately **design + token documentation**, not an implementation log — no
code has been written against it yet (see `files/phases.md`'s Phase 6 section for status).

## 2. Technical Design

### 2.1 Token system

A new `web/src/styles/tokens.css` becomes the single source of truth for color, replacing
every raw hex literal currently duplicated across screen CSS files. Light values live on
`:root`; dark values override under **both** `:root[data-theme="dark"]` (an explicit user
choice, set via a new Preferences screen toggle) **and** `@media (prefers-color-scheme: dark)`
(the OS-level default when the user hasn't picked one) — an explicit `data-theme` always wins
over the system default; `:root[data-theme="light"]` explicitly opts out of the dark media
query even on a dark-mode OS.

**Identity palette** (named by role, not just hex — a real, deliberate choice, not the cold
gray a generic dashboard would default to):

| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-ink` | `#23201b` | `#eae6dd` | Primary text — replaces the `#111`/`#333`/`#666` gray soup found across screens |
| `--color-ink-muted` | `#6b6558` | `#a39b8a` | Secondary/caption text |
| `--color-paper` | `#f7f4ee` | `#1b1815` | Page/card surface — warm kraft-paper tone (kitchen-notebook-adjacent), not the cold `#fafafa`/`#f5f5f7` gray currently used |
| `--color-paper-raised` | `#fffdf9` | `#252119` | Raised surface (cards on top of the page background) |
| `--color-cart-blue` | `#2563eb` | `#5b8dfb` | Primary action/brand — **kept deliberately**, not replaced. It's already shipped in the PWA manifest, `theme-color` meta, and native install icons; replacing it outright would be a bigger, harder-to-reverse rebrand than the "wordmark only" branding decision calls for |
| `--color-cart-blue-strong` | `#1d4ed8` | `#82aaff` | Hover/active state of the above |
| `--color-basil` | `#3f7d4a` | `#6fae78` | One deliberate fresh-produce green accent (success states, pantry-staple chip) — replaces the 3 drifting greens found in the audit with a single domain-grounded choice |
| `--color-basil-bg` / `--color-basil-border` | `#eaf4ec` / `#c3ddc8` | `#1e2c20` / `#35492f` | Basil-tinted background/border pairing |
| `--color-border` | `#e2ddd8` | `#3a352c` | One warm-neutral border value replacing `#ccc`/`#ddd`/`#e0e0e0`/`#eee` |

**Status colors** (a functional layer, separate from the identity palette above — kept the
more legible member of each drifting pair found in the audit rather than inventing new ones):

| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-error` / `-bg` / `-border` | `#b3261e` / `#fdecea` / `#f5c2bc` | `#e2665c` / `#3a1f1c` / `#5c2e29` | Error text/background/border |
| `--color-warning` / `-bg` / `-border` | `#a15c00` / `#fff4e0` / `#f0b429` | `#d99a3d` / `#3a2c14` / `#5c471f` | Warning text/background/border |
| `--color-focus-ring` | `--color-cart-blue` | same | Always the brand blue, always visible — paired with a real `outline`, never a background-only or color-only change (WCAG "don't rely on color alone") |

### 2.2 Typography

**Display face: Fraunces.** A warm, soft-personality serif — genuinely kitchen/recipe-card-
adjacent rather than a stiff traditional serif or a generic sans default. Used sparingly:
screen headings (`h1`/`h2`/`h3`), ingredient/product prices, and the Cart Result signature
total figure (§2.5). **Body face: Karla** — a clean humanist grotesk that pairs well with
Fraunces, chosen deliberately over defaulting to Inter (which the design-review process flags
as an overused non-choice). **System monospace stack kept as-is** (`ui-monospace, "SF Mono",
Menlo, monospace`) for evidence snippets/small data text — a deliberate "utility face" choice;
no need to load a third webfont just for that.

Both fonts ship via `@fontsource/fraunces` and `@fontsource/karla` (self-hosted through Vite's
bundler, no external Google Fonts network call — better for privacy and reliability on a
mobile PWA). Weights loaded: 400 (body regular), 600 (emphasis/labels), 700 (headings) —
non-italic only, to control bundle size.

**Type scale** (rem-only — fixes the `em`/`rem` unit drift found in `Review.css`):

| Token | Size | Typical use |
|---|---|---|
| `--text-xs` | 0.75rem | Captions, small badges |
| `--text-sm` | 0.875rem | Secondary/meta text |
| `--text-base` | 1rem | Body text |
| `--text-md` | 1.125rem | Emphasized body, ingredient names |
| `--text-lg` | 1.375rem | Screen headings (matches the one value that had accidentally converged across 5 screens already) |
| `--text-xl` | 1.75rem | Larger emphasis, e.g. Cart Result total figure |
| `--text-2xl` | 2.25rem | Reserved for the receipt "total" figure specifically (§2.5) |

Weights: `--weight-regular` 400, `--weight-emphasis` 600, `--weight-heading` 700.

### 2.3 Spacing scale

A strict 4px/0.25rem-based ladder, replacing the off-grid one-offs found in the audit
(`0.6rem`, `1.1rem`, `0.35rem`, `0.15rem`, and stray `em`-based spacing):

`--space-1` 0.25rem · `--space-2` 0.5rem · `--space-3` 0.75rem · `--space-4` 1rem ·
`--space-5` 1.25rem · `--space-6` 1.5rem · `--space-8` 2rem · `--space-12` 3rem

Every screen's padding/margin/gap should round to the nearest of these during migration
(Slice 2, §3) rather than keep its original arbitrary value.

Also: `--radius-sm` 6px, `--radius-md` 8px, `--radius-lg` 10px (consolidating the existing
`6px`/`8px`/`10px` border-radius values already in informal, accidental use).

### 2.4 Dark mode mechanism

A new light/dark/system toggle on the existing **Preferences** screen. This is a purely
client-side display preference (unlike `PreferencesDto`'s server-synced fields), so it's
stored in `localStorage` (key `recipecart_theme`), not round-tripped through the API. On load,
`main.tsx` applies the stored preference synchronously (before the first React render, to
avoid a flash of the wrong theme) by stamping `data-theme="dark"` / `data-theme="light"` on
`<html>`, or leaving the attribute absent for "system" (falls through to the
`prefers-color-scheme` media query in `tokens.css`).

### 2.5 Signature moment — Cart Result receipt treatment

The one deliberate design risk this phase takes, confined to a single screen
(`web/src/screens/CartResult/`) per the "spend boldness in one place" principle — everywhere
else in the app stays quiet and disciplined, using the token system with no thematic motif.

The "Added" items list becomes a receipt-styled panel:
- **Paper**-colored panel with a zigzag/perforated top edge, done via a CSS `clip-path`
  polygon (no image assets needed).
- Each item row: product name in the body face (left), a **dotted leader** (`border-bottom:
  dotted` or a flex filler) connecting to the price in the **display face**, right-aligned —
  evoking a real, itemized grocery receipt rather than a generic card list.
- A **double-rule divider** above a **total line**, set in the display face at `--text-xl`,
  using `--color-ink` (or `--color-cart-blue` for emphasis — to be decided at implementation
  time based on contrast testing, §2.7).
- The "Needs attention" section keeps the plain card treatment from Phase 5's Cart Result
  cleanup — the receipt motif applies only to genuinely-added items, since a receipt implies
  a completed transaction.

### 2.6 Wordmark & branding assets

`web/src/components/AppShell/` styles "RecipeCart" as a considered logotype rather than plain
text — e.g. "Recipe" set in the body face at regular weight next to "Cart" set in the display
face at a heavier weight, tying the wordmark literally to the domain (the input is a recipe,
the output is a cart). A simple monogram/glyph favicon derived from the same type treatment
replaces the current near-placeholder PWA icons (`apple-touch-icon.png`, `pwa-icon-192.png`,
`pwa-icon-512.png` — all under 3KB today). `web/index.html` also gains a real
`<meta name="description">` and a proper `<link rel="icon">` (both currently missing).
**Explicitly out of scope**: an illustrated icon/logo mark — this phase is wordmark-only.

### 2.7 Accessibility contrast validation

Every token color pairing (text-on-background, in **both** light and dark) must pass WCAG AA
contrast before this phase is considered done. This is narrower than Phase 5's still-open
full accessibility item (Dynamic Type, VoiceOver labels, 44×44pt targets stay Phase 5 scope)
— this phase's job is only to make sure the *new palette itself* doesn't hand that later pass
a non-compliant starting point. Any token value that fails gets adjusted here, before Phase 5's
broader accessibility work begins.

## 3. Screens & components in scope

| Screen/component | Current CSS state | Work needed |
|---|---|---|
| `RecipesList` | Has CSS, color drift | Migrate to tokens |
| `Review` | Has CSS (largest, `em`/`rem` drift) | Migrate to tokens, fix unit drift |
| `CartProgress` | Has CSS | Migrate to tokens |
| `CartResult` | Has CSS | Migrate to tokens **+** signature receipt treatment (§2.5) |
| `Preferences` | Has CSS | Migrate to tokens **+** add theme toggle (§2.4) |
| `Privacy` | Has CSS | Migrate to tokens |
| `Setup` | Has CSS | Migrate to tokens |
| `ConnectKroger` | **No CSS at all** | Style from scratch |
| `FailureCard` | **No CSS at all** | Style from scratch |
| `AppShell` (nav) | Has CSS | Migrate to tokens **+** wordmark treatment (§2.6) |
| `ConfidenceBadge` | Inline JS color map, no CSS file | Move to a real `ConfidenceBadge.css` using tokens |
| `StageLine` | **No CSS at all** | Style from scratch |

## 4. Slices (implementation order, once this phase is picked up)

1. **Token + type + base foundation** — `tokens.css`, `base.css`, `@fontsource` deps,
   `main.tsx` wiring, theme toggle on Preferences. Must land first, alone — every other slice
   depends on these tokens existing.
2. **Migrate all screens/components onto tokens** — mechanical, repeatable pattern; safe to
   split across parallel work by disjoint screen groups once Slice 1 lands.
3. **Style the two zero-CSS screens** (`ConnectKroger`, `FailureCard`) from scratch.
4. **Cart Result signature receipt treatment** (§2.5) — independent file set from Slices 2/3/5.
5. **Wordmark + favicon/branding assets** (§2.6).
6. **Accessibility contrast validation** (§2.7) — last, once the palette is locked by the
   slices above.

**Execution strategy:** the same frozen-contract pattern that worked cleanly for Phase 5's
UI slices — Slice 1 lands first, alone (small and foundational; one agent or done directly,
not worth parallelizing on its own). Once tokens exist, dispatch Slices 2 (split across a
few agents by disjoint screen group), 3, 4, and 5 in parallel — all touch separate files,
so there's no write-collision risk. Slice 6 runs last, alone, once the palette is frozen by
everything above it.

## 5. Out of scope

- Illustrated logo/icon mark (wordmark-only, §2.6).
- Phase 5's remaining items: Preferences-into-ranking, the full Dynamic Type/VoiceOver/44pt
  accessibility pass (only contrast is checked here, §2.7), operational drills, the PRD
  acceptance-criteria walk, Kroger Partner-tier evaluation. Those stay Phase 5 scope.

## 6. Verification (once implemented)

`cd web && npm run build` clean after each slice. Visually confirm both `data-theme="light"`
and `data-theme="dark"` (and OS-level `prefers-color-scheme` with no explicit choice) render
correctly on every screen in §3. Confirm the Cart Result receipt treatment with 0, 1, and many
items (empty/singular/plural states). Run a contrast checker against every token pairing in
§2.1/2.2 for both themes (§2.7). Confirm the favicon/wordmark render correctly in a browser
tab and on an installed PWA icon.

## 7. Setup & Environment

| Phase | Needs |
|---|---|
| P6 | `@fontsource/fraunces` + `@fontsource/karla` npm deps (self-hosted, OFL-licensed — no API key, account, or external network call required) |

No new accounts, keys, or infrastructure of any kind — this phase is entirely `web/`-local
npm packages plus new CSS/asset files.

## 8. Open Action Items

- [ ] **A5-1 — Cart Result total-line color.** §2.5 leaves this as either `--color-ink` or
  `--color-cart-blue` for emphasis — decide at implementation time based on which passes WCAG
  AA contrast more comfortably against `--color-paper` in both themes (§2.7 covers the check;
  this item is picking the winner).
- [ ] **A5-2 — Wordmark face-per-word split.** §2.6 gives "Recipe" in body weight / "Cart" in
  the display face as an example treatment, not a locked decision — confirm the exact
  weight/face/color split when actually building the `AppShell` wordmark (Slice 5), since it's
  the one place this phase's typography choices become a literal brand mark.

## 9. Blockers

None. No external accounts, API keys, or paid services are required anywhere in this phase —
both webfonts are self-hosted npm packages with no runtime network dependency.

## 10. Considerations

- **Font-loading weight**: two new webfonts (even self-hosted, weights limited to 400/600/700)
  add real bytes to first load on a PWA that's often reviewed over mobile networks — worth a
  quick bundle-size check after Slice 1 lands, not just assuming it's negligible.
- **PWA manifest icons**: replacing the placeholder `apple-touch-icon.png`/`pwa-icon-192.png`/
  `pwa-icon-512.png` (§2.6) means regenerating all three at their required sizes from the new
  favicon/monogram treatment, not just swapping the favicon alone — `manifest.webmanifest`
  references all three explicitly.
- **Dynamic Type interaction**: the new rem-based type scale (§2.2) must still scale correctly
  under the OS-level text-size setting Phase 5's still-open accessibility item will eventually
  test for (Dynamic Type/VoiceOver/44pt targets) — this phase should not accidentally lock in
  sizing that fights that later pass; stick to `rem` (relative to root font size) throughout,
  never `px`, for anything text-related.
