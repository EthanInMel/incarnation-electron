/**
 * Reinforcement Learning Module - 基于历史对局的强化学习系统
 * 
 * 设计目标：
 * 1. 从历史对局中提取状态-动作-奖励三元组
 * 2. 构建经验回放缓冲区
 * 3. 计算策略价值和优势估计
 * 4. 生成改进的决策建议
 * 5. 支持离线学习（无需实时训练）
 */

// ==================== 核心类型定义 ====================

/**
 * 游戏状态表示
 */
export interface GameState {
  turn: number;
  phase: 'early' | 'mid' | 'late';  // 游戏阶段
  
  // 己方状态
  selfHeroHp: number;
  selfMana: number;
  selfHandSize: number;
  selfUnitCount: number;
  selfTotalAttack: number;
  selfTotalHealth: number;
  selfCanAttackCount: number;
  
  // 敌方状态
  enemyHeroHp: number;
  enemyUnitCount: number;
  enemyTotalAttack: number;
  enemyTotalHealth: number;
  
  // 场面优势
  boardControl: number;      // -1 到 1，负数表示敌方优势
  tempoAdvantage: number;    // 节奏优势
  materialAdvantage: number; // 卡差优势
  
  // 特殊状态
  hasLethalThreat: boolean;  // 是否面临斩杀威胁
  canLethal: boolean;        // 是否可以斩杀对方
  priorityTargetsOnBoard: string[];  // 场上的高价值目标
}

/**
 * 动作类型
 */
export type ActionType = 'attack' | 'play_card' | 'move' | 'move_attack' | 'hero_power' | 'end_turn';

/**
 * 动作表示
 */
export interface GameAction {
  id: number;
  type: ActionType;
  
  // 动作详情
  cardName?: string;
  unitName?: string;
  targetName?: string;
  position?: string;
  
  // 动作元数据
  manaCost?: number;
  expectedDamage?: number;
  expectedValue?: number;
}

/**
 * 转换（Transition）- 强化学习的基本单元
 */
export interface Transition {
  id: string;
  sessionId: string;
  turn: number;
  timestamp: number;
  
  state: GameState;
  action: GameAction;
  nextState: GameState | null;  // null 表示游戏结束
  
  // 奖励信号
  reward: number;
  immediateReward: number;      // 即时奖励（伤害、斩杀等）
  strategicReward: number;      // 战略奖励（场面控制、节奏等）
  terminalReward: number;       // 终局奖励（胜负）
  
  // 元数据
  decisionMethod: 'fast' | 'llm';
  confidence: number;
  wasSuccessful: boolean;
}

/**
 * 对局摘要
 */
export interface GameSummary {
  sessionId: string;
  startTime: number;
  endTime: number;
  duration: number;
  
  // 结果
  won: boolean;
  finalTurn: number;
  selfFinalHp: number;
  enemyFinalHp: number;
  
  // 统计
  totalActions: number;
  attackActions: number;
  playActions: number;
  moveActions: number;
  
  // 表现指标
  averageReward: number;
  totalReward: number;
  decisionAccuracy: number;  // 决策成功率
  
  // 关键时刻
  keyMoments: Array<{
    turn: number;
    description: string;
    impact: number;  // 影响分数
  }>;
}

/**
 * 策略评估结果
 */
export interface PolicyEvaluation {
  stateKey: string;
  actionType: ActionType;
  
  // Q 值估计
  qValue: number;
  advantage: number;
  
  // 统计
  sampleCount: number;
  winRate: number;
  averageReward: number;
  
  // 置信区间
  confidenceLower: number;
  confidenceUpper: number;
}

// ==================== 奖励函数设计 ====================

/**
 * 奖励函数 - 设计核心
 */
export class RewardFunction {
  // 奖励权重（可调整）
  private weights = {
    // 即时奖励
    damageDealt: 0.1,           // 造成伤害
    unitKilled: 0.3,            // 击杀单位
    priorityKilled: 0.5,        // 击杀高价值目标
    heroDirectDamage: 0.2,      // 英雄直伤
    
    // 战略奖励
    boardControlGain: 0.4,      // 场面控制提升
    tempoGain: 0.2,             // 节奏提升
    materialGain: 0.3,          // 卡差提升
    threatRemoval: 0.4,         // 解除威胁
    
    // 惩罚
    unitLost: -0.2,             // 损失单位
    heroTaken: -0.15,           // 英雄受伤
    missedLethal: -1.0,         // 错过斩杀
    inefficientTrade: -0.3,     // 低效交换
    
    // 终局奖励
    win: 1.0,
    loss: -1.0,
    
    // 特殊情况
    perfectGame: 0.5,           // 完美对局（满血获胜）
    comeback: 0.3,              // 翻盘（从劣势获胜）
  };
  
  /**
   * 计算即时奖励
   */
  computeImmediateReward(
    prevState: GameState,
    action: GameAction,
    nextState: GameState
  ): number {
    let reward = 0;
    
    // 造成伤害奖励
    const damageTaken = prevState.enemyHeroHp - nextState.enemyHeroHp;
    if (damageTaken > 0) {
      reward += damageTaken * this.weights.damageDealt;
      
      // 英雄直伤额外奖励
      if (action.type === 'attack' && action.targetName?.toLowerCase() === 'hero') {
        reward += damageTaken * this.weights.heroDirectDamage;
      }
    }
    
    // 击杀单位奖励
    const unitsKilled = prevState.enemyUnitCount - nextState.enemyUnitCount;
    if (unitsKilled > 0) {
      reward += unitsKilled * this.weights.unitKilled;
      
      // 高价值目标奖励
      if (this.isPriorityTarget(action.targetName)) {
        reward += this.weights.priorityKilled;
      }
    }
    
    // 损失惩罚
    const unitsLost = prevState.selfUnitCount - nextState.selfUnitCount;
    if (unitsLost > 0) {
      reward += unitsLost * this.weights.unitLost;
    }
    
    const heroHpLost = prevState.selfHeroHp - nextState.selfHeroHp;
    if (heroHpLost > 0) {
      reward += heroHpLost * this.weights.heroTaken;
    }
    
    return reward;
  }
  
  /**
   * 计算战略奖励
   */
  computeStrategicReward(
    prevState: GameState,
    action: GameAction,
    nextState: GameState
  ): number {
    let reward = 0;
    
    // 场面控制变化
    const boardControlDelta = nextState.boardControl - prevState.boardControl;
    reward += boardControlDelta * this.weights.boardControlGain;
    
    // 节奏变化
    const tempoDelta = nextState.tempoAdvantage - prevState.tempoAdvantage;
    reward += tempoDelta * this.weights.tempoGain;
    
    // 卡差变化
    const materialDelta = nextState.materialAdvantage - prevState.materialAdvantage;
    reward += materialDelta * this.weights.materialGain;
    
    // 威胁解除
    if (prevState.hasLethalThreat && !nextState.hasLethalThreat) {
      reward += this.weights.threatRemoval;
    }
    
    // 错过斩杀惩罚
    if (prevState.canLethal && action.type === 'end_turn') {
      reward += this.weights.missedLethal;
    }
    
    return reward;
  }
  
  /**
   * 计算终局奖励
   */
  computeTerminalReward(
    finalState: GameState,
    won: boolean,
    gameHistory: Transition[]
  ): number {
    let reward = won ? this.weights.win : this.weights.loss;
    
    if (won) {
      // 完美对局奖励
      if (finalState.selfHeroHp >= 25) {
        reward += this.weights.perfectGame;
      }
      
      // 翻盘奖励
      const minHp = Math.min(...gameHistory.map(t => t.state.selfHeroHp));
      if (minHp <= 10) {
        reward += this.weights.comeback;
      }
    }
    
    return reward;
  }
  
  /**
   * 计算总奖励
   */
  computeTotalReward(
    prevState: GameState,
    action: GameAction,
    nextState: GameState | null,
    isTerminal: boolean,
    won?: boolean,
    gameHistory?: Transition[]
  ): { total: number; immediate: number; strategic: number; terminal: number } {
    if (!nextState) {
      // 游戏结束
      const terminal = this.computeTerminalReward(prevState, won || false, gameHistory || []);
      return { total: terminal, immediate: 0, strategic: 0, terminal };
    }
    
    const immediate = this.computeImmediateReward(prevState, action, nextState);
    const strategic = this.computeStrategicReward(prevState, action, nextState);
    const terminal = isTerminal && won !== undefined
      ? this.computeTerminalReward(nextState, won, gameHistory || [])
      : 0;
    
    return {
      total: immediate + strategic + terminal,
      immediate,
      strategic,
      terminal
    };
  }
  
  /**
   * 更新奖励权重（基于学习）
   */
  updateWeights(updates: Partial<typeof this.weights>): void {
    this.weights = { ...this.weights, ...updates };
  }
  
  private isPriorityTarget(targetName?: string): boolean {
    if (!targetName) return false;
    const name = targetName.toLowerCase();
    return ['cinda', 'ash', 'archer', 'crossbowman', 'manavault'].some(p => name.includes(p));
  }
}

// ==================== 经验回放缓冲区 ====================

/**
 * 经验回放缓冲区
 */
export class ExperienceReplayBuffer {
  private buffer: Transition[] = [];
  private maxSize: number;
  private prioritized: boolean;
  
  // 优先级相关
  private priorities: Map<string, number> = new Map();
  private alpha: number = 0.6;  // 优先级指数
  private beta: number = 0.4;   // 重要性采样指数
  
  constructor(maxSize: number = 100000, prioritized: boolean = true) {
    this.maxSize = maxSize;
    this.prioritized = prioritized;
  }
  
  /**
   * 添加转换
   */
  add(transition: Transition): void {
    // 计算初始优先级（使用 TD 误差或奖励绝对值）
    const priority = Math.abs(transition.reward) + 0.01;
    
    if (this.buffer.length >= this.maxSize) {
      // 移除最旧或最低优先级的
      if (this.prioritized) {
        const minPriorityIdx = this.findMinPriorityIndex();
        this.buffer.splice(minPriorityIdx, 1);
      } else {
        this.buffer.shift();
      }
    }
    
    this.buffer.push(transition);
    this.priorities.set(transition.id, priority);
  }
  
  /**
   * 批量添加（一局游戏的所有转换）
   */
  addBatch(transitions: Transition[]): void {
    for (const t of transitions) {
      this.add(t);
    }
  }
  
  /**
   * 采样
   */
  sample(batchSize: number): { transitions: Transition[]; weights: number[] } {
    if (this.buffer.length === 0) {
      return { transitions: [], weights: [] };
    }
    
    const actualSize = Math.min(batchSize, this.buffer.length);
    
    if (!this.prioritized) {
      // 均匀采样
      const indices = this.randomIndices(actualSize);
      return {
        transitions: indices.map(i => this.buffer[i]),
        weights: new Array(actualSize).fill(1.0)
      };
    }
    
    // 优先级采样
    const priorities = this.buffer.map(t => 
      Math.pow(this.priorities.get(t.id) || 0.01, this.alpha)
    );
    const totalPriority = priorities.reduce((a, b) => a + b, 0);
    const probabilities = priorities.map(p => p / totalPriority);
    
    const indices: number[] = [];
    const weights: number[] = [];
    const n = this.buffer.length;
    
    for (let i = 0; i < actualSize; i++) {
      const idx = this.sampleByProbability(probabilities);
      indices.push(idx);
      
      // 重要性采样权重
      const prob = probabilities[idx];
      const weight = Math.pow(n * prob, -this.beta);
      weights.push(weight);
    }
    
    // 归一化权重
    const maxWeight = Math.max(...weights);
    const normalizedWeights = weights.map(w => w / maxWeight);
    
    return {
      transitions: indices.map(i => this.buffer[i]),
      weights: normalizedWeights
    };
  }
  
  /**
   * 更新优先级
   */
  updatePriority(transitionId: string, tdError: number): void {
    const priority = Math.abs(tdError) + 0.01;
    this.priorities.set(transitionId, priority);
  }
  
  /**
   * 获取缓冲区大小
   */
  get size(): number {
    return this.buffer.length;
  }
  
  /**
   * 获取统计信息
   */
  getStats(): {
    size: number;
    avgReward: number;
    winRate: number;
    actionDistribution: Record<ActionType, number>;
  } {
    if (this.buffer.length === 0) {
      return {
        size: 0,
        avgReward: 0,
        winRate: 0,
        actionDistribution: {} as Record<ActionType, number>
      };
    }
    
    const rewards = this.buffer.map(t => t.reward);
    const avgReward = rewards.reduce((a, b) => a + b, 0) / rewards.length;
    
    // 计算胜率（基于终局奖励）
    const terminalTransitions = this.buffer.filter(t => t.terminalReward !== 0);
    const wins = terminalTransitions.filter(t => t.terminalReward > 0).length;
    const winRate = terminalTransitions.length > 0 ? wins / terminalTransitions.length : 0;
    
    // 动作分布
    const actionDistribution: Record<string, number> = {};
    for (const t of this.buffer) {
      actionDistribution[t.action.type] = (actionDistribution[t.action.type] || 0) + 1;
    }
    
    return {
      size: this.buffer.length,
      avgReward,
      winRate,
      actionDistribution: actionDistribution as Record<ActionType, number>
    };
  }
  
  /**
   * 导出数据
   */
  export(): Transition[] {
    return [...this.buffer];
  }
  
  /**
   * 导入数据
   */
  import(transitions: Transition[]): void {
    for (const t of transitions) {
      this.add(t);
    }
  }
  
  /**
   * 清空
   */
  clear(): void {
    this.buffer = [];
    this.priorities.clear();
  }
  
  private randomIndices(count: number): number[] {
    const indices: number[] = [];
    const used = new Set<number>();
    
    while (indices.length < count) {
      const idx = Math.floor(Math.random() * this.buffer.length);
      if (!used.has(idx)) {
        used.add(idx);
        indices.push(idx);
      }
    }
    
    return indices;
  }
  
  private sampleByProbability(probabilities: number[]): number {
    const r = Math.random();
    let cumulative = 0;
    
    for (let i = 0; i < probabilities.length; i++) {
      cumulative += probabilities[i];
      if (r <= cumulative) {
        return i;
      }
    }
    
    return probabilities.length - 1;
  }
  
  private findMinPriorityIndex(): number {
    let minIdx = 0;
    let minPriority = Infinity;
    
    for (let i = 0; i < this.buffer.length; i++) {
      const priority = this.priorities.get(this.buffer[i].id) || 0;
      if (priority < minPriority) {
        minPriority = priority;
        minIdx = i;
      }
    }
    
    return minIdx;
  }
}

// ==================== 状态提取器 ====================

/**
 * 从游戏快照提取状态表示
 */
export class StateExtractor {
  /**
   * 提取游戏状态
   */
  extract(snapshot: any): GameState {
    const turn = snapshot?.turn ?? 0;
    const phase = this.getPhase(turn);
    
    // 己方状态
    const selfHeroHp = snapshot?.you?.hero_hp ?? 30;
    const selfMana = snapshot?.you?.mana ?? 0;
    const selfHand = snapshot?.you?.hand ?? [];
    const selfUnits = snapshot?.self_units ?? [];
    
    // 敌方状态
    const enemyHeroHp = snapshot?.opponent?.hero_hp ?? 30;
    const enemyUnits = snapshot?.enemy_units ?? [];
    
    // 计算聚合值
    const selfTotalAttack = selfUnits.reduce((sum: number, u: any) => sum + (u.atk || 0), 0);
    const selfTotalHealth = selfUnits.reduce((sum: number, u: any) => sum + (u.hp || 0), 0);
    const selfCanAttackCount = selfUnits.filter((u: any) => u.can_attack).length;
    
    const enemyTotalAttack = enemyUnits.reduce((sum: number, u: any) => sum + (u.atk || 0), 0);
    const enemyTotalHealth = enemyUnits.reduce((sum: number, u: any) => sum + (u.hp || 0), 0);
    
    // 计算优势指标
    const boardControl = this.computeBoardControl(selfUnits, enemyUnits);
    const tempoAdvantage = this.computeTempoAdvantage(selfMana, selfCanAttackCount, selfUnits.length);
    const materialAdvantage = this.computeMaterialAdvantage(selfHand.length, selfUnits.length, enemyUnits.length);
    
    // 特殊状态检测
    const hasLethalThreat = enemyTotalAttack >= selfHeroHp;
    const canLethal = selfTotalAttack >= enemyHeroHp;
    const priorityTargetsOnBoard = this.findPriorityTargets(enemyUnits);
    
    return {
      turn,
      phase,
      selfHeroHp,
      selfMana,
      selfHandSize: selfHand.length,
      selfUnitCount: selfUnits.length,
      selfTotalAttack,
      selfTotalHealth,
      selfCanAttackCount,
      enemyHeroHp,
      enemyUnitCount: enemyUnits.length,
      enemyTotalAttack,
      enemyTotalHealth,
      boardControl,
      tempoAdvantage,
      materialAdvantage,
      hasLethalThreat,
      canLethal,
      priorityTargetsOnBoard
    };
  }
  
  /**
   * 生成状态键（用于聚合相似状态）
   */
  generateStateKey(state: GameState): string {
    // 离散化状态以便聚合
    const hpBucket = (hp: number) => Math.floor(hp / 5) * 5;
    const countBucket = (n: number) => Math.min(n, 5);
    
    return [
      state.phase,
      `sh${hpBucket(state.selfHeroHp)}`,
      `eh${hpBucket(state.enemyHeroHp)}`,
      `su${countBucket(state.selfUnitCount)}`,
      `eu${countBucket(state.enemyUnitCount)}`,
      `bc${Math.round(state.boardControl * 2)}`,
      state.hasLethalThreat ? 'lt' : '',
      state.canLethal ? 'cl' : ''
    ].filter(Boolean).join('_');
  }
  
  private getPhase(turn: number): 'early' | 'mid' | 'late' {
    if (turn <= 5) return 'early';
    if (turn <= 12) return 'mid';
    return 'late';
  }
  
  private computeBoardControl(selfUnits: any[], enemyUnits: any[]): number {
    const selfPower = selfUnits.reduce((sum, u) => sum + (u.atk || 0) + (u.hp || 0), 0);
    const enemyPower = enemyUnits.reduce((sum, u) => sum + (u.atk || 0) + (u.hp || 0), 0);
    
    if (selfPower + enemyPower === 0) return 0;
    return (selfPower - enemyPower) / (selfPower + enemyPower);
  }
  
  private computeTempoAdvantage(mana: number, canAttack: number, unitCount: number): number {
    // 简单的节奏评估：有法力、有能攻击的单位
    return (mana / 10) + (canAttack / Math.max(1, unitCount));
  }
  
  private computeMaterialAdvantage(handSize: number, selfUnits: number, enemyUnits: number): number {
    // 卡差 = 手牌数 + 场面单位差
    return (handSize - 3) / 5 + (selfUnits - enemyUnits) / 5;
  }
  
  private findPriorityTargets(enemyUnits: any[]): string[] {
    const priorityNames = ['cinda', 'ash', 'archer', 'crossbowman', 'manavault'];
    return enemyUnits
      .filter((u: any) => priorityNames.some(p => (u.name || '').toLowerCase().includes(p)))
      .map((u: any) => u.name || 'unknown');
  }
}

// ==================== 策略评估器 ====================

/**
 * 策略评估器 - 计算状态-动作价值
 */
export class PolicyEvaluator {
  private qTable: Map<string, Map<ActionType, PolicyEvaluation>> = new Map();
  private gamma: number = 0.95;  // 折扣因子
  private learningRate: number = 0.1;
  
  /**
   * 从经验数据学习
   */
  learn(transitions: Transition[]): void {
    const stateExtractor = new StateExtractor();
    
    for (const t of transitions) {
      const stateKey = stateExtractor.generateStateKey(t.state);
      const actionType = t.action.type;
      
      // 获取或初始化 Q 值
      if (!this.qTable.has(stateKey)) {
        this.qTable.set(stateKey, new Map());
      }
      
      const stateQ = this.qTable.get(stateKey)!;
      let evaluation = stateQ.get(actionType);
      
      if (!evaluation) {
        evaluation = {
          stateKey,
          actionType,
          qValue: 0,
          advantage: 0,
          sampleCount: 0,
          winRate: 0,
          averageReward: 0,
          confidenceLower: 0,
          confidenceUpper: 0
        };
      }
      
      // 更新 Q 值（简化的 Q-learning）
      const nextQ = t.nextState 
        ? this.getMaxQ(stateExtractor.generateStateKey(t.nextState))
        : 0;
      
      const target = t.reward + this.gamma * nextQ;
      evaluation.qValue += this.learningRate * (target - evaluation.qValue);
      
      // 更新统计
      evaluation.sampleCount++;
      evaluation.averageReward = 
        (evaluation.averageReward * (evaluation.sampleCount - 1) + t.reward) / evaluation.sampleCount;
      
      // 胜率更新（仅终局状态）
      if (t.terminalReward !== 0) {
        const won = t.terminalReward > 0 ? 1 : 0;
        const prevWins = evaluation.winRate * (evaluation.sampleCount - 1);
        evaluation.winRate = (prevWins + won) / evaluation.sampleCount;
      }
      
      // 计算置信区间
      const std = this.estimateStd(evaluation);
      const z = 1.96;  // 95% 置信区间
      evaluation.confidenceLower = evaluation.qValue - z * std;
      evaluation.confidenceUpper = evaluation.qValue + z * std;
      
      stateQ.set(actionType, evaluation);
    }
    
    // 计算优势函数
    this.computeAdvantages();
  }
  
  /**
   * 获取状态下最优动作建议
   */
  recommend(state: GameState): {
    bestAction: ActionType;
    qValue: number;
    confidence: number;
    alternatives: Array<{ action: ActionType; qValue: number; advantage: number }>;
  } | null {
    const stateExtractor = new StateExtractor();
    const stateKey = stateExtractor.generateStateKey(state);
    
    const stateQ = this.qTable.get(stateKey);
    if (!stateQ || stateQ.size === 0) {
      return null;
    }
    
    // 按 Q 值排序
    const sorted = Array.from(stateQ.values())
      .sort((a, b) => b.qValue - a.qValue);
    
    const best = sorted[0];
    const confidence = best.sampleCount > 10 
      ? Math.min(1, best.sampleCount / 100) 
      : 0.3;
    
    return {
      bestAction: best.actionType,
      qValue: best.qValue,
      confidence,
      alternatives: sorted.slice(1, 4).map(e => ({
        action: e.actionType,
        qValue: e.qValue,
        advantage: e.advantage
      }))
    };
  }
  
  /**
   * 导出 Q 表
   */
  export(): Record<string, Partial<Record<ActionType, PolicyEvaluation>>> {
    const result: Record<string, Partial<Record<ActionType, PolicyEvaluation>>> = {};
    
    for (const [stateKey, actionMap] of this.qTable) {
      result[stateKey] = {};
      for (const [action, eval_] of actionMap) {
        result[stateKey][action] = eval_;
      }
    }
    
    return result;
  }
  
  /**
   * 导入 Q 表
   */
  import(data: Record<string, Partial<Record<ActionType, PolicyEvaluation>>>): void {
    this.qTable.clear();
    
    for (const [stateKey, actionMap] of Object.entries(data)) {
      const map = new Map<ActionType, PolicyEvaluation>();
      for (const [action, eval_] of Object.entries(actionMap)) {
        map.set(action as ActionType, eval_);
      }
      this.qTable.set(stateKey, map);
    }
  }
  
  /**
   * 获取学习统计
   */
  getStats(): {
    totalStates: number;
    totalStateActionPairs: number;
    averageQValue: number;
    topActions: Array<{ stateKey: string; action: ActionType; qValue: number }>;
  } {
    let totalPairs = 0;
    let qSum = 0;
    const allPairs: Array<{ stateKey: string; action: ActionType; qValue: number }> = [];
    
    for (const [stateKey, actionMap] of this.qTable) {
      for (const [action, eval_] of actionMap) {
        totalPairs++;
        qSum += eval_.qValue;
        allPairs.push({ stateKey, action, qValue: eval_.qValue });
      }
    }
    
    allPairs.sort((a, b) => b.qValue - a.qValue);
    
    return {
      totalStates: this.qTable.size,
      totalStateActionPairs: totalPairs,
      averageQValue: totalPairs > 0 ? qSum / totalPairs : 0,
      topActions: allPairs.slice(0, 10)
    };
  }
  
  private getMaxQ(stateKey: string): number {
    const stateQ = this.qTable.get(stateKey);
    if (!stateQ || stateQ.size === 0) return 0;
    
    return Math.max(...Array.from(stateQ.values()).map(e => e.qValue));
  }
  
  private computeAdvantages(): void {
    for (const [stateKey, actionMap] of this.qTable) {
      // 计算状态价值 V(s) = max_a Q(s, a)
      const values = Array.from(actionMap.values()).map(e => e.qValue);
      const stateValue = Math.max(...values);
      
      // 优势 A(s, a) = Q(s, a) - V(s)
      for (const eval_ of actionMap.values()) {
        eval_.advantage = eval_.qValue - stateValue;
      }
    }
  }
  
  private estimateStd(evaluation: PolicyEvaluation): number {
    // 简化的标准差估计
    if (evaluation.sampleCount < 2) return 1.0;
    return 1.0 / Math.sqrt(evaluation.sampleCount);
  }
}

// ==================== 主学习系统 ====================

/**
 * 强化学习系统 - 主入口
 */
export class ReinforcementLearningSystem {
  private replayBuffer: ExperienceReplayBuffer;
  private rewardFunction: RewardFunction;
  private stateExtractor: StateExtractor;
  private policyEvaluator: PolicyEvaluator;
  
  private currentSession: string | null = null;
  private sessionTransitions: Transition[] = [];
  
  constructor(options: {
    bufferSize?: number;
    prioritizedReplay?: boolean;
  } = {}) {
    this.replayBuffer = new ExperienceReplayBuffer(
      options.bufferSize ?? 100000,
      options.prioritizedReplay ?? true
    );
    this.rewardFunction = new RewardFunction();
    this.stateExtractor = new StateExtractor();
    this.policyEvaluator = new PolicyEvaluator();
  }
  
  /**
   * 开始新对局
   */
  startGame(sessionId: string): void {
    this.currentSession = sessionId;
    this.sessionTransitions = [];
  }
  
  /**
   * 记录一步决策
   */
  recordStep(params: {
    snapshot: any;
    action: GameAction;
    nextSnapshot: any;
    decisionMethod: 'fast' | 'llm';
    confidence: number;
    wasSuccessful: boolean;
  }): Transition {
    const state = this.stateExtractor.extract(params.snapshot);
    const nextState = params.nextSnapshot 
      ? this.stateExtractor.extract(params.nextSnapshot)
      : null;
    
    // 计算奖励
    const rewards = this.rewardFunction.computeTotalReward(
      state,
      params.action,
      nextState,
      false
    );
    
    const transition: Transition = {
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      sessionId: this.currentSession || 'unknown',
      turn: state.turn,
      timestamp: Date.now(),
      state,
      action: params.action,
      nextState,
      reward: rewards.total,
      immediateReward: rewards.immediate,
      strategicReward: rewards.strategic,
      terminalReward: 0,
      decisionMethod: params.decisionMethod,
      confidence: params.confidence,
      wasSuccessful: params.wasSuccessful
    };
    
    this.sessionTransitions.push(transition);
    return transition;
  }
  
  /**
   * 结束对局
   */
  endGame(won: boolean, finalSnapshot: any): GameSummary {
    const finalState = this.stateExtractor.extract(finalSnapshot);
    
    // 计算终局奖励并更新所有转换
    const terminalReward = this.rewardFunction.computeTerminalReward(
      finalState,
      won,
      this.sessionTransitions
    );
    
    // 反向传播终局奖励（折扣）
    const gamma = 0.95;
    let discountedReward = terminalReward;
    
    for (let i = this.sessionTransitions.length - 1; i >= 0; i--) {
      const t = this.sessionTransitions[i];
      t.terminalReward = discountedReward;
      t.reward += discountedReward;
      discountedReward *= gamma;
    }
    
    // 添加到回放缓冲区
    this.replayBuffer.addBatch(this.sessionTransitions);
    
    // 生成对局摘要
    const summary = this.generateGameSummary(won, finalState);
    
    // 增量学习
    this.policyEvaluator.learn(this.sessionTransitions);
    
    // 清理
    this.sessionTransitions = [];
    this.currentSession = null;
    
    return summary;
  }
  
  /**
   * 批量学习（从历史数据）
   */
  batchLearn(batchSize: number = 64): {
    samplesLearned: number;
    avgLoss: number;
  } {
    const { transitions, weights } = this.replayBuffer.sample(batchSize);
    
    if (transitions.length === 0) {
      return { samplesLearned: 0, avgLoss: 0 };
    }
    
    this.policyEvaluator.learn(transitions);
    
    // 简化的损失计算
    const avgReward = transitions.reduce((sum, t) => sum + Math.abs(t.reward), 0) / transitions.length;
    
    return {
      samplesLearned: transitions.length,
      avgLoss: avgReward
    };
  }
  
  /**
   * 获取决策建议
   */
  getRecommendation(snapshot: any): {
    recommended: ActionType | null;
    confidence: number;
    qValue: number;
    alternatives: Array<{ action: ActionType; score: number }>;
    stateAnalysis: {
      phase: string;
      boardControl: number;
      hasLethalThreat: boolean;
      canLethal: boolean;
    };
  } {
    const state = this.stateExtractor.extract(snapshot);
    const recommendation = this.policyEvaluator.recommend(state);
    
    return {
      recommended: recommendation?.bestAction ?? null,
      confidence: recommendation?.confidence ?? 0,
      qValue: recommendation?.qValue ?? 0,
      alternatives: recommendation?.alternatives.map(a => ({
        action: a.action,
        score: a.qValue
      })) ?? [],
      stateAnalysis: {
        phase: state.phase,
        boardControl: state.boardControl,
        hasLethalThreat: state.hasLethalThreat,
        canLethal: state.canLethal
      }
    };
  }
  
  /**
   * 获取系统统计
   */
  getStats(): {
    buffer: ReturnType<ExperienceReplayBuffer['getStats']>;
    policy: ReturnType<PolicyEvaluator['getStats']>;
  } {
    return {
      buffer: this.replayBuffer.getStats(),
      policy: this.policyEvaluator.getStats()
    };
  }
  
  /**
   * 导出学习数据
   */
  exportData(): {
    transitions: Transition[];
    qTable: ReturnType<PolicyEvaluator['export']>;
  } {
    return {
      transitions: this.replayBuffer.export(),
      qTable: this.policyEvaluator.export()
    };
  }
  
  /**
   * 导入学习数据
   */
  importData(data: {
    transitions?: Transition[];
    qTable?: ReturnType<PolicyEvaluator['export']>;
  }): void {
    if (data.transitions) {
      this.replayBuffer.import(data.transitions);
    }
    if (data.qTable) {
      this.policyEvaluator.import(data.qTable);
    }
  }
  
  private generateGameSummary(won: boolean, finalState: GameState): GameSummary {
    const transitions = this.sessionTransitions;
    
    // 统计动作
    const actionCounts = {
      attack: 0,
      play: 0,
      move: 0
    };
    
    for (const t of transitions) {
      if (t.action.type === 'attack' || t.action.type === 'move_attack') {
        actionCounts.attack++;
      } else if (t.action.type === 'play_card') {
        actionCounts.play++;
      } else if (t.action.type === 'move') {
        actionCounts.move++;
      }
    }
    
    // 识别关键时刻
    const keyMoments: GameSummary['keyMoments'] = [];
    
    for (const t of transitions) {
      if (Math.abs(t.reward) > 0.5) {
        keyMoments.push({
          turn: t.turn,
          description: `${t.action.type} ${t.action.targetName || t.action.cardName || ''}`,
          impact: t.reward
        });
      }
    }
    
    keyMoments.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
    
    // 计算表现指标
    const rewards = transitions.map(t => t.reward);
    const avgReward = rewards.length > 0 
      ? rewards.reduce((a, b) => a + b, 0) / rewards.length 
      : 0;
    const totalReward = rewards.reduce((a, b) => a + b, 0);
    
    const successfulActions = transitions.filter(t => t.wasSuccessful).length;
    const decisionAccuracy = transitions.length > 0 
      ? successfulActions / transitions.length 
      : 0;
    
    return {
      sessionId: this.currentSession || 'unknown',
      startTime: transitions[0]?.timestamp || Date.now(),
      endTime: Date.now(),
      duration: transitions.length > 0 
        ? Date.now() - transitions[0].timestamp 
        : 0,
      won,
      finalTurn: finalState.turn,
      selfFinalHp: finalState.selfHeroHp,
      enemyFinalHp: finalState.enemyHeroHp,
      totalActions: transitions.length,
      attackActions: actionCounts.attack,
      playActions: actionCounts.play,
      moveActions: actionCounts.move,
      averageReward: avgReward,
      totalReward,
      decisionAccuracy,
      keyMoments: keyMoments.slice(0, 5)
    };
  }
}

// ==================== 全局实例 ====================

let globalRLSystem: ReinforcementLearningSystem | null = null;

export function getRLSystem(): ReinforcementLearningSystem {
  if (!globalRLSystem) {
    globalRLSystem = new ReinforcementLearningSystem();
  }
  return globalRLSystem;
}

export function resetRLSystem(options?: ConstructorParameters<typeof ReinforcementLearningSystem>[0]): void {
  globalRLSystem = new ReinforcementLearningSystem(options);
}




