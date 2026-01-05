/**
 * Execution Compiler (v1)
 *
 * Goal: compile high-level intent steps (LLM or player) into Unity-executable
 * atomic action ids from current available_actions.
 *
 * Notes:
 * - We intentionally do NOT invent ids. We only select from available_actions[].id.
 * - For move-then-attack combos that require a state refresh, v1 compiles only the
 *   immediate action ids and optionally emits "chain" hints (handled by AgentModule).
 */

export type IntentStep = {
  type:
    | 'advance_and_attack'
    | 'direct_attack'
    | 'defensive_play'
    | 'aggressive_play'
    | 'develop_board'
    | 'reposition'
    | 'hold'
    | 'end_turn';
  unit?: string | null;
  target?: string | null;
  card?: string | null;
  zone?: string | null;
  direction?: string | null;
  intent?: string | null;
  [k: string]: any;
};

export type CompileChainHint = {
  kind: 'attack_after_move';
  attacker_unit_id: number;
  preferred_target_unit_id?: number | null;
};

export type CompileResult = {
  ok: boolean;
  ids: number[];
  chains: CompileChainHint[];
  explain: string[];
  errors: Array<{ intentIndex: number; code: string; message: string }>;
};

type AnyAction = any;

function norm(s: any): string {
  return String(s ?? '').toLowerCase().trim();
}

function fuzzyIncludes(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function getSelfUnits(snapshot: any): any[] {
  return Array.isArray(snapshot?.self_units) ? snapshot.self_units : [];
}

function getEnemyUnits(snapshot: any): any[] {
  return Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units : [];
}

function buildHandCardNameMap(snapshot: any): Map<number, string> {
  const m = new Map<number, string>();
  const hand = snapshot?.you?.hand;
  if (Array.isArray(hand)) {
    for (const c of hand) {
      const id = Number(c?.card_id ?? c?.id);
      const name = String(c?.label ?? c?.name ?? '').trim();
      if (Number.isFinite(id) && name) m.set(id, name);
    }
  }
  return m;
}

function resolveUnitIdByName(snapshot: any, unitName: any): number | null {
  const name = norm(unitName);
  if (!name) return null;
  const units = getSelfUnits(snapshot);
  let hit = units.find((u: any) => fuzzyIncludes(norm(u?.label ?? u?.name), name));
  if (!hit && name.includes('#')) {
    const base = name.split('#')[0]?.trim();
    hit = units.find((u: any) => norm(u?.label ?? u?.name).includes(base));
  }
  const id = Number(hit?.unit_id ?? hit?.id);
  return Number.isFinite(id) ? id : null;
}

function resolveEnemyUnitIdByName(snapshot: any, targetName: any): number | null {
  const name = norm(targetName);
  if (!name) return null;
  const units = getEnemyUnits(snapshot);
  let hit = units.find((u: any) => fuzzyIncludes(norm(u?.label ?? u?.name), name));
  if (!hit && name.includes('hero')) {
    hit = units.find((u: any) => norm(u?.label ?? u?.name).includes('hero') || u?.is_hero === true || u?.role === 'hero');
  }
  const id = Number(hit?.unit_id ?? hit?.id);
  return Number.isFinite(id) ? id : null;
}

function listMoveActionsForUnit(actions: AnyAction[], unitId: number): AnyAction[] {
  return (actions || []).filter((a: any) => a?.move_unit && Number(a.move_unit.unit_id) === Number(unitId) && Number.isFinite(Number(a.id)));
}

function listAttackActionsForUnit(actions: AnyAction[], unitId: number): AnyAction[] {
  return (actions || []).filter((a: any) => a?.unit_attack && Number(a.unit_attack.attacker_unit_id) === Number(unitId) && Number.isFinite(Number(a.id)));
}

function listPlayCardActions(actions: AnyAction[]): AnyAction[] {
  return (actions || []).filter((a: any) => a?.play_card && Number.isFinite(Number(a.id)));
}

function findEndTurnAction(actions: AnyAction[]): AnyAction | null {
  const a = (actions || []).find((x: any) => x?.end_turn && Number.isFinite(Number(x.id)));
  return a || null;
}

function scoreEnemyTargetByName(snapshot: any, targetUnitId: number): number {
  const enemies = getEnemyUnits(snapshot);
  const t = enemies.find((e: any) => Number(e?.unit_id ?? e?.id) === Number(targetUnitId));
  const name = norm(t?.label ?? t?.name);
  const hp = Number(t?.hp ?? t?.Hp ?? 9999);
  let s = 0;
  if (name.includes('cinda')) s += 60;
  if (name.includes('ash')) s += 50;
  if (name.includes('archer') || name.includes('crossbow')) s += 40;
  if (name.includes('hero')) s += 55;
  if (Number.isFinite(hp)) s += Math.max(0, 30 - Math.min(30, hp));
  return s;
}

function pickBestAttack(actions: AnyAction[], snapshot: any, attackerUnitId: number, preferredTargetUnitId?: number | null): AnyAction | null {
  const atks = listAttackActionsForUnit(actions, attackerUnitId);
  if (!atks.length) return null;
  if (preferredTargetUnitId != null) {
    const exact = atks.find((a: any) => Number(a?.unit_attack?.target_unit_id) === Number(preferredTargetUnitId));
    if (exact) return exact;
  }
  let best = atks[0];
  let bestScore = -1e9;
  for (const a of atks) {
    const tid = Number(a?.unit_attack?.target_unit_id);
    const sc = Number.isFinite(tid) ? scoreEnemyTargetByName(snapshot, tid) : 0;
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  }
  return best;
}

function pickBestMove(moveActions: AnyAction[], intent: IntentStep, snapshot: any): AnyAction | null {
  if (!moveActions.length) return null;
  const zone = norm(intent.zone ?? intent.intent ?? intent.direction);
  if (!zone) return moveActions[0];

  const width = Number(snapshot?.board?.width ?? 0);
  const selfHero = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index ?? -1);
  const enemyHero = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index ?? -1);
  const heroY = (width > 0 && selfHero >= 0) ? Math.floor(selfHero / width) : null;
  const enemyY = (width > 0 && enemyHero >= 0) ? Math.floor(enemyHero / width) : null;
  const dirY = (heroY != null && enemyY != null) ? Math.sign(enemyY - heroY) : 0;

  const hasFront = ['front', '前', '前排'].some(k => zone.includes(k));
  const hasBack = ['back', '后', '後', '后排'].some(k => zone.includes(k));
  const hasLeft = ['left', '左'].some(k => zone.includes(k));
  const hasRight = ['right', '右'].some(k => zone.includes(k));

  const score = (a: any): number => {
    const to = Number(a?.move_unit?.to_cell_index);
    if (!Number.isFinite(to) || width <= 0) return 0;
    const y = Math.floor(to / width);
    const x = to % width;
    let s = 0;
    if (hasFront && heroY != null && dirY !== 0) s += (y - heroY) * dirY;
    if (hasBack && heroY != null && dirY !== 0) s += -(y - heroY) * dirY;
    if (hasLeft) s += -(x - (width / 2));
    if (hasRight) s += (x - (width / 2));
    return s;
  };

  let best = moveActions[0];
  let bestS = -1e9;
  for (const a of moveActions) {
    const s = score(a);
    if (s > bestS) { bestS = s; best = a; }
  }
  return best;
}

function pickBestPlayCard(actions: AnyAction[], intent: IntentStep, snapshot: any): AnyAction | null {
  const plays = listPlayCardActions(actions);
  if (!plays.length) return null;

  const cardName = norm(intent.card);
  const cardMap = buildHandCardNameMap(snapshot);

  if (cardName) {
    const byName: AnyAction[] = [];
    for (const a of plays) {
      const cid = Number(a?.play_card?.card_id);
      const nm1 = norm(a?.card_name ?? a?.play_card?.card_name ?? '');
      const nm2 = norm(cardMap.get(cid) ?? '');
      const nm = nm1 || nm2;
      if (nm && fuzzyIncludes(nm, cardName)) byName.push(a);
    }
    if (byName.length) return byName[0];
  }

  const zone = norm(intent.zone ?? intent.intent ?? intent.direction);
  const isDef = String(intent.type || '').includes('defensive');
  const preferFront = !isDef && (zone.includes('front') || zone.includes('前'));
  const preferBack = isDef || (zone.includes('back') || zone.includes('后') || zone.includes('後'));

  const width = Number(snapshot?.board?.width ?? 0);
  const selfHero = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index ?? -1);
  const enemyHero = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index ?? -1);
  const heroY = (width > 0 && selfHero >= 0) ? Math.floor(selfHero / width) : null;
  const enemyY = (width > 0 && enemyHero >= 0) ? Math.floor(enemyHero / width) : null;
  const dirY = (heroY != null && enemyY != null) ? Math.sign(enemyY - heroY) : 0;

  const score = (a: any): number => {
    let s = 0;
    const cell = Number(a?.play_card?.cell_index);
    if (Number.isFinite(cell) && width > 0 && heroY != null && dirY !== 0) {
      const y = Math.floor(cell / width);
      const forward = (y - heroY) * dirY;
      if (preferFront) s += forward * 2;
      if (preferBack) s += -forward * 2;
    }
    if (cardName) {
      const nm = norm(a?.card_name ?? '');
      if (nm && fuzzyIncludes(nm, cardName)) s += 50;
    }
    return s;
  };

  let best = plays[0];
  let bestS = -1e9;
  for (const a of plays) {
    const sc = score(a);
    if (sc > bestS) { bestS = sc; best = a; }
  }
  return best;
}

function summarizeActionTypes(actions: AnyAction[]) {
  try {
    const sum: any = { end: 0, play: 0, atk: 0, move: 0, power: 0, skill: 0, mta: 0, unknown: 0 };
    for (const a of actions || []) {
      if (!a) continue;
      if (a.end_turn) sum.end++;
      else if (a.play_card) sum.play++;
      else if (a.unit_attack) sum.atk++;
      else if (a.move_unit) sum.move++;
      else if (a.hero_power) sum.power++;
      else if (a.use_skill) sum.skill++;
      else if (a.move_then_attack) sum.mta++;
      else sum.unknown++;
    }
    return sum;
  } catch {
    return null;
  }
}

export function compileIntentStepsToActionIds(params: {
  intentSteps: IntentStep[];
  snapshot: any;
  actions: AnyAction[];
  tacticalPreview?: any[];
  strict?: boolean;
  maxIds?: number;
}): CompileResult {
  const { intentSteps, snapshot, actions, tacticalPreview = [], strict = true, maxIds = 6 } = params;
  const ids: number[] = [];
  const chains: CompileChainHint[] = [];
  const explain: string[] = [];
  const errors: Array<{ intentIndex: number; code: string; message: string }> = [];

  let manaLeft = Number(snapshot?.self?.mana);
  if (!Number.isFinite(manaLeft)) manaLeft = Number(snapshot?.you?.mana);
  if (!Number.isFinite(manaLeft)) manaLeft = Number(snapshot?.self?.hero?.energy);
  if (!Number.isFinite(manaLeft)) manaLeft = Number(snapshot?.you?.energy);
  if (!Number.isFinite(manaLeft)) manaLeft = Number(snapshot?.you?.mana_limit ?? snapshot?.self?.hero?.energy_limit ?? 0);

  let remaining: AnyAction[] = Array.isArray(actions) ? actions.slice() : [];
  const removeById = (id: number) => { remaining = remaining.filter((a: any) => Number(a?.id) !== Number(id)); };
  const removeMovesForUnit = (unitId: number) => { remaining = remaining.filter((a: any) => !(a?.move_unit && Number(a.move_unit.unit_id) === Number(unitId))); };
  const removeAttacksForUnit = (unitId: number) => { remaining = remaining.filter((a: any) => !(a?.unit_attack && Number(a.unit_attack.attacker_unit_id) === Number(unitId))); };
  const removePlaysForCell = (cellIndex: number) => { remaining = remaining.filter((a: any) => !(a?.play_card && Number(a.play_card.cell_index) === Number(cellIndex))); };

  const safePush = (id: any, why: string) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    if (ids.length >= maxIds) return;
    if (ids.includes(n)) return;
    ids.push(n);
    if (why) explain.push(why);
    removeById(n);
  };

  for (let i = 0; i < (intentSteps || []).length; i++) {
    const st: any = intentSteps[i] || {};
    const t = String(st.type || '');
    try { explain.push(`intent#${i}: ${t} unit=${st.unit ?? ''} target=${st.target ?? ''} card=${st.card ?? ''}`); } catch { }

    if (t === 'hold') {
      explain.push(`intent#${i}: hold (${st.unit || 'unknown'})`);
      continue;
    }

    if (t === 'end_turn') {
      const hasAtk = Array.isArray(remaining) && remaining.some((a: any) => a?.unit_attack);
      if (hasAtk) { explain.push(`intent#${i}: end_turn skipped (attacks available)`); continue; }
      const end = findEndTurnAction(remaining);
      if (end) safePush(end.id, `intent#${i}: end_turn`);
      else errors.push({ intentIndex: i, code: 'NO_END_TURN', message: 'No end_turn action available' });
      continue;
    }

    if (t === 'aggressive_play' || t === 'defensive_play' || t === 'develop_board') {
      const a = pickBestPlayCard(remaining, st, snapshot);
      if (a) {
        const cost = Number(a?.mana_cost);
        if (Number.isFinite(manaLeft) && Number.isFinite(cost) && cost > manaLeft) {
          errors.push({ intentIndex: i, code: 'NO_MANA', message: `Insufficient mana for play_card cost=${cost} mana=${manaLeft}` });
          continue;
        }
        safePush(a.id, `intent#${i}: play_card (${st.card || 'auto'})`);
        if (Number.isFinite(manaLeft) && Number.isFinite(cost)) manaLeft -= cost;
        try {
          const cell = Number(a?.play_card?.cell_index);
          if (Number.isFinite(cell)) removePlaysForCell(cell);
        } catch { }
      } else {
        errors.push({ intentIndex: i, code: 'NO_PLAY_CARD', message: 'No play_card actions available or card not found' });
      }
      continue;
    }

    if (t === 'reposition') {
      const unitId = resolveUnitIdByName(snapshot, st.unit);
      if (unitId == null) { errors.push({ intentIndex: i, code: 'UNIT_NOT_FOUND', message: `Unit not found: ${String(st.unit || '')}` }); continue; }
      const moves = listMoveActionsForUnit(remaining, unitId);
      if (!moves.length) {
        errors.push({ intentIndex: i, code: 'NO_MOVE_ACTIONS', message: `No move_unit actions published for unit=${unitId} (${String(st.unit || '')}). actionTypes=${JSON.stringify(summarizeActionTypes(remaining))}` });
      }
      const mv = pickBestMove(moves, st, snapshot);
      if (mv) {
        safePush(mv.id, `intent#${i}: move (${st.unit || unitId})`);
        removeMovesForUnit(unitId);
        removeAttacksForUnit(unitId);
      } else {
        errors.push({ intentIndex: i, code: 'NO_MOVE', message: `No move actions available for unit ${String(st.unit || unitId)}` });
      }
      continue;
    }

    if (t === 'direct_attack') {
      const unitId = resolveUnitIdByName(snapshot, st.unit);
      if (unitId == null) { errors.push({ intentIndex: i, code: 'UNIT_NOT_FOUND', message: `Unit not found: ${String(st.unit || '')}` }); continue; }
      const targetId = resolveEnemyUnitIdByName(snapshot, st.target);
      const atk = pickBestAttack(remaining, snapshot, unitId, targetId);
      if (atk) {
        safePush(atk.id, `intent#${i}: attack (${st.unit || unitId} -> ${st.target || 'best'})`);
        removeAttacksForUnit(unitId);
        removeMovesForUnit(unitId);
      } else {
        errors.push({ intentIndex: i, code: 'NO_ATTACK', message: `No unit_attack actions available for attacker ${String(st.unit || unitId)}` });
      }
      continue;
    }

    if (t === 'advance_and_attack') {
      const unitId = resolveUnitIdByName(snapshot, st.unit);
      if (unitId == null) { errors.push({ intentIndex: i, code: 'UNIT_NOT_FOUND', message: `Unit not found: ${String(st.unit || '')}` }); continue; }
      const targetIdFromName = resolveEnemyUnitIdByName(snapshot, st.target);
      let preferredTargetId: number | null = targetIdFromName;
      const immediateAtk = pickBestAttack(remaining, snapshot, unitId, preferredTargetId);
      if (immediateAtk) {
        safePush(immediateAtk.id, `intent#${i}: immediate attack (${st.unit || unitId} -> ${st.target || 'best'})`);
        removeAttacksForUnit(unitId);
        removeMovesForUnit(unitId);
        continue;
      }

      const moves = listMoveActionsForUnit(remaining, unitId);

      const pickMoveByPreview = (): { move: AnyAction | null; preferredTarget: number | null } => {
        try {
          const pv = Array.isArray(tacticalPreview) ? tacticalPreview : [];
          const options: Array<{ to: number; tgt: number; score: number }> = [];
          for (const row of pv) {
            const unit = Number(row?.unit_id ?? row?.move_then_attack?.unit_id);
            if (!Number.isFinite(unit) || unit !== Number(unitId)) continue;
            const to = Number(row?.to_cell_index ?? row?.move_then_attack?.to_cell_index);
            if (!Number.isFinite(to)) continue;
            const atks = Array.isArray(row?.attacks) ? row.attacks : null;
            if (atks && atks.length) {
              for (const a of atks) {
                const tgt = Number(a?.target_unit_id);
                if (!Number.isFinite(tgt)) continue;
                let sc = 10 + scoreEnemyTargetByName(snapshot, tgt);
                try { if (a?.kill === true) sc += 40; } catch { }
                if (preferredTargetId != null && tgt === preferredTargetId) sc += 80;
                options.push({ to, tgt, score: sc });
              }
            } else {
              const tgt = Number(row?.move_then_attack?.target_unit_id);
              if (Number.isFinite(tgt)) {
                let sc = 10 + scoreEnemyTargetByName(snapshot, tgt);
                if (preferredTargetId != null && tgt === preferredTargetId) sc += 80;
                options.push({ to, tgt, score: sc });
              }
            }
          }
          if (!options.length) return { move: null, preferredTarget: preferredTargetId };
          options.sort((a, b) => b.score - a.score);
          const best = options[0];
          const mv2 = moves.find((m: any) => Number(m?.move_unit?.to_cell_index) === Number(best.to));
          if (mv2) return { move: mv2, preferredTarget: Number.isFinite(best.tgt) ? Number(best.tgt) : preferredTargetId };
          return { move: null, preferredTarget: preferredTargetId };
        } catch {
          return { move: null, preferredTarget: preferredTargetId };
        }
      };

      const byPreview = pickMoveByPreview();
      if (byPreview.preferredTarget != null) preferredTargetId = byPreview.preferredTarget;

      const mv = byPreview.move || pickBestMove(moves, st, snapshot);
      if (mv) {
        safePush(mv.id, `intent#${i}: move (advance) (${st.unit || unitId})`);
        removeMovesForUnit(unitId);
        chains.push({ kind: 'attack_after_move', attacker_unit_id: unitId, preferred_target_unit_id: preferredTargetId ?? null });
        continue;
      }

      errors.push({ intentIndex: i, code: 'NO_ADVANCE', message: `No attack or move actions available for ${String(st.unit || unitId)}` });
      continue;
    }

    errors.push({ intentIndex: i, code: 'UNKNOWN_INTENT', message: `Unknown intent type: ${t}` });
  }

  const ok = ids.length > 0 || (!strict && errors.length === 0);
  return { ok, ids, chains, explain, errors };
}
