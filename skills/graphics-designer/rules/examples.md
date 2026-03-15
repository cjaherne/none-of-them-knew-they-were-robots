---
description: Few-shot examples of Graphics Designer outputs
alwaysApply: true
---

# Examples

## Example 1: Complete design token CSS file (Professional SaaS dashboard)

```css
/* design-tokens.css - Professional SaaS dashboard */
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap");

:root {
  /* Brand & primary */
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-active: #1e40af;
  --color-primary-focus-ring: rgba(37, 99, 235, 0.4);

  /* Surfaces */
  --color-surface: #ffffff;
  --color-surface-elevated: #f8fafc;
  --color-surface-overlay: rgba(15, 23, 42, 0.5);

  /* Text */
  --color-text: #0f172a;
  --color-text-muted: #64748b;
  --color-text-inverse: #ffffff;

  /* Borders */
  --color-border: #e2e8f0;
  --color-border-subtle: #f1f5f9;

  /* Semantic */
  --color-success: #059669;
  --color-success-bg: #d1fae5;
  --color-warning: #d97706;
  --color-warning-bg: #fef3c7;
  --color-error: #dc2626;
  --color-error-bg: #fee2e2;
  --color-info: #0284c7;
  --color-info-bg: #e0f2fe;

  /* Typography */
  --font-family-sans: "Inter", system-ui, -apple-system, sans-serif;
  --font-family-mono: "JetBrains Mono", ui-monospace, monospace;
  --font-size-xs: 0.75rem;
  --font-size-sm: 0.875rem;
  --font-size-base: 1rem;
  --font-size-lg: 1.125rem;
  --font-size-xl: 1.25rem;
  --font-size-2xl: 1.5rem;
  --font-size-3xl: 1.875rem;
  --line-height-tight: 1.25;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.75;
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;

  /* Spacing (4px base) */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;
  --space-12: 3rem;
  --space-16: 4rem;

  /* Border radius */
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --radius-xl: 0.75rem;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(15, 23, 42, 0.1), 0 2px 4px -2px rgba(15, 23, 42, 0.1);
  --shadow-lg: 0 10px 15px -3px rgba(15, 23, 42, 0.1), 0 4px 6px -4px rgba(15, 23, 42, 0.1);

  /* Transitions */
  --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-normal: 250ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-slow: 350ms cubic-bezier(0.4, 0, 0.2, 1);
}

[data-theme="dark"] {
  --color-primary: #3b82f6;
  --color-primary-hover: #60a5fa;
  --color-primary-active: #93c5fd;
  --color-primary-focus-ring: rgba(59, 130, 246, 0.5);
  --color-surface: #0f172a;
  --color-surface-elevated: #1e293b;
  --color-surface-overlay: rgba(0, 0, 0, 0.7);
  --color-text: #f8fafc;
  --color-text-muted: #94a3b8;
  --color-text-inverse: #0f172a;
  --color-border: #334155;
  --color-border-subtle: #1e293b;
  --color-success: #34d399;
  --color-success-bg: #064e3b;
  --color-warning: #fbbf24;
  --color-warning-bg: #78350f;
  --color-error: #f87171;
  --color-error-bg: #7f1d1d;
  --color-info: #38bdf8;
  --color-info-bg: #0c4a6e;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -2px rgba(0, 0, 0, 0.3);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.4);
}
```

## Example 2: Component style spec (Card with variants)

```css
/* card.css - Card component using design tokens */
.card {
  background-color: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  box-shadow: var(--shadow-sm);
  transition: box-shadow var(--transition-normal), border-color var(--transition-normal),
    background-color var(--transition-normal);
}

.card--default {
  /* Uses base .card styles */
}

.card--interactive {
  cursor: pointer;
}

.card--interactive:hover {
  border-color: var(--color-border-subtle);
  box-shadow: var(--shadow-md);
}

.card--interactive:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-focus-ring);
}

.card--interactive:focus:not(:focus-visible) {
  border-color: var(--color-border);
  box-shadow: var(--shadow-sm);
}

.card--interactive:focus-visible {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-focus-ring);
}

.card--highlighted {
  background-color: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-text-inverse);
}

.card--highlighted .card__title,
.card--highlighted .card__body {
  color: var(--color-text-inverse);
}

.card--highlighted .card__body {
  opacity: 0.9;
}

.card--highlighted.card--interactive:hover {
  background-color: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}

.card--highlighted.card--interactive:active {
  background-color: var(--color-primary-active);
  border-color: var(--color-primary-active);
}

.card__title {
  font-family: var(--font-family-sans);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-tight);
  color: var(--color-text);
  margin: 0 0 var(--space-2) 0;
}

.card__body {
  font-family: var(--font-family-sans);
  font-size: var(--font-size-base);
  line-height: var(--line-height-normal);
  color: var(--color-text-muted);
  margin: 0;
}
```

**Usage (HTML):**

```html
<!-- Default card -->
<div class="card card--default">
  <h3 class="card__title">Title</h3>
  <p class="card__body">Body text.</p>
</div>

<!-- Interactive card -->
<div class="card card--interactive" tabindex="0">
  <h3 class="card__title">Clickable</h3>
  <p class="card__body">Hover and focus for feedback.</p>
</div>

<!-- Highlighted card -->
<div class="card card--highlighted">
  <h3 class="card__title">Featured</h3>
  <p class="card__body">Primary-colored card.</p>
</div>
```
