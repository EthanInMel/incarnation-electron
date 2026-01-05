import { Agent } from '@mastra/core';
import { RuntimeContext } from '@mastra/core/runtime-context';
import type { AgentConfig, SemanticIntentResponse } from '../types.js';
import { mastra, mastraMemory } from '../mastra/runtime.js';
import { buildSemanticReport } from '../semantic/perception.js';
import { SEMANTIC_V2_SYSTEM_PROMPT, buildSemanticV2UserContent } from '../semantic/prompt.js';

// NOTE:
// 旧版 runMastraIntentAgent / runMastraIntentAgentCandidates 已经被语义 v2 管线替代。
// 为了兼容 AgentModule 里的引用，这里提供一个“语义 v2 包裹”的实现：
// - 输入签名保持不变（cfg / snapshot / actions / tacticalPreview / strategy / lastFeedback / memory）
// - 内部直接调用 semantic agent，返回与旧结构兼容的字段（text / output / usage）

type MastraMemoryParams = {
  enabled?: boolean;
  threadId?: string;
  resourceId?: string;
  workingMemory?: string | null;
};

type LegacyRunParams = {
  cfg: AgentConfig;
  instructionsOverride?: string;
  snapshot: any;
  actions: any[];
  tacticalPreview?: any[];
  strategy?: any;
  lastFeedback?: any;
  memory?: MastraMemoryParams;
  n?: number;
};

type LegacyRunResult = {
  text: string | undefined;
  output: any | null;
  usage?: any;
};

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

const MAS_TRA_LEGACY_WRAPPER_ID = 'incarnation-legacy-wrapper-agent';

function safeParse(text: string | undefined): any | null {
  if (!text) return null;
  let s = String(text).trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*/i, '');
    const fenceEnd = s.lastIndexOf('```');
    if (fenceEnd > 0) s = s.slice(0, fenceEnd);
    s = s.trim();
  }
  s = s.replace(/^json\s*/i, '');
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function runMastraIntentAgent(params: LegacyRunParams): Promise<LegacyRunResult> {
  const { cfg, snapshot, actions, tacticalPreview = [], lastFeedback, memory } = params;

  // 直接重用 semantic v2 的语义报告 + 提示词
  const { report } = buildSemanticReport({
    snapshot,
    actions,
    tacticalPreview,
    enableHexBoard: cfg.hexBoardEnabled !== false,
  });
  const userContent = buildSemanticV2UserContent(report, memory?.workingMemory ?? null, lastFeedback);

  const agent = new Agent({
    name: MAS_TRA_LEGACY_WRAPPER_ID,
    instructions: SEMANTIC_V2_SYSTEM_PROMPT,
    model: buildModelConfig(cfg),
    tools: {},
    memory: mastraMemory,
    maxRetries: 1,
  });

  (mastra as any).agents ??= {};
  (mastra as any).agents[MAS_TRA_LEGACY_WRAPPER_ID] = agent;

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

  const result = await (agent as any).generate(
    [{ role: 'user', content: userContent }],
    {
      runtimeContext,
      toolChoice: 'none',
      maxSteps: Math.max(2, Math.min(6, Number(cfg.maxSteps || 6))),
      modelSettings: { temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.2 },
    },
  );

  const parsed = safeParse(result.text);
  return { text: result.text, output: parsed, usage: result.usage };
}

export async function runMastraIntentAgentCandidates(params: LegacyRunParams): Promise<LegacyRunResult> {
  // 简化：目前不再区分单计划 / 多候选，直接复用 runMastraIntentAgent 的输出，
  // 并包装成 { candidates: [...] } 结构，兼容 AgentModule 里对 .output.candidates 的访问。
  const base = await runMastraIntentAgent(params);
  let output: any = null;
  if (base.output && Array.isArray((base.output as SemanticIntentResponse)?.strategy)) {
    output = { candidates: [base.output] };
  } else if (base.output && Array.isArray(base.output.candidates)) {
    output = base.output;
  } else {
    output = { candidates: [] };
  }
  return { text: base.text, output, usage: base.usage };
}

