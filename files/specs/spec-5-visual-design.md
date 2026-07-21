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

#### 2.7 results — status colors, focus ring, real-usage spot-checks

Real WCAG relative-luminance math (sRGB→linear, L, then `(L1+0.05)/(L2+0.05)`) computed
against the actual current `tokens.css` hex values, 2026-07-20. Covers the status-color and
focus-ring pairings; a parallel pass covers the identity-palette tokens (ink/paper/cart-blue/
basil/border) separately — together the two passes are Slice 6 in full.

**Status color / focus-ring pairings**

| Pairing | Threshold | Light | Dark | Result |
|---|---|---|---|---|
| `--color-error` on `--color-error-bg` | 4.5:1 (renders at 12px/13px normal weight in body copy) | 5.72:1 | 4.52:1 | Pass both |
| `--color-error-border` vs `--color-paper` | 3:1 (non-text/1.4.11) | was 1.44:1 (**fail**) → fixed to 3.74:1 | was 1.58:1 (**fail**) → fixed to 4.13:1 | Pass both (after fix) |
| `--color-error-border` vs `--color-paper-raised` | 3:1 | was 1.55:1 (**fail**) → fixed to 4.05:1 | was 1.43:1 (**fail**) → fixed to 3.74:1 | Pass both (after fix) |
| `--color-warning` on `--color-warning-bg` | 4.5:1 | 4.76:1 | 5.57:1 | Pass both |
| `--color-warning-border` vs `--color-paper` | 3:1 | was 1.70:1 (**fail**) → fixed to 3.21:1 | was 2.00:1 (**fail**) → fixed to 4.14:1 | Pass both (after fix) |
| `--color-warning-border` vs `--color-paper-raised` | 3:1 | was 1.83:1 (**fail**) → fixed to 3.47:1 | was 1.81:1 (**fail**) → fixed to 3.76:1 | Pass both (after fix) |
| `--color-focus-ring` (= `--color-cart-blue`) vs `--color-paper` | 3:1 (2.4.11/1.4.11) | 4.71:1 | 5.60:1 | Pass both, untouched |
| `--color-focus-ring` vs `--color-paper-raised` | 3:1 | 5.09:1 | 5.07:1 | Pass both, untouched |

All four border pairings failed outright in both themes (borders were near-white-on-near-white
tints, ~1.4–2.0:1) — these are genuine non-text-contrast failures, not edge cases. Fixed by
increasing saturation/darkening (light) or brightening (dark) while keeping the same hue family,
so error still reads red-toned and warning still reads amber-toned:

- `--color-error-border`: light `#f5c2bc` → `#c85c52`; dark `#5c2e29` → `#c25b50`
- `--color-warning-border`: light `#f0b429` → `#b57e08`; dark `#5c471f` → `#987530`

`--color-error`/`--color-error-bg`/`--color-warning`/`--color-warning-bg` and the focus ring
were untouched — all already passed.

**Real-usage spot-checks**

- `ConfidenceBadge.css` renders label text at `--text-xs` (12px) / `--weight-emphasis` (600).
  12px bold does **not** qualify as WCAG "large text" (needs ~18.7px bold / 24px regular), so
  the 4.5:1 text threshold applies, not 3:1:
  - `--high` (basil-on-basil-bg): covered by the parallel identity-palette pass.
  - `--medium`/`--amount-unclear` (`--color-warning` on `--color-warning-bg`): 4.76:1 light /
    5.57:1 dark — pass (same token pairing as row above).
  - `--low` (`--color-error` on `--color-error-bg`): 5.72:1 light / 4.52:1 dark — pass. Dark
    mode is the tightest margin in this whole audit (4.52 vs. 4.5 threshold) — legitimate pass,
    not rounding, but has near-zero headroom; worth a mental flag if `--color-error`/`-bg` dark
    values ever shift again.
  - Badge borders (all three modifiers) inherit the `-border` tokens fixed above, now passing.
- `CartResult.css` `.cart-result__receipt-total-value`: `--color-ink` on `--color-paper-raised`
  at `--text-xl` (28px) / `--weight-heading` (700) — genuinely large text, 3:1 threshold.
  Recomputed independently: **15.98:1 light / 12.87:1 dark**. Matches the parallel agent's
  12.87–15.98:1 exactly — no discrepancy.
- Confirmed via `grep -rn "color-error\|color-warning" web/src --include="*.css"` that
  `Privacy.css`, `Preferences.css`, `Setup.css`, `CartResult.css`, `RecipesList.css`,
  `ConnectKroger.css`, `FailureCard.css`, `Review.css`, and `CartProgress.css` all consume the
  shared `--color-error`/`-bg`/`-border` and `--color-warning`/`-bg`/`-border` tokens (no raw
  hex leftovers found), so the token-level fix above covers all of them without a per-file
  check. `Review.css` renders its error/warning blocks at ordinary body text sizes, same
  4.5:1/3:1 split as above — no additional failures found.

Slice 6 status: status-color/focus-ring token pairings and the real-usage spot-checks above are
fully covered by this pass. Full Slice 6 completion also requires the parallel identity-palette
pass (ink/paper/cart-blue/basil/border) to be recorded — see that pass's own section for its
results.

#### 2.7 results — identity palette (ink/paper/cart-blue/basil/border)

Real WCAG relative-luminance math (sRGB→linear, L, then `(L1+0.05)/(L2+0.05)`) computed
against the actual current `tokens.css` hex values, 2026-07-20. Covers the identity-palette
pairings; the parallel pass above covers status colors and the focus ring — together the two
passes are Slice 6 in full.

**Cross-check against Stage 2's numbers** (recorded in §8 A5-1): independently recomputed
`--color-ink` vs `--color-paper` (14.78:1 light / 14.19:1 dark), `--color-ink` vs
`--color-paper-raised` (15.98:1 light / 12.87:1 dark), `--color-cart-blue` vs `--color-paper`
(4.71:1 light / 5.60:1 dark), and `--color-cart-blue` vs `--color-paper-raised` (5.09:1 light /
5.07:1 dark). All four match Stage 2's figures exactly — no discrepancy, no token drift since
that pass.

**Text-on-background pairings** (4.5:1 threshold — confirmed via
`grep -rn "color-ink-muted\|color-cart-blue" web/src --include="*.css"` that these tokens are
used at `--text-sm`/`--text-base`/`--text-xs`, `--weight-regular`/`--weight-emphasis` (600), in
real screens — never at large-text size/weight, so the stricter 4.5:1 floor applies throughout,
not the 3:1 large-text floor):

| Pairing | Light | Dark | Result |
|---|---|---|---|
| `--color-ink` vs `--color-paper` | 14.78:1 | 14.19:1 | Pass both |
| `--color-ink` vs `--color-paper-raised` | 15.98:1 | 12.87:1 | Pass both |
| `--color-ink-muted` vs `--color-paper` | 5.27:1 | 6.41:1 | Pass both |
| `--color-ink-muted` vs `--color-paper-raised` | 5.70:1 | 5.81:1 | Pass both |
| `--color-cart-blue` vs `--color-paper` | 4.71:1 | 5.60:1 | Pass both |
| `--color-cart-blue` vs `--color-paper-raised` | 5.09:1 | 5.07:1 | Pass both |
| `--color-cart-blue-strong` vs `--color-paper` | 6.10:1 | 7.70:1 | Pass both |
| `--color-cart-blue-strong` vs `--color-paper-raised` | 6.60:1 | 6.98:1 | Pass both |
| `--color-basil` vs `--color-basil-bg` | was 4.39:1 (**fail**) → fixed to 5.02:1 | 5.57:1 (already passing) | Pass both (after fix) |

`--color-basil` (light) failed by a narrow margin: `.cart-result__badge--added` and
`ConfidenceBadge--high` render this pairing at `--text-xs` (12px) / `--weight-emphasis` (600) —
not large text — so 4.39:1 was a real, if small, non-passing gap under the 4.5:1 floor. Fixed by
darkening `--color-basil` along its existing hue/saturation (HSL lightness 0.369 → 0.34) rather
than lightening `--color-basil-bg`, since the "basil-tinted background" pairing's light,
airy background tone reads as more identity-critical than the exact shade of the text color
sitting on it. Dark `--color-basil` was already passing (5.57:1) and left untouched.

**Non-text UI-component pairings** (3:1 threshold, WCAG 1.4.11 — `--color-border` and
`--color-basil-border` are both used on real interactive-component boundaries, not just
decorative dividers: `grep -rn "color-border" web/src --include="*.css"` shows it on
`input[type="text"]` fields (Preferences, Setup, RecipesList), buttons
(`.recipes-list__refresh`, `.recipe-card__delete`), and clickable cards (`.recipe-card`,
`.ingredient-card`, `.match-picker__summary`); `--color-basil-border` outlines the
pantry-staple/confidence badge chips):

| Pairing | Light | Dark | Result |
|---|---|---|---|
| `--color-border` vs `--color-paper` | was 1.23:1 (**fail**) → fixed to 3.46:1 | was 1.45:1 (**fail**) → fixed to 3.90:1 | Pass both (after fix) |
| `--color-border` vs `--color-paper-raised` | was 1.33:1 (**fail**) → fixed to 3.74:1 | was 1.32:1 (**fail**) → fixed to 3.54:1 | Pass both (after fix) |
| `--color-basil-border` vs `--color-paper` | was 1.32:1 (**fail**) → fixed to 3.65:1 | was 1.81:1 (**fail**) → fixed to 3.88:1 | Pass both (after fix) |
| `--color-basil-border` vs `--color-paper-raised` | was 1.43:1 (**fail**) → fixed to 3.95:1 | was 1.64:1 (**fail**) → fixed to 3.52:1 | Pass both (after fix) |
| `--color-basil-border` vs `--color-basil-bg` (its actual real-usage neighbor, checked in addition to the two pairings above since every real badge sits directly on `--color-basil-bg`, not bare paper) | was 1.29:1 (**fail**) → fixed to 3.56:1 | was 1.49:1 (**fail**) → fixed to 3.21:1 | Pass both (after fix) |

Both border tokens failed outright, and badly, in every pairing in both themes (original values
were near-invisible tints, ~1.2–1.8:1 — a genuine non-text-contrast failure, not an edge case;
these borders would have been effectively invisible against their surfaces). Fixed by darkening
(light theme) / lightening (dark theme) along each token's existing hue, rather than touching
`--color-paper`/`--color-paper-raised`/`--color-basil-bg` — those surface tokens carry more of
the "warm kraft-paper" / "basil-tinted background" identity, so the border tokens (whose whole
job is to be a visible outline) absorbed the fix:

- `--color-border`: light `#e2ddd8` → `#92806d`; dark `#3a352c` → `#807561`
- `--color-basil-border`: light `#c3ddc8` → `#4f8c5b`; dark `#35492f` → `#5c7f52`

`--color-ink`, `--color-ink-muted`, `--color-cart-blue`, `--color-cart-blue-strong`, and dark
`--color-basil` were all already passing and left untouched. `npm run build` confirmed clean
after all token changes above (no broken `var()` references).

Slice 6 status (identity-palette pass): fully covers ink/paper/cart-blue/basil/border. Combined
with the status-color/focus-ring pass above, **Slice 6 is now complete in full** — every token
pairing in §2.1's color table has been checked against real WCAG math in both themes, and every
failure found has been fixed and reverified.

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
   slices above. **Done 2026-07-20** — see §2.7 results (two passes: status-color/focus-ring,
   and identity-palette). All token pairings pass WCAG AA; several border/badge tokens were
   fixed in `tokens.css`.

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

- [x] **A5-1 — Cart Result total-line color.** Decided: **`--color-ink`**. Computed contrast
  ratios (WCAG relative-luminance formula) for both candidates against both paper surfaces, in
  both themes:

  | Pairing | Light | Dark |
  |---|---|---|
  | `--color-ink` vs `--color-paper` | 14.78:1 | 14.19:1 |
  | `--color-ink` vs `--color-paper-raised` | 15.98:1 | 12.87:1 |
  | `--color-cart-blue` vs `--color-paper` | 4.71:1 | 5.60:1 |
  | `--color-cart-blue` vs `--color-paper-raised` | 5.09:1 | 5.07:1 |

  Both colors clear WCAG AA everywhere (`--text-xl` bold qualifies as "large text," so the
  3:1 floor applies, and even the stricter 4.5:1 normal-text floor is met by every cell above).
  But `--color-cart-blue` on `--color-paper` in light mode sits at 4.71:1 — only 0.21 above the
  4.5:1 floor, with no margin for the total figure ever being reduced from bold to regular
  weight later. `--color-ink` clears every pairing by 12.87:1 or better, nearly 3x the required
  margin in the tightest case. Implemented in `web/src/screens/CartResult/CartResult.css`
  (`.cart-result__receipt-total-value`).
- [x] **A5-2 — Wordmark face-per-word split.** Resolved during Slice 5. Final treatment:
  "Recipe" in `--font-body` (Karla) at `--weight-regular` / `--text-md`, colored
  `--color-ink-muted`; "Cart" in `--font-display` (Fraunces) at `--weight-heading` (700) /
  `--text-lg`, colored `--color-cart-blue` (hover/focus shifts to `--color-cart-blue-strong`).
  Rationale: the weight/face split alone (example treatment) read as arbitrary, so color was
  added as a third axis carrying the actual meaning — "Recipe" stays muted/quiet because it's
  the input the user already has, "Cart" is bold, larger, and rendered in the app's one
  existing primary-action color because it's the output the app produces. Reusing
  `--color-cart-blue` (rather than inventing a new wordmark-only accent) was deliberate: it's
  already the color a user associates with "the button that does the thing" everywhere else in
  the app, so the wordmark points at the same color instead of introducing a second brand
  color to track. This same "Cart = bold + brand blue" logic is what the favicon monogram
  (§2.6) is derived from.

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
