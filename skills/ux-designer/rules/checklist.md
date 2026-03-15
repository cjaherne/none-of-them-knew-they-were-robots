---
description: Quality checklist for UX design specifications
alwaysApply: true
---

# Quality Checklist

Before finalising any design specification, verify the following.

---

## WCAG 2.1 AA Compliance

- [ ] **Colour contrast:** All text meets 4.5:1 (normal) or 3:1 (large text 18px+ or 14px bold)
- [ ] **Keyboard navigation:** Every interactive element reachable and operable via Tab/Shift+Tab
- [ ] **Focus indicators:** Visible focus ring (2px minimum) on all focusable elements; 3:1 contrast
- [ ] **Screen reader:** Semantic HTML roles specified (button, link, heading, form control); no div/span for interactive elements
- [ ] **Form labels:** Every input has a visible, programmatically associated label (never placeholder-only)
- [ ] **Alt text:** Images that convey meaning have descriptive alt text; decorative images have `alt=""`
- [ ] **Error identification:** Form errors described in text, not colour alone; linked via `aria-describedby`
- [ ] **Motion:** No auto-playing motion > 5 seconds; provide reduced-motion alternative if animations are essential

---

## Responsive Design

- [ ] **Mobile (320px):** Layout works at minimum viewport; no horizontal scroll; touch targets ≥ 44×44px
- [ ] **Tablet (768px):** Breakpoint defined; layout adapts (e.g. sidebar appears, grid columns increase)
- [ ] **Desktop (1024px+):** Max-width or constraints specified; content doesn't stretch infinitely
- [ ] **Touch targets:** Buttons and links ≥ 44×44px on mobile; adequate spacing between tappable elements

---

## Interaction Completeness

For every interactive component, confirm these states are specified:

| State | Required? | Notes |
|-------|-----------|-------|
| Default | ✓ | Initial appearance |
| Hover | ✓ | Pointer over (desktop) |
| Focus | ✓ | Keyboard focus |
| Active | ✓ | Pressed/clicked |
| Disabled | ✓ | When applicable |
| Loading | ✓ | When async action in progress |
| Error | ✓ | When validation or request fails |
| Success | ✓ | When action completes (if applicable) |
| Empty | ✓ | When no data (lists, tables, filters) |

---

## Edge Cases

- [ ] **Long text:** Truncation rules (ellipsis, max lines, tooltip) for titles, labels, user-generated content
- [ ] **Missing data:** Placeholder or fallback for empty fields (e.g. "No description", "—")
- [ ] **Slow connections:** Loading states for every async operation; consider timeout messaging
- [ ] **Large datasets:** Pagination, infinite scroll, or virtualisation strategy documented
- [ ] **Form validation:** Inline vs. on-submit; when errors clear; focus management on error
- [ ] **Modals/drawers:** Focus trap, Escape to close, focus return on close
- [ ] **Multi-step flows:** Progress indicator, back navigation, data persistence across steps

---

## Output Completeness

- [ ] User flow is a numbered sequence with branches and outcomes
- [ ] Wireframe includes layout grid, component hierarchy, spacing
- [ ] Every interactive element has interaction states documented
- [ ] Accessibility requirements listed per component
- [ ] File saved to `docs/design/` with descriptive filename
