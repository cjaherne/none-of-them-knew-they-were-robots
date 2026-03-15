---
description: Few-shot examples of complete UX design specifications
alwaysApply: true
---

# Examples

These examples show the full markdown output the agent should produce. Use them as templates.

---

## Example 1: User Registration Page

```markdown
# User Registration — Design Specification

**File:** `docs/design/user-registration-spec.md`

---

## User Flow

1. User lands on registration page (from signup CTA or marketing link)
2. User sees form: email, password, confirm password, terms checkbox
3. User enters email → system validates format on blur
4. User enters password → strength indicator updates in real time
5. User enters confirm password → match indicator shows (checkmark or error)
6. User checks "I agree to terms" → submit button enables
7. User taps "Create account"
8. **Loading**: Button shows spinner, form disabled, "Creating your account..."
9. **Success**: Redirect to onboarding/welcome screen
10. **Error**: Inline error above form, focus moved to first error field

**Branch:** If user clicks "Already have an account? Sign in" → go to login flow.

---

## Layout Grid

| Breakpoint | Width | Columns | Gutter | Max content |
|------------|-------|---------|--------|-------------|
| Mobile | 320px–767px | 1 | 16px | 100% |
| Tablet | 768px–1023px | 1 | 24px | 480px centred |
| Desktop | 1024px+ | 1 | 24px | 480px centred |

---

## Component Hierarchy

```
Page
├── Header (logo, "Sign in" link)
├── Main
│   └── Card (registration form container)
│       ├── Heading (h1) — "Create your account"
│       ├── Subheading — "Start your free trial. No credit card required."
│       ├── Form
│       │   ├── Email input
│       │   ├── Password input + strength meter
│       │   ├── Confirm password input
│       │   ├── Checkbox — "I agree to Terms of Service and Privacy Policy"
│       │   ├── Submit button — "Create account"
│       │   └── Error summary (when validation fails)
│       └── Footer — "Already have an account? Sign in"
└── Footer (site links)
```

---

## Component Specs

### Email input
- **Label:** "Email address" (visible, above input)
- **Placeholder:** "you@example.com"
- **Type:** email, autocomplete="email"
- **Spacing:** Margin-bottom 1rem

### Password input
- **Label:** "Password"
- **Placeholder:** none (label is sufficient)
- **Type:** password, autocomplete="new-password"
- **Show/hide toggle:** Icon button to right of input
- **Strength meter:** Bar below input, 4 levels (weak/moderate/strong/very strong), colour-coded
- **Spacing:** Margin-bottom 0.5rem

### Confirm password input
- **Label:** "Confirm password"
- **Type:** password, autocomplete="new-password"
- **Match indicator:** Checkmark (green) or X (red) when length > 0
- **Spacing:** Margin-bottom 1rem

### Terms checkbox
- **Label:** "I agree to the [Terms of Service] and [Privacy Policy]" — links open in new tab
- **Required:** Must be checked to submit
- **Spacing:** Margin-bottom 1.5rem

### Submit button
- **Label:** "Create account"
- **Full width** on mobile; max 200px on desktop
- **Disabled** until: valid email, password meets min length, passwords match, terms checked

---

## Interaction States

### Inputs (email, password, confirm)
| State | Visual |
|-------|--------|
| Default | 1px solid #d1d5db, border-radius 6px |
| Focus | 2px solid #2563eb, box-shadow 0 0 0 3px rgba(37,99,235,0.2) |
| Error | 2px solid #dc2626, error text below in #dc2626 |
| Disabled | Background #f3f4f6, cursor not-allowed |

### Submit button
| State | Visual |
|-------|--------|
| Default (enabled) | Background #2563eb, white text |
| Hover | Background #1d4ed8 |
| Focus | 2px outline #2563eb, 2px offset |
| Active | Background #1e40af |
| Loading | Spinner icon, "Creating account...", disabled |
| Disabled | Background #9ca3af, cursor not-allowed |

### Checkbox
| State | Visual |
|-------|--------|
| Unchecked | Empty square, 20×20px |
| Checked | Checkmark, background #2563eb |
| Focus | 2px focus ring |
| Error (unchecked, submit attempted) | Red border, "You must agree to continue" below |

---

## Responsive Breakpoints

- **320px:** Single column, 16px padding, stacked layout, full-width button
- **768px:** Form max-width 480px, centred, 24px padding
- **1024px+:** Same as tablet; consider split layout (form left, illustration/benefits right) if space allows

---

## Accessibility Notes

- **Form labels:** Every input has visible `<label>` with `for`; no placeholder-only labels
- **Password strength:** Announced to screen readers: "Password strength: weak" etc.
- **Error summary:** `role="alert"` at top of form on submit error; links to fields via `aria-describedby`
- **Focus management:** On error, focus first invalid field; on success, focus welcome heading
- **Checkbox:** `aria-required="true"`, `aria-invalid` when error
- **Links:** "Terms" and "Privacy" — `target="_blank"` with `rel="noopener"`; announce "opens in new tab"
- **Contrast:** All text 4.5:1 minimum; focus indicators 3:1 against background
```

---

## Example 2: Search Results Page with Filters

```markdown
# Search Results with Filters — Design Specification

**File:** `docs/design/search-results-filters-spec.md`

---

## User Flow

1. User enters query in search box, submits (or lands via URL with query params)
2. System shows loading state (skeleton or spinner)
3. **Results loaded:** Display results list + filter sidebar/chips
4. User applies filter (category, price, date) → URL updates, results refresh
5. User clears filter → results refresh, filter UI resets
6. User changes sort → results reorder without full reload if possible
7. User scrolls → infinite scroll or "Load more" at bottom
8. **Empty state:** No results → show "No results found" + suggestions
9. **Error state:** Request failed → retry button + error message

---

## Layout Grid

| Breakpoint | Results area | Filters |
|------------|--------------|---------|
| Mobile (320–767px) | Full width | Drawer/sheet, triggered by "Filters" button |
| Tablet (768–1023px) | 2/3 width | Sidebar 1/3 width, collapsible |
| Desktop (1024px+) | 75% | Sidebar 25%, sticky |

---

## Component Hierarchy

```
Page
├── Search bar (sticky on scroll)
├── Results header
│   ├── Result count — "247 results for 'wireless headphones'"
│   ├── Sort dropdown — "Relevance" | "Price: Low to High" | "Price: High to Low" | "Newest"
│   └── Filter chips (active filters as removable tags)
├── Main layout (sidebar + results)
│   ├── Filters sidebar
│   │   ├── Category (accordion)
│   │   ├── Price range (min/max inputs or slider)
│   │   ├── Brand (checkboxes)
│   │   ├── Rating (checkboxes: 4+, 3+, etc.)
│   │   └── "Apply" / "Clear all" buttons
│   └── Results list
│       ├── Result card (repeat)
│       └── Load more / Pagination
├── Empty state (when no results)
└── Error state (when request fails)
```

---

## Filter Interaction Patterns

### Filter drawer (mobile)
- **Trigger:** "Filters" button with badge showing active filter count (e.g. "Filters (3)")
- **Open:** Sheet slides up from bottom, 80% viewport height
- **Content:** Same filter groups as sidebar
- **Actions:** "Apply" (primary) and "Clear all" at bottom
- **Close:** Swipe down or tap overlay; "Apply" also closes

### Filter sidebar (tablet/desktop)
- **Sticky:** Stays in view while scrolling results
- **Accordions:** Category, Brand, Rating — expand/collapse
- **Price:** Always visible; dual-thumb range or two number inputs
- **Apply:** Optional — can live-update on change, or require "Apply" click
- **Clear all:** Resets all filters, refreshes results

### Filter chips
- **Display:** Active filters as removable tags above results (e.g. "Category: Electronics ✕", "Price: $20–$50 ✕")
- **Remove:** Click ✕ removes that filter, results refresh
- **"Clear all"** link when 2+ chips

---

## Loading States

| Context | Behaviour |
|---------|-----------|
| Initial search | Full-page skeleton: 8 result card placeholders, filters disabled |
| Filter change | Results area shows skeleton; filters remain interactive |
| Load more | Spinner at bottom of list; existing results stay visible |
| Sort change | Results area shows brief skeleton or fade; preserve scroll position |

---

## Empty State

- **Layout:** Centred, max-width 400px
- **Icon:** Magnifying glass or empty box (decorative, `aria-hidden="true"`)
- **Heading:** "No results for '[query]'"
- **Body:** "Try adjusting your search or filters to find what you're looking for."
- **Actions:** "Clear filters" button; suggested searches as links
- **Accessibility:** `role="status"` with `aria-live="polite"` so screen readers announce

---

## Error State

- **Layout:** Inline in results area, or full-width banner
- **Icon:** Warning or error icon
- **Heading:** "Something went wrong"
- **Body:** "We couldn't load your results. Please check your connection and try again."
- **Action:** "Try again" button — retries last request
- **Accessibility:** `role="alert"` so screen readers announce immediately

---

## Result Card (per item)

- **Image:** Product/result thumbnail, aspect-ratio 1:1, object-fit cover
- **Title:** 2 lines max, truncate with ellipsis
- **Price:** Prominent; strikethrough original if sale
- **Rating:** Stars + count (e.g. "4.2 (128)")
- **Quick actions:** Add to cart, wishlist (icon buttons)

**States:** Default, hover (slight elevation), focus (focus ring on card or first link)

---

## Accessibility Notes

- **Filter drawer:** Focus trap when open; focus returns to "Filters" button on close
- **Sort dropdown:** `aria-label="Sort results"`; options read with current selection
- **Filter chips:** Each chip is a button; "Remove [filter name]" as accessible name
- **Loading:** `aria-live="polite"` region announces "Loading results" / "Results loaded"
- **Empty/Error:** `aria-live="assertive"` for error; `polite` for empty
- **Infinite scroll:** "Load more" button preferred for accessibility; if infinite scroll, announce "X results loaded" to screen readers
```
