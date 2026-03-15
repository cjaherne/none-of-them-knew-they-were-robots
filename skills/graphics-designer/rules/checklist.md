---
description: Quality checklist for Graphics Designer outputs
alwaysApply: true
---

# Quality Checklist

Before finalising any design output, verify:

## Color contrast (WCAG AA)

- **Normal text**: minimum 4.5:1 contrast ratio against background
- **Large text** (18px+ or 14px+ bold): minimum 3:1 contrast ratio
- Verify **both light and dark modes**
- Test `--color-text` on `--color-surface`, `--color-text-muted` on `--color-surface`, and all semantic colours

## Typography

- Base font size **≥ 16px** for body text
- Clear hierarchy (distinct sizes for headings, body, captions)
- Maximum **2–3 font families** (e.g. sans + mono, or sans + display)
- Line height appropriate for line length (typically 1.5 for body)

## Consistency

- All visual values reference **design tokens** (no magic numbers)
- Systematic spacing (use `--space-*` scale consistently)
- Border radii, shadows, and transitions use token variables

## Responsive

- Tokens work across breakpoints (consider `--font-size-*` scaling if needed)
- Touch targets **≥ 44px** for interactive elements
- Spacing and padding scale appropriately on smaller screens

## Theming

- All visual values defined as **CSS custom properties**
- Dark mode complete (every colour token has a dark variant)
- Smooth **transition** on theme switch (e.g. `transition: background-color var(--transition-normal), color var(--transition-normal)` on `html` or `:root`)
