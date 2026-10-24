---
name: Par Physics Playground
description: Canvas2D rigid-body playground — clean dark editor HUD with precise, quiet chrome
colors:
  canvas: "#111418"
  surface: "#1b2028"
  surface-raised: "#232b36"
  border: "#2a323d"
  border-strong: "#3b475a"
  text: "#e6e9ee"
  text-secondary: "#9aa4b5"
  text-tertiary: "#6f7a8c"
  accent: "#4aa3ff"
  accent-hover: "#6db6ff"
  accent-dim: "rgba(74, 163, 255, 0.12)"
  accent-fill: "rgba(74, 163, 255, 0.7)"
  danger: "#f44336"
  danger-text: "#ff6b60"
  text-placeholder: "#8b96a5"
typography:
  title:
    fontFamily: "system-ui, -apple-system, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  label:
    fontFamily: "system-ui, -apple-system, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.06em"
  body:
    fontFamily: "system-ui, -apple-system, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  numeric:
    fontFamily: "system-ui, -apple-system, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  tool-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    size: "36px"
  tool-button-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
  tool-button-active:
    backgroundColor: "{colors.accent-dim}"
    textColor: "{colors.accent}"
  ghost-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
  ghost-button-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
  panel-heading:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
---

# Design System: Par Physics Playground

## Overview

**Creative North Star: "Precision Instrument"**

The HUD is the chassis of a measurement device: matte dark surfaces hold the
tools, a single electric-blue accent marks every live or armed state, and the
canvas — the actual experiment — stays the brightest, clearest thing on
screen. Chrome recedes; state speaks. Depth is earned by interaction (hover
lifts, armed glows), never by decoration at rest, so the editor reads calm
between actions and responsive during them.

**Key Characteristics:**

- Flat-until-touched: chrome has no shadows or lifts at rest.
- One accent (#4aa3ff) owns selection, armed tools, and live values.
- Canvas center is sacred — no chrome effects bleed onto the stage.
- Tabular numerals in every readout so values tick without jitter.

## Colors

A near-monochrome blue-gray ramp with a single electric-blue accent.

### Primary
- **Electric Instrument Blue** (#4aa3ff): selection outlines, armed tools,
  slider fills and thumbs, focus rings, the renderer's selection color. The
  only saturated hue in the UI.

### Neutral
- **Stage Void** (#111418): the canvas and the deepest inset surfaces (text
  and color inputs inside panels).
- **Panel Graphite** (#1b2028): top bar, tool rail, context panel backgrounds.
- **Raised Slate** (#232b36): hover fills, the material editor card.
- **Seam** (#2a323d): 1px panel seams and control borders at rest.
- **Seam Highlight** (#3b475a): control borders on hover.
- **Instrument Text** (#e6e9ee): primary text and readouts.
- **Secondary Text** (#9aa4b5): labels, hints, resting icons.
- **Tertiary Text** (#6f7a8c): disabled chrome only — never reading text.
- **Placeholder Text** (#8b96a5): input placeholder hints.

### Named Rules
**The One Voice Rule.** Blue is used for state, never for decoration. If a
blue pixel does not tell the user what is selected, armed, or focused, it is
in the wrong place.

## Typography

**Body Font:** system-ui stack (`system-ui, -apple-system, "SF Pro Text", "Segoe UI", sans-serif`)

**Character:** Instrument-panel utilitarian — small, dense, quiet. Hierarchy
comes from weight (400/500/600) and case (uppercase micro-labels with wide
tracking), never from size jumps.

### Hierarchy
- **Title** (600, 13px, -0.01em): the top-bar product name only.
- **Panel heading** (500, 11px, 0.06em tracking, uppercase): MATERIALS-style
  section headers in the context panel.
- **Body** (400, 14px): panel rows, control labels at 12px.
- **Numeric** (500, 12px, `font-variant-numeric: tabular-nums`): every slider
  output and readout. Values tick in place without reflow.

### Named Rules
**The Tabular Numerals Rule.** Every live number renders with
`font-variant-numeric: tabular-nums`. Readouts must never wiggle.

## Layout

A fixed three-column editor chassis: 48px tool rail | fluid canvas stage |
280px context panel, under a 40px top bar. Groups inside the top bar separate
by 1px seam dividers, not whitespace alone. Control clusters sit tight (4–8px
gaps); clusters separate generously. The context panel scrolls independently;
the canvas never scrolls.

## Elevation & Depth

Flat by default; depth is a state response, layered softly and always with
offset so it reads as physical lift rather than a halo.

### Shadow Vocabulary
- **Lift** (`box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35)`): hover raise on
  interactive chrome, material editor card, dropdown-ish surfaces.
- **Accent glow** (`box-shadow: 0 0 0 1px {colors.accent}, 0 0 10px rgba(74, 163, 255, 0.28)`):
  selection and armed state. The 1px ring keeps the edge crisp; the 10px
  bloom whispers.

### Named Rules
**The Flat-Until-Touched Rule.** A surface at rest carries no shadow. Shadows
appear only as a response to hover, press, open, or selection, and never on
the canvas.

**The Canvas Stays Clear Rule.** No chrome casts onto the stage. The canvas
is the brightest, calmest surface; the HUD frames it.

**The Neutral Shadow Rule.** Every shadow color is neutral black alpha
(`rgba(0, 0, 0, a)` at 0.3–0.45). Shadows never take hue; glow is the only
colored depth.

## Shapes

Small radii, consistent by role: 4px swatches, 6px controls (buttons,
inputs, sliders' thumb), 8px containers (material editor card). Two
sub-scale micro-radii are intentional: 2px for the 3px slider track channel
and 5px for the scrollbar thumb. Borders are
1px seams at rest that brighten to Seam Highlight on hover. No pills, no
asymmetric corners, no heavy outlines — the accent ring in the elevation
vocabulary is the only outline emphasis, and only for selection.

## Components

### Tool buttons (rail + sim controls)
- **Shape:** 36×36, 6px radius, 18px drawn SVG icons at 1.5px stroke.
- **Rest:** transparent on Panel Graphite, Secondary Text icon.
- **Hover:** icon brightens to Instrument Text, fill becomes Raised Slate,
  1px Lift shadow, 1px upward translate.
- **Active/armed:** Accent Blue icon on a 12% accent tint, full accent glow
  ring.
- **Disabled:** 35% opacity, no hover response.

### Ghost buttons (presets, panel actions)
- **Shape:** auto width, 6px radius, 12px text, 4×8px padding.
- **Rest:** Secondary Text on transparent, 1px Seam border.
- **Hover:** Raised Slate fill, Instrument Text, 1px lift.
- **Accent variant** (Apply to selection, Create): Accent Blue text and
  border at rest; hover fills 12% accent tint and glows.

### Sliders
- **Track:** 3px Seam channel, rounded; filled portion Accent Blue at 70%
  alpha (`--accent-fill`), painted from the slider's live value.
- **Thumb:** 12px Instrument Blue disc, Seam-highlight border, 1px Lift
  shadow on hover.
- **Readout:** tabular numerals right of the track, Instrument Text.

### Material list rows
- **Shape:** full-width, 6px radius, 14px color swatch (4px radius, inset
  seam border).
- **Hover:** Raised Slate fill, Lift shadow.
- **Selected:** 12% accent tint fill, accent glow ring, Instrument Text.
- **Row actions** (edit/delete): quiet Secondary Text ghost buttons that
  brighten on row hover.

### Inputs (text, color)
- **Style:** Stage Void background (inset feel), 1px Seam border, 6px radius.
- **Focus:** accent ring from the elevation vocabulary + accent caret.
- **Error:** Danger Text (#ff6b60 — the contrast-safe variant of the
  reserved #f44336 graphic hue) for message text below the editor fields.

### Navigation
Top bar groups: title | sim controls (pause/step/reset, gravity fields,
presets, speed) separated by 1px seams. Tool rail: tool group, then divider,
then static-mode toggle and edit actions. Grouping is positional; no nav
highlight beyond the armed tool.

## Do's and Don'ts

### Do:
- **Do** keep every surface flat at rest; express state with the two-shadow
  vocabulary (Lift, accent glow) and nothing else.
- **Do** render all live numbers with tabular numerals.
- **Do** theme the browser chrome the design forgets: `::selection`, caret,
  focus-visible rings, and panel scrollbars in the instrument palette.
- **Do** keep icons a single family: drawn SVG, 1.5px stroke, 18px box.

### Don't:
- **Don't** use cream/off-white surfaces, italic accent type, pill buttons,
  section numbers, or oversized display type (D11/D15 anti-reference).
- **Don't** put chrome shadows, gradients, or accent tints on or over the
  canvas; the renderer's own selection/preview highlights drawn INTO the
  canvas are the exception (they are state, not chrome).
- **Don't** introduce a second saturated hue; danger red is reserved for
  error text.
- **Don't** let a readout reflow while its value ticks (tabular-nums).
- **Don't** create depth with zero-offset colored halos; shadows carry
  offset and blur. The accent glow is the single sanctioned exception: it
  marks state (selection, armed, focus), never depth.
