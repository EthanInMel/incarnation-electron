// Intent-driven (strategy-only) prompt used by Mastra agent line.

export const INTENT_SYSTEM_PROMPT = `你是策略卡牌战棋游戏的战略 AI，目标是击败敌方英雄并保护己方英雄。

⚠️ 你只负责「策略与意图」，不直接下达具体坐标 / 动作 ID：
- 不要输出 cell_index、id_move、id_attack、action_id 等底层字段。
- 只需要说明“谁要做什么、优先打谁、想达成什么局面”，由执行器在本地根据真实可执行动作自动换算为具体指令。

严格遵循以下规则，仅输出严格 JSON（不含任何多余文本）。

🔍 合法性与参考信息（概念层面）：
- 只能引用当前观测中真实存在的单位 / 卡牌 / 区域：
  - 友方单位：self_units[].name
  - 敌方单位：enemy_units[].name
  - 手牌 / 可出牌：you.hand[].name（注意：同名牌可能有 count>1）
  - 位置 / 区域：可以用“前排/中排/后排/左翼/右翼/靠近敌方英雄”等自然语言描述，而不是具体格子编号。
- 你不需要自己保证逐条动作的完全合法性（这一点由执行器根据 available_actions 校验），但不要设计明显不可能的计划（如让不存在的单位行动、攻击不存在的目标）。

🎯 攻击与威胁优先级（指导性，而非死板顺序）：
- 优先考虑：
  1) 直接或多步组合实现斩杀（kill 敌方英雄）；
  2) 集火高威胁随从：Cinda > Ash > 远程(Archer/Crossbowman) > 其他高价值/低 HP 单位；
  3) 在不送死的前提下，压低敌方英雄血量，建立场面优势。
- 若出现强力 combo（例如先移动到安全位置再攻击关键目标），可以为了 combo 略微牺牲「单步动作」的优先级，优先整体收益更高的多步计划。

🧠 策略层面的考虑（而非具体操作）：
- 明确本回合的主线：是「全力进攻」、「稳住防守」、「抢节奏铺场」还是「为下一回合做准备」。
- 对每个关键友方单位，说明它本回合的角色：进攻核心 / 关键防守 / 牵制 / 保护英雄 等。
- 对每个关键敌方单位，说明你打算如何处理：本回合击杀 / 压低血线 / 暂时无视 等。
- 可以提到你期望达成的局面，例如「让 Minotaur 站在前排中路，挡住 Cinda 的进攻路线」之类。

🧩 输出内容（只给出“意图”，由系统翻译为具体动作）：
- 只使用格式 B（高层意图），不要主动构造底层 turn_plan.steps 里的引擎字段。
- 关键要求：请遍历所有己方单位 self_units，为每个单位都给出本回合的意图；
  即使该单位本回合什么都不做，也要用 type="hold" 明确说明“保持位置 / 负责保护英雄 / 暂时观望”等原因。
- 每个 step 清晰描述一件事，包括：
  - type: "advance_and_attack" | "direct_attack" | "defensive_play" | "aggressive_play" | "reposition" | "develop_board" | "hold" | "end_turn"
  - unit: 主要执行该动作的友方单位名称（例如 "Minotaur"；若是 hold，建议明确指出是哪一个）
  - target: 关键敌方目标名称或“敌方英雄”（例如 "Cinda" / "Ash" / "Crossbowman" / "enemy_hero"）
  - card: 若涉及出牌，指出卡牌名称或大致效果（例如 "Skeleton" / "AOE spell"）
  - zone / direction: 期望的大致站位或方向（例如 "frontline_center" / "left_flank" / "safe_backline"）
  - intent: 一句简要中文，解释这一步的目的（例如 "用 Minotaur 顶住 Cinda，保护我方英雄"）。

✅ 严格输出 JSON（不含任何多余文本）。

输出格式（统一使用 B）：
{
  "steps": [
    {
      "type": "advance_and_attack" | "direct_attack" | "defensive_play" | "aggressive_play" | "reposition" | "develop_board" | "hold" | "end_turn",
      "unit": "可选，友方单位名称（若是 hold，建议明确写出具体单位名）",
      "target": "可选，敌方单位名称或 enemy_hero",
      "card": "可选，卡牌名称或简要说明",
      "zone": "可选，自然语言区域描述",
      "intent": "必须：一句话说明这步意图"
    }
  ]
}
`;

function buildFeedbackBlock(): string {
  try {
    const g: any = globalThis as any;
    const fb: any = g.__agent_last_feedback;
    if (!fb) return '';
    const failedSteps = Array.isArray(fb.steps) ? fb.steps.filter((s: any) => !s?.ok) : [];
    const failedIds = Array.isArray(fb.failed) ? fb.failed : [];
    if ((!failedSteps || failedSteps.length === 0) && (!failedIds || failedIds.length === 0)) return '';
    const lines: string[] = [];
    lines.push('⚠️ 上回合失败动作（避免重复）：');
    try {
      for (const s of failedSteps || []) {
        lines.push(`- id=${s?.id} ${s?.desc ? `(${s.desc})` : ''} reason=${s?.reason || 'unknown'}`);
      }
    } catch { }
    if (Array.isArray(failedIds) && failedIds.length) lines.push(`- failed ids: ${failedIds.join(', ')}`);
    return lines.join('\n');
  } catch {
    return '';
  }
}

export const buildIntentObservation = (snapshot: any) => {
  try {
    const selfObj = snapshot?.self || snapshot?.you || {};
    const enemyObj = snapshot?.enemy || snapshot?.opponent || {};

    const rawHand = Array.isArray(selfObj?.hand)
      ? selfObj.hand
      : Array.isArray(snapshot?.you?.hand)
        ? snapshot.you.hand
        : [];

    const handByCardId: Record<number, any> = {};
    for (const c of rawHand) {
      const cardId = Number(c?.card_id ?? c?.id);
      const name = String(c?.label ?? c?.name ?? '').trim();
      if (!Number.isFinite(cardId) || !name) continue;
      const entry = handByCardId[cardId] || {
        card_id: cardId,
        name,
        cost: c?.mana_cost ?? c?.cost,
        type: c?.type,
        desc: c?.desc,
        count: 0,
      };
      entry.name = entry.name || name;
      if (entry.cost == null) entry.cost = c?.mana_cost ?? c?.cost;
      if (entry.type == null) entry.type = c?.type;
      if (entry.desc == null) entry.desc = c?.desc;
      entry.count++;
      handByCardId[cardId] = entry;
    }

    const handSummary = Object.values(handByCardId).map((x: any) => ({
      name: x.name,
      cost: x.cost,
      type: x.type,
      desc: x.desc,
      card_id: x.card_id,
      count: x.count,
    }));

    const bucketDistance = (d: any) => {
      const n = Number(d);
      if (!Number.isFinite(n)) return undefined;
      if (n <= 0) return 'melee';
      if (n === 1) return 'near';
      if (n === 2) return 'mid';
      return 'far';
    };

    const myUnits = Array.isArray(snapshot?.self_units) ? snapshot.self_units : [];
    const enemyUnits = Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units : [];
    const myHP = Number(selfObj?.health ?? snapshot?.you?.hero_hp);
    const enemyHP = Number(enemyObj?.health ?? snapshot?.opponent?.hero_hp);
    const myCount = myUnits.length;
    const enemyCount = enemyUnits.length;
    const enemyRanged = enemyUnits.filter((u: any) => {
      const tp = String(u.attack_type || '').toLowerCase();
      const rng = Number(u.attack_range);
      return tp === 'ranged' || (Number.isFinite(rng) && rng > 1);
    }).length;

    let tempo: 'ahead' | 'even' | 'behind' = 'even';
    try {
      let score = 0;
      if (Number.isFinite(myHP) && Number.isFinite(enemyHP)) score += (enemyHP - myHP);
      score += (enemyCount - myCount) * 2;
      if (score >= 3) tempo = 'behind';
      else if (score <= -3) tempo = 'ahead';
    } catch {
      tempo = 'even';
    }

    let oppPosture: 'aggressive' | 'defensive' | 'develop' = 'develop';
    try {
      if (enemyRanged >= 2 || (enemyCount > myCount + 1 && enemyHP >= myHP)) oppPosture = 'aggressive';
      else if (enemyCount < myCount - 1 || enemyHP < myHP - 4) oppPosture = 'defensive';
      else oppPosture = 'develop';
    } catch {
      oppPosture = 'develop';
    }

    const obs: any = {
      turn: snapshot?.turn,
      you: {
        hero_hp: selfObj?.health ?? snapshot?.you?.hero_hp,
        mana: selfObj?.mana ?? snapshot?.you?.mana,
        hand: handSummary,
      },
      opponent: {
        hero_hp: enemyObj?.health ?? snapshot?.opponent?.hero_hp,
      },
      meta: {
        tempo,
        opponent_posture_guess: oppPosture,
        my_units: myCount,
        enemy_units: enemyCount,
      },
      self_units: myUnits.map((u: any) => ({
        name: u.label || u.name,
        is_hero: u.is_hero === true,
        role: u.is_hero === true ? 'hero' : 'unit',
        hp: u.hp,
        atk: u.atk,
        can_attack: u.can_attack,
        position: u.pos,
        distance_to_my_hero: u.distance_to_self_hero,
        distance_to_enemy_hero: u.distance_to_enemy_hero,
        distance_bucket_to_my_hero: bucketDistance(u.distance_to_self_hero),
        distance_bucket_to_enemy_hero: bucketDistance(u.distance_to_enemy_hero),
        move_range: u.move_range,
        attack_range: u.attack_range,
        attack_type: u.attack_type,
      })),
      enemy_units: enemyUnits.map((u: any) => ({
        name: u.label || u.name,
        is_hero: u.is_hero === true,
        role: u.is_hero === true ? 'hero' : 'unit',
        hp: u.hp,
        atk: u.atk,
        position: u.pos,
        distance_to_my_hero: u.distance_to_self_hero,
        distance_to_enemy_hero: u.distance_to_enemy_hero,
        distance_bucket_to_my_hero: bucketDistance(u.distance_to_self_hero),
        distance_bucket_to_enemy_hero: bucketDistance(u.distance_to_enemy_hero),
        move_range: u.move_range,
        attack_range: u.attack_range,
        attack_type: u.attack_type,
      })),
    };

    // Optional: pass through high-level hints if present (computed in AgentModule)
    if (snapshot?.attack_hints) obs.attack_hints = snapshot.attack_hints;

    return obs;
  } catch {
    return snapshot;
  }
};

export const buildIntentPrompt = (snapshot: any, cfg?: { model?: string; temperature?: number; maxTokens?: number }) => {
  const obs = buildIntentObservation(snapshot);
  const fb = buildFeedbackBlock();
  return {
    model: cfg?.model,
    messages: [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${fb ? fb + '\n\n' : ''}当前游戏状态：\n${JSON.stringify(obs, null, 2)}\n\n请只输出格式 B（steps 意图），不要输出 turn_plan。`,
      },
    ],
    temperature: typeof cfg?.temperature === 'number' ? cfg.temperature : 0.2,
    max_tokens: typeof cfg?.maxTokens === 'number' ? cfg.maxTokens : 512,
  };
};
