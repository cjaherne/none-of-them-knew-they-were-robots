---
description: Expected structure for Graphics Designer outputs
alwaysApply: true
---

# Output Format

Structure your outputs as follows:

## 1. Color palette

CSS custom properties for light and dark themes:

- `--color-primary`, `--color-primary-hover`, `--color-primary-active`
- `--color-surface`, `--color-surface-elevated`, `--color-surface-overlay`
- `--color-text`, `--color-text-muted`, `--color-text-inverse`
- `--color-border`, `--color-border-subtle`
- `--color-success`, `--color-warning`, `--color-error`, `--color-info`

## 2. Typography scale

- `--font-family-sans`, `--font-family-mono`, `--font-family-display`
- `--font-size-xs` through `--font-size-2xl` (or equivalent scale)
- `--line-height-tight`, `--line-height-normal`, `--line-height-relaxed`
- `--font-weight-normal`, `--font-weight-medium`, `--font-weight-semibold`, `--font-weight-bold`

## 3. Spacing scale

- `--space-1` through `--space-12` (or equivalent, e.g. 4px base unit)

## 4. Component styles

CSS class definitions that reference the tokens above. Include:

- Base styles
- Variants (e.g. `--variant-default`, `--variant-highlighted`)
- Hover, focus, active states
- Responsive adjustments where needed

## Example: complete design token file

```css
/* design-tokens.css - Professional SaaS dashboard */
:root {
  /* Colors - Light mode */
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-active: #1e40af;
  --color-surface: #ffffff;
  --color-surface-elevated: #f8fafc;
  --color-surface-overlay: rgba(0, 0, 0, 0.5);
  --color-text: #0f172a;
  --color-text-muted: #64748b;
  --color-text-inverse: #ffffff;
  --color-border: #e2e8f0;
  --color-border-subtle: #f1f5f9;
  --color-success: #059669;
  --color-warning: #d97706;
  --color-error: #dc2626;
  --color-info: #0284c7;

  /* Typography */
  --font-family-sans: "Inter", system-ui, sans-serif;
  --font-family-mono: "JetBrains Mono", ui-monospace, monospace;
  --font-size-xs: 0.75rem;
  --font-size-sm: 0.875rem;
  --font-size-base: 1rem;
  --font-size-lg: 1.125rem;
  --font-size-xl: 1.25rem;
  --font-size-2xl: 1.5rem;
  --line-height-tight: 1.25;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.75;

  /* Spacing */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;
  --space-12: 3rem;

  /* Other */
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
  --transition-fast: 150ms ease;
  --transition-normal: 250ms ease;
}

[data-theme="dark"] {
  --color-primary: #3b82f6;
  --color-primary-hover: #60a5fa;
  --color-primary-active: #93c5fd;
  --color-surface: #0f172a;
  --color-surface-elevated: #1e293b;
  --color-surface-overlay: rgba(0, 0, 0, 0.7);
  --color-text: #f8fafc;
  --color-text-muted: #94a3b8;
  --color-text-inverse: #0f172a;
  --color-border: #334155;
  --color-border-subtle: #1e293b;
  --color-success: #34d399;
  --color-warning: #fbbf24;
  --color-error: #f87171;
  --color-info: #38bdf8;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -2px rgba(0, 0, 0, 0.3);
}
```
