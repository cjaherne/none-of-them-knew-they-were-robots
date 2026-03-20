---
description: Few-shot examples of BigBoss pipeline plans
alwaysApply: true
---

# Example Plans

## Example 1: "Add a user settings page with dark mode toggle"

```json
{
  "stages": [
    {
      "name": "design",
      "parallel": true,
      "agents": [
        {
          "type": "ux-designer",
          "context": {
            "focus": "Design the settings page layout with a dark mode toggle. Include user flow from main nav to settings. Specify toggle interaction, feedback state, and persistence behavior. Include mobile responsive breakpoints."
          }
        },
        {
          "type": "graphics-designer",
          "context": {
            "focus": "Design a dark mode color palette as CSS custom properties. Define light and dark token values for backgrounds, text, borders, and interactive elements. Include transition animations for theme switching."
          }
        },
        {
          "type": "core-code-designer",
          "context": {
            "focus": "Design the theme state management: where the preference is stored (localStorage + user profile), how components consume the theme, and the CSS custom property architecture. Define the settings API endpoint if user preferences are server-persisted."
          }
        }
      ]
    },
    {
      "name": "implement",
      "agents": [
        {
          "type": "coding",
          "context": {
            "focus": "Implement the settings page component, dark mode toggle, theme provider, and CSS custom properties based on all three design specs. Wire up localStorage persistence."
          }
        }
      ]
    },
    {
      "name": "validate",
      "agents": [
        {
          "type": "testing",
          "context": {
            "focus": "Test theme toggle behavior, localStorage persistence, CSS variable application, settings page rendering, and responsive layout. Include E2E test for the full toggle flow."
          }
        }
      ]
    }
  ],
  "reasoning": "A settings page with dark mode needs UX layout, visual tokens, and state architecture designed in parallel before implementation. All three design disciplines are relevant."
}
```

## Example 2: "Fix the login API returning 500 on invalid email format"

```json
{
  "stages": [
    {
      "name": "design",
      "agents": [
        {
          "type": "core-code-designer",
          "context": {
            "focus": "Review the login endpoint validation logic. Specify the correct validation approach for email format, the expected error response shape (400 with field-level errors), and where validation should occur (middleware vs handler)."
          }
        }
      ]
    },
    {
      "name": "implement",
      "agents": [
        {
          "type": "coding",
          "context": {
            "focus": "Fix the login endpoint to validate email format before processing. Return 400 with a structured error response instead of letting it propagate as 500. Follow the validation pattern from the architecture spec."
          }
        }
      ]
    },
    {
      "name": "validate",
      "agents": [
        {
          "type": "testing",
          "context": {
            "focus": "Add unit tests for email validation. Test: valid email, missing @, missing domain, empty string, null, SQL injection attempt. Verify 400 response shape matches the API contract."
          }
        }
      ]
    }
  ],
  "reasoning": "This is a bug fix -- only the Core Code Designer is needed to specify the fix approach. No UX or graphics work required."
}
```

## Example 3: "Refactor the database queries to use a repository pattern"

```json
{
  "stages": [
    {
      "name": "design",
      "agents": [
        {
          "type": "core-code-designer",
          "context": {
            "focus": "Design the repository pattern: define interfaces for each entity repository, specify the base repository class, define how transactions are handled, and map out which files need to change. Include the dependency injection approach."
          }
        }
      ]
    },
    {
      "name": "implement",
      "agents": [
        {
          "type": "coding",
          "context": {
            "focus": "Implement the repository interfaces and concrete classes. Migrate all direct database calls to use the repositories. Ensure all existing tests still pass after the refactor."
          }
        }
      ]
    },
    {
      "name": "validate",
      "agents": [
        {
          "type": "testing",
          "context": {
            "focus": "Add unit tests for each repository using mock database clients. Verify existing integration tests still pass. Add tests for transaction rollback behavior."
          }
        }
      ]
    }
  ],
  "reasoning": "Pure architectural refactor -- only needs Core Code Designer for the pattern specification. No UI/UX changes involved."
}
```

## Example 4: "Add a two-player versus mode to our LÖVE game"

```json
{
  "stages": [
    {
      "name": "design",
      "parallel": true,
      "agents": [
        {
          "type": "game-designer",
          "context": {
            "focus": "Define versus rules, win conditions, character or palette assignment per player, and input bindings for P1/P2 (keyboard + optional gamepad)."
          }
        },
        {
          "type": "love-architect",
          "context": {
            "focus": "Specify scene changes for versus flow, shared vs split update loops, and where player state lives (modules under src/). Avoid globals; document require order."
          }
        },
        {
          "type": "love-ux",
          "context": {
            "focus": "HUD for two players: score or lives per corner, pause overlay, versus-ready screen. Pixel layout and safe areas for split view."
          }
        }
      ]
    },
    {
      "name": "implement",
      "agents": [
        {
          "type": "lua-coding",
          "context": {
            "focus": "Implement versus mode per merged DESIGN.md: scenes, input, HUD, and game loop changes. Keep modules testable where possible."
          }
        }
      ]
    },
    {
      "name": "validate",
      "agents": [
        {
          "type": "love-testing",
          "context": {
            "focus": "Add busted specs for pure logic (scoring, state). Run busted; smoke-test love . for load errors."
          }
        }
      ]
    }
  ],
  "reasoning": "LÖVE game work uses the game + love-architect + love-ux trio in parallel, lua-coding for implementation, and love-testing for Lua-focused validation."
}
```
