/**
 * Decision Tracker - 决策追溯系统
 * 
 * 功能：
 * 1. 记录每次决策的完整上下文
 * 2. 追踪决策结果（成功/失败）
 * 3. 分析失败模式
 * 4. 为 Prompt 改进提供数据支持
 */

// ==================== 类型定义 ====================

export interface DecisionRecord {
  id: string;
  timestamp: number;
  sessionId: string;
  turn: number;
  
  // 上下文
  context: {
    heroHp: number;
    enemyHeroHp: number;
    mana: number;
    handSize: number;
    selfUnitCount: number;
    enemyUnitCount: number;
    canAttackUnits: number;
  };
  
  // 决策
  decision: {
    mode: 'fast' | 'llm';
    actionId: number | null;
    reason: string;
    confidence?: number;
    llmLatencyMs?: number;
  };
  
  // LLM 相关（如果使用）
  llm?: {
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    rawPrompt?: string;
    rawResponse?: string;
    parsedPlan?: any;
  };
  
  // 结果
  result?: {
    success: boolean;
    executedActionId?: number;
    failureReason?: string;
    gameStateAfter?: {
      heroHp: number;
      enemyHeroHp: number;
      selfUnitCount: number;
      enemyUnitCount: number;
    };
  };
  
  // 回合结果
  turnOutcome?: {
    won: boolean;
    damageDealt: number;
    damageTaken: number;
    unitsLost: number;
    unitsKilled: number;
  };
}

export interface DecisionAnalysis {
  totalDecisions: number;
  fastDecisions: number;
  llmDecisions: number;
  successRate: number;
  averageLLMLatency: number;
  
  // 失败模式分析
  failurePatterns: Array<{
    pattern: string;
    count: number;
    examples: string[];
  }>;
  
  // 决策分布
  decisionDistribution: {
    attack: number;
    play: number;
    move: number;
    endTurn: number;
    other: number;
  };
  
  // 改进建议
  recommendations: string[];
}

// ==================== 决策追踪器 ====================

class DecisionTrackerImpl {
  private records: DecisionRecord[] = [];
  private currentSessionId: string = '';
  private maxRecords: number = 1000;
  
  constructor() {
    this.currentSessionId = this.generateSessionId();
  }
  
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  
  /**
   * 开始新会话
   */
  startNewSession(): string {
    this.currentSessionId = this.generateSessionId();
    return this.currentSessionId;
  }
  
  /**
   * 记录决策
   */
  recordDecision(params: {
    turn: number;
    snapshot: any;
    mode: 'fast' | 'llm';
    actionId: number | null;
    reason: string;
    confidence?: number;
    llmLatencyMs?: number;
    llmModel?: string;
    llmPrompt?: string;
    llmResponse?: string;
    llmTokens?: { prompt?: number; completion?: number };
    parsedPlan?: any;
  }): DecisionRecord {
    const record: DecisionRecord = {
      id: `decision_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      sessionId: this.currentSessionId,
      turn: params.turn,
      
      context: this.extractContext(params.snapshot),
      
      decision: {
        mode: params.mode,
        actionId: params.actionId,
        reason: params.reason,
        confidence: params.confidence,
        llmLatencyMs: params.llmLatencyMs
      }
    };
    
    // LLM 详情
    if (params.mode === 'llm' && params.llmModel) {
      record.llm = {
        model: params.llmModel,
        promptTokens: params.llmTokens?.prompt,
        completionTokens: params.llmTokens?.completion,
        rawPrompt: params.llmPrompt?.slice(0, 2000), // 截断以节省空间
        rawResponse: params.llmResponse?.slice(0, 2000),
        parsedPlan: params.parsedPlan
      };
    }
    
    this.records.push(record);
    this.pruneOldRecords();
    
    return record;
  }
  
  /**
   * 更新决策结果
   */
  updateDecisionResult(decisionId: string, result: {
    success: boolean;
    executedActionId?: number;
    failureReason?: string;
    snapshotAfter?: any;
  }): void {
    const record = this.records.find(r => r.id === decisionId);
    if (!record) return;
    
    record.result = {
      success: result.success,
      executedActionId: result.executedActionId,
      failureReason: result.failureReason,
      gameStateAfter: result.snapshotAfter ? {
        heroHp: result.snapshotAfter.you?.hero_hp ?? 0,
        enemyHeroHp: result.snapshotAfter.opponent?.hero_hp ?? 0,
        selfUnitCount: result.snapshotAfter.self_units?.length ?? 0,
        enemyUnitCount: result.snapshotAfter.enemy_units?.length ?? 0
      } : undefined
    };
  }
  
  /**
   * 记录回合结果
   */
  recordTurnOutcome(turn: number, outcome: {
    won: boolean;
    damageDealt: number;
    damageTaken: number;
    unitsLost: number;
    unitsKilled: number;
  }): void {
    // 找到该回合的所有决策并更新
    const turnRecords = this.records.filter(
      r => r.sessionId === this.currentSessionId && r.turn === turn
    );
    
    for (const record of turnRecords) {
      record.turnOutcome = outcome;
    }
  }
  
  /**
   * 分析决策历史
   */
  analyze(options: {
    sessionId?: string;
    lastN?: number;
  } = {}): DecisionAnalysis {
    let records = this.records;
    
    if (options.sessionId) {
      records = records.filter(r => r.sessionId === options.sessionId);
    }
    
    if (options.lastN) {
      records = records.slice(-options.lastN);
    }
    
    if (records.length === 0) {
      return this.emptyAnalysis();
    }
    
    // 基础统计
    const fastDecisions = records.filter(r => r.decision.mode === 'fast').length;
    const llmDecisions = records.filter(r => r.decision.mode === 'llm').length;
    const successfulDecisions = records.filter(r => r.result?.success).length;
    
    // LLM 延迟
    const llmLatencies = records
      .filter(r => r.decision.llmLatencyMs)
      .map(r => r.decision.llmLatencyMs!);
    const avgLatency = llmLatencies.length > 0 
      ? llmLatencies.reduce((a, b) => a + b, 0) / llmLatencies.length 
      : 0;
    
    // 失败模式分析
    const failurePatterns = this.analyzeFailurePatterns(records);
    
    // 决策分布
    const distribution = this.analyzeDecisionDistribution(records);
    
    // 生成建议
    const recommendations = this.generateRecommendations(records, failurePatterns);
    
    return {
      totalDecisions: records.length,
      fastDecisions,
      llmDecisions,
      successRate: records.length > 0 ? successfulDecisions / records.length : 0,
      averageLLMLatency: avgLatency,
      failurePatterns,
      decisionDistribution: distribution,
      recommendations
    };
  }
  
  /**
   * 获取最近的决策记录
   */
  getRecentDecisions(count: number = 10): DecisionRecord[] {
    return this.records.slice(-count);
  }
  
  /**
   * 获取当前会话的决策
   */
  getCurrentSessionDecisions(): DecisionRecord[] {
    return this.records.filter(r => r.sessionId === this.currentSessionId);
  }
  
  /**
   * 导出决策历史（用于调试）
   */
  exportHistory(): string {
    return JSON.stringify(this.records, null, 2);
  }
  
  /**
   * 清除历史
   */
  clearHistory(): void {
    this.records = [];
  }
  
  // ==================== 私有方法 ====================
  
  private extractContext(snapshot: any): DecisionRecord['context'] {
    const selfUnits = snapshot?.self_units || [];
    const canAttack = selfUnits.filter((u: any) => u.can_attack === true);
    
    return {
      heroHp: snapshot?.you?.hero_hp ?? 0,
      enemyHeroHp: snapshot?.opponent?.hero_hp ?? 0,
      mana: snapshot?.you?.mana ?? 0,
      handSize: snapshot?.you?.hand?.length ?? 0,
      selfUnitCount: selfUnits.length,
      enemyUnitCount: snapshot?.enemy_units?.length ?? 0,
      canAttackUnits: canAttack.length
    };
  }
  
  private pruneOldRecords(): void {
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }
  
  private analyzeFailurePatterns(records: DecisionRecord[]): DecisionAnalysis['failurePatterns'] {
    const failures = records.filter(r => r.result && !r.result.success);
    const patterns: Map<string, { count: number; examples: string[] }> = new Map();
    
    for (const failure of failures) {
      const reason = failure.result?.failureReason || 'unknown';
      const pattern = this.categorizeFailure(reason);
      
      const existing = patterns.get(pattern) || { count: 0, examples: [] };
      existing.count++;
      if (existing.examples.length < 3) {
        existing.examples.push(reason);
      }
      patterns.set(pattern, existing);
    }
    
    return Array.from(patterns.entries())
      .map(([pattern, data]) => ({ pattern, ...data }))
      .sort((a, b) => b.count - a.count);
  }
  
  private categorizeFailure(reason: string): string {
    const lower = reason.toLowerCase();
    
    if (lower.includes('not found') || lower.includes('cannot find')) {
      return 'name_resolution_failure';
    }
    if (lower.includes('out of range') || lower.includes('invalid cell')) {
      return 'position_error';
    }
    if (lower.includes('cannot attack') || lower.includes('no attack')) {
      return 'attack_unavailable';
    }
    if (lower.includes('mana') || lower.includes('cost')) {
      return 'insufficient_mana';
    }
    if (lower.includes('timeout')) {
      return 'timeout';
    }
    if (lower.includes('parse') || lower.includes('json')) {
      return 'llm_parse_error';
    }
    
    return 'other';
  }
  
  private analyzeDecisionDistribution(records: DecisionRecord[]): DecisionAnalysis['decisionDistribution'] {
    const dist = { attack: 0, play: 0, move: 0, endTurn: 0, other: 0 };
    
    for (const record of records) {
      const reason = record.decision.reason.toLowerCase();
      
      if (reason.includes('attack') || reason.includes('kill') || reason.includes('lethal')) {
        dist.attack++;
      } else if (reason.includes('play') || reason.includes('defense') || reason.includes('deploy')) {
        dist.play++;
      } else if (reason.includes('move') || reason.includes('advance')) {
        dist.move++;
      } else if (reason.includes('end_turn') || reason.includes('only_end')) {
        dist.endTurn++;
      } else {
        dist.other++;
      }
    }
    
    return dist;
  }
  
  private generateRecommendations(
    records: DecisionRecord[], 
    failurePatterns: DecisionAnalysis['failurePatterns']
  ): string[] {
    const recommendations: string[] = [];
    
    // 基于失败模式生成建议
    for (const pattern of failurePatterns) {
      if (pattern.count >= 3) {
        switch (pattern.pattern) {
          case 'name_resolution_failure':
            recommendations.push(
              `名称解析失败频繁 (${pattern.count}次)：建议检查 LLM 输出格式是否与单位名称一致，` +
              `或增加别名映射`
            );
            break;
          case 'attack_unavailable':
            recommendations.push(
              `攻击不可用错误 (${pattern.count}次)：LLM 可能在尝试攻击没有 ⚔️ 标记的单位，` +
              `建议在 Prompt 中强调攻击限制`
            );
            break;
          case 'llm_parse_error':
            recommendations.push(
              `LLM 响应解析失败 (${pattern.count}次)：建议简化输出格式要求，` +
              `或增加 JSON 修复逻辑`
            );
            break;
          case 'position_error':
            recommendations.push(
              `位置错误 (${pattern.count}次)：可能是 cell_index 计算问题，` +
              `建议检查棋盘方向和坐标系统`
            );
            break;
        }
      }
    }
    
    // 基于统计生成建议
    const llmRecords = records.filter(r => r.decision.mode === 'llm');
    if (llmRecords.length > 0) {
      const avgLatency = llmRecords
        .filter(r => r.decision.llmLatencyMs)
        .reduce((sum, r) => sum + (r.decision.llmLatencyMs || 0), 0) / llmRecords.length;
      
      if (avgLatency > 3000) {
        recommendations.push(
          `LLM 平均延迟 ${Math.round(avgLatency)}ms 偏高：` +
          `建议使用更快的模型或减少 Prompt 长度`
        );
      }
    }
    
    const fastRate = records.filter(r => r.decision.mode === 'fast').length / records.length;
    if (fastRate < 0.2) {
      recommendations.push(
        `快速决策率偏低 (${Math.round(fastRate * 100)}%)：` +
        `大多数情况都在调用 LLM，建议扩展快速决策的覆盖场景`
      );
    }
    
    return recommendations;
  }
  
  private emptyAnalysis(): DecisionAnalysis {
    return {
      totalDecisions: 0,
      fastDecisions: 0,
      llmDecisions: 0,
      successRate: 0,
      averageLLMLatency: 0,
      failurePatterns: [],
      decisionDistribution: { attack: 0, play: 0, move: 0, endTurn: 0, other: 0 },
      recommendations: []
    };
  }
}

// ==================== 全局实例 ====================

export const decisionTracker = new DecisionTrackerImpl();

// ==================== 便捷函数 ====================

/**
 * 记录快速决策
 */
export function trackFastDecision(params: {
  turn: number;
  snapshot: any;
  actionId: number | null;
  reason: string;
  confidence?: number;
}): DecisionRecord {
  return decisionTracker.recordDecision({
    ...params,
    mode: 'fast'
  });
}

/**
 * 记录 LLM 决策
 */
export function trackLLMDecision(params: {
  turn: number;
  snapshot: any;
  actionId: number | null;
  reason: string;
  latencyMs: number;
  model: string;
  prompt?: string;
  response?: string;
  tokens?: { prompt?: number; completion?: number };
  parsedPlan?: any;
}): DecisionRecord {
  return decisionTracker.recordDecision({
    turn: params.turn,
    snapshot: params.snapshot,
    mode: 'llm',
    actionId: params.actionId,
    reason: params.reason,
    llmLatencyMs: params.latencyMs,
    llmModel: params.model,
    llmPrompt: params.prompt,
    llmResponse: params.response,
    llmTokens: params.tokens,
    parsedPlan: params.parsedPlan
  });
}

/**
 * 获取决策分析报告
 */
export function getDecisionAnalysis(options?: {
  sessionId?: string;
  lastN?: number;
}): DecisionAnalysis {
  return decisionTracker.analyze(options);
}











