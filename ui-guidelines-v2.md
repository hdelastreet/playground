# UI Guidelines — Warm Precision Design System

## Purpose

A shared visual language for aligning any project's UI to the same design system.

The goal is **alignment, not a redesign**. Apply these rules to the existing product, layout, UX, and information architecture. Do not restructure a product just to make it fit the system.

This system is intentionally small and opinionated. Prefer consistency and reuse over inventing new visual treatments.

---

## 1. Design philosophy

**Warm Precision**

A warm, editorial visual identity combined with the restraint, hierarchy, spatial clarity, and interaction precision of modern native interfaces.

### Core principles

- Warm, not beige.
- Minimal, not sterile.
- Soft, not blurry.
- Expressive typography, functional UI.
- One accent, many semantic states.
- Depth through layering, not decoration.
- Content before chrome.
- Motion should explain, not entertain.
- Consistency over novelty.
- Reuse existing tokens and patterns instead of inventing new ones.

When a decision is not specified here, choose the simplest option that is consistent with these principles and existing components.

---

## 2. Foundations

### Color

Keep the warm palette. Do not introduce additional brand colors.

```text
Background:          #fdf7ec   warm off-white page canvas
Surface:             #ffffff   cards, panels, primary UI surfaces
Surface secondary:   #f5ede0   secondary / alternating surfaces

Text primary:        #0f0d0a
Text secondary:      #5c5448
Text tertiary:       #a09280

Border subtle:       #eee3d4
Border default:      #e8d8c2
Border strong:       #d8c8b0

Accent:              #D07818
Accent hover:        #b86814
Accent active:       #a85f12
Accent subtle:       rgba(208,120,24,0.08)
Accent soft:         rgba(208,120,24,0.14)

Error:               #dc2626
Success:             #2f7d4a
Warning:             #a66a00

Focus:               #D07818
```

Rules:

- Amber is the single brand/accent color.
- Use accent tints/opacities for subtle states.
- Do not introduce arbitrary colors for individual components.
- Semantic colors such as error, success, and warning are functional, not brand colors.
- Keep backgrounds and borders soft. Avoid harsh black separators.
- Do not use gradients unless the product specifically requires them.
- Do not use color as decoration when it does not communicate hierarchy or state.

### Typography

```text
Display / headings: Bricolage Grotesque
UI / body:          Instrument Sans
```

Use Bricolage Grotesque for:

- Page and section headings
- Hero content
- Large numbers and important values
- Occasional editorial emphasis

Use Instrument Sans for:

- Body copy
- Navigation
- Buttons
- Inputs
- Tabs
- Filters
- Labels
- Metadata
- Functional UI

Typography scale:

```text
Display:       48 / 52   Bricolage 800
H1:            36 / 40   Bricolage 800
H2:            28 / 34   Bricolage 800
H3:            22 / 28   Bricolage 700
Body:          16 / 24   Instrument 400
Body small:    14 / 20   Instrument 400
Label:         14 / 20   Instrument 600
Caption:       12 / 16   Instrument 500

Hero value:    40 / 44   Bricolage 800
Large stat:    32 / 36   Bricolage 800
```

Use the nearest scale value rather than inventing arbitrary font sizes.

### Spacing

Use a small spacing scale throughout the product:

```text
4   6   8   12   16   20   24   32   40   48   64   80   96
```

Rules:

- Small inline gaps: 4–12
- Control padding/gaps: 8–16
- Card padding: 16–24
- Section spacing: 32–48
- Major page sections: 64–96
- Prefer these values over arbitrary numbers.
- Do not change existing component dimensions merely to force them onto the scale.

### Radius

```text
XS:     6px
SM:     8px
MD:     12px
LG:     16px
XL:     20px
FULL:   999px
```

Use:

- Buttons, inputs, controls: SM
- Cards, panels: MD
- Dialogs, larger floating surfaces: LG
- Large featured/floating surfaces: LG–XL
- Pills/badges: FULL

Keep radii consistent within a product. Do not mix many unrelated radii.

### Elevation

Most UI should be flat.

```text
Level 0: page / normal content
Level 1: cards / raised surfaces
Level 2: dropdowns / popovers / floating controls
Level 3: dialogs / important overlays
```

Use borders first and shadows second.

```text
Shadow small:  0 1px 2px rgba(15,13,10,0.04)
Shadow medium: 0 4px 16px rgba(15,13,10,0.07)
Shadow large:  0 12px 40px rgba(15,13,10,0.10)
```

Rules:

- Normal cards generally do not need a visible shadow.
- Floating UI may use medium shadow.
- Dialogs may use large shadow.
- Never add shadows simply to make every component look elevated.
- Do not spend time tuning z-index values. Use the smallest sensible stacking order needed to keep overlays above their triggering content.

### Material / translucency

Use translucency selectively for UI that genuinely floats above content:

- Sticky navigation
- Toolbars
- Dropdowns
- Command palettes
- Floating controls
- Modal chrome

A translucent surface should remain readable and visually quiet.

Do not turn normal cards, page sections, or content into glass.

Avoid blur/glass effects when they do not communicate a real layer relationship.

### Icons

Use one consistent icon family per project.

Prefer a clean SVG icon system such as Lucide when no existing icon system is provided.

```text
XS: 14px
SM: 16px
MD: 20px
LG: 24px
```

Use:

- 16px for compact controls
- 20px for navigation and normal actions
- 24px for prominent actions or empty states

Do not mix icon styles.

Do not use emoji as interface icons.

---

## 3. Interaction states

Interactive components should have clear, restrained states.

Use these states when relevant:

```text
Default
Hover
Pressed
Focus-visible
Selected / Active
Disabled
Loading
Error
Success
```

General rules:

- Hover: subtle color, border, or surface change.
- Pressed: slightly stronger state; a tiny scale reduction is acceptable for buttons.
- Focus-visible: clearly visible accent focus ring; never remove keyboard focus indication.
- Selected: use the accent and/or accent-subtle treatment.
- Disabled: reduce contrast and interaction affordance without making text unreadably faint.
- Loading: preserve the component's shape and hierarchy; avoid layout shifts.
- Error/success: use semantic color primarily on the relevant text, icon, border, or indicator rather than flooding the surrounding UI.

Prefer subtle state changes over dramatic animations.

---

## 4. Components

### Buttons

Use four basic levels:

**Primary**
- Accent background
- White text
- 8px radius
- Instrument Sans 600
- Medium, comfortable padding

**Secondary**
- Surface background
- Default border
- Primary/secondary text
- Same radius and typography as primary

**Tertiary**
- No visible border
- Text-based action
- Use accent or secondary text

**Destructive**
- Use semantic error styling
- Keep the treatment restrained

Button sizes:

```text
Small:   compact controls
Medium:  default
Large:   prominent CTAs
```

Do not create many button variants unless the product genuinely needs them.

### Inputs

Default:

- White surface
- Default border
- 8px radius
- Instrument Sans
- Clear label and/or placeholder
- Comfortable vertical padding

States:

- Hover: slightly stronger border
- Focus: accent focus ring/border
- Error: error border/text where useful
- Disabled: muted surface/text
- Filled: same structure as default

Do not rely on placeholder text as the only label for important fields.

### Cards / panels

Default:

- White surface
- Default border
- 12px radius
- 16–24px padding

Cards should organize content, not decorate it.

Use a secondary surface when a section needs subtle differentiation.

Do not automatically add shadows.

### Selection / active states

For selectable items:

- Selected: accent border or accent background depending on component
- Subtle accent tint is appropriate for non-destructive selection
- Related/highlighted items may use a very light accent tint

Avoid making every selected state fully amber. Preserve hierarchy.

### Pills / badges

```text
Background: rgba(208,120,24,0.10)
Text:       #D07818
Radius:     999px
Font:       Instrument Sans 600
Size:       12px
Padding:    4px 10px
```

Use filled accent only for strongly active/selected pills.

Badges should communicate status or classification, not be used as decoration.

### Tabs / segmented controls

- Keep the control visually compact.
- Use a clear active state.
- Prefer surface + accent treatment over heavy borders.
- Do not make every tab look like a button.
- Preserve familiar tab behavior.

### Dialogs / popovers

- White surface
- 16px radius
- Stronger visual separation from the page
- Medium/large shadow depending on importance
- Clear heading hierarchy
- Primary action visually obvious
- Keep the surrounding backdrop quiet

### Status / metadata

Use Instrument Sans.

Secondary metadata uses `#5c5448`.

Tertiary metadata uses `#a09280`.

Active/live status may use the accent.

Keep metadata visually subordinate to primary content.

### Empty states

Keep them simple:

- Clear heading
- Short explanation
- One useful next action
- Optional restrained icon/illustration

Do not create elaborate illustrations unless they serve the product.

### Success / completion

- White surface
- Default border
- 12–16px radius
- Generous but not excessive padding
- Bricolage for the main result/value
- Instrument Sans for supporting information
- Accent for important positive values
- One clear CTA

---

## 5. Layout and responsive behavior

This is a responsive web system. It does not assume a mobile application.

Do not redesign the layout to fit this guide.

When adapting an existing interface responsively:

- Preserve the content hierarchy.
- Preserve familiar interaction patterns.
- Reduce columns when necessary.
- Collapse sidebars into drawers or compact navigation when necessary.
- Allow horizontal controls to scroll rather than wrap awkwardly.
- Prioritize readability over preserving desktop density.
- Never shrink text excessively to preserve a desktop layout.
- Avoid unnecessary breakpoint-specific redesigns.

Use the existing project's layout system when one exists.

If a new layout needs breakpoints, prefer a small set of practical breakpoints rather than many device-specific rules.

---

## 6. Motion

Motion should communicate interaction and hierarchy, not add spectacle.

```text
Fast:    ~100ms
Normal:  ~180ms
Slow:    ~280ms
```

Use:

- Fast for hover/focus/button feedback
- Normal for dropdowns, popovers, and common transitions
- Slow only for larger spatial changes

Prefer opacity and transform transitions.

Avoid:

- Bouncy UI
- Excessive spring effects
- Decorative animations
- Large unexpected movements
- Animations that delay basic interactions

Respect `prefers-reduced-motion`.

---

## 7. Accessibility

Accessibility is part of the visual system.

- Keep text readable.
- Maintain sufficient contrast.
- Never remove visible keyboard focus.
- Use `:focus-visible` for keyboard interaction.
- Preserve clear labels for controls.
- Ensure interactive targets remain comfortably usable on touch screens.
- Do not rely on color alone to communicate an important state.
- Respect reduced-motion preferences.
- Preserve browser zoom and text scaling.

Do not sacrifice accessibility to make the UI look more minimal.

---

## 8. AI implementation rules

These rules are especially important.

### Prefer reuse over invention

When implementing a new UI:

1. Look for an existing component or pattern.
2. Reuse existing tokens.
3. Reuse existing spacing, radii, typography, and states.
4. Only create a new visual treatment when the product genuinely needs one.

### Do not invent

Do not introduce:

- New brand colors
- New fonts
- Arbitrary gradients
- Random border radii
- One-off shadows
- Mixed icon families
- Decorative glass effects
- Excessive blur
- Emoji as UI icons
- Unnecessary animation
- Arbitrary spacing values when a system value works

### When something is unspecified

Choose the simplest existing pattern.

Do not stop implementation to ask about minor visual decisions unless the decision materially affects UX or product behavior.

Use judgment for small details while staying inside this system.

### Important boundary

This document controls **visual language**, not product strategy.

Do not change:

- Product logic
- Data flow
- Information architecture
- UX flows
- Content hierarchy
- Component dimensions
- Feature behavior
- Event/messaging code

unless explicitly requested.

Do not redesign a screen simply because another composition would look more polished.

---

## 9. What makes this system recognizable

Across different projects, the following should remain recognizable:

- Warm off-white canvas
- White, softly bordered surfaces
- Amber as the single brand accent
- Bricolage Grotesque for expressive hierarchy
- Instrument Sans for functional UI
- Soft borders and restrained elevation
- Compact, consistent radii
- Generous but disciplined spacing
- Quiet interaction states
- Minimal decoration
- Strong content hierarchy

The goal is for different products to feel like they belong to the same design family without looking like copies of one another.

---

## 10. Final rule

**Make it feel designed, not decorated.**

When in doubt:

- simplify
- reuse
- preserve hierarchy
- preserve usability
- prefer subtlety
- keep the warm identity
- do not redesign the product
