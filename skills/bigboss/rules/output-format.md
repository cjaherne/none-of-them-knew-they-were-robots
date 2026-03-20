---
description: Required output format for BigBoss pipeline plans
alwaysApply: true
---

# Output Format

Your output MUST be valid JSON matching this structure:

```json
{
  "stages": [
    {
      "name": "stage-name",
      "parallel": true,
      "agents": [
        {
          "type": "agent-type",
          "context": {
            "focus": "specific instructions for this agent"
          }
        }
      ]
    }
  ],
  "reasoning": "Brief explanation of why this plan was chosen"
}
```

## Field requirements

- `stages`: ordered array; earlier stages complete before later ones start
- `stages[].name`: descriptive stage name (e.g. "design", "implement", "validate")
- `stages[].parallel`: whether agents within this stage can run concurrently
- `stages[].agents[].type`: must be one of: `ux-designer`, `core-code-designer`, `graphics-designer`, `game-designer`, `love-architect`, `love-ux`, `coding`, `lua-coding`, `testing`, `love-testing`
- `stages[].agents[].context.focus`: specific, actionable instructions -- not vague
- `reasoning`: 1-3 sentences explaining the agent selection and ordering

## Game vs web tasks

- **LÖVE / Lua game**: Design stage (parallel: true): `game-designer`, `love-architect`, `love-ux`. Coding: `lua-coding`. Validation: `love-testing`. Do not use web designers (`ux-designer`, `core-code-designer`, `graphics-designer`) for LÖVE game design.
- **Web / UI**: Design: `ux-designer`, `graphics-designer`, `core-code-designer`. Implementation: `coding`. Validation: `testing`.
