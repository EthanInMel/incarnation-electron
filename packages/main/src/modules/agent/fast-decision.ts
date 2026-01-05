/**
 * Fast Decision Engine - 快速决策引擎
 * 
 * 对于简单情况，跳过 LLM 调用，直接返回最优动作
 * 目标：降低延迟，节省 API 调用费用
 */

export interface FastDecisionResult {
  shouldUseLLM: boolean;
  actionId?: number;
  reason?: string;
  confidence?: number;
}

export interface GameSnapshot {
  turn?: number;
  is_my_turn?: boolean;
  you?: {
    hero_hp?: number;
    mana?: number;
    hand?: Array<{ card_id: number; name: string; mana_cost?: number }>;
  };
  opponent?: {
    hero_hp?: number;
  };
  self_units?: Array<{
    unit_id: number;
    name: string;
    label?: string;
    hp?: number;
    atk?: number;
    can_attack?: boolean;
    cell_index?: number;
  }>;
  enemy_units?: Array<{
    unit_id: number;
    name: string;
    label?: string;
    hp?: number;
    atk?: number;
    cell_index?: number;
  }>;
  tactical_preview?: Array<{
    unit_id: number;
    to_cell_index: number;
    attacks?: Array<{ target_unit_id: number; id_attack?: number }>;
  }>;
}

export interface GameAction {
  id: number;
  play_card?: { card_id: number; cell_index: number };
  move_unit?: { unit_id: number; to_cell_index: number };
  unit_attack?: { attacker_unit_id: number; target_unit_id?: number };
  hero_power?: boolean;
  end_turn?: boolean;
}

// ==================== 优先级目标名称 ====================

const PRIORITY_TARGETS = new Set([
  'cinda', 'ash', 'archer', 'crossbowman', 'manavault', 'mana vault'
]);

const HIGH_VALUE_TARGETS = new Set([
  'cinda', 'ash'
]);

// ==================== 核心决策函数 ====================

/**
 * 尝试快速决策
 * 返回 shouldUseLLM: false 表示可以直接使用返回的 actionId
 * 返回 shouldUseLLM: true 表示需要调用 LLM
 */
export function tryFastDecision(
  snapshot: GameSnapshot,
  actions: GameAction[],
  options: {
    aggressiveness?: number; // 0-1, 1 = 非常激进
    safetyFirst?: boolean;
  } = {}
): FastDecisionResult {
  if (!actions || actions.length === 0) {
    return { shouldUseLLM: false, reason: 'no_actions_available' };
  }

  const aggressiveness = options.aggressiveness ?? 0.5;
  const safetyFirst = options.safetyFirst ?? false;

  // 1. 检查是否只有 end_turn
  if (actions.length === 1 && actions[0].end_turn) {
    return { 
      shouldUseLLM: false, 
      actionId: actions[0].id, 
      reason: 'only_end_turn',
      confidence: 1.0
    };
  }

  // 2. 紧急防守：英雄 HP 很低
  const heroHp = snapshot.you?.hero_hp ?? 100;
  if (heroHp <= 5 && safetyFirst) {
    const defensiveAction = findDefensivePlay(snapshot, actions);
    if (defensiveAction) {
      return {
        shouldUseLLM: false,
        actionId: defensiveAction,
        reason: 'emergency_defense',
        confidence: 0.9
      };
    }
  }

  // 3. 检查是否有明显的斩杀机会
  const lethalKill = findLethalKill(snapshot, actions);
  if (lethalKill) {
    return {
      shouldUseLLM: false,
      actionId: lethalKill.actionId,
      reason: `lethal_kill_${lethalKill.targetName}`,
      confidence: 0.95
    };
  }

  // 4. 检查是否可以直接攻击敌方英雄获胜
  const enemyHp = snapshot.opponent?.hero_hp ?? 100;
  if (enemyHp <= 10) {
    const heroAttack = findHeroLethal(snapshot, actions, enemyHp);
    if (heroAttack) {
      return {
        shouldUseLLM: false,
        actionId: heroAttack,
        reason: 'hero_lethal',
        confidence: 0.98
      };
    }
  }

  // 5. 检查是否有高价值目标可斩杀（Cinda, Ash）
  const priorityKill = findPriorityTargetKill(snapshot, actions);
  if (priorityKill && priorityKill.confidence > 0.85) {
    return {
      shouldUseLLM: false,
      actionId: priorityKill.actionId,
      reason: `priority_kill_${priorityKill.targetName}`,
      confidence: priorityKill.confidence
    };
  }

  // 6. 简单情况：只有一个攻击动作
  const attackActions = actions.filter(a => a.unit_attack);
  if (attackActions.length === 1 && aggressiveness > 0.3) {
    const attack = attackActions[0];
    const target = snapshot.enemy_units?.find(
      u => u.unit_id === attack.unit_attack?.target_unit_id
    );
    
    // 确保不是自杀式攻击（攻击者会被反杀且对方不会死）
    if (target && !isSuicideAttack(snapshot, attack)) {
      return {
        shouldUseLLM: false,
        actionId: attack.id,
        reason: 'single_attack_option',
        confidence: 0.7
      };
    }
  }

  // 7. 检查移动后攻击机会
  const moveAttackOpportunity = findBestMoveAttack(snapshot, actions);
  if (moveAttackOpportunity && moveAttackOpportunity.confidence > 0.8) {
    return {
      shouldUseLLM: false,
      actionId: moveAttackOpportunity.moveActionId,
      reason: `move_then_attack_${moveAttackOpportunity.targetName}`,
      confidence: moveAttackOpportunity.confidence
    };
  }

  // 默认：需要 LLM 决策
  return { shouldUseLLM: true, reason: 'complex_situation' };
}

// ==================== 辅助函数 ====================

/**
 * 查找可以斩杀的目标
 */
function findLethalKill(
  snapshot: GameSnapshot,
  actions: GameAction[]
): { actionId: number; targetName: string } | null {
  const attackActions = actions.filter(a => a.unit_attack);
  
  for (const action of attackActions) {
    const attackerId = action.unit_attack?.attacker_unit_id;
    const targetId = action.unit_attack?.target_unit_id;
    
    if (!attackerId || !targetId) continue;
    
    const attacker = snapshot.self_units?.find(u => u.unit_id === attackerId);
    const target = snapshot.enemy_units?.find(u => u.unit_id === targetId);
    
    if (attacker && target && attacker.atk && target.hp) {
      if (attacker.atk >= target.hp) {
        return { actionId: action.id, targetName: target.name || 'unknown' };
      }
    }
  }
  
  return null;
}

/**
 * 查找可以斩杀敌方英雄的攻击组合
 */
function findHeroLethal(
  snapshot: GameSnapshot,
  actions: GameAction[],
  enemyHp: number
): number | null {
  // 查找直接攻击英雄的动作
  const heroAttacks = actions.filter(a => 
    a.unit_attack && !a.unit_attack.target_unit_id
  );
  
  // 计算总伤害
  let totalDamage = 0;
  let firstAttackId: number | null = null;
  
  for (const action of heroAttacks) {
    const attackerId = action.unit_attack?.attacker_unit_id;
    const attacker = snapshot.self_units?.find(u => u.unit_id === attackerId);
    
    if (attacker?.atk) {
      totalDamage += attacker.atk;
      if (!firstAttackId) firstAttackId = action.id;
    }
  }
  
  // 如果总伤害足够击杀英雄，返回第一个攻击
  if (totalDamage >= enemyHp && firstAttackId) {
    return firstAttackId;
  }
  
  return null;
}

/**
 * 查找高价值目标斩杀机会
 */
function findPriorityTargetKill(
  snapshot: GameSnapshot,
  actions: GameAction[]
): { actionId: number; targetName: string; confidence: number } | null {
  const attackActions = actions.filter(a => a.unit_attack);
  
  let bestKill: { actionId: number; targetName: string; confidence: number } | null = null;
  
  for (const action of attackActions) {
    const attackerId = action.unit_attack?.attacker_unit_id;
    const targetId = action.unit_attack?.target_unit_id;
    
    if (!attackerId || !targetId) continue;
    
    const attacker = snapshot.self_units?.find(u => u.unit_id === attackerId);
    const target = snapshot.enemy_units?.find(u => u.unit_id === targetId);
    
    if (!attacker || !target) continue;
    
    const targetName = (target.name || '').toLowerCase();
    const isHighValue = HIGH_VALUE_TARGETS.has(targetName);
    const isPriority = PRIORITY_TARGETS.has(targetName);
    const canKill = (attacker.atk || 0) >= (target.hp || 0);
    
    if (canKill && (isHighValue || isPriority)) {
      const confidence = isHighValue ? 0.95 : 0.88;
      
      if (!bestKill || confidence > bestKill.confidence) {
        bestKill = { actionId: action.id, targetName: target.name || 'unknown', confidence };
      }
    }
  }
  
  return bestKill;
}

/**
 * 查找最佳移动后攻击机会
 */
function findBestMoveAttack(
  snapshot: GameSnapshot,
  actions: GameAction[]
): { moveActionId: number; targetName: string; confidence: number } | null {
  const preview = snapshot.tactical_preview || [];
  if (preview.length === 0) return null;
  
  const moveActions = actions.filter(a => a.move_unit);
  
  let bestMove: { moveActionId: number; targetName: string; confidence: number } | null = null;
  
  for (const moveAction of moveActions) {
    const unitId = moveAction.move_unit?.unit_id;
    const toCell = moveAction.move_unit?.to_cell_index;
    
    if (unitId === undefined || toCell === undefined) continue;
    
    // 查找 tactical_preview 中的匹配项
    const previewItem = preview.find(p => 
      p.unit_id === unitId && p.to_cell_index === toCell
    );
    
    if (!previewItem?.attacks || previewItem.attacks.length === 0) continue;
    
    const attacker = snapshot.self_units?.find(u => u.unit_id === unitId);
    if (!attacker) continue;
    
    // 评估每个可攻击目标
    for (const attack of previewItem.attacks) {
      const target = snapshot.enemy_units?.find(u => u.unit_id === attack.target_unit_id);
      if (!target) continue;
      
      const targetName = (target.name || '').toLowerCase();
      const canKill = (attacker.atk || 0) >= (target.hp || 0);
      const isHighValue = HIGH_VALUE_TARGETS.has(targetName);
      const isPriority = PRIORITY_TARGETS.has(targetName);
      
      let confidence = 0.7;
      if (canKill) confidence += 0.15;
      if (isHighValue) confidence += 0.1;
      if (isPriority) confidence += 0.05;
      
      if (!bestMove || confidence > bestMove.confidence) {
        bestMove = { 
          moveActionId: moveAction.id, 
          targetName: target.name || 'unknown', 
          confidence 
        };
      }
    }
  }
  
  return bestMove;
}

/**
 * 查找防守性出牌
 */
function findDefensivePlay(
  snapshot: GameSnapshot,
  actions: GameAction[]
): number | null {
  const playActions = actions.filter(a => a.play_card);
  const mana = snapshot.you?.mana ?? 0;
  
  // 优先选择低费防守单位
  const defensiveCards = ['skeleton', 'fairy', 'tryx'];
  
  for (const cardName of defensiveCards) {
    const hand = snapshot.you?.hand || [];
    const card = hand.find(c => 
      (c.name || '').toLowerCase().includes(cardName) &&
      (c.mana_cost || 0) <= mana
    );
    
    if (card) {
      // 查找放在后排的动作
      const playAction = playActions.find(a => 
        a.play_card?.card_id === card.card_id
      );
      
      if (playAction) {
        return playAction.id;
      }
    }
  }
  
  return null;
}

/**
 * 检查是否是自杀式攻击（攻击者会死且目标不会死）
 */
function isSuicideAttack(
  snapshot: GameSnapshot,
  action: GameAction
): boolean {
  const attackerId = action.unit_attack?.attacker_unit_id;
  const targetId = action.unit_attack?.target_unit_id;
  
  if (!attackerId || !targetId) return false;
  
  const attacker = snapshot.self_units?.find(u => u.unit_id === attackerId);
  const target = snapshot.enemy_units?.find(u => u.unit_id === targetId);
  
  if (!attacker || !target) return false;
  
  const attackerHp = attacker.hp || 0;
  const attackerAtk = attacker.atk || 0;
  const targetHp = target.hp || 0;
  const targetAtk = target.atk || 0;
  
  // 攻击者会被反杀，且目标不会死
  const attackerDies = targetAtk >= attackerHp;
  const targetDies = attackerAtk >= targetHp;
  
  return attackerDies && !targetDies;
}

// ==================== 统计和调试 ====================

export interface FastDecisionStats {
  totalDecisions: number;
  fastDecisions: number;
  llmDecisions: number;
  fastDecisionReasons: Record<string, number>;
}

class FastDecisionTracker {
  private stats: FastDecisionStats = {
    totalDecisions: 0,
    fastDecisions: 0,
    llmDecisions: 0,
    fastDecisionReasons: {}
  };
  
  recordDecision(result: FastDecisionResult): void {
    this.stats.totalDecisions++;
    
    if (result.shouldUseLLM) {
      this.stats.llmDecisions++;
    } else {
      this.stats.fastDecisions++;
      const reason = result.reason || 'unknown';
      this.stats.fastDecisionReasons[reason] = 
        (this.stats.fastDecisionReasons[reason] || 0) + 1;
    }
  }
  
  getStats(): FastDecisionStats {
    return { ...this.stats };
  }
  
  reset(): void {
    this.stats = {
      totalDecisions: 0,
      fastDecisions: 0,
      llmDecisions: 0,
      fastDecisionReasons: {}
    };
  }
}

export const fastDecisionTracker = new FastDecisionTracker();

/**
 * 带统计的快速决策
 */
export function tryFastDecisionWithTracking(
  snapshot: GameSnapshot,
  actions: GameAction[],
  options?: Parameters<typeof tryFastDecision>[2]
): FastDecisionResult {
  const result = tryFastDecision(snapshot, actions, options);
  fastDecisionTracker.recordDecision(result);
  return result;
}











