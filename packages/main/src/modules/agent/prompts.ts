// Improved LLM Prompts - Intent-Driven Approach

export const INTENT_SYSTEM_PROMPT = `你是策略卡牌战棋游戏的 AI，目标是击败敌方英雄并保护己方英雄。

严格遵循以下规则，仅输出严格 JSON（不含任何多余文本）。

🔒 回合校验（最高优先级）：
- 若 is_my_turn=false，严格返回：
{ "turn_plan": { "atomic": false, "auto_end": false, "steps": [] }, "rationale": "非我方回合" }

🔍 CRITICAL - 可用动作与优先级（务必满足合法性）：
- 每个 step 必须能在 available_actions 中找到对应动作；若包含 tactical_preview.combos 的 id_move/id_attack，优先使用这些 id。
- 优先级：1) unit_attack；2) tactical_preview 的 move→attack（同一 turn_plan 内先 move 再 unit_attack）；3) 纯 move（仅当能形成后续攻击或提高安全/威胁）；4) play_card；5) 其他；最后才考虑 end_turn（由 auto_end 自动追加）。
- 仅当 available_actions 含 hero_power 才能使用 hero_power。

📋 详细合法性约束：
- play_card: (card_id, cell_index) 必须出现在 available_actions.play_card 列表中。
- move: (unit_id, to_cell_index) 必须出现在 available_actions.move 列表中；同一单位每回合最多移动一次。
- unit_attack: (attacker_unit_id, target_unit_id) 必须出现在 available_actions.unit_attack 列表中。
- 禁止攻击本回合刚刚出牌的单位；禁止使用未提供的坐标或 id。

🎯 攻击目标优先级（从高到低）：斩杀 > Cinda > Ash > 远程(Archer/Crossbowman) > 其他高价值/低 HP > 敌方英雄。

🧩 批量规划：
- 返回：{"turn_plan":{"atomic":false,"auto_end":true,"steps":[ ... ]},"rationale":"<=30字简要理由"}
- 若能 move→attack，请在同一 turn_plan 中顺序输出 move→unit_attack；若 combos 提供 id_move/id_attack 字段，请一并包含在 step 中（便于直接执行）。

✅ 严格输出 JSON（不含任何多余文本）。`;

export const buildIntentObservation = (snapshot: any) => {
  try {
    // 简化的观测，只保留战略相关信息
    const obs = {
      turn: snapshot?.turn,
      you: {
        hero_hp: snapshot?.you?.hero_hp,
        mana: snapshot?.you?.mana,
        hand: (snapshot?.you?.hand || []).map((c: any) => ({
          name: c.label || c.name,
          cost: c.mana_cost
        }))
      },
      opponent: {
        hero_hp: snapshot?.opponent?.hero_hp
      },
      self_units: (snapshot?.self_units || []).map((u: any) => ({
        name: u.label || u.name,
        hp: u.hp,
        atk: u.atk,
        can_attack: u.can_attack,
        position: u.pos
      })),
      enemy_units: (snapshot?.enemy_units || []).map((u: any) => ({
        name: u.label || u.name,
        hp: u.hp,
        atk: u.atk,
        position: u.pos
      })),
      // 关键：移动攻击机会（仅概要）
      move_attack_opportunities: snapshot?.move_attack_opportunities || []
    };

    // 附加 available_actions 的精简视图（仅合法组合）
    try {
      const actions = (snapshot as any)?.available_actions || [];
      const compact:any = { play_card:[], move:[], unit_attack:[] };
      for (const a of (actions||[])) {
        if (a?.play_card) compact.play_card.push({ card_id:a.play_card.card_id, cell_index:a.play_card.cell_index });
        else if (a?.move_unit) compact.move.push({ unit_id:a.move_unit.unit_id, to_cell_index:a.move_unit.to_cell_index });
        else if (a?.unit_attack) compact.unit_attack.push({ attacker_unit_id:a.unit_attack.attacker_unit_id, target_unit_id:a.unit_attack.target_unit_id });
      }
      (obs as any).available_actions = compact;
    } catch {}

    // 附加 tactical_preview 的 combos（若有 id_move/id_attack）
    try {
      const tp = (snapshot as any)?.tactical_preview || [];
      const combos = Array.isArray(tp) ? tp.filter((x:any)=> x && (x.id_move!=null || (x.attacks && x.attacks.length>0))).slice(0,50) : [];
      (obs as any).tactical_preview = { combos };
    } catch {}

    return obs;
  } catch {
    return snapshot;
  }
};

export const buildIntentPrompt = (snapshot: any) => {
  const obs = buildIntentObservation(snapshot);
  return {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      { role: 'user', content: `当前游戏状态：\n${JSON.stringify(obs, null, 2)}\n\n请基于上述“规则”和“可用动作/预览”返回严格 JSON 的 turn_plan。` }
    ],
    temperature: 0.2,
    max_tokens: 512
  };
};

