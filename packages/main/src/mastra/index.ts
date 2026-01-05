import { mastra, mastraMemory, mastraStorage } from '../modules/agent/mastra/runtime.js';
import { Agent } from '@mastra/core/agent';

// Minimal static agent config so that Mastra Studio can discover at least one
// agent on startup (otherwise it会提示“Mastra agents are not configured yet”).
// 实际对局时仍然使用运行时在 intent-agent.ts 里创建的同名 agent。

const studioModelId =
  process.env.MASTRA_STUDIO_MODEL_ID ||
  process.env.OPENAI_MODEL_ID ||
  'gpt-4o-mini';

const studioApiKey =
  process.env.MASTRA_STUDIO_API_KEY ||
  process.env.OPENAI_API_KEY ||
  '';

// 如果没有 API Key，仍然注册 agent，只是实际在 Studio 里点执行时会报鉴权错误。
const studioAgent = new Agent({
  name: 'incarnation-intent-agent',
  instructions:
    'You are the global strategy and turn-planning agent for the card game "Incarnation". ' +
    'When used from Mastra Studio, you are mainly for debugging and trace inspection.',
  model: {
    providerId: 'openai',
    modelId: studioModelId,
    apiKey: studioApiKey,
  },
  tools: {},
  memory: mastraMemory,
  maxRetries: 0,
});

(mastra as any).agents ??= {};
(mastra as any).agents['incarnation-intent-agent'] = studioAgent;

// Re-export the Mastra runtime so that `mastra dev` (Studio) can discover the
// `mastra` instance for observability / AI tracing.
export { mastra, mastraMemory, mastraStorage };


