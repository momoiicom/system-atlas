# Design

## Scene

A developer at a desk late in the afternoon, inspecting a live system without leaving their editor: dark ink, sharp amber signals, and quiet paper-white structure.

## Strategy

Restrained product UI. A cool near-black canvas holds the graph; the warm coral seed is reserved for active execution and primary controls.

## Tokens

```css
:root {
  --atlas-bg: oklch(0.12 0.012 255);
  --atlas-panel: oklch(0.16 0.014 255);
  --atlas-panel-raised: oklch(0.20 0.016 255);
  --atlas-ink: oklch(0.95 0.008 255);
  --atlas-muted: oklch(0.69 0.018 255);
  --atlas-line: oklch(0.31 0.018 255);
  --atlas-primary: oklch(0.65 0.18 35.8);
  --atlas-accent: oklch(0.76 0.15 142);
  --atlas-danger: oklch(0.64 0.20 25);
}
```

## Typography

Use the system UI sans stack. Data, paths, and JSON use a system monospace stack.

## Layout

A narrow evidence rail sits beside a full-height graph canvas. Details occupy the right edge only when selected, so the map remains the working surface. Avoid grids of cards.
