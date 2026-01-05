# Mastra Agent Integration (Electron Main)

This project uses **Mastra** directly (in-process) for the primary AI modes:

- `mastra_smart`: default Mastra agent (fast decision + Mastra multi-candidate planning + local scoring).
- `mastra_deep`: same agent but with more candidates / slightly deeper look-ahead (slower but stronger).

## What we do

- **Perception**: we reuse `buildIntentObservation()` from `../prompts.ts` to convert `snapshot + available_actions + tactical_preview` into a compact JSON observation.
- **Memory/Reflection**: we pass previous-turn failure feedback via `globalThis.__agent_last_feedback` and expose it to the agent with a tool.
- **Reasoning**: Mastra `Agent` runs with tool calling enabled and produces either:
  - A concrete `turn_plan`, or
  - A high-level `steps[]` intent plan.
- **Action**: we keep the existing Unity execution path (`turn_plan` → Unity, `plan_result`/`action_batch_summary` feedback back).

## Files

- `intent-agent.ts`: Mastra agent + tools for reading actions/preview/feedback.
- `AgentModule.ts`: `#decideIntentDriven()` uses Mastra by default for `mastra_smart` / `mastra_deep` / `intent_driven`, and falls back to legacy `callDispatcher()` only when `provider === "dispatcher"` (not OpenAI-compatible).

## Notes

- Mastra uses OpenAI-compatible endpoints via an `OpenAICompatibleConfig` model config.
- If you want to use a non-OpenAI-compatible `dispatcher`, keep `provider: "dispatcher"` for now and the system will use the legacy HTTP path.


