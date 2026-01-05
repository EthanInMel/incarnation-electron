/**
 * Agent Core - 代理核心模块
 * 
 * 整合所有新功能，提供统一的 API：
 * - PromptBuilder: Prompt 模板系统
 * - NameResolver: 增强版名称解析
 * - FastDecision: 快速决策引擎
 * - DecisionTracker: 决策追溯系统
 */

// 重导出所有子模块
export * from './prompt-templates.js';
export * from './name-resolver.js';
export * from './fast-decision.js';
export * from './decision-tracker.js';

// 导入类型和核心功能
import { PromptBuilder, getPromptBuilder, type GameObservation, type FailedActionFeedback } from './prompt-templates.js';
import { resolveUnit, resolveCard, resolveUnitId, resolveCardId, isHeroTarget, generateUnitLabels, type NameMatch, type UnitInfo, type CardInfo } from './name-resolver.js';
import { tryFastDecision, tryFastDecisionWithTracking, type FastDecisionResult, type GameSnapshot, type GameAction } from './fast-decision.js';
import { decisionTracker, trackFastDecision, trackLLMDecision, getDecisionAnalysis, type DecisionRecord, type DecisionAnalysis } from './decision-tracker.js';
import type { AgentConfig } from './types.js';

// ==================== 统一决策接口 ====================

export interface DecisionContext {
  snapshot: GameSnapshot;
  actions: GameAction[];
  config: AgentConfig;
  feedback?: FailedActionFeedback;
}

export interface DecisionOutput {
  actionId: number | null;
  method: 'fast' | 'llm';
  reason: string;
  confidence?: number;
  plan?: any;
  llmLatencyMs?: number;
  record?: DecisionRecord;
}

/**
 * 核心决策引擎
 * 
 * 决策流程：
 * 1. 尝试快速决策
 * 2. 如果需要 LLM，构建 Prompt
 * 3. 调用 LLM 获取计划
 * 4. 解析并验证计划
 * 5. 记录决策供分析
 */
export class AgentCore {
  private promptBuilder: PromptBuilder;
  private config: AgentConfig;
  
  constructor(config: AgentConfig) {
    this.config = config;
    this.promptBuilder = getPromptBuilder();
  }
  
  /**
   * 更新配置
   */
  updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * 尝试快速决策
   */
  tryFastDecision(ctx: DecisionContext): FastDecisionResult {
    return tryFastDecisionWithTracking(ctx.snapshot, ctx.actions, {
      aggressiveness: this.getAggressiveness(),
      safetyFirst: this.config.strategyProfile === 'defensive'
    });
  }
  
  /**
   * 构建 LLM Prompt
   */
  buildPrompt(ctx: DecisionContext): { system: string; user: string } {
    // 转换快照为观测格式
    const observation = this.snapshotToObservation(ctx.snapshot);
    
    // 构建系统 Prompt
    const system = this.promptBuilder.buildSystemPrompt({
      strategyProfile: this.config.strategyProfile,
      customRules: this.getCustomRules()
    });
    
    // 构建用户 Prompt
    const user = this.promptBuilder.buildUserPrompt(observation, {
      includeFeedback: !!ctx.feedback,
      feedback: ctx.feedback,
      maxSteps: this.config.maxSteps
    });
    
    return { system, user };
  }
  
  /**
   * 解析单位名称
   */
  resolveUnitByName(
    snapshot: GameSnapshot, 
    name: string, 
    isEnemy: boolean = false
  ): NameMatch {
    const units = isEnemy ? snapshot.enemy_units : snapshot.self_units;
    return resolveUnit(units as UnitInfo[] || [], name);
  }
  
  /**
   * 解析卡牌名称
   */
  resolveCardByName(snapshot: GameSnapshot, name: string): NameMatch {
    const hand = snapshot.you?.hand || [];
    return resolveCard(hand as CardInfo[], name, {
      maxManaCost: snapshot.you?.mana
    });
  }
  
  /**
   * 记录快速决策
   */
  trackFastDecision(
    turn: number,
    snapshot: any,
    result: FastDecisionResult
  ): DecisionRecord {
    return trackFastDecision({
      turn,
      snapshot,
      actionId: result.actionId ?? null,
      reason: result.reason || 'fast_decision',
      confidence: result.confidence
    });
  }
  
  /**
   * 记录 LLM 决策
   */
  trackLLMDecision(params: {
    turn: number;
    snapshot: any;
    actionId: number | null;
    reason: string;
    latencyMs: number;
    prompt?: string;
    response?: string;
    parsedPlan?: any;
  }): DecisionRecord {
    return trackLLMDecision({
      ...params,
      model: this.config.model
    });
  }
  
  /**
   * 获取决策分析
   */
  getAnalysis(options?: { lastN?: number }): DecisionAnalysis {
    return getDecisionAnalysis(options);
  }
  
  /**
   * 开始新会话
   */
  startNewSession(): string {
    return decisionTracker.startNewSession();
  }
  
  // ==================== 私有方法 ====================
  
  private getAggressiveness(): number {
    switch (this.config.strategyProfile) {
      case 'aggressive': return 0.8;
      case 'defensive': return 0.2;
      default: return 0.5;
    }
  }
  
  private getCustomRules(): string[] {
    const rules: string[] = [];
    
    // 添加知识库规则
    if (this.config.knowledge?.global) {
      rules.push(this.config.knowledge.global);
    }
    
    // 添加自定义系统提示
    if (this.config.systemPrompt) {
      rules.push(this.config.systemPrompt);
    }
    
    return rules;
  }
  
  private snapshotToObservation(snapshot: GameSnapshot): GameObservation {
    // 为单位生成标签
    const selfUnits = generateUnitLabels(snapshot.self_units as UnitInfo[] || []);
    const enemyUnits = generateUnitLabels(snapshot.enemy_units as UnitInfo[] || []);
    
    // 提取移动攻击机会
    const moveAttackOpportunities = this.extractMoveAttackOpportunities(snapshot, selfUnits, enemyUnits);
    
    return {
      turn: snapshot.turn,
      is_my_turn: snapshot.is_my_turn,
      you: {
        hero_hp: snapshot.you?.hero_hp,
        mana: snapshot.you?.mana,
        hand: snapshot.you?.hand
      },
      opponent: {
        hero_hp: snapshot.opponent?.hero_hp
      },
      self_units: selfUnits,
      enemy_units: enemyUnits,
      move_attack_opportunities: moveAttackOpportunities
    };
  }
  
  private extractMoveAttackOpportunities(
    snapshot: GameSnapshot,
    selfUnits: UnitInfo[],
    enemyUnits: UnitInfo[]
  ): Array<{ unit: string; can_attack: string[] }> {
    const preview = snapshot.tactical_preview || [];
    if (preview.length === 0) return [];
    
    const opportunities: Array<{ unit: string; can_attack: string[] }> = [];
    const processedUnits = new Set<number>();
    
    for (const item of preview) {
      if (processedUnits.has(item.unit_id)) continue;
      if (!item.attacks || item.attacks.length === 0) continue;
      
      const unit = selfUnits.find(u => u.unit_id === item.unit_id);
      if (!unit) continue;
      
      const targets: string[] = [];
      for (const attack of item.attacks) {
        const target = enemyUnits.find(u => u.unit_id === attack.target_unit_id);
        if (target) {
          targets.push(target.label || target.name || `Unit${attack.target_unit_id}`);
        }
      }
      
      if (targets.length > 0) {
        opportunities.push({
          unit: unit.label || unit.name || `Unit${unit.unit_id}`,
          can_attack: [...new Set(targets)] // 去重
        });
        processedUnits.add(item.unit_id);
      }
    }
    
    return opportunities.slice(0, 8); // 限制数量
  }
}

// ==================== 全局实例 ====================

let globalAgentCore: AgentCore | null = null;

export function getAgentCore(config?: AgentConfig): AgentCore {
  if (!globalAgentCore && config) {
    globalAgentCore = new AgentCore(config);
  }
  if (!globalAgentCore) {
    throw new Error('AgentCore not initialized. Call getAgentCore(config) first.');
  }
  return globalAgentCore;
}

export function resetAgentCore(config: AgentConfig): AgentCore {
  globalAgentCore = new AgentCore(config);
  return globalAgentCore;
}

// ==================== 便捷函数 ====================

/**
 * 完整的决策流程（快速决策 -> LLM）
 */
export async function makeDecision(
  ctx: DecisionContext,
  callLLM: (system: string, user: string) => Promise<{ text: string; latencyMs: number; tokens?: { prompt?: number; completion?: number } }>
): Promise<DecisionOutput> {
  const core = getAgentCore(ctx.config);
  const turn = ctx.snapshot.turn ?? 0;
  
  // 1. 尝试快速决策
  const fastResult = core.tryFastDecision(ctx);
  
  if (!fastResult.shouldUseLLM && fastResult.actionId !== undefined) {
    const record = core.trackFastDecision(turn, ctx.snapshot, fastResult);
    return {
      actionId: fastResult.actionId,
      method: 'fast',
      reason: fastResult.reason || 'fast_decision',
      confidence: fastResult.confidence,
      record
    };
  }
  
  // 2. 需要 LLM 决策
  const { system, user } = core.buildPrompt(ctx);
  
  try {
    const startTime = Date.now();
    const llmResult = await callLLM(system, user);
    const latencyMs = llmResult.latencyMs || (Date.now() - startTime);
    
    // 3. 解析 LLM 响应
    const parsedPlan = parseJSONResponse(llmResult.text);
    
    // 4. 从计划中提取第一个动作
    const actionId = extractFirstActionId(parsedPlan, ctx);
    
    // 5. 记录决策
    const record = core.trackLLMDecision({
      turn,
      snapshot: ctx.snapshot,
      actionId,
      reason: parsedPlan?.analysis || 'llm_decision',
      latencyMs,
      prompt: user,
      response: llmResult.text,
      parsedPlan
    });
    
    return {
      actionId,
      method: 'llm',
      reason: parsedPlan?.analysis || 'llm_decision',
      plan: parsedPlan,
      llmLatencyMs: latencyMs,
      record
    };
  } catch (error) {
    // LLM 调用失败，使用 fallback
    console.error('[AgentCore] LLM call failed:', error);
    
    const fallbackAction = selectFallbackAction(ctx.actions);
    const record = core.trackFastDecision(turn, ctx.snapshot, {
      shouldUseLLM: false,
      actionId: fallbackAction ?? undefined,
      reason: 'llm_fallback',
      confidence: 0.3
    });
    
    return {
      actionId: fallbackAction,
      method: 'fast',
      reason: 'llm_fallback',
      confidence: 0.3,
      record
    };
  }
}

// ==================== 辅助函数 ====================

function parseJSONResponse(text: string): any {
  if (!text) return null;
  
  try {
    return JSON.parse(text);
  } catch {
    // 尝试提取 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractFirstActionId(plan: any, ctx: DecisionContext): number | null {
  if (!plan?.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return selectFallbackAction(ctx.actions);
  }
  
  const core = getAgentCore();
  const firstStep = plan.steps[0];
  const stepType = String(firstStep.type || '').toLowerCase();
  
  // 根据步骤类型查找对应的动作
  switch (stepType) {
    case 'attack': {
      const attackerName = firstStep.attacker;
      const targetName = firstStep.target;
      
      const attackerMatch = core.resolveUnitByName(ctx.snapshot, attackerName, false);
      if (!attackerMatch.matched) return null;
      
      const attackerId = attackerMatch.matchedItem?.unit_id;
      
      if (isHeroTarget(targetName)) {
        // 攻击英雄
        return ctx.actions.find(a => 
          a.unit_attack?.attacker_unit_id === attackerId && 
          !a.unit_attack?.target_unit_id
        )?.id ?? null;
      }
      
      const targetMatch = core.resolveUnitByName(ctx.snapshot, targetName, true);
      if (!targetMatch.matched) return null;
      
      const targetId = targetMatch.matchedItem?.unit_id;
      return ctx.actions.find(a => 
        a.unit_attack?.attacker_unit_id === attackerId &&
        a.unit_attack?.target_unit_id === targetId
      )?.id ?? null;
    }
    
    case 'play': {
      const cardName = firstStep.card;
      const cardMatch = core.resolveCardByName(ctx.snapshot, cardName);
      if (!cardMatch.matched) return null;
      
      const cardId = cardMatch.matchedItem?.card_id;
      // 返回第一个可用的放置位置
      return ctx.actions.find(a => a.play_card?.card_id === cardId)?.id ?? null;
    }
    
    case 'move': {
      const unitName = firstStep.unit;
      const unitMatch = core.resolveUnitByName(ctx.snapshot, unitName, false);
      if (!unitMatch.matched) return null;
      
      const unitId = unitMatch.matchedItem?.unit_id;
      // 返回第一个可用的移动
      return ctx.actions.find(a => a.move_unit?.unit_id === unitId)?.id ?? null;
    }
    
    case 'end_turn':
      return ctx.actions.find(a => a.end_turn)?.id ?? null;
    
    default:
      return null;
  }
}

function selectFallbackAction(actions: GameAction[]): number | null {
  // 优先级：攻击 > 出牌 > 移动 > 结束回合
  const attack = actions.find(a => a.unit_attack);
  if (attack) return attack.id;
  
  const play = actions.find(a => a.play_card);
  if (play) return play.id;
  
  const move = actions.find(a => a.move_unit);
  if (move) return move.id;
  
  const endTurn = actions.find(a => a.end_turn);
  return endTurn?.id ?? null;
}




