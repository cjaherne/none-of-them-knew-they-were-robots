---
description: Expected output structure for UX design specifications
alwaysApply: true
---

# Output Format

All design specifications must follow this structure.

## User Flows

Write user flows as **numbered step sequences**. Each step should be a single, testable action or decision point.

```
1. User lands on [screen]
2. User taps/clicks [element]
3. System shows [feedback]
4. If [condition], go to step X; else continue
5. User completes [action]
6. Success: [outcome]; Error: [fallback]
```

## Wireframe Specs

Describe wireframes as **structured component descriptions**, not images. Include:

- **Layout grid** — columns, gutters, max-width
- **Component hierarchy** — parent → child relationships
- **Spacing** — padding, margins in rem or px
- **Typography** — heading levels, body text, labels
- **Component inventory** — list each UI element with its purpose

## Interaction Specs

For every interactive element, document:

| State | Trigger | Visual/Behaviour |
|-------|---------|------------------|
| Default | — | Initial appearance |
| Hover | Pointer over | Cursor, colour, elevation change |
| Focus | Tab/keyboard | Focus ring, outline |
| Active | Click/tap down | Pressed state |
| Disabled | N/A | Reduced opacity, no pointer |
| Loading | Async in progress | Spinner, skeleton, disabled |
| Error | Validation failed | Border, message, icon |
| Success | Action completed | Checkmark, confirmation |

## Accessibility Requirements

Per component, specify:

- **Semantic role** (button, link, heading, form control)
- **ARIA attributes** if needed (aria-label, aria-expanded, aria-live)
- **Keyboard behaviour** (Tab order, Enter/Space, Escape)
- **Screen reader announcements** (what gets read, when)
- **Focus management** (where focus moves on open/close)
- **Colour contrast** (minimum 4.5:1 for text, 3:1 for large text)

---

## Example: Login Form Wireframe Spec

```markdown
# Login Form — Wireframe Specification

## Layout Grid
- Max-width: 400px, centred
- Padding: 1.5rem (24px)
- Single column, full width on mobile

## Component Hierarchy

1. **Container** (card/surface)
   - Border-radius: 8px
   - Box-shadow: 0 2px 8px rgba(0,0,0,0.08)
   - Padding: 2rem

2. **Heading** (h1)
   - "Sign in"
   - Font-size: 1.5rem, font-weight: 600
   - Margin-bottom: 1.5rem

3. **Form**
   - Email input (text, type="email")
   - Password input (type="password", show/hide toggle)
   - "Forgot password?" link
   - Submit button ("Sign in")
   - Secondary link ("Create account")

## Interaction States

### Email input
| State | Appearance |
|-------|------------|
| Default | 1px solid #ccc, placeholder "you@example.com" |
| Focus | 2px solid #0066cc, no placeholder |
| Error | 2px solid #c00, error message below |
| Disabled | Background #f5f5f5, cursor not-allowed |

### Submit button
| State | Appearance |
|-------|------------|
| Default | Background #0066cc, white text |
| Hover | Background #0052a3 |
| Focus | 2px outline offset 2px |
| Active | Slightly darker |
| Loading | Spinner replaces text, disabled |
| Disabled | Background #ccc, cursor not-allowed |

## Accessibility

- **Form labels**: Use `<label>` with `for` matching input `id`; never placeholder-only
- **Error messages**: `aria-describedby` links input to error; `aria-invalid="true"` when error
- **Show/hide password**: Button has `aria-label="Show password"` / `aria-label="Hide password"`
- **Focus order**: Email → Password → Show/hide → Forgot link → Submit → Create account
- **Submit loading**: `aria-busy="true"` on button; announce "Signing in..." to screen readers
```
