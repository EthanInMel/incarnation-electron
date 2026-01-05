/**
 * Agent 配置类型
 * 
 * 决策模式说明（对外推荐三档）：
 * - 'fast_only': 纯快速模式 - 只使用规则引擎，不调用 LLM（用于调试/低算力）
 * - 'mastra_smart': Mastra 智能模式（推荐）- 先尝试快速决策，再使用 Mastra 多候选+评分的 LLM 规划
 * - 'mastra_deep': Mastra 深度模式 - 类似 mastra_smart，但使用更多候选/更深 look-ahead（更慢但更强）
 *
 * 内部兼容模式：
 * - 'smart': 旧的智能模式别名，等价于 'mastra_smart'
 * - 'llm_only': 纯 LLM（跳过快速决策）
 *
 * 
 * 旧模式兼容性映射：
 * - 'intent' | 'intent_driven' | 'hierarchical' | 'mixed' -> 'smart'
 * - 'policy_only' -> 'llm_only'
 */
export type AgentConfig = {
  provider: string;
  model: string;
  baseUrl: string;
  upstreamProvider?: string;
  bridgeToken?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  maxTurnMs?: number;
  policyTimeoutMs?: number;
  endpoint?: string;
  
  // 新的简化决策模式
  decisionMode: 'fast_only' | 'mastra_smart' | 'mastra_deep' | 'smart' | 'llm_only' |
    // 保持向后兼容（将被映射到新模式）
    'intent' | 'hierarchical' | 'policy_only' | 'mixed' | 'intent_driven';
  
  // 快速决策配置
  fastDecisionEnabled?: boolean;       // 是否启用快速决策（默认 true）
  fastDecisionConfidenceThreshold?: number;  // 快速决策置信度阈值（默认 0.7）
  
  requireLLMTargetForAttack?: boolean;
  alwaysCallLLMOnOwnTurn?: boolean;
  strategyProfile?: 'aggressive' | 'balanced' | 'defensive';
  adaptiveTemp?: boolean;
  minTemp?: number;
  maxTemp?: number;
  nBest?: number;
  nBestParallel?: boolean;
  maxActions?: number;
  knowledge?: {
    weight?: number;
    global?: string;
    phase?: string;
    cards?: string;
  };
  systemPrompt?: string;
  fewshot?: string;
  orientationOverride?: 'auto' | 'as_is' | 'flipped';
  
  // 追踪和调试
  enableDecisionTracking?: boolean;    // 是否启用决策追踪（默认 true）
  debugMode?: boolean;                  // 调试模式

  // Mastra
  mastraMemoryEnabled?: boolean;        // 是否启用 Mastra 记忆（默认 true；仅 intent_driven 使用）

  // Decision pipeline
  // - legacy: intent steps -> (LLM2 optional) -> compiler v1 -> Unity action ids
  // - semantic_v2: semantic state -> semantic intents -> semantic solver -> Unity action ids
  decisionPipeline?: 'legacy' | 'semantic_v2'; // 默认 semantic_v2

  /**
   * 是否在 Semantic v2 报告中包含 hex_board（轴向坐标 + 邻接表）。
   * 默认 true；如果为 false，则不生成 hex_board 以节省 token。
   */
  hexBoardEnabled?: boolean;

  // Execution compiler (Intent -> Unity action ids)
  compiledExecutionEnabled?: boolean;   // 启用“编译执行层”（默认 true for mastra_* / intent_driven）
  compiledExecutionStrict?: boolean;    // 严格模式：只执行可验证的 action ids（默认 true）
  compiledExecutionMaxIds?: number;     // 每回合最多下发的 action ids（默认 6）
  compiledExecutionUseLLM2?: boolean;   // 是否启用二阶段 LLM 映射（默认 true；可显式设为 false 关闭）
};

// ===== Semantic v2 (new system) =====

export type SemanticIntentVerb =
  | 'KILL'
  | 'ATTACK'
  | 'POKE'
  | 'POSITION'
  | 'SCREEN'
  | 'PROTECT'
  | 'DEPLOY'
  | 'HOLD'
  | 'END_TURN';

export type SemanticIntent = {
  verb: SemanticIntentVerb;
  subject: string;          // unit name or "Hand(CardName)"
  target?: string | null;   // enemy unit name / ally name / zone id
  priority: number;         // 1..5
  reason: string;
  [k: string]: any;
};

export type SemanticIntentResponse = {
  strategy: SemanticIntent[];
  notes?: string;
};

export type Action = {
  id: number;
  type: string;
  payload: any; // Raw JSON from Unity
  unit_id?: number;
  card_id?: string | number;
  target_id?: number;
  cell_index?: number;
};

// --- Legacy Types (to be deprecated) ---

export type PolicyStep = {
  type: 'play' | 'move' | 'attack' | 'move_then_attack' | 'hero_power' | 'end_turn';
  card?: string;
  unit?: string;
  attacker?: string;
  target?: string;
  hint?: string;
  raw?: any;
  meta?: {
    index?: number;
    status?: 'pending' | 'queued' | 'executed';
    revision?: number;
    updatedAt?: number;
    pendingActionId?: number;
    reason?: string;
  };
};

export type PolicyBaseline = {
  turn: number;
  summary: {
  myUnits: number;
  enemyUnits: number;
  myHP: number;
  enemyHP: number;
  myHand: number;
  };
  digest?: string;
  createdAt?: number;
};

export type PolicyRuntimeState = {
  plan: any;
  steps: PolicyStep[];
  cursor: number;
  revision: number;
  lastOutcome?: {kind:'success'|'failure'; ts:number; detail?:any};
  baseline: PolicyBaseline | null;
  lastTurn?: string;
  digest?: string | null;
};

export type DecisionResult = {
  mode: 'fast_only' | 'mastra_smart' | 'mastra_deep' | 'smart' | 'llm_only' |
    // 向后兼容（内部使用）
    'intent' | 'hierarchical' | 'policy_only' | 'auto' | 'intent_driven';
  actionId: number | null;
  reason?: string;
  nextStep?: PolicyStep | null;
  metadata?: any;
  deferExecution?: boolean;
  
  // 新增字段
  method?: 'fast' | 'llm';           // 实际使用的决策方法
  confidence?: number;               // 决策置信度
  llmLatencyMs?: number;            // LLM 调用延迟
  trackingId?: string;              // 决策追踪 ID
};

// ==================== 工具函数 ====================

/**
 * 将旧决策模式映射到新模式
 */
export function normalizeDecisionMode(mode: AgentConfig['decisionMode']): 'smart' | 'llm_only' | 'fast_only' {
  switch (mode) {
    case 'smart':
    case 'mastra_smart':
    case 'mastra_deep':
    case 'intent':
    case 'intent_driven':
    case 'hierarchical':
    case 'mixed':
      return 'smart';
    case 'policy_only':
    case 'llm_only':
      return 'llm_only';
    case 'fast_only':
      return 'fast_only';
    default:
      return 'smart';
  }
}
