/**
 * Prompt Template System - 可配置的 Prompt 模板
 * 
 * 设计目标：
 * 1. 将 Prompt 从代码中分离，便于迭代和 A/B 测试
 * 2. 支持动态变量替换
 * 3. 支持多语言（中/英）
 * 4. 支持不同的策略档案（aggressive/balanced/defensive）
 */

export interface PromptTemplate {
  id: string;
  version: string;
  language: 'zh' | 'en';
  system: string;
  rules: PromptRule[];
  examples?: PromptExample[];
  strategyModifiers?: Record<string, string>;
}

export interface PromptRule {
  id: string;
  priority: number;
  content: string;
  condition?: string; // 条件表达式，如 "hero_hp < 10"
}

export interface PromptExample {
  scenario: string;
  input: string;
  output: string;
}

// ==================== 默认模板 ====================

export const DEFAULT_POLICY_TEMPLATE: PromptTemplate = {
  id: 'policy_v2',
  version: '2.0.0',
  language: 'en',
  system: `You are a tactical AI for a HERO-BASED card battler game.

🎯 WIN CONDITION: Reduce enemy Hero HP to 0 while protecting YOUR Hero.
Heroes are fixed units on the board - deploy units to SHIELD your Hero and STRIKE enemy Hero.

Your job: Generate a concise, EXECUTABLE action plan in strict JSON.
The executor will translate card/unit NAMES to IDs automatically.

⚠️ CRITICAL RULES:
1. Only use units ALREADY on board with ⚔️ symbol for attack steps
2. Newly played cards CANNOT attack in the same turn
3. Keep plans simple: 3-5 steps maximum for reliability`,

  rules: [
    {
      id: 'output_format',
      priority: 100,
      content: `Return ONLY valid JSON in this EXACT format:
{ "analysis": "brief situation summary", "steps": [Step1, Step2, ...] }`
    },
    {
      id: 'step_types',
      priority: 90,
      content: `Step Types (use EXACT field names):
1. Play a card: { "type": "play", "card": "<CardName>", "hint": "<position_hint>" }
   - hint values: defensive_center | defensive_left | defensive_right | mid_center | mid_left | mid_right | offensive_center | offensive_left | offensive_right
   - defensive = near YOUR Hero (back row), offensive = near ENEMY Hero (front row)

2. Move a unit: { "type": "move", "unit": "<UnitName#N>", "hint": "forward|back|left|right" }
   - Use #N suffix for unit instances: Tryx#1, Skeleton#2, etc.

3. Attack with unit: { "type": "attack", "attacker": "<UnitName#N>", "target": "<EnemyName#N or Hero>" }
   - ONLY use units marked with ⚔️ in "Your units on board" section
   - target can be enemy unit name or "Hero" for direct hero attack

4. End turn: { "type": "end_turn" }`
    },
    {
      id: 'forbidden',
      priority: 85,
      content: `❌ NEVER use: card_id, unit_id, cell_index, rXcY coordinates
✅ ALWAYS use: English card/unit names from the observation`
    },
    {
      id: 'attack_priority',
      priority: 80,
      content: `Attack Target Priority (high to low):
1. Lethal kills (your ATK >= target HP)
2. High-threat units: Cinda, Ash, Ranged units (Archer/Crossbowman)
3. Low HP enemies
4. Enemy Hero (when path is clear)`
    }
  ],

  examples: [
    {
      scenario: 'Basic attack setup',
      input: 'Your Tryx#1 (⚔️) can attack, enemy has Cinda#1 (hp:3)',
      output: '{"analysis":"Tryx can kill Cinda","steps":[{"type":"attack","attacker":"Tryx#1","target":"Cinda#1"}]}'
    },
    {
      scenario: 'Deploy and position',
      input: 'Hand: Skeleton (cost:2), Mana: 3, Hero HP low',
      output: '{"analysis":"Need defense","steps":[{"type":"play","card":"Skeleton","hint":"defensive_center"}]}'
    }
  ],

  strategyModifiers: {
    aggressive: 'Prioritize attacking enemy Hero when possible. Take calculated risks for damage.',
    balanced: 'Balance offense and defense. Protect your Hero while looking for attack opportunities.',
    defensive: 'Prioritize protecting your Hero. Only attack when it\'s safe or removes immediate threats.'
  }
};

export const DEFAULT_INTENT_TEMPLATE: PromptTemplate = {
  id: 'intent_v2',
  version: '2.0.0',
  language: 'zh',
  system: `你是策略卡牌战棋游戏的 AI，目标是击败敌方英雄并保护己方英雄。

严格遵循以下规则，仅输出严格 JSON（不含任何多余文本）。

🔒 回合校验（最高优先级）：
- 若 is_my_turn=false，严格返回：
{ "turn_plan": { "atomic": false, "auto_end": false, "steps": [] }, "rationale": "非我方回合" }`,

  rules: [
    {
      id: 'validation',
      priority: 100,
      content: `每个 step 必须能在 available_actions 中找到对应动作。
优先级：1) unit_attack；2) move→attack 组合；3) play_card；4) 其他`
    },
    {
      id: 'legality',
      priority: 95,
      content: `合法性约束：
- play_card: (card_id, cell_index) 必须在 available_actions.play_card 中
- move: (unit_id, to_cell_index) 必须在 available_actions.move 中
- unit_attack: (attacker_unit_id, target_unit_id) 必须在 available_actions.unit_attack 中
- 禁止攻击本回合刚出的单位`
    },
    {
      id: 'target_priority',
      priority: 85,
      content: `攻击目标优先级（从高到低）：
斩杀 > Cinda > Ash > 远程(Archer/Crossbowman) > 其他高价值/低 HP > 敌方英雄`
    },
    {
      id: 'output_format',
      priority: 80,
      content: `输出格式：
{
  "turn_plan": { "atomic": false, "auto_end": true, "steps": [...] },
  "rationale": "<=30字简要理由"
}`
    }
  ],

  strategyModifiers: {
    aggressive: '优先进攻敌方英雄，可承受适度风险换取伤害',
    balanced: '攻防兼顾，保护己方英雄的同时寻找攻击机会',
    defensive: '优先保护己方英雄，仅在安全时攻击或清除直接威胁'
  }
};

// ==================== PromptBuilder 类 ====================

export class PromptBuilder {
  private templates: Map<string, PromptTemplate> = new Map();
  private activeTemplate: PromptTemplate;

  constructor(defaultTemplate?: PromptTemplate) {
    this.activeTemplate = defaultTemplate || DEFAULT_POLICY_TEMPLATE;
    this.templates.set(this.activeTemplate.id, this.activeTemplate);
    this.templates.set(DEFAULT_INTENT_TEMPLATE.id, DEFAULT_INTENT_TEMPLATE);
  }

  /**
   * 注册自定义模板
   */
  registerTemplate(template: PromptTemplate): void {
    this.templates.set(template.id, template);
  }

  /**
   * 切换活动模板
   */
  setActiveTemplate(templateId: string): boolean {
    const template = this.templates.get(templateId);
    if (template) {
      this.activeTemplate = template;
      return true;
    }
    return false;
  }

  /**
   * 构建系统 Prompt
   */
  buildSystemPrompt(options: {
    strategyProfile?: 'aggressive' | 'balanced' | 'defensive';
    customRules?: string[];
  } = {}): string {
    const parts: string[] = [this.activeTemplate.system];

    // 添加策略修饰
    if (options.strategyProfile && this.activeTemplate.strategyModifiers) {
      const modifier = this.activeTemplate.strategyModifiers[options.strategyProfile];
      if (modifier) {
        parts.push(`\n📊 Strategy Profile: ${options.strategyProfile.toUpperCase()}\n${modifier}`);
      }
    }

    // 添加自定义规则
    if (options.customRules && options.customRules.length > 0) {
      parts.push('\n📝 Additional Rules:');
      parts.push(...options.customRules.map(r => `- ${r}`));
    }

    return parts.join('\n');
  }

  /**
   * 构建用户 Prompt（包含游戏状态）
   */
  buildUserPrompt(observation: GameObservation, options: {
    includeFeedback?: boolean;
    feedback?: FailedActionFeedback;
    maxSteps?: number;
  } = {}): string {
    const parts: string[] = [];

    // 添加失败反馈
    if (options.includeFeedback && options.feedback) {
      parts.push(this.buildFeedbackBlock(options.feedback));
      parts.push('');
    }

    // 添加规则
    const sortedRules = [...this.activeTemplate.rules].sort((a, b) => b.priority - a.priority);
    for (const rule of sortedRules) {
      // 检查条件
      if (rule.condition && !this.evaluateCondition(rule.condition, observation)) {
        continue;
      }
      parts.push(rule.content);
      parts.push('');
    }

    // 添加游戏状态
    parts.push(this.buildGameStateBlock(observation));

    // 添加可用的移动攻击机会
    if (observation.move_attack_opportunities && observation.move_attack_opportunities.length > 0) {
      parts.push('');
      parts.push('💡 Move→Attack Opportunities (HIGH PRIORITY!):');
      for (const opp of observation.move_attack_opportunities) {
        parts.push(`- ${opp.unit} → can attack: ${opp.can_attack.join(' or ')}`);
      }
    }

    // 添加示例
    if (this.activeTemplate.examples && this.activeTemplate.examples.length > 0) {
      parts.push('');
      parts.push('📖 Examples:');
      for (const ex of this.activeTemplate.examples.slice(0, 2)) {
        parts.push(`Scenario: ${ex.scenario}`);
        parts.push(`Output: ${ex.output}`);
      }
    }

    // 添加步数限制提示
    const maxSteps = options.maxSteps || 6;
    parts.push('');
    parts.push(`⚠️ Maximum ${maxSteps} steps for reliability. End with end_turn if needed.`);

    return parts.join('\n');
  }

  /**
   * 构建反馈块
   */
  private buildFeedbackBlock(feedback: FailedActionFeedback): string {
    const lines: string[] = ['⚠️ Previous failed actions (avoid repeating):'];
    
    if (feedback.failedSteps && feedback.failedSteps.length > 0) {
      for (const step of feedback.failedSteps) {
        lines.push(`- ${step.type}: ${step.desc || 'unknown'} - reason: ${step.reason || 'unknown'}`);
      }
    }
    
    if (feedback.failedIds && feedback.failedIds.length > 0) {
      lines.push(`- Failed action IDs: ${feedback.failedIds.join(', ')}`);
    }
    
    return lines.join('\n');
  }

  /**
   * 构建游戏状态块
   */
  private buildGameStateBlock(obs: GameObservation): string {
    const lines: string[] = [];

    // 英雄状态
    lines.push('🏆 GAME STATE:');
    lines.push(`- YOUR HERO HP: ${obs.you?.hero_hp || 0}${obs.you?.hero_position ? ` (at ${obs.you.hero_position})` : ''}`);
    lines.push(`- ENEMY HERO HP: ${obs.opponent?.hero_hp || 0}${obs.opponent?.hero_position ? ` (at ${obs.opponent.hero_position})` : ''}`);
    
    // 危急提示
    if ((obs.you?.hero_hp || 0) < 10) {
      lines.push('- ⚠️ YOUR Hero HP is LOW! Prioritize DEFENSE!');
    }
    if ((obs.opponent?.hero_hp || 0) < 10) {
      lines.push('- 🎯 Enemy Hero HP is LOW! Consider direct attack!');
    }
    lines.push('');

    // 手牌
    lines.push('🎮 Cards in hand:');
    if (obs.you?.hand && obs.you.hand.length > 0) {
      const handStr = obs.you.hand.map(c => `${c.name}(cost:${c.mana_cost || 0})`).join(', ');
      lines.push(`${handStr} | Mana: ${obs.you.mana || 0}`);
    } else {
      lines.push('(empty)');
    }
    lines.push('');

    // 己方单位
    lines.push('🎮 Your units on board:');
    if (obs.self_units && obs.self_units.length > 0) {
      const unitsStr = obs.self_units.map(u => {
        const attackMark = u.can_attack ? ' ⚔️' : '';
        return `${u.label || u.name}(hp:${u.hp}/${u.max_hp || u.hp}, atk:${u.atk || 0}${attackMark})`;
      }).join(', ');
      lines.push(unitsStr);
      
      // 可攻击单位提示
      const canAttack = obs.self_units.filter(u => u.can_attack);
      if (canAttack.length > 0) {
        lines.push(`   ⚔️ Ready to attack: ${canAttack.map(u => u.label || u.name).join(', ')}`);
      } else {
        lines.push('   ❌ NO units ready to attack this turn');
      }
    } else {
      lines.push('NONE - no units on board yet!');
    }
    lines.push('');

    // 敌方单位
    lines.push('🎯 Enemy units:');
    if (obs.enemy_units && obs.enemy_units.length > 0) {
      const enemyStr = obs.enemy_units.map(u => 
        `${u.label || u.name}(hp:${u.hp}/${u.max_hp || u.hp}, atk:${u.atk || 0})`
      ).join(', ');
      lines.push(enemyStr);
    } else {
      lines.push('none');
    }

    return lines.join('\n');
  }

  /**
   * 简单条件求值
   */
  private evaluateCondition(condition: string, obs: GameObservation): boolean {
    try {
      // 简单条件支持：hero_hp < 10, enemy_count > 3 等
      const match = condition.match(/^(\w+)\s*([<>=!]+)\s*(\d+)$/);
      if (!match) return true;

      const [, field, op, valueStr] = match;
      const value = parseInt(valueStr, 10);
      
      let fieldValue: number | undefined;
      switch (field) {
        case 'hero_hp': fieldValue = obs.you?.hero_hp; break;
        case 'enemy_hp': fieldValue = obs.opponent?.hero_hp; break;
        case 'mana': fieldValue = obs.you?.mana; break;
        case 'hand_count': fieldValue = obs.you?.hand?.length; break;
        case 'unit_count': fieldValue = obs.self_units?.length; break;
        case 'enemy_count': fieldValue = obs.enemy_units?.length; break;
        default: return true;
      }

      if (fieldValue === undefined) return true;

      switch (op) {
        case '<': return fieldValue < value;
        case '<=': return fieldValue <= value;
        case '>': return fieldValue > value;
        case '>=': return fieldValue >= value;
        case '==': case '=': return fieldValue === value;
        case '!=': return fieldValue !== value;
        default: return true;
      }
    } catch {
      return true;
    }
  }

  /**
   * 获取当前模板信息
   */
  getTemplateInfo(): { id: string; version: string; language: string } {
    return {
      id: this.activeTemplate.id,
      version: this.activeTemplate.version,
      language: this.activeTemplate.language
    };
  }
}

// ==================== 类型定义 ====================

export interface GameObservation {
  turn?: number;
  is_my_turn?: boolean;
  you?: {
    hero_hp?: number;
    hero_position?: string;
    mana?: number;
    hand?: Array<{ name: string; mana_cost?: number; card_id?: number }>;
  };
  opponent?: {
    hero_hp?: number;
    hero_position?: string;
  };
  self_units?: Array<{
    unit_id?: number;
    name?: string;
    label?: string;
    hp?: number;
    max_hp?: number;
    atk?: number;
    can_attack?: boolean;
    cell_index?: number;
  }>;
  enemy_units?: Array<{
    unit_id?: number;
    name?: string;
    label?: string;
    hp?: number;
    max_hp?: number;
    atk?: number;
    cell_index?: number;
  }>;
  move_attack_opportunities?: Array<{
    unit: string;
    can_attack: string[];
  }>;
}

export interface FailedActionFeedback {
  failedSteps?: Array<{
    id?: number;
    type?: string;
    desc?: string;
    reason?: string;
  }>;
  failedIds?: number[];
}

// ==================== 工厂函数 ====================

let globalPromptBuilder: PromptBuilder | null = null;

export function getPromptBuilder(): PromptBuilder {
  if (!globalPromptBuilder) {
    globalPromptBuilder = new PromptBuilder();
  }
  return globalPromptBuilder;
}

export function resetPromptBuilder(template?: PromptTemplate): void {
  globalPromptBuilder = new PromptBuilder(template);
}











