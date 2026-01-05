/**
 * Prompt Optimizer - 基于强化学习的提示词自动优化系统
 * 
 * 参考论文:
 * 1. RLPrompt (2022): 使用强化学习优化离散文本提示词
 *    - https://arxiv.org/abs/2205.12548
 * 
 * 2. APO (2023): 自动提示优化 - 结合"梯度下降"和束搜索
 *    - https://arxiv.org/abs/2305.03495
 * 
 * 3. AutoHint (2023): 通过错误分析自动生成优化提示
 *    - https://arxiv.org/abs/2307.07415
 * 
 * 4. OPRO (2023): 使用 LLM 作为优化器
 *    - Google DeepMind 提出
 * 
 * 核心思想:
 * - 不微调模型参数，只优化提示词
 * - 使用历史对局数据作为反馈信号
 * - LLM 自我反思生成改进建议
 * - 多臂老虎机选择最佳提示词变体
 */

import type { AgentConfig } from './types.js';

// ==================== 类型定义 ====================

/**
 * 提示词变体
 */
export interface PromptVariant {
  id: string;
  version: number;
  
  // 提示词内容
  systemPrompt: string;
  ruleSnippets: string[];
  fewShotExamples: string[];
  
  // 元数据
  createdAt: number;
  parentId: string | null;      // 来源变体
  mutationType: MutationType;   // 变异类型
  
  // 性能统计
  stats: PromptStats;
}

/**
 * 提示词统计
 */
export interface PromptStats {
  totalGames: number;
  wins: number;
  winRate: number;
  
  // 详细指标
  avgReward: number;
  avgTurnsToWin: number;
  parseSuccessRate: number;    // LLM 输出解析成功率
  actionSuccessRate: number;   // 动作执行成功率
  
  // UCB 相关
  ucbScore: number;
  lastUpdated: number;
}

/**
 * 变异类型
 */
export type MutationType = 
  | 'initial'           // 初始版本
  | 'rephrase'          // 重新表述
  | 'add_rule'          // 添加规则
  | 'remove_rule'       // 删除规则
  | 'add_example'       // 添加示例
  | 'clarify'           // 澄清歧义
  | 'simplify'          // 简化
  | 'emphasize'         // 强调关键点
  | 'fix_failure';      // 修复失败模式

/**
 * 失败案例
 */
export interface FailureCase {
  id: string;
  promptVariantId: string;
  timestamp: number;
  
  // 上下文
  gameState: string;           // 状态摘要
  llmInput: string;            // 输入给 LLM 的内容
  llmOutput: string;           // LLM 输出
  
  // 失败信息
  failureType: FailureType;
  failureReason: string;
  expectedBehavior: string;    // 期望的行为
  
  // 影响
  rewardLoss: number;          // 造成的奖励损失
}

export type FailureType = 
  | 'parse_error'        // JSON 解析失败
  | 'invalid_action'     // 无效动作
  | 'name_mismatch'      // 名称解析失败
  | 'missed_lethal'      // 错过斩杀
  | 'inefficient_trade'  // 低效交换
  | 'ignored_threat'     // 忽视威胁
  | 'wrong_priority';    // 优先级错误

/**
 * 优化建议
 */
export interface OptimizationSuggestion {
  type: MutationType;
  description: string;
  newContent: string;
  confidence: number;
  basedOn: string[];           // 基于哪些失败案例
}

// ==================== 核心优化器 ====================

/**
 * Prompt 优化器主类
 * 
 * 工作流程:
 * 1. 收集失败案例
 * 2. 分析失败模式
 * 3. 生成优化建议
 * 4. 创建新的提示词变体
 * 5. 使用 UCB 算法选择变体
 * 6. 评估并迭代
 */
export class PromptOptimizer {
  private variants: Map<string, PromptVariant> = new Map();
  private activeVariantId: string | null = null;
  private failureCases: FailureCase[] = [];
  
  // UCB 参数
  private explorationParam: number = 1.41;  // sqrt(2)
  
  // LLM 调用函数（外部注入）
  private callLLM: ((prompt: string) => Promise<string>) | null = null;
  
  constructor() {
    // 创建初始变体
    this.createInitialVariant();
  }
  
  /**
   * 设置 LLM 调用函数
   */
  setLLMCaller(fn: (prompt: string) => Promise<string>): void {
    this.callLLM = fn;
  }
  
  /**
   * 获取当前活动的提示词
   */
  getActivePrompt(): PromptVariant | null {
    if (!this.activeVariantId) return null;
    return this.variants.get(this.activeVariantId) || null;
  }
  
  /**
   * 选择下一个要使用的提示词变体（UCB 算法）
   */
  selectVariant(): PromptVariant {
    const variants = Array.from(this.variants.values());
    
    if (variants.length === 0) {
      throw new Error('No variants available');
    }
    
    // 计算总试验次数
    const totalTrials = variants.reduce((sum, v) => sum + v.stats.totalGames, 0);
    
    // 计算每个变体的 UCB 分数
    let bestVariant = variants[0];
    let bestUCB = -Infinity;
    
    for (const variant of variants) {
      const ucb = this.computeUCB(variant, totalTrials);
      variant.stats.ucbScore = ucb;
      
      if (ucb > bestUCB) {
        bestUCB = ucb;
        bestVariant = variant;
      }
    }
    
    this.activeVariantId = bestVariant.id;
    return bestVariant;
  }
  
  /**
   * 记录对局结果
   */
  recordGameResult(result: {
    won: boolean;
    reward: number;
    turnsToEnd: number;
    parseErrors: number;
    totalActions: number;
    failedActions: number;
  }): void {
    const variant = this.getActivePrompt();
    if (!variant) return;
    
    // 更新统计
    const stats = variant.stats;
    stats.totalGames++;
    if (result.won) stats.wins++;
    stats.winRate = stats.wins / stats.totalGames;
    
    // 指数移动平均更新
    const alpha = 0.1;
    stats.avgReward = stats.avgReward * (1 - alpha) + result.reward * alpha;
    
    if (result.won) {
      stats.avgTurnsToWin = stats.avgTurnsToWin * (1 - alpha) + result.turnsToEnd * alpha;
    }
    
    const parseSuccess = 1 - (result.parseErrors / Math.max(1, result.totalActions));
    stats.parseSuccessRate = stats.parseSuccessRate * (1 - alpha) + parseSuccess * alpha;
    
    const actionSuccess = 1 - (result.failedActions / Math.max(1, result.totalActions));
    stats.actionSuccessRate = stats.actionSuccessRate * (1 - alpha) + actionSuccess * alpha;
    
    stats.lastUpdated = Date.now();
  }
  
  /**
   * 记录失败案例
   */
  recordFailure(failure: Omit<FailureCase, 'id' | 'promptVariantId' | 'timestamp'>): void {
    const variant = this.getActivePrompt();
    if (!variant) return;
    
    const failureCase: FailureCase = {
      id: `failure_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      promptVariantId: variant.id,
      timestamp: Date.now(),
      ...failure
    };
    
    this.failureCases.push(failureCase);
    
    // 保持合理大小
    if (this.failureCases.length > 1000) {
      this.failureCases = this.failureCases.slice(-800);
    }
  }
  
  /**
   * 分析失败模式
   */
  analyzeFailures(): Map<FailureType, FailureCase[]> {
    const grouped = new Map<FailureType, FailureCase[]>();
    
    for (const failure of this.failureCases) {
      const list = grouped.get(failure.failureType) || [];
      list.push(failure);
      grouped.set(failure.failureType, list);
    }
    
    return grouped;
  }
  
  /**
   * 生成优化建议（使用 LLM 自我反思）
   */
  async generateOptimizations(): Promise<OptimizationSuggestion[]> {
    if (!this.callLLM) {
      return this.generateRuleBasedOptimizations();
    }
    
    const failureAnalysis = this.analyzeFailures();
    const suggestions: OptimizationSuggestion[] = [];
    
    // 为每种主要失败类型生成优化建议
    for (const [failureType, cases] of failureAnalysis) {
      if (cases.length < 3) continue;  // 至少 3 个案例才分析
      
      const suggestion = await this.generateLLMOptimization(failureType, cases.slice(0, 5));
      if (suggestion) {
        suggestions.push(suggestion);
      }
    }
    
    return suggestions;
  }
  
  /**
   * 基于优化建议创建新变体
   */
  async createOptimizedVariant(suggestion: OptimizationSuggestion): Promise<PromptVariant> {
    const parent = this.getActivePrompt();
    if (!parent) {
      throw new Error('No active variant to optimize');
    }
    
    const newVariant: PromptVariant = {
      id: `variant_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      version: parent.version + 1,
      systemPrompt: parent.systemPrompt,
      ruleSnippets: [...parent.ruleSnippets],
      fewShotExamples: [...parent.fewShotExamples],
      createdAt: Date.now(),
      parentId: parent.id,
      mutationType: suggestion.type,
      stats: this.createEmptyStats()
    };
    
    // 应用变异
    this.applyMutation(newVariant, suggestion);
    
    this.variants.set(newVariant.id, newVariant);
    return newVariant;
  }
  
  /**
   * 自动优化循环（APO 风格）
   */
  async runOptimizationCycle(): Promise<{
    newVariants: PromptVariant[];
    suggestions: OptimizationSuggestion[];
  }> {
    // 1. 分析当前失败模式
    const failureAnalysis = this.analyzeFailures();
    
    // 2. 生成优化建议
    const suggestions = await this.generateOptimizations();
    
    // 3. 创建新变体
    const newVariants: PromptVariant[] = [];
    for (const suggestion of suggestions.slice(0, 3)) {  // 最多创建 3 个新变体
      try {
        const variant = await this.createOptimizedVariant(suggestion);
        newVariants.push(variant);
      } catch (e) {
        console.error('[PromptOptimizer] Failed to create variant:', e);
      }
    }
    
    // 4. 清理旧的低性能变体
    this.pruneVariants();
    
    return { newVariants, suggestions };
  }
  
  /**
   * 获取优化统计
   */
  getStats(): {
    totalVariants: number;
    activeVariant: { id: string; winRate: number; totalGames: number } | null;
    bestVariant: { id: string; winRate: number; totalGames: number } | null;
    failureCounts: Record<FailureType, number>;
    recentImprovements: number;
  } {
    const variants = Array.from(this.variants.values());
    const active = this.getActivePrompt();
    
    // 找最佳变体
    const qualified = variants.filter(v => v.stats.totalGames >= 10);
    const best = qualified.length > 0
      ? qualified.reduce((a, b) => a.stats.winRate > b.stats.winRate ? a : b)
      : null;
    
    // 统计失败类型
    const failureCounts: Record<string, number> = {};
    for (const failure of this.failureCases) {
      failureCounts[failure.failureType] = (failureCounts[failure.failureType] || 0) + 1;
    }
    
    // 计算最近改进
    const recentVariants = variants
      .filter(v => v.parentId && v.stats.totalGames >= 5)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);
    
    let improvements = 0;
    for (const v of recentVariants) {
      const parent = this.variants.get(v.parentId!);
      if (parent && v.stats.winRate > parent.stats.winRate) {
        improvements++;
      }
    }
    
    return {
      totalVariants: variants.length,
      activeVariant: active ? {
        id: active.id,
        winRate: active.stats.winRate,
        totalGames: active.stats.totalGames
      } : null,
      bestVariant: best ? {
        id: best.id,
        winRate: best.stats.winRate,
        totalGames: best.stats.totalGames
      } : null,
      failureCounts: failureCounts as Record<FailureType, number>,
      recentImprovements: improvements
    };
  }
  
  /**
   * 导出数据
   */
  exportData(): {
    variants: PromptVariant[];
    failureCases: FailureCase[];
    activeVariantId: string | null;
  } {
    return {
      variants: Array.from(this.variants.values()),
      failureCases: this.failureCases,
      activeVariantId: this.activeVariantId
    };
  }
  
  /**
   * 导入数据
   */
  importData(data: ReturnType<PromptOptimizer['exportData']>): void {
    this.variants.clear();
    for (const v of data.variants) {
      this.variants.set(v.id, v);
    }
    this.failureCases = data.failureCases || [];
    this.activeVariantId = data.activeVariantId;
  }
  
  // ==================== 私有方法 ====================
  
  private createInitialVariant(): void {
    const initial: PromptVariant = {
      id: 'variant_initial',
      version: 1,
      systemPrompt: INITIAL_SYSTEM_PROMPT,
      ruleSnippets: INITIAL_RULES,
      fewShotExamples: INITIAL_EXAMPLES,
      createdAt: Date.now(),
      parentId: null,
      mutationType: 'initial',
      stats: this.createEmptyStats()
    };
    
    this.variants.set(initial.id, initial);
    this.activeVariantId = initial.id;
  }
  
  private createEmptyStats(): PromptStats {
    return {
      totalGames: 0,
      wins: 0,
      winRate: 0,
      avgReward: 0,
      avgTurnsToWin: 15,
      parseSuccessRate: 1,
      actionSuccessRate: 1,
      ucbScore: 0,
      lastUpdated: Date.now()
    };
  }
  
  /**
   * UCB (Upper Confidence Bound) 计算
   */
  private computeUCB(variant: PromptVariant, totalTrials: number): number {
    const stats = variant.stats;
    
    if (stats.totalGames === 0) {
      return Infinity;  // 未探索的变体优先
    }
    
    // UCB1 公式: reward + c * sqrt(ln(N) / n)
    const exploitation = stats.winRate;
    const exploration = this.explorationParam * Math.sqrt(
      Math.log(totalTrials + 1) / stats.totalGames
    );
    
    // 额外考虑其他指标
    const bonus = 
      stats.parseSuccessRate * 0.1 + 
      stats.actionSuccessRate * 0.1;
    
    return exploitation + exploration + bonus;
  }
  
  /**
   * 基于规则的优化（无 LLM 时的备选）
   */
  private generateRuleBasedOptimizations(): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const failureAnalysis = this.analyzeFailures();
    
    // 解析错误 -> 简化输出格式
    const parseErrors = failureAnalysis.get('parse_error') || [];
    if (parseErrors.length >= 3) {
      suggestions.push({
        type: 'simplify',
        description: '简化 JSON 输出格式要求，减少解析错误',
        newContent: '输出格式必须是严格的 JSON，不要包含任何额外文本或注释。',
        confidence: 0.7,
        basedOn: parseErrors.slice(0, 3).map(f => f.id)
      });
    }
    
    // 名称匹配错误 -> 强调使用精确名称
    const nameMismatches = failureAnalysis.get('name_mismatch') || [];
    if (nameMismatches.length >= 3) {
      suggestions.push({
        type: 'emphasize',
        description: '强调必须使用观测中提供的精确名称',
        newContent: '⚠️ 重要：单位和卡牌名称必须与观测中提供的完全一致，包括 #N 后缀（如 Tryx#1）。',
        confidence: 0.8,
        basedOn: nameMismatches.slice(0, 3).map(f => f.id)
      });
    }
    
    // 错过斩杀 -> 添加斩杀检查规则
    const missedLethals = failureAnalysis.get('missed_lethal') || [];
    if (missedLethals.length >= 2) {
      suggestions.push({
        type: 'add_rule',
        description: '添加强制斩杀检查规则',
        newContent: '🔴 斩杀检查（最高优先级）：如果你的攻击力总和 >= 敌方英雄血量，必须优先尝试斩杀！',
        confidence: 0.9,
        basedOn: missedLethals.slice(0, 3).map(f => f.id)
      });
    }
    
    // 低效交换 -> 添加价值交换指南
    const inefficientTrades = failureAnalysis.get('inefficient_trade') || [];
    if (inefficientTrades.length >= 3) {
      suggestions.push({
        type: 'add_rule',
        description: '添加价值交换指南',
        newContent: '交换原则：攻击前检查 - 如果你的单位会死且敌方不会死，这是亏交换，除非是高价值目标（Cinda/Ash）。',
        confidence: 0.7,
        basedOn: inefficientTrades.slice(0, 3).map(f => f.id)
      });
    }
    
    return suggestions;
  }
  
  /**
   * 使用 LLM 生成优化建议（OPRO 风格）
   */
  private async generateLLMOptimization(
    failureType: FailureType,
    cases: FailureCase[]
  ): Promise<OptimizationSuggestion | null> {
    if (!this.callLLM) return null;
    
    const currentPrompt = this.getActivePrompt();
    if (!currentPrompt) return null;
    
    // 构建反思提示
    const reflectionPrompt = `你是一个提示词优化专家。分析以下失败案例并提出改进建议。

当前提示词片段:
${currentPrompt.ruleSnippets.join('\n')}

失败类型: ${failureType}

失败案例:
${cases.map((c, i) => `
案例 ${i + 1}:
- 游戏状态: ${c.gameState}
- LLM 输出: ${c.llmOutput}
- 失败原因: ${c.failureReason}
- 期望行为: ${c.expectedBehavior}
`).join('\n')}

请分析这些失败的根本原因，并提出一条简洁的规则或修改建议来避免类似错误。

输出格式 (JSON):
{
  "analysis": "失败原因分析",
  "suggestion_type": "add_rule|clarify|emphasize|simplify",
  "new_rule": "具体的新规则或修改内容（简洁，不超过 50 字）",
  "confidence": 0.0-1.0
}`;

    try {
      const response = await this.callLLM(reflectionPrompt);
      const parsed = JSON.parse(response);
      
      return {
        type: parsed.suggestion_type as MutationType,
        description: parsed.analysis,
        newContent: parsed.new_rule,
        confidence: parsed.confidence,
        basedOn: cases.map(c => c.id)
      };
    } catch (e) {
      console.error('[PromptOptimizer] LLM optimization failed:', e);
      return null;
    }
  }
  
  /**
   * 应用变异到新变体
   */
  private applyMutation(variant: PromptVariant, suggestion: OptimizationSuggestion): void {
    switch (suggestion.type) {
      case 'add_rule':
        variant.ruleSnippets.push(suggestion.newContent);
        break;
        
      case 'remove_rule':
        // 移除包含特定关键词的规则
        variant.ruleSnippets = variant.ruleSnippets.filter(
          r => !r.includes(suggestion.newContent)
        );
        break;
        
      case 'emphasize':
        // 将强调内容放在规则最前面
        variant.ruleSnippets.unshift(suggestion.newContent);
        break;
        
      case 'clarify':
      case 'rephrase':
        // 替换相关规则
        variant.ruleSnippets.push(suggestion.newContent);
        break;
        
      case 'simplify':
        // 简化：移除冗余规则，添加简化版本
        variant.ruleSnippets = variant.ruleSnippets.slice(0, 5);
        variant.ruleSnippets.push(suggestion.newContent);
        break;
        
      case 'add_example':
        variant.fewShotExamples.push(suggestion.newContent);
        break;
        
      case 'fix_failure':
        variant.ruleSnippets.push(suggestion.newContent);
        break;
    }
  }
  
  /**
   * 清理低性能变体
   */
  private pruneVariants(): void {
    const variants = Array.from(this.variants.values());
    
    // 保留条件：
    // 1. 初始变体
    // 2. 当前活动变体
    // 3. 试验次数不足的（< 20）
    // 4. 胜率在前 50% 的
    
    const qualified = variants.filter(v => v.stats.totalGames >= 20);
    if (qualified.length <= 5) return;  // 不够多，不清理
    
    const sorted = qualified.sort((a, b) => b.stats.winRate - a.stats.winRate);
    const threshold = sorted[Math.floor(sorted.length / 2)].stats.winRate;
    
    for (const variant of variants) {
      if (
        variant.mutationType === 'initial' ||
        variant.id === this.activeVariantId ||
        variant.stats.totalGames < 20
      ) {
        continue;
      }
      
      if (variant.stats.winRate < threshold && this.variants.size > 10) {
        this.variants.delete(variant.id);
      }
    }
  }
}

// ==================== 初始提示词模板 ====================

const INITIAL_SYSTEM_PROMPT = `你是一个卡牌战棋游戏的战术 AI。
目标：击败敌方英雄（将其 HP 降为 0），同时保护己方英雄。
输出：严格的 JSON 格式动作计划。`;

const INITIAL_RULES = [
  '🎯 输出格式: {"analysis": "分析", "steps": [...]}',
  '动作类型: play(出牌), attack(攻击), move(移动), end_turn(结束)',
  'play 格式: {"type": "play", "card": "卡牌名", "hint": "位置提示"}',
  'attack 格式: {"type": "attack", "attacker": "单位名#N", "target": "目标名#N 或 Hero"}',
  '⚠️ 只能使用标记 ⚔️ 的单位进行攻击',
  '攻击优先级: 斩杀 > Cinda > Ash > 远程单位 > 低血量 > 英雄',
];

const INITIAL_EXAMPLES = [
  '示例1: {"analysis":"Tryx#1可斩杀Cinda","steps":[{"type":"attack","attacker":"Tryx#1","target":"Cinda#1"}]}',
  '示例2: {"analysis":"防守出牌","steps":[{"type":"play","card":"Skeleton","hint":"defensive_center"}]}',
];

// ==================== 全局实例 ====================

let globalPromptOptimizer: PromptOptimizer | null = null;

export function getPromptOptimizer(): PromptOptimizer {
  if (!globalPromptOptimizer) {
    globalPromptOptimizer = new PromptOptimizer();
  }
  return globalPromptOptimizer;
}

export function resetPromptOptimizer(): PromptOptimizer {
  globalPromptOptimizer = new PromptOptimizer();
  return globalPromptOptimizer;
}











