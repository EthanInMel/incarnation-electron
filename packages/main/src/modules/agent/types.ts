export type AgentConfig = {
  provider: string;
  model: string;
  baseUrl: string;
  bridgeToken?: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  maxTurnMs?: number;
  policyTimeoutMs?: number;
  endpoint?: string;
  decisionMode: 'intent' | 'hierarchical' | 'policy_only' | 'mixed' | 'intent_driven';
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
};

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
  myUnits: number;
  enemyUnits: number;
  myHP: number;
  enemyHP: number;
  myHand: number;
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
  mode: 'intent' | 'hierarchical' | 'policy_only' | 'auto' | 'intent_driven';
  actionId: number | null;
  reason?: string;
  nextStep?: PolicyStep | null;
  metadata?: any;
  deferExecution?: boolean;
};
