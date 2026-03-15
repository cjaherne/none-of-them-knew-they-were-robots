---
description: Coding Agent quality checklist
alwaysApply: true
---

# Quality Checklist

Before considering implementation complete, verify:

## Type safety

- [ ] No `any` types — use `unknown` and narrow, or define proper types
- [ ] Explicit return types on exported functions
- [ ] Strict null checks — handle `null` and `undefined` explicitly
- [ ] Generic types used correctly where applicable

## Error handling

- [ ] Try/catch around async operations that can fail
- [ ] Error boundaries for React components where appropriate
- [ ] User-friendly error messages — no raw stack traces or internal details
- [ ] No empty catch blocks — always handle or rethrow with context

## Input validation

- [ ] Validate at boundaries (API handlers, form handlers, CLI args)
- [ ] Sanitize user input before use (XSS, injection)
- [ ] Use schema validation (e.g. Zod, Yup) for structured input

## Code organisation

- [ ] Single responsibility — each function/module does one thing
- [ ] Small, focused functions — easy to test and reason about
- [ ] Clear naming — names describe intent and behaviour

## Performance

- [ ] Avoid unnecessary re-renders (React: memo, useMemo, useCallback where appropriate)
- [ ] Lazy loading for heavy modules or routes
- [ ] Efficient queries — avoid N+1, unnecessary data fetching
