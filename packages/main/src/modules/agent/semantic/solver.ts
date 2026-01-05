import type { SemanticIntent, SemanticIntentResponse } from '../types.js';
import { buildSemanticReport } from './perception.js';

export type SemanticSolveResult = {
  ok: boolean;
  ids: number[];
  chains: Array<{ kind: 'attack_after_move'; attacker_unit_id: number; preferred_target_unit_id?: number | null }>;
  explain: string[];
  errors: Array<{ intentIndex: number; code: string; message: string }>;
};

function norm(s: any): string {
  return String(s ?? '').trim().toLowerCase();
}

function fuzzyIncludes(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function resolveUnitIdByName(snapshot: any, unitName: any, isEnemy: boolean, internals?: { myNameToUnitId: Map<string, number>; enemyNameToUnitId: Map<string, number> }): number | null {
  const name = norm(unitName);
  if (!name) return null;
  // 优先使用 SemanticInternals 中的精确映射（支持同名单位通过 "Name#N" 区分）
  if (internals) {
    const map = isEnemy ? internals.enemyNameToUnitId : internals.myNameToUnitId;
    const direct = map.get(name);
    if (direct != null) return direct;
    if (name.includes('#')) {
      const base = name.split('#')[0]?.trim().toLowerCase();
      for (const [k, v] of map.entries()) {
        if (k.startsWith(base)) return v;
      }
    }
  }
  const units = isEnemy ? (Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units : []) : (Array.isArray(snapshot?.self_units) ? snapshot.self_units : []);
  let hit = units.find((u: any) => fuzzyIncludes(norm(u?.label ?? u?.name), name));
  if (!hit && name.includes('#')) {
    const base = name.split('#')[0]?.trim();
    hit = units.find((u: any) => norm(u?.label ?? u?.name).includes(base));
  }
  if (!hit && isEnemy && name.includes('enemyhero')) {
    hit = units.find((u: any) => u?.is_hero === true || String(u?.role || '').toLowerCase() === 'hero');
  }
  const id = Number(hit?.unit_id ?? hit?.id);
  return Number.isFinite(id) ? id : null;
}

function pickAttack(actions: any[], snapshot: any, attackerUnitId: number, preferredTargetUnitId: number | null): any | null {
  const atks = (actions || []).filter((a: any) => a?.unit_attack && Number(a.unit_attack.attacker_unit_id) === Number(attackerUnitId) && Number.isFinite(Number(a.id)));
  if (!atks.length) return null;
  if (preferredTargetUnitId != null) {
    const exact = atks.find((a: any) => Number(a.unit_attack.target_unit_id) === Number(preferredTargetUnitId));
    if (exact) return exact;
  }
  // heuristic: prefer Cinda/Ash/ranged/hero/low hp (same as compiler v1)
  const enemies = Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units : [];
  const scoreTarget = (tid: number) => {
    const t = enemies.find((e: any) => Number(e?.unit_id ?? e?.id) === Number(tid));
    const name = norm(t?.label ?? t?.name);
    const hp = Number(t?.hp ?? 9999);
    let s = 0;
    if (name.includes('cinda')) s += 60;
    if (name.includes('ash')) s += 50;
    if (name.includes('archer') || name.includes('crossbow')) s += 40;
    if (name.includes('hero')) s += 55;
    if (Number.isFinite(hp)) s += Math.max(0, 30 - Math.min(30, hp));
    return s;
  };
  let best = atks[0];
  let bestS = -1e9;
  for (const a of atks) {
    const tid = Number(a?.unit_attack?.target_unit_id);
    const sc = Number.isFinite(tid) ? scoreTarget(tid) : 0;
    if (sc > bestS) { bestS = sc; best = a; }
  }
  return best;
}

function pickMoveToZone(actions: any[], snapshot: any, unitId: number, zoneId: string | null): any | null {
  const moves = (actions || []).filter((a: any) => a?.move_unit && Number(a.move_unit.unit_id) === Number(unitId) && Number.isFinite(Number(a.id)));
  if (!moves.length) return null;
  if (!zoneId) return moves[0];

  const width = Number(snapshot?.board?.width ?? 0);
  const height = Number(snapshot?.board?.height ?? 0);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return moves[0];

  const selfHero = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index ?? -1);
  const enemyHero = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index ?? -1);
  const heroY = (selfHero >= 0) ? Math.floor(selfHero / width) : null;
  const enemyY = (enemyHero >= 0) ? Math.floor(enemyHero / width) : null;
  const dirY = (heroY != null && enemyY != null) ? Math.sign(enemyY - heroY) : 0;

  const z = norm(zoneId);
  const wantFront = z.includes('front');
  const wantBack = z.includes('back');
  const wantMid = z.includes('mid');
  const wantLeft = z.includes('left');
  const wantRight = z.includes('right');
  const wantCenter = z.includes('center');

  const score = (a: any) => {
    const to = Number(a?.move_unit?.to_cell_index);
    if (!Number.isFinite(to)) return -1e9;
    const y = Math.floor(to / width);
    const x = to % width;
    let s = 0;
    if (dirY !== 0 && heroY != null) {
      const forward = (y - heroY) * dirY;
      if (wantFront) s += forward * 2;
      if (wantBack) s += -forward * 2;
      if (wantMid) s += -Math.abs(forward - Math.round(height / 2));
    }
    if (wantLeft) s += -(x - width / 2);
    if (wantRight) s += (x - width / 2);
    if (wantCenter) s += -Math.abs(x - width / 2);
    return s;
  };

  let best = moves[0];
  let bestS = -1e9;
  for (const a of moves) {
    const sc = score(a);
    if (sc > bestS) { bestS = sc; best = a; }
  }
  return best;
}


function pickPlayCard(actions: any[], snapshot: any, cardName: string, zoneId: string | null, manaLeft: number): any | null {
  const plays = (actions || []).filter((a: any) => a?.play_card && Number.isFinite(Number(a.id)));
  if (!plays.length) return null;
  const cn = norm(cardName);
  const filtered = cn
    ? plays.filter((a: any) => {
      const nm = norm(a?.card_name ?? a?.play_card?.card_name ?? '');
      return nm && fuzzyIncludes(nm, cn);
    })
    : plays;

  const affordable = filtered.filter((a: any) => {
    const cost = Number(a?.mana_cost ?? a?.play_card?.mana_cost ?? 0);
    return !Number.isFinite(cost) || cost <= manaLeft;
  });
  const pool = affordable.length ? affordable : filtered;
  if (!pool.length) return null;

  if (!zoneId) return pool[0];
  // prefer placements whose cell maps to requested zone
  const { internals } = buildSemanticReport({ snapshot, actions, tacticalPreview: [], enableHexBoard: false });
  const want = norm(zoneId);
  const scored = pool.map((a: any) => {
    const cell = Number(a?.play_card?.cell_index);
    const z = internals.cellToZone(cell);
    const ok = norm(z) === want;
    return { a, s: ok ? 10 : 0 };
  }).sort((x: any, y: any) => y.s - x.s);
  return scored[0]?.a ?? pool[0];
}

export function solveSemanticIntents(params: {
  snapshot: any;
  actions: any[];
  tacticalPreview: any[];
  intents: SemanticIntent[];
  strict?: boolean;
  maxIds?: number;
}): SemanticSolveResult {
  const { snapshot, actions, tacticalPreview, intents, strict = true, maxIds = 6 } = params;

  const ids: number[] = [];
  const chains: SemanticSolveResult['chains'] = [];
  const explain: string[] = [];
  const errors: SemanticSolveResult['errors'] = [];

  // 从 Semantic v2 感知层获取内部映射（用于区分同名单位等）；不需要 hex_board
  const { internals } = buildSemanticReport({ snapshot, actions, tacticalPreview: [], enableHexBoard: false });

  let manaLeft = Number(snapshot?.self?.mana);
  if (!Number.isFinite(manaLeft)) manaLeft = Number(snapshot?.you?.mana);
  if (!Number.isFinite(manaLeft)) manaLeft = 0;

  let remaining = Array.isArray(actions) ? actions.slice() : [];
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

  const sorted = Array.isArray(intents) ? [...intents].sort((a, b) => (Number(a.priority ?? 5) - Number(b.priority ?? 5))) : [];
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    const verb = String(it?.verb || '').toUpperCase();
    const subject = String(it?.subject || '');
    const target = it?.target != null ? String(it.target) : null;
    explain.push(`intent#${i}: ${verb} subject=${subject} target=${target ?? ''}`);

    if (verb === 'END_TURN') {
      const end = remaining.find((a: any) => a?.end_turn && Number.isFinite(Number(a.id)));
      if (end) safePush(end.id, `intent#${i}: end_turn`);
      else errors.push({ intentIndex: i, code: 'NO_END_TURN', message: 'No end_turn action available' });
      continue;
    }

    if (verb === 'HOLD') {
      // no-op
      continue;
    }

    if (verb === 'DEPLOY') {
      const m = subject.match(/hand\((.*?)\)/i);
      const card = m ? m[1] : null;
      if (!card) { errors.push({ intentIndex: i, code: 'INVALID_SUBJECT', message: `DEPLOY subject must be Hand(CardName): ${subject}` }); continue; }
      const a = pickPlayCard(remaining, snapshot, card, target, manaLeft);
      if (!a) { errors.push({ intentIndex: i, code: 'NO_PLAY', message: `No play_card for ${card}` }); continue; }
      const cost = Number(a?.mana_cost ?? a?.play_card?.mana_cost ?? 0);
      if (Number.isFinite(cost) && cost > manaLeft) { errors.push({ intentIndex: i, code: 'NO_MANA', message: `mana ${manaLeft} < cost ${cost}` }); continue; }
      safePush(a.id, `intent#${i}: play_card ${card}`);
      if (Number.isFinite(cost)) manaLeft -= cost;
      try {
        const cell = Number(a?.play_card?.cell_index);
        if (Number.isFinite(cell)) removePlaysForCell(cell);
      } catch { }
      continue;
    }

    if (verb === 'POSITION' || verb === 'SCREEN' || verb === 'PROTECT') {
      const uid = resolveUnitIdByName(snapshot, subject, false, internals);
      if (uid == null) { errors.push({ intentIndex: i, code: 'UNIT_NOT_FOUND', message: `Unit not found: ${subject}` }); continue; }
      // POSITION target is a zone, SCREEN/PROTECT target is ally unit -> convert to "mid/back near hero" heuristic
      const zone = (verb === 'POSITION') ? target : null;
      const mv = pickMoveToZone(remaining, snapshot, uid, zone);
      if (!mv) { errors.push({ intentIndex: i, code: 'NO_MOVE', message: `No move for unit ${subject}` }); continue; }
      safePush(mv.id, `intent#${i}: move ${subject}`);
      removeMovesForUnit(uid);
      removeAttacksForUnit(uid);
      continue;
    }

    if (verb === 'KILL' || verb === 'ATTACK' || verb === 'POKE') {
      const uid = resolveUnitIdByName(snapshot, subject, false, internals);
      if (uid == null) { errors.push({ intentIndex: i, code: 'UNIT_NOT_FOUND', message: `Unit not found: ${subject}` }); continue; }
      const tid = target ? resolveUnitIdByName(snapshot, target, true, internals) : null;
      const atk = pickAttack(remaining, snapshot, uid, tid);
      if (atk) {
        safePush(atk.id, `intent#${i}: attack ${subject} -> ${target ?? 'best'}`);
        removeAttacksForUnit(uid);
        removeMovesForUnit(uid);
        continue;
      }

      // If no immediate attack, try a move that enables attack according to tacticalPreview
      const moves = (remaining || []).filter((a: any) => a?.move_unit && Number(a.move_unit.unit_id) === Number(uid) && Number.isFinite(Number(a.id)));
      const pv = Array.isArray(tacticalPreview) ? tacticalPreview : [];
      const options: Array<{ to: number; tgt: number; score: number }> = [];
      for (const row of pv) {
        const u = Number(row?.unit_id ?? row?.move_then_attack?.unit_id);
        if (!Number.isFinite(u) || u !== Number(uid)) continue;
        const to = Number(row?.to_cell_index ?? row?.move_then_attack?.to_cell_index);
        if (!Number.isFinite(to)) continue;
        const atks = Array.isArray(row?.attacks) ? row.attacks : null;
        const add = (t: number, bonus: number) => {
          if (!Number.isFinite(t)) return;
          let sc = 10 + bonus;
          if (tid != null && t === tid) sc += 80;
          options.push({ to, tgt: t, score: sc });
        };
        if (atks && atks.length) {
          for (const a of atks) {
            const t = Number(a?.target_unit_id);
            add(t, 0);
          }
        } else {
          const t = Number(row?.move_then_attack?.target_unit_id);
          add(t, 0);
        }
      }
      if (options.length && moves.length) {
        options.sort((a, b) => b.score - a.score);
        const best = options[0];
        const mv = moves.find((m: any) => Number(m?.move_unit?.to_cell_index) === Number(best.to)) || moves[0];
        safePush(mv.id, `intent#${i}: move to enable attack (${subject})`);
        removeMovesForUnit(uid);
        chains.push({ kind: 'attack_after_move', attacker_unit_id: uid, preferred_target_unit_id: tid ?? null });
        continue;
      }

      // 如果这回合无论如何都打不到指定目标，则按照“朝目标方向靠近”的 POSITION 语义，至少向前移动一格
      const fallbackMoves = (remaining || []).filter((a: any) => a?.move_unit && Number(a.move_unit.unit_id) === Number(uid) && Number.isFinite(Number(a.id)));
      if (fallbackMoves.length && tid != null) {
        const enemies = Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units : [];
        const targetUnit = enemies.find((e: any) => Number(e?.unit_id ?? e?.id) === Number(tid));
        const tCell = Number(targetUnit?.cell_index ?? targetUnit?.pos?.cell_index ?? -1);
        const zone = Number.isFinite(tCell) && tCell >= 0 ? internals.cellToZone(tCell) : null;
        const mv = pickMoveToZone(fallbackMoves, snapshot, uid, zone);
        if (mv) {
          safePush(mv.id, `intent#${i}: move toward target for future attack (${subject} -> ${target})`);
          removeMovesForUnit(uid);
          continue;
        }
      }

      errors.push({ intentIndex: i, code: 'NO_ATTACK', message: `No attack or enabling move for ${subject}` });
      continue;
    }

    errors.push({ intentIndex: i, code: 'UNKNOWN_VERB', message: `Unknown verb: ${verb}` });
  }

  const ok = ids.length > 0 || (!strict && errors.length === 0);
  return { ok, ids, chains, explain, errors };
}

export function normalizeSemanticResponse(obj: any): SemanticIntentResponse | null {
  try {
    if (!obj || typeof obj !== 'object') return null;
    const arr = Array.isArray((obj as any).strategy) ? (obj as any).strategy : null;
    if (!arr) return null;
    const strategy: SemanticIntent[] = arr.map((x: any) => ({
      verb: String(x?.verb || '').toUpperCase(),
      subject: String(x?.subject || ''),
      target: x?.target ?? null,
      priority: Number.isFinite(Number(x?.priority)) ? Number(x.priority) : 5,
      reason: String(x?.reason || ''),
    } as any));
    return { strategy, notes: (obj as any).notes };
  } catch {
    return null;
  }
}


