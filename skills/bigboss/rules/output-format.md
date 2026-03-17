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
- `stages[].agents[].type`: must be one of: `ux-designer`, `core-code-designer`, `graphics-designer`, `game-designer`, `coding`, `lua-coding`, `testing`
- `stages[].agents[].context.focus`: specific, actionable instructions -- not vague
- `reasoning`: 1-3 sentences explaining the agent selection and ordering

## Game vs web tasks

- **Full game / Lua / LÖVE**: In the design stage include **multiple** agents: `game-designer`, `core-code-designer`, `ux-designer`, `graphics-designer` (all in the same stage with parallel: true). Use `lua-coding` (not `coding`) for the coding stage. Do not use only one designer for a full videogame.
- **Web / UI**: Use `ux-designer`, `graphics-designer`, `core-code-designer` in design; `coding` for implementation.
