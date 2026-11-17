# Artiflow brand guidelines

Version 0.2. How to use the Artiflow brand: logo, color, type, layout and components. The full
manual, with specimens, is `brand/brand-manual.html`. This file is the short reference that code
and agents follow. When the two disagree, the manual wins and this file is the defect.

Positioning, messaging, product principles and voice are not in the repo. They live in the "Brand
and voice" document of the Artiflow project in Linear.

## 1. Concept

**White, ink and one orange.** The page around an artifact stays quiet: white space, near-black ink
with a trace of forest green, 1px lines, and one Ember accent that marks what matters.

- **The artifact leads.** It is the only colorful thing on screen.
- **One accent.** Ember marks what matters and never fills large surfaces.
- **The wave stays in the mark.** The wave stroke lives in the wordmark and the symbol. The
  interface uses straight lines and 1px dividers.

## 2. Logo

- **Wordmark: trazo.** Every letter comes from one rounded stroke; the «w» is a wave and the dot of
  the «i» is the only color (Ember). Always lowercase `artiflow`. The source paths are in
  `brand/brand-manual.html` (section Wordmark).
  - Ink on light, white on dark. The dot is Ember 500 on light and Ember 400 on dark.
  - Minimum width 72px; below that, use the symbol.
  - Clear space equals the height of the «o».
- **Symbol: A+F arc.** The «a» is an arc holding the artifact (an Ember dot), and its right leg is
  the stem of the «f». The file is `brand/mark.svg`, drawn on a 24×24 viewBox.
- **App icon:** ink background, radius 23% of the side, symbol at 66%.
- **Rules:**
  - Never stretch, recolor the strokes with Ember, add an Ember wave tail, or place it on gradients
    or noisy photos.
  - `brand/mark.svg` hardcodes its colors because a standalone SVG cannot read CSS tokens. It
    switches on `prefers-color-scheme`.

## 3. Color

One palette for the landing, the brand and the app. Never use raw hex in components; use the tokens.
They live in `apps/dashboard/src/styles/tokens.css`, which the app and the landing both import.

### Base palette

| Name | Hex | Use |
|---|---|---|
| White | `#ffffff` | Background, paper |
| Stone 100 | `#f4f4f3` | Surfaces, secondary button, closing boxes |
| Stone 200 | `#ebebea` | 1px lines |
| Ink | `#0f1d16` | Text, primary button, dark panels |
| Ink 600 | `#545b57` | Secondary text |
| Ember 500 | `#fa5a1e` | Accent on light |
| Ember 700 | `#c2410c` | Small orange text on light (≥ 4.5:1) |
| Ember 400 | `#ff6a2b` | Accent on dark |

Rough share of a screen: 70% white, 20% ink, 8% stone, 2% Ember.

### Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0b0f0d` | Page background, inputs |
| `--bg-raised` | `#ffffff` | `#111613` | Cards, menus, modals |
| `--surface` | `#f4f4f3` | `#161c18` | Hover fills, code blocks, segmented track |
| `--surface-2` | `#efefed` | `#1a211d` | Secondary button, active nav item |
| `--surface-3` | `#e4e4e1` | `#222a25` | Avatars, tooltips, hover on secondary |
| `--line` | `#ebebea` | `#212924` | Hairlines, card borders |
| `--line-strong` | `#d9d9d6` | `#2f3933` | Input borders, floating layer borders |
| `--fg` | `#0f1d16` | `#f4f4f2` | Primary text, primary button fill |
| `--fg-muted` | `#545b57` | `#a9b0ab` | Secondary text, idle controls |
| `--fg-subtle` | `#6b716d` | `#858d88` | Labels, metadata, placeholders (≥ 4.5:1) |
| `--accent` | `#fa5a1e` | `#ff6a2b` | Logo dot, focus, selection, highlights |
| `--accent-text` | `#c2410c` | `#ff8a55` | Accent as text |
| `--danger` | `#c2261c` | `#ff6a5e` | Destructive fill |
| `--danger-text` | `#b42318` | `#ff8f84` | Destructive text |

The sidebar (`--side-*`) is a slightly grey version of the page. Feature surfaces (`--feat-*`: the
auth panel and file tiles) are ink panels in both themes.

### Spending the accent

Use Ember only for: the dot of the logo, the second line of a hero headline, section numbers on the
landing, the `+` marks where landing lines cross, focus rings, selection, and the one highlighted
element of an illustration. Never for large backgrounds, never as a button fill.

### Artifact content

The artifact keeps its own palette. Product chrome never tints, frames, or restyles the artifact.

## 4. Typography

Two families, self-hosted: Geist and Geist Mono.

| Role | Font | Spec |
|---|---|---|
| Display (hero) | Geist 500 | 60px, letter-spacing -0.045em, line-height 1.02 |
| Section title | Geist 500 | 44px, -0.04em, 1.08 |
| Light section title (comparison, FAQ) | Geist 300 | 36–44px, -0.035em |
| Interface text | Geist 400 | 14px / 1.5 |
| Labels, buttons, tabs | Geist 500 | 12–13.5px, sentence case |
| Code, commands, URLs, scopes | Geist Mono 400 | 12.5–13.5px |
| Landing section labels | Geist Mono 400 | 12px, +0.04em, `[ 01 / 05 ] · PRODUCT` |
| Numbers, sizes, versions | Geist Mono | `tabular-nums` |

**Rules:**
- Headlines are sentence case. The second line of the hero headline may be Ember.
- Mono capitals are only for landing section labels and illustration labels, never for buttons.
- The server-rendered pages (viewer, server 404) use system font stacks, because their CSP blocks
  font loading and the sandboxed iframe inherits it.

## 5. Structure and layout

- **Lines stay.** Regions are separated by 1px hairlines that run edge to edge.
- **Radius:** 8px for controls inside the app, 12px for cards, 14–16px for modals and large panels.
  Landing buttons are pills.
- **App shell:** a 248px left sidebar on `--side-bg`, then the content on white.
- **Viewer:** a single 48px bar, then the artifact edge to edge.
- **Landing:** a 1200px column whose side borders are visible hairlines (rails). Each section starts
  with a full-width line and an Ember `+` where it meets each rail.
- **Shadows:** soft and only for what floats: menus, modals, toasts, and cards placed over an
  illustration.
- **Gutters:** `max(16px, env(safe-area-inset-*))`. No horizontal page scroll at any width.

## 6. Signature details

| Detail | Use |
|---|---|
| **Keyboard hints** | `Kbd` chips next to the action they trigger. Only for shortcuts that work. |
| **Command chips** | A real command or URL in Geist Mono, with an Ember `$` and a Copy action. |
| **Copy prompt card** | A short prompt with a Copy prompt button, on the landing and the empty library. |
| **Section labels** | `[ 01 / 05 ] · PRODUCT` in mono on the landing, the number in Ember. |
| **Line illustrations** | Isometric 1px line art in ink (white on ink panels), one element in Ember, labels in mono with leader lines. |
| **Dot texture** | A halftone of ink dots fading to the edges, only as a background, with an optional small Ember cluster. |

## 7. Components

All built from the tokens above. Transitions take 120ms. Pop-ins take 120–160ms and use
`cubic-bezier(.2,.8,.2,1)`.

- **Buttons:** 38px tall (sm 30px), Geist 500, sentence case, 8px radius in the app, pill on the
  landing.
  - Primary: ink fill (`--fg`) with `--bg` text, one per view.
  - Secondary: `--surface-2` with a `--line-strong` border, or Stone 100 without border on the
    landing.
  - Ghost: text only.
  - Danger: `--danger` fill, used only in a confirmation step.
- **Inputs:** 40px, `--bg` with a `--line-strong` border, 8px radius. Focus shows an Ember outline.
  Invalid shows a `--danger` border with a message below. Each field has a sentence-case label.
- **Chips:** 24px pills with a `--line-strong` border. They are for facts (Public link, v3), never
  for status decoration.
- **Cards:** `--bg-raised`, `--line` border, 12px radius.
- **Avatars:** round, initials on `--surface-3`.
- **Menus:** `--bg-raised`, `--line-strong` border, 8px radius. Shortcut or meta on the right.
- **Modals:** max 500px (overlays such as Connect up to 860px), 14px radius. On phones they become
  bottom sheets.
- **Toast:** bottom-center, an accent check plus text.
- **Tooltips:** 12px on `--surface-3`, with a 350ms delay. They include the shortcut.
- **Focus:** `outline: 2px solid var(--accent)`, offset 2px. Never remove it.
- **Icons:** 16px (sm 13px), 1.5–1.8 stroke, `currentColor`. Feature icons sit in a 36px tile with a
  hairline and a soft shadow.

## 8. Do / Don't

| Do | Don't |
|---|---|
| White space and hairlines between regions | Cream or tinted page backgrounds |
| One accent, used for meaning | Gradients, glows, Ember fills, multiple brand colors |
| Ink primary buttons | Ember primary buttons |
| Tight sans headlines, second line in Ember | Serif headlines or a dimmed first phrase |
| Numbered mono section labels on the landing | Mono capitals on buttons and in-app labels |
| The real product in screenshots | Illustrations of the product UI |
| Give the artifact the whole screen | Toolbars, sidebars or watermarks over the artifact |
| Native confirm steps inside the UI | `alert()` / `confirm()` |

## 9. Implementation notes

- **Token setup** (`apps/dashboard/src/styles/tokens.css`):
  - Dark values live on bare `:root`.
  - Light values apply under `@media (prefers-color-scheme: light) :root:not([data-theme="dark"])`
    and under `:root[data-theme="light"]`.
  - `data-theme` forces a theme.
- **One palette:** Ink is the only palette. Users choose light or dark, never a palette.
- **shadcn/Radix + Tailwind v4:** the radius scale and fonts are mapped in `globals.css`.
- Respect `prefers-reduced-motion`: disable transitions and animations.
