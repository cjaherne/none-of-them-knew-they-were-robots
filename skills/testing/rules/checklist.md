---
description: Testing Agent quality checklist
alwaysApply: true
---

# Quality Checklist

Before considering tests complete, verify:

## Coverage

- [ ] **Happy path** — primary success scenario covered
- [ ] **Edge cases** — boundary values, empty inputs, max lengths
- [ ] **Error cases** — invalid input, not found, permission denied
- [ ] **Null/undefined** — explicit tests for optional or nullable inputs
- [ ] **Target** — >80% coverage on new or modified code

## Isolation

- [ ] **Mocked externals** — APIs, DB, file system, third-party services
- [ ] **No shared state** — each test sets up its own data; no cross-test dependencies
- [ ] **Self-contained** — test can run in any order; cleanup in `afterEach` if needed

## Readability

- [ ] **Descriptive names** — test names explain scenario and expected outcome
- [ ] **Arrange-act-assert** — clear structure: setup, action, assertion
- [ ] **Clear assertions** — one logical assertion per test where possible; avoid assertion soup

## Reliability

- [ ] **No flaky tests** — no random failures; avoid `setTimeout` or arbitrary waits
- [ ] **No timing dependencies** — use `waitFor`, `toBeVisible`, or deterministic mocks
- [ ] **Deterministic data** — fixed test data; no `Date.now()` or random IDs in assertions

## Completeness

- [ ] **All new functions tested** — every exported function has at least one test
- [ ] **All error paths covered** — each `throw` or error branch has a test
- [ ] **User-facing states verified** — E2E covers key flows and visible outcomes
