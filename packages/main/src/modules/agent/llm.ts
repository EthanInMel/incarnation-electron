import axios from 'axios';
import type { AgentConfig } from './types.js';
import { buildHintsPromptBlock } from './card-hint-client.js';

function getDefaultBaseUrl(provider: string): string {
  const p = String(provider || '').toLowerCase();
  if (p === 'siliconflow') return 'https://api.siliconflow.cn/v1';
  // default to OpenAI compatible
  return 'https://api.openai.com/v1';
}

export async function callDispatcher(cfg: AgentConfig, payload: any) {
  const prov = String(cfg.provider || '').toLowerCase()
  // Dispatcher mode: treat baseUrl as dispatcher host and call /dispatch
  if (prov === 'dispatcher') {
    const endpoint = '/dispatch'
    const baseURL = cfg.baseUrl && cfg.baseUrl.trim().length > 0 ? cfg.baseUrl : 'http://localhost:3000'
    let attempt = 0; let lastErr: any = null
    while (attempt < 2) {
      try {
        const timeout = Math.max(5000, Math.min(60000, Number((cfg as any).policyTimeoutMs || cfg.maxTurnMs || 15000)));
        const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
        if ((cfg as any).apiKey) headers.Authorization = `Bearer ${(cfg as any).apiKey}`;
        const client = axios.create({ baseURL, timeout, headers });
        const upstream = cfg.upstreamProvider || 'siliconflow'
        const body = {
          provider: upstream,
          model: cfg.model,
          endpoint: cfg.endpoint || 'chat/completions',
          payload,
          source: 'electron-agent'
        }
        return await client.post(endpoint, body)
      } catch (e) {
        lastErr = e; await new Promise(r => setTimeout(r, 500 * (attempt + 1))); attempt++
      }
    }
    if (lastErr) throw lastErr
    throw new Error('dispatcher failed')
  }

  // Direct call to provider (OpenAI or SiliconFlow)
  const endpoint = `/${String(cfg.endpoint || 'chat/completions').replace(/^\/+/, '')}`;
  const baseURL = cfg.baseUrl && cfg.baseUrl.trim().length > 0 ? cfg.baseUrl : getDefaultBaseUrl(cfg.provider);

  let attempt = 0;
  let lastErr: any = null;
  while (attempt < 2) {
    try {
      const timeout = Math.max(5000, Math.min(60000, Number((cfg as any).policyTimeoutMs || cfg.maxTurnMs || 15000)));
      const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
      if ((cfg as any).apiKey) headers.Authorization = `Bearer ${(cfg as any).apiKey}`;
      // For custom OpenAI-compatible gateways: allow routing via headers like x-provider / x-upstream-provider
      if (cfg.upstreamProvider) {
        headers['x-upstream-provider'] = String(cfg.upstreamProvider);
        headers['x-provider'] = String(cfg.upstreamProvider);
      } else if (cfg.provider) {
        headers['x-provider'] = String(cfg.provider);
      }

      const client = axios.create({ baseURL, timeout, headers });
      // Ensure model and safety defaults
      const body = { ...payload } as any;
      body.model = cfg.model || body.model;
      if (typeof body.temperature !== 'number' && typeof cfg.temperature === 'number') body.temperature = cfg.temperature;
      if (typeof body.max_tokens !== 'number' && typeof cfg.maxTokens === 'number') body.max_tokens = cfg.maxTokens;
      // SiliconFlow requires enable_thinking=false for function/tool calls; keep compatible defaults
      if (String(cfg.provider || '').toLowerCase() === 'siliconflow' && body.tools) {
        if (typeof body.enable_thinking === 'undefined') body.enable_thinking = false
      }

      return await client.post(endpoint, body);
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      attempt++;
    }
  }
  // Normalize error
  const providerName = String(cfg.provider || '').toLowerCase();
  const hint = providerName === 'siliconflow'
    ? 'SiliconFlow 调用失败，请检查 API Key 与模型是否正确。文档: https://docs.siliconflow.cn/cn/api-reference/'
    : 'OpenAI 调用失败，请检查 API Key 与模型是否正确。';
  if (lastErr) {
    try { (lastErr as any).hint = hint } catch { }
    throw lastErr
  }
  const err = new Error(hint)
  throw err
}

export function buildPolicyPrompt(observation: any, snapshot: any, cfg: AgentConfig, clampTemp: (v: number) => number, strategy?: any) {
  // Optional feedback block based on last plan execution
  let feedbackBlock = ''
  try {
    const g: any = (globalThis as any)
    const fb: any = g.__agent_last_feedback
    if (fb) {
      const failedSteps = Array.isArray(fb.steps) ? fb.steps.filter((s: any) => !s?.ok) : []
      const failedIds = Array.isArray(fb.failed) ? fb.failed : []
      if ((failedSteps && failedSteps.length) || (failedIds && failedIds.length)) {
        const reasonLines: string[] = []
        try {
          for (const s of (failedSteps || [])) {
            const id = s?.id
            const rsn = s?.reason
            const desc = s?.desc
            reasonLines.push(`- id=${id} ${desc ? `(${desc})` : ''} reason=${rsn || 'unknown'}`.trim())
          }
        } catch { }
        if (Array.isArray(failedIds) && failedIds.length) reasonLines.push(`- failed ids: ${failedIds.join(', ')}`)
        feedbackBlock = ['', '⚠️ 上回合失败动作（避免重复）：', ...reasonLines].join('\n')
      }
    }
  } catch { }

  const baseSystemPrompt = [
    'You are a tactical AI for a hero-based card battler tactics game.',
    'Return ONLY valid JSON (no markdown, no extra text).',
    'Goal priority: protect your Hero, remove threats, then pressure/kill enemy Hero.',
    'CRITICAL: never invent cards/units/positions. Use only the observation below.',
    'OUTPUT CONSTRAINTS: your returned JSON steps MUST NOT contain ids (card_id/unit_id/cell_index) or coordinates (row/col/rXcY).',
    'Use ONLY English card/unit names from the observation and the allowed "hint" fields.',
    'Newly played units cannot attack in the same plan.',
  ].join(' ');

  const playerTacticsBlock = (() => {
    try {
      const s = String((cfg as any)?.systemPrompt || '').trim()
      if (!s) return ''
      return ['','🧠 玩家战术偏好（不允许违反合法性/可用动作，仅作倾向）:', s].join('\n')
    } catch { return '' }
  })()

  const hintsBlock = (() => {
    try {
      const hb = buildHintsPromptBlock(snapshot)
      if (!hb) return ''
      return ['','🧠 玩家自定义卡牌提示词（cards hints）:', hb].join('\n')
    } catch { return '' }
  })()

  const fmtUnit = (u: any) => {
    try {
      const nm = u?.label || u?.name || ''
      const hp = Number(u?.hp)
      const atk = Number(u?.atk || 0)
      const pos = u?.pos || u?.position || ''
      const zone = u?.zone_from_self
      const rank = u?.rank_from_self_hero
      const dS = u?.distance_to_self_hero
      const dE = u?.distance_to_enemy_hero
      const parts: string[] = []
      if (Number.isFinite(hp)) parts.push(`hp:${hp}`)
      if (Number.isFinite(atk)) parts.push(`atk:${atk}`)
      if (pos) parts.push(`pos:${pos}`)
      if (zone != null) parts.push(`zone:${zone}`)
      if (rank != null && Number.isFinite(Number(rank))) parts.push(`rank:${rank}`)
      if (dS != null && Number.isFinite(Number(dS))) parts.push(`dSelf:${dS}`)
      if (dE != null && Number.isFinite(Number(dE))) parts.push(`dEnemy:${dE}`)
      const can = u?.can_attack ? ' ⚔️' : ''
      return parts.length ? `${nm}${can}(${parts.join(', ')})` : `${nm}${can}`
    } catch { return String(u?.label || u?.name || '') }
  }

  const rules = [
    '🎯 CRITICAL: Return ONLY valid JSON in this EXACT format:',
    '{ "analysis": "brief situation summary", "steps": [Step1, Step2, ...] }',
    '',
    '🏆 GAME STATE (positions shown here are for understanding ONLY — do NOT output coordinates in your steps):',
    `- YOUR HERO HP: ${observation?.you?.hero_hp || 0} ${observation?.you?.hero_position ? `(pos ${observation.you.hero_position})` : ''}`,
    `- ENEMY HERO HP: ${observation?.opponent?.hero_hp || 0} ${observation?.opponent?.hero_position ? `(pos ${observation.opponent.hero_position})` : ''}`,
    '- ⚠️ If your Hero HP is low, prioritize DEFENSE! Deploy units to block enemy attacks.',
    '- 🎯 If enemy Hero HP is low, prioritize OFFENSE! Attack enemy Hero to win!',
    playerTacticsBlock,
    hintsBlock,
    (() => {
      try {
        if (!strategy) return ''
        return ['', '🧭 对局策略（多回合持续，除非明确重新规划，否则遵守这些约束/倾向）:', JSON.stringify(strategy)].join('\n')
      } catch { return '' }
    })(),
    '',
    '📝 Step Types (use EXACT field names):',
    '1. Play a card: { "type": "play", "card": "Tryx", "hint": "defensive_center" }',
    '   - card: EXACT English card name from your hand (Tryx, Skeleton, Fairy, Lycan, etc.)',
    '   - hint: defensive_center | defensive_left | defensive_right (to protect YOUR Hero)',
    '           mid_center | mid_left | mid_right (middle ground)',
    '           offensive_center | offensive_left | offensive_right (to attack ENEMY Hero)',
    '   🛡️ IMPORTANT: "defensive" = near YOUR Hero (back row), "offensive" = near ENEMY Hero (front row)',
    '',
    '2. Move a unit: { "type": "move", "unit": "Tryx#1", "hint": "forward" }',
    '   - unit: Unit ALREADY on board (use #N suffix: Tryx#1, Skeleton#1, etc.)',
    '   - hint: "forward" (toward enemy), "back" (retreat), "left", "right"',
    '   💡 Use move to position units for attack - check "Move→Attack Opportunities" below!',
    '   🎯 After moving, unit can often attack in the SAME turn',
    '',
    '3. Attack with unit: { "type": "attack", "attacker": "Minotaur#1", "target": "Cinda#1" }',
    '   - attacker: Unit ALREADY on board with ⚔️ symbol (use #N suffix: Minotaur#1, Skeleton#1, etc.)',
    '   - target: Enemy unit name with #N suffix, OR "Hero" to hit enemy Hero directly',
    '   ⚠️ CRITICAL: ONLY use units marked with ⚔️ symbol in "Your units ALREADY on board" section!',
    '   ❌ DO NOT attack with units you just played OR units without ⚔️ symbol!',
    '   💡 If unit needs to move first, add a "move" step BEFORE the "attack" step',
    '',
    '4. End turn: { "type": "end_turn" }',
    '',
    '❌ NEVER output: card_id, unit_id, cell_index, row/col, rXcY coordinates',
    '✅ ALWAYS output: English card/unit names from observation below + allowed hints',
    '✅ Keep steps sequenced: Deploy defenders → Move to attack range → Attack → End',
    '✅ Max 6 steps for reliability',
    '',
    '🎮 Available cards in hand:',
    (Array.isArray(observation?.you?.hand) ? observation.you.hand.map((c: any) => `${c?.name}(cost:${c?.mana_cost || 0})`).filter(Boolean).join(', ') : 'none'),
    `(Your mana: ${observation?.you?.mana || 0})`,
    '',
    '🎮 Your units ALREADY on board (include position/zone for reasoning):',
    (Array.isArray(observation?.self_units) && observation.self_units.length > 0
      ? observation.self_units.map(fmtUnit).filter(Boolean).join(', ')
      : 'NONE - no units on board yet!'),
    (() => {
      const canAttack = (observation?.self_units || []).filter((u: any) => u?.can_attack)
      const canAttackDirectly = canAttack.filter((u: any) => {
        // 检查这个单位是否在move_attack_opportunities中（需要移动才能攻击）
        const needsMove = (observation?.move_attack_opportunities || []).some((opp: any) =>
          String(opp?.unit || '').toLowerCase().includes(String(u?.label || u?.name || '').toLowerCase().split('#')[0])
        )
        return !needsMove
      })
      const needsMovement = canAttack.filter((u: any) => {
        const needsMove = (observation?.move_attack_opportunities || []).some((opp: any) =>
          String(opp?.unit || '').toLowerCase().includes(String(u?.label || u?.name || '').toLowerCase().split('#')[0])
        )
        return needsMove
      })

      const lines = []
      if (canAttackDirectly.length > 0) {
        lines.push(`   ⚔️ Can attack NOW: ${canAttackDirectly.map((u: any) => u?.label || u?.name).join(', ')}`)
      }
      if (needsMovement.length > 0) {
        lines.push(`   🚶 Need to MOVE first: ${needsMovement.map((u: any) => u?.label || u?.name).join(', ')} - check "Move→Attack Opportunities" below!`)
      }
      if (canAttack.length === 0) {
        lines.push('   ❌ NO units ready to attack - DO NOT output any "attack" steps this turn!')
      }
      return lines.join('\n')
    })(),
    '',
    '🎯 Enemy units (include position/zone for reasoning):',
    (Array.isArray(observation?.enemy_units) ? observation.enemy_units.map(fmtUnit).filter(Boolean).join(', ') : 'none'),
    '',
    ...(observation?.move_attack_opportunities?.length > 0 ? [
      '',
      '💡 Move→Attack Opportunities (HIGH PRIORITY!):',
      observation.move_attack_opportunities.map((opp: any) =>
        `- ${opp.unit} → can attack: ${opp.can_attack.join(' or ')}`
      ).join('\n'),
      '🎯 Use these! Add move step for the unit, then attack step for the target!',
      '   Example: { "type": "move", "unit": "Tryx#1", "hint": "forward" }, { "type": "attack", "attacker": "Tryx#1", "target": "Cinda#1" }',
    ] : []),
  ].join('\n') + feedbackBlock;

  return {
    model: cfg.model,
    messages: [
      { role: 'system', content: baseSystemPrompt },
      { role: 'user', content: rules },
      // Extra hint: provide executable combos to encourage move_then_attack
      ...(Array.isArray((observation as any)?.move_attack_combos) && (observation as any).move_attack_combos.length > 0 ? [
        { role: 'user', content: 'Executable move→attack combos (prefer these when generating steps):\n' + JSON.stringify((observation as any).move_attack_combos.slice(0, 8)) }
      ] : []),
    ],
    temperature: clampTemp(cfg.temperature ?? 0.15),
    max_tokens: Math.max(256, cfg.maxTokens || 384),
  };
}

export function buildIntentPrompt(snapshot: any, observation: any, actions: any[], buildActionsForPrompt: (acts: any[]) => any[]) {
  try {
    const parts: string[] = [];
    // Inject last-turn feedback
    try {
      const g: any = (globalThis as any)
      const fb: any = g.__agent_last_feedback
      if (fb) {
        const failedSteps = Array.isArray(fb.steps) ? fb.steps.filter((s: any) => !s?.ok) : []
        const failedIds = Array.isArray(fb.failed) ? fb.failed : []
        if ((failedSteps && failedSteps.length) || (failedIds && failedIds.length)) {
          parts.push('⚠️ 上回合失败动作（避免重复）：')
          if (failedSteps && failedSteps.length) {
            for (const s of failedSteps) {
              parts.push(`- id=${s?.id} ${s?.desc ? `(${s.desc})` : ''} reason=${s?.reason || 'unknown'}`)
            }
          }
          if (failedIds && failedIds.length) {
            parts.push(`- failed ids: ${failedIds.join(', ')}`)
          }
          parts.push('请不要重复上述失败方案，改用其他可用动作/落点。\n')
        }
      }
    } catch { }

    // 统计可用动作类型
    const actionTypes = {
      play_card: actions.filter(a => a?.play_card).length,
      move: actions.filter(a => a?.move_unit).length,
      unit_attack: actions.filter(a => a?.unit_attack).length,
      hero_power: actions.filter(a => a?.hero_power).length,
    };

    const stateText = snapshot?.summary_text;
    const actionsText = snapshot?.actions_text;
    if (stateText) {
      parts.push('状态概览（summary_text）:');
      parts.push(String(stateText));
    }
    if (actionsText) {
      parts.push('可行动压缩视图（actions_text）:');
      parts.push(String(actionsText));
    }

    // 添加动作可用性提示
    parts.push('\n⚠️ 可用动作类型:');
    parts.push(`- 出牌: ${actionTypes.play_card} 个可选`);
    parts.push(`- 移动: ${actionTypes.move} 个可选`);
    parts.push(`- 攻击: ${actionTypes.unit_attack} 个可选`);
    parts.push(`- 英雄技能: ${actionTypes.hero_power > 0 ? '✅ 可用' : '❌ 未就绪（不要输出 hero_power）'}`);
    parts.push('只能从 available_actions 中选择存在的动作！\n');

    // 添加玩家自定义的卡牌 AI 提示词
    try {
      const hintsBlock = buildHintsPromptBlock(snapshot);
      if (hintsBlock) {
        parts.push('🧠 玩家自定义卡牌策略:');
        parts.push(hintsBlock);
      }
    } catch { }

    parts.push('战局观测（JSON）:');
    parts.push(JSON.stringify(observation, null, 0));
    const pruned = buildActionsForPrompt(actions);
    // Aggregate explicit attack and move options to make tool-use easier
    try {
      const atk = Array.isArray(actions) ? actions.filter((a: any) => a?.unit_attack).map((a: any) => ({ attacker_unit_id: a.unit_attack.attacker_unit_id, target_unit_id: a.unit_attack.target_unit_id })) : []
      const mv = Array.isArray(actions) ? actions.filter((a: any) => a?.move_unit).map((a: any) => ({ unit_id: a.move_unit.unit_id, to_cell_index: a.move_unit.to_cell_index })) : []
      parts.push('\n可攻击选项（仅可从中选择）:')
      parts.push(JSON.stringify(atk))
      parts.push('可移动选项（仅可从中选择）:')
      parts.push(JSON.stringify(mv))
    } catch { }
    parts.push('available_actions（精简JSON，必须从中选择）:');
    parts.push(JSON.stringify(pruned, null, 0));
    parts.push('请输出严格 JSON turn_plan（不含多余文本）。');
    return parts.join('\n');
  } catch {
    return '请输出严格 JSON 意图';
  }
}

export function parseStrategyJson(text: string | null): any {
  if (!text) return null;
  try { return JSON.parse(String(text)); } catch { return null; }
}

export function parseIntentObject(text: string | null): any {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryParse(trimmed);
  if (!obj) {
    const i = trimmed.indexOf('{'); const j = trimmed.lastIndexOf('}');
    if (i >= 0 && j >= i) obj = tryParse(trimmed.slice(i, j + 1));
  }
  return obj && typeof obj === 'object' ? obj : null;
}

export function extractText(data: any): string | null {
  try {
    // Support both OpenAI-like root object and nested {data: {...}}
    const root = data && (data.data || data);
    const choices = root && root.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = choices[0]?.message;
      const delta = choices[0]?.delta;
      if (msg?.content && typeof msg.content === 'string') return msg.content;
      const tool = msg?.tool_calls?.[0];
      if (tool?.function && typeof tool.function.arguments === 'string') return tool.function.arguments;
      if (delta?.content && typeof delta.content === 'string') return delta.content;
    }
    if (typeof root === 'string') return root;
    if (root && typeof root === 'object') return JSON.stringify(root);
    return null;
  } catch { return null; }
}

export function parseActionId(text: string | null, actions: any[]): number | null {
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    if (typeof obj === 'object' && obj !== null) {
      if (typeof (obj as any).action_id === 'number') return (obj as any).action_id;
      if ((obj as any).action && typeof (obj as any).action.id === 'number') return (obj as any).action.id;
    }
  } catch { }
  const m = /Action:\s*(\d+)/i.exec(text);
  if (m) return Number(m[1]);
  const num = Number(String(text).trim());
  if (!Number.isNaN(num)) return num;
  return actions && actions[0] && actions[0].id || null;
}
