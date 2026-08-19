# UI Guidelines — Visual Design System

A shared visual language for aligning any project's UI to the same design system. The goal is **alignment, not a redesign** — apply these tokens and component styles on top of existing layout/UX, don't restructure it.

---

## Design tokens

```
Background:   #fdf7ec   (warm off-white — page canvas)
Surface:      #ffffff   (cards, panels)
Surface2:     #f5ede0   (secondary surfaces, shaded/alternating areas)
Text primary: #0f0d0a   (near-black)
Text secondary: #5c5448 (warm grey)
Text tertiary:  #a09280 (muted grey, hints, metadata)
Accent:       #D07818   (warm amber — the single brand color)
Border:       #e8d8c2   (primary borders)
Border2:      #d8c8b0   (stronger borders / separators)
Error:        #dc2626   (red, use sparingly — text only, avoid changing surrounding bg)

Display font: Bricolage Grotesque, weights 700 and 800
Body font:    Instrument Sans, weights 400–700

Border radius: 12px for panels/cards, 8px for buttons, 999px for pills
```

Both fonts are available on Google Fonts. Display font is for headings and any "hero" numerals/values; body font is for everything else (labels, buttons, body text, metadata).

---

## Core principles

- One accent color (`#D07818`). Don't introduce secondary brand colors — use tints/opacities of the accent (e.g. `rgba(208,120,24,0.05–0.10)`) for subtle states instead.
- Warm, off-white background instead of pure white or neutral grey — it's what makes the system feel distinct.
- Keep borders soft (`#e8d8c2` / `#d8c8b0`) rather than dark or black; avoid harsh separators.
- Two-font system only: Bricolage Grotesque for display/emphasis, Instrument Sans for everything functional.

---

## Component patterns

### 1. Page background
Set the page background to `#fdf7ec` instead of white or neutral grey.

### 2. Surfaces & panels
- **Default surface** (cards, panels, default cells/tiles): `#ffffff`
- **Secondary surface** (alternating rows, shaded sections): `#f5ede0`
- Panel border radius: `12px`, border color `#e8d8c2`

### 3. Selection / active / highlighted states
For any selectable or highlightable element (list item, cell, card, tab):
- **Selected**: base surface color with a `1.5px solid #D07818` border and a subtle `rgba(208,120,24,0.08)` fill
- **Highlighted / related-group** (e.g. same row/section as selection): `rgba(208,120,24,0.05)` tint
- **Error state**: text color `#dc2626`, no change to surface background — keep it minimal

### 4. Typography
- **Emphasized values** (large numbers, key stats, primary content): Bricolage Grotesque, weight 700–800, sized to feel substantial relative to context (roughly `1.4rem`–`1.6rem` for inline emphasis, up to `2.5rem` for hero stats).
- **UI labels, button text, timers, toggles, body copy**: Instrument Sans.
- **Page/section headings**: Bricolage Grotesque, weight 800, color `#0f0d0a`.
- Secondary/metadata text: Instrument Sans, color `#5c5448` (or `#a09280` for tertiary/hint text).

### 5. Buttons

Primary:
```
background:    #D07818
color:         #ffffff
border-radius: 8px
font:          Instrument Sans, weight 600
padding:       0.5rem 1.25rem

hover:         background slightly darker — #b86814
active:        scale(0.97)
transition:    150ms ease
```

Secondary / ghost:
```
background:    transparent
border:        1.5px solid #e8d8c2
color:         #5c5448
border-radius: 8px

hover:         border-color #D07818, color #D07818
```

### 6. Selector / choice controls
For any set of discrete options (digit pads, filter chips, segmented controls):
- Default option: `bg-surface`, `border border-border`, `rounded-[8px]`, Bricolage Grotesque weight 700
- Selected/active option: `bg-accent text-white`
- Auxiliary toggles (clear/undo/secondary actions): use the ghost button style above

### 7. Completion / success screens
For celebratory or summary states (success screens, results, confirmations):
- Card: `#ffffff` background, `#e8d8c2` border, `12px` border-radius, generous padding
- Heading: Bricolage Grotesque, weight 800, `~2rem`, color `#0f0d0a`
- Stat labels: Instrument Sans, color `#5c5448`
- Stat values: Bricolage Grotesque, weight 800, color `#D07818`, large (`~2.5rem`)
- CTA button: primary button style from §5

### 8. Status / metadata bars
- Font: Instrument Sans, weight 600, color `#5c5448`
- Accent any "live"/active element (running timer, active status) with `#D07818`

### 9. Pills / badges
```
background:    rgba(208,120,24,0.10)
color:         #D07818
border-radius: 999px
font:          Instrument Sans, weight 600, size 0.7rem
padding:       0.25rem 0.625rem
```

Active/selected pill:
```
background:    #D07818
color:         #ffffff
```

---

## What to leave alone

When applying this system to an existing project, only touch colors, typography, and surface treatments:
- Don't change logic, data flow, or event/messaging code
- Don't change layout structure or component dimensions
- Don't change animation timing unless it visually conflicts with the new palette
