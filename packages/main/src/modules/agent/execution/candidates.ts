/**
 * Candidate generation for LLM2 mapper.
 *
 * Generates SMALL, PRE-VALIDATED candidates derived from current available_actions.
 * LLM2 is only allowed to pick among these candidates.
 */
import type { IntentStep, CompileChainHint } from './compiler.js';

export type Candidate = {
  id: string;
  intentIndex: number;
  summary: string;
  action_ids: number[];
  signals?: Record<string, any>;
  chain?: CompileChainHint | null;
};

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

function scoreTarget(snapshot: any, targetId: number): number {
  const enemies = getEnemyUnits(snapshot);
  const t = enemies.find((e: any) => Number(e?.unit_id ?? e?.id) === Number(targetId));
  const name = norm(t?.label ?? t?.name);
  const hp = Number(t?.hp ?? 9999);
  let s = 0;
  if (name.includes('cinda')) s += 60;
  if (name.includes('ash')) s += 50;
  if (name.includes('archer') || name.includes('crossbow')) s += 40;
  if (name.includes('hero')) s += 55;
  if (Number.isFinite(hp)) s += Math.max(0, 30 - Math.min(30, hp));
  return s;
}

function scoreCellForward(snapshot: any, cellIndex: number): number {
  const width = Number(snapshot?.board?.width ?? 0);
  const selfHero = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index ?? -1);
  const enemyHero = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index ?? -1);
  const heroY = (width > 0 && selfHero >= 0) ? Math.floor(selfHero / width) : null;
  const enemyY = (width > 0 && enemyHero >= 0) ? Math.floor(enemyHero / width) : null;
  const dirY = (heroY != null && enemyY != null) ? Math.sign(enemyY - heroY) : 0;
  if (width <= 0 || heroY == null || dirY === 0) return 0;
  const y = Math.floor(cellIndex / width);
  return (y - heroY) * dirY;
}

function describeCellRegion(snapshot: any, cellIndex: number): string {
  const width = Number(snapshot?.board?.width ?? 0);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(cellIndex) || cellIndex < 0) return `cell ${cellIndex}`;
  const selfHero = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index ?? -1);
  const enemyHero = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index ?? -1);
  const heroY = (selfHero >= 0) ? Math.floor(selfHero / width) : null;
  const enemyY = (enemyHero >= 0) ? Math.floor(enemyHero / width) : null;
  const x = cellIndex % width;
  const y = Math.floor(cellIndex / width);

  let lane: 'left' | 'center' | 'right' = 'center';
  if (x < width / 3) lane = 'left';
  else if (x >= (2 * width) / 3) lane = 'right';

  let rank: 'backline' | 'midline' | 'frontline' = 'midline';
  if (heroY != null) {
    const dy = y - heroY;
    if (dy <= 0) rank = 'backline';
    else if (enemyY != null && Math.abs(y - enemyY) <= 1) rank = 'frontline';
    else rank = 'midline';
  }

  return `${rank}_${lane}`;
}

export function generateMapperCandidates(params: {
  intentSteps: IntentStep[];
  snapshot: any;
  actions: any[];
  tacticalPreview?: any[];
  perIntentLimit?: number;
}): Candidate[] {
  const { intentSteps, snapshot, actions, tacticalPreview = [], perIntentLimit = 4 } = params;
  const out: Candidate[] = [];
  const handNames = buildHandCardNameMap(snapshot);

  const add = (c: Candidate) => {
    if (!c) return;
    if (!Array.isArray(c.action_ids)) c.action_ids = [];
    c.action_ids = c.action_ids.map((x: any) => Number(x)).filter((x: any) => Number.isFinite(x) && x > 0);
    out.push(c);
  };

  const endTurn = (actions || []).find((a: any) => a?.end_turn && Number.isFinite(Number(a.id)));

  for (let i = 0; i < (intentSteps || []).length; i++) {
    const st = intentSteps[i] || ({} as any);
    const type = String(st.type || '');
    const zone = norm(st.zone ?? st.intent ?? st.direction);

    if (type === 'hold') {
      add({ id: `i${i}_hold`, intentIndex: i, summary: 'hold', action_ids: [], signals: { kind: 'hold' }, chain: null });
      continue;
    }
    if (type === 'end_turn') {
      if (endTurn) add({ id: `i${i}_end`, intentIndex: i, summary: 'end_turn', action_ids: [Number(endTurn.id)], signals: { kind: 'end_turn' }, chain: null });
      continue;
    }

    if (type === 'reposition') {
      const uid = resolveUnitIdByName(snapshot, st.unit);
      const moves = (actions || []).filter((a: any) => a?.move_unit && Number(a.move_unit.unit_id) === Number(uid) && Number.isFinite(Number(a.id)));
      const scored = moves.map((a: any) => {
        const to = Number(a?.move_unit?.to_cell_index);
        let s = 0;
        if (Number.isFinite(to)) {
          const f = scoreCellForward(snapshot, to);
          const hasFront = ['front', '前', '前排'].some(k => zone.includes(k));
          const hasBack = ['back', '后', '後', '后排'].some(k => zone.includes(k));
          if (hasFront) s += f * 2;
          if (hasBack) s += -f * 2;
        }
        return { a, s };
      }).sort((x: any, y: any) => y.s - x.s).slice(0, Math.max(1, perIntentLimit));
      for (let k = 0; k < scored.length; k++) {
        const a = scored[k].a;
        const to = Number(a?.move_unit?.to_cell_index);
        const region = describeCellRegion(snapshot, to);
        add({
          id: `i${i}_mv${k}`,
          intentIndex: i,
          summary: `move ${st.unit || uid} -> ${region} (cell ${a.move_unit?.to_cell_index})`,
          action_ids: [Number(a.id)],
          signals: { kind: 'move', score: scored[k].s },
          chain: null,
        });
      }
      if (!scored.length) add({ id: `i${i}_hold`, intentIndex: i, summary: 'hold (no move)', action_ids: [], signals: { reason: 'no_move' }, chain: null });
      continue;
    }

    if (type === 'direct_attack') {
      const uid = resolveUnitIdByName(snapshot, st.unit);
      const preferred = resolveEnemyUnitIdByName(snapshot, st.target);
      const atks = (actions || []).filter((a: any) => a?.unit_attack && Number(a.unit_attack.attacker_unit_id) === Number(uid) && Number.isFinite(Number(a.id)));
      const scored = atks.map((a: any) => {
        const tid = Number(a?.unit_attack?.target_unit_id);
        let s = Number.isFinite(tid) ? scoreTarget(snapshot, tid) : 0;
        if (preferred != null && tid === preferred) s += 80;
        return { a, s };
      }).sort((x: any, y: any) => y.s - x.s).slice(0, Math.max(1, perIntentLimit));
      for (let k = 0; k < scored.length; k++) {
        const a = scored[k].a;
        add({
          id: `i${i}_atk${k}`,
          intentIndex: i,
          summary: `attack ${st.unit || uid} -> ${a.unit_attack?.target_unit_id}`,
          action_ids: [Number(a.id)],
          signals: { kind: 'attack', score: scored[k].s },
          chain: null,
        });
      }
      if (!scored.length) add({ id: `i${i}_hold`, intentIndex: i, summary: 'hold (no attack)', action_ids: [], signals: { reason: 'no_attack' }, chain: null });
      continue;
    }

    if (type === 'aggressive_play' || type === 'defensive_play' || type === 'develop_board') {
      const cardName = norm(st.card);
      const plays = (actions || []).filter((a: any) => a?.play_card && Number.isFinite(Number(a.id)));
      const filtered = cardName
        ? plays.filter((a: any) => {
            const cid = Number(a?.play_card?.card_id);
            const nm1 = norm(a?.card_name ?? '');
            const nm2 = norm(handNames.get(cid) ?? '');
            const nm = nm1 || nm2;
            return nm && fuzzyIncludes(nm, cardName);
          })
        : plays;
      const preferBack = (type === 'defensive_play') || ['back', '后', '後', '后排'].some(k => zone.includes(k));
      const preferFront = !preferBack;
      const scored = filtered.map((a: any) => {
        const cell = Number(a?.play_card?.cell_index);
        let s = 0;
        if (Number.isFinite(cell)) {
          const f = scoreCellForward(snapshot, cell);
          if (preferFront) s += f * 2;
          if (preferBack) s += -f * 2;
        }
        return { a, s };
      }).sort((x: any, y: any) => y.s - x.s).slice(0, Math.max(1, perIntentLimit));
      for (let k = 0; k < scored.length; k++) {
        const a = scored[k].a;
        const cell = Number(a?.play_card?.cell_index);
        const region = describeCellRegion(snapshot, cell);
        add({
          id: `i${i}_play${k}`,
          intentIndex: i,
          summary: `play ${a?.card_name ?? a?.play_card?.card_id} @ ${region} (cell ${a?.play_card?.cell_index})`,
          action_ids: [Number(a.id)],
          signals: { kind: 'play_card', score: scored[k].s },
          chain: null,
        });
      }
      if (!scored.length) add({ id: `i${i}_hold`, intentIndex: i, summary: 'hold (no play)', action_ids: [], signals: { reason: 'no_play' }, chain: null });
      continue;
    }

    if (type === 'advance_and_attack') {
      const uid = resolveUnitIdByName(snapshot, st.unit);
      const preferred = resolveEnemyUnitIdByName(snapshot, st.target);
      const atks = (actions || []).filter((a: any) => a?.unit_attack && Number(a.unit_attack.attacker_unit_id) === Number(uid) && Number.isFinite(Number(a.id)));
      // immediate attack candidates first
      const atkScored = atks.map((a: any) => {
        const tid = Number(a?.unit_attack?.target_unit_id);
        let s = Number.isFinite(tid) ? scoreTarget(snapshot, tid) : 0;
        if (preferred != null && tid === preferred) s += 80;
        return { a, s };
      }).sort((x: any, y: any) => y.s - x.s).slice(0, Math.max(1, Math.floor(perIntentLimit / 2)));
      for (let k = 0; k < atkScored.length; k++) {
        const a = atkScored[k].a;
        add({
          id: `i${i}_atk${k}`,
          intentIndex: i,
          summary: `attack-now ${st.unit || uid} -> ${a.unit_attack?.target_unit_id}`,
          action_ids: [Number(a.id)],
          signals: { kind: 'attack', score: atkScored[k].s },
          chain: null,
        });
      }
      // move candidates that enable an attack per preview
      const moves = (actions || []).filter((a: any) => a?.move_unit && Number(a.move_unit.unit_id) === Number(uid) && Number.isFinite(Number(a.id)));
      const pv = Array.isArray(tacticalPreview) ? tacticalPreview : [];
      const mvHints: Array<{ to: number; tgt: number; sc: number }> = [];
      for (const row of pv) {
        const unit = Number(row?.unit_id ?? row?.move_then_attack?.unit_id);
        if (!Number.isFinite(unit) || unit !== Number(uid)) continue;
        const to = Number(row?.to_cell_index ?? row?.move_then_attack?.to_cell_index);
        if (!Number.isFinite(to)) continue;
        const atks2 = Array.isArray(row?.attacks) ? row.attacks : null;
        if (atks2 && atks2.length) {
          for (const a of atks2) {
            const tid = Number(a?.target_unit_id);
            if (!Number.isFinite(tid)) continue;
            let sc = 10 + scoreTarget(snapshot, tid);
            if (a?.kill === true) sc += 40;
            if (preferred != null && tid === preferred) sc += 80;
            mvHints.push({ to, tgt: tid, sc });
          }
        } else {
          const tid = Number(row?.move_then_attack?.target_unit_id);
          if (Number.isFinite(tid)) {
            let sc = 10 + scoreTarget(snapshot, tid);
            if (preferred != null && tid === preferred) sc += 80;
            mvHints.push({ to, tgt: tid, sc });
          }
        }
      }
      mvHints.sort((a, b) => b.sc - a.sc);
      const usedTo = new Set<number>();
      let added = 0;
      for (const h of mvHints) {
        if (added >= Math.max(1, perIntentLimit)) break;
        if (usedTo.has(h.to)) continue;
        usedTo.add(h.to);
        const mv = moves.find((m: any) => Number(m?.move_unit?.to_cell_index) === Number(h.to));
        if (!mv) continue;
        const region = describeCellRegion(snapshot, h.to);
        add({
          id: `i${i}_mv${added}`,
          intentIndex: i,
          summary: `move ${st.unit || uid} -> ${region} (cell ${h.to}, enables attack ${h.tgt})`,
          action_ids: [Number(mv.id)],
          signals: { kind: 'move', score: h.sc, enables_attack: true },
          chain: { kind: 'attack_after_move', attacker_unit_id: Number(uid), preferred_target_unit_id: Number.isFinite(h.tgt) ? Number(h.tgt) : (preferred ?? null) },
        });
        added++;
      }
      if (added === 0 && atkScored.length === 0) add({ id: `i${i}_hold`, intentIndex: i, summary: 'hold (no attack/move)', action_ids: [], signals: { reason: 'no_attack_or_move' }, chain: null });
      continue;
    }

    // unknown -> hold
    add({ id: `i${i}_hold`, intentIndex: i, summary: 'hold (unknown)', action_ids: [], signals: { reason: 'unknown_intent' }, chain: null });
  }

  return out;
}


