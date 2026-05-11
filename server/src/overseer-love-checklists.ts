/** Appended to Overseer prompts when the pipeline stack is LÖVE (shared by bigboss-director + agent-runner). */

export const OVERSEER_LOVE_DESIGN_CHECKLIST = `## LÖVE design review checklist
- Module/scene plan: main.lua delegates to scenes; avoid a single giant file unless the task is trivial.
- Input: keyboard + gamepad covered if the task mentions multiplayer or controllers.
- Save/load or persistence: addressed if the task requires it.
- Screen flow: menus, gameplay, pause, game-over paths match the Original task.
- Performance-sensitive areas (many entities, particles) called out if relevant.`;

export const OVERSEER_LOVE_CODE_CHECKLIST = `## LÖVE code review checklist
- love.load / love.update / love.draw exist and match the design’s scene flow.
- require() graph is acyclic; no accidental globals for shared state.
- Input layer matches design (keys + gamepad as specified).
- Files referenced in spec.md / plan.md exist and implement the described behaviour.
- Pure logic modules are testable (minimal love.* calls inside hot logic paths).`;
