import { Agent } from '@mastra/core';
import { RuntimeContext } from '@mastra/core/runtime-context';
import type { AgentConfig, SemanticIntentResponse } from '../types.js';
import { mastra, mastraMemory } from '../mastra/runtime.js';
import { buildSemanticReport } from './perception.js';
import { SEMANTIC_V2_SYSTEM_PROMPT, buildSemanticV2UserContent } from './prompt.js';

export const MAS_TRA_SEMANTIC_AGENT_ID = 'incarnation-semantic-agent';

type MastraMemoryParams = {
  enabled?: boolean;
  threadId?: string;
  resourceId?: string;
  workingMemory?: string | null;
};

export type RunMastraSemanticAgentParams = {
  cfg: AgentConfig;
  memory?: MastraMemoryParams;
  snapshot: any;
  actions: any[];
  tacticalPreview: any[];
  strategy?: any;
  lastFeedback?: any;
};

export type RunMastraSemanticAgentResult = {
  text: string | undefined;
  output: SemanticIntentResponse | null;
  usage?: any;
};

function safeParseSemanticResponse(text: string | undefined): SemanticIntentResponse | null {
  if (!text) return null;
  let s = String(text).trim();

  // Strip common wrappers like ```json ... ``` or ``` ... ```
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*/i, '');
    const fenceEnd = s.lastIndexOf('```');
    if (fenceEnd > 0) s = s.slice(0, fenceEnd);
    s = s.trim();
  }

  // Strip leading "json" or "JSON" hint lines
  s = s.replace(/^json\s*/i, '');

  // Heuristic: keep substring from first '{' to last '}' to ignore any stray text
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(s) as SemanticIntentResponse;
  } catch {
    return null;
  }
}

function buildModelConfig(cfg: AgentConfig) {
  const url =
    cfg.baseUrl && cfg.baseUrl.trim().length > 0
      ? cfg.baseUrl
      : String(cfg.provider || '').toLowerCase() === 'siliconflow'
        ? 'https://api.siliconflow.cn/v1'
        : 'https://api.openai.com/v1';

  const headers: Record<string, string> = {};
  if (cfg.bridgeToken) headers['x-bridge-token'] = String(cfg.bridgeToken);
  if (cfg.upstreamProvider) {
    headers['x-upstream-provider'] = String(cfg.upstreamProvider);
    headers['x-provider'] = String(cfg.upstreamProvider);
  }
  if (!cfg.upstreamProvider && cfg.provider) headers['x-provider'] = String(cfg.provider);

  return {
    providerId: 'openai',
    modelId: String(cfg.model || ''),
    url,
    apiKey: cfg.apiKey,
    headers,
  };
}

export async function runMastraSemanticAgent(params: RunMastraSemanticAgentParams): Promise<RunMastraSemanticAgentResult> {
  const { cfg, memory, snapshot, actions, tacticalPreview, lastFeedback } = params;

  const agent = new Agent({
    name: MAS_TRA_SEMANTIC_AGENT_ID,
    instructions: SEMANTIC_V2_SYSTEM_PROMPT,
    model: buildModelConfig(cfg),
    tools: {},
    memory: mastraMemory,
    maxRetries: 1,
  });

  (mastra as any).agents ??= {};
  (mastra as any).agents[MAS_TRA_SEMANTIC_AGENT_ID] = agent;

  // runtime context kept for consistency (tracing) and potential future tool use
  const rt = { snapshot, actions, tacticalPreview, lastFeedback: lastFeedback ?? null };
  const runtimeContext = new RuntimeContext([['rt', rt]]);

  try {
    if (memory?.enabled !== false && memory?.workingMemory && memory.threadId && memory.resourceId) {
      await mastraMemory.updateWorkingMemory({
        threadId: memory.threadId,
        resourceId: memory.resourceId,
        workingMemory: memory.workingMemory,
      });
    }
  } catch { }

  const { report } = buildSemanticReport({
    snapshot,
    actions,
    tacticalPreview,
    enableHexBoard: cfg.hexBoardEnabled !== false,
  });
  const userContent = buildSemanticV2UserContent(report, memory?.workingMemory ?? null, lastFeedback);

  const result = await (agent as any).generate(
    [{ role: 'user', content: userContent }],
    {
      runtimeContext,
      toolChoice: 'none',
      maxSteps: Math.max(2, Math.min(6, Number(cfg.maxSteps || 6))),
      modelSettings: { temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.2 },
    },
  );

  const parsed = safeParseSemanticResponse(result.text);
  return { text: result.text, output: parsed, usage: result.usage };
}


