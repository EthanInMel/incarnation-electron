import type {AgentConfig} from './types.js';

export function buildKnowledgeSnippet(
  cfg: AgentConfig,
  snapshot: any,
  actions: any[],
  parseKeyedLines:(text:string)=>Record<string,string>,
  collectRelated:(snapshot:any, cardMap:Record<string,string>)=>string,
) {
  try {
    const k = cfg.knowledge || {};
    const w = Number.isFinite(k.weight) ? Number(k.weight) : 0.6;
    const parts: string[] = [];
    if (k.global) parts.push(`[Global:${w}] ${k.global}`);
    if (k.phase && snapshot && typeof snapshot.turn === 'number') {
      const map = parseKeyedLines(k.phase);
      const t = Number(snapshot.turn)||0;
      const phase = t < 6 ? 'early' : (t < 12 ? 'mid' : 'late');
      const note = map[phase];
      if (note) parts.push(`[Phase:${w}] (${phase}) ${note}`);
    }
    if (k.cards) {
      const map = parseKeyedLines(k.cards);
      const related = collectRelated(snapshot, map);
      if (related) parts.push(`[Cards:${w}] ${related}`);
    }
    return parts.join('\n');
  } catch { return ''; }
}

export function parseKeyedLines(text: string): Record<string,string> {
  const map: Record<string,string> = {};
  for (const ln of String(text).split('\n')) {
    const s = ln.trim(); if (!s) continue;
    const idx = s.indexOf(':'); if (idx <= 0) continue;
    const key = s.slice(0, idx).trim();
    const val = s.slice(idx+1).trim();
    if (key) map[key] = val;
  }
  return map;
}

export function collectRelatedCardNotes(snapshot: any, cardMap: Record<string,string>) {
  try {
    const lines: string[] = [];
    const add = (id: any) => { const n = cardMap[String(id)] || cardMap[Number(id)]; if (n) lines.push(`${id}:${n}`); };
    if (snapshot?.self && Array.isArray(snapshot.self.hand)) {
      for (const c of snapshot.self.hand) { if (c && (c.card_id!=null || c.id!=null)) add(c.card_id ?? c.id); }
    }
    if (Array.isArray(snapshot?.self_units)) {
      for (const u of snapshot.self_units) { if (u && (u.card_id!=null || u.id!=null)) add(u.card_id ?? u.id); }
    }
    if (Array.isArray(snapshot?.enemy_units)) {
      for (const u of snapshot.enemy_units) { if (u && (u.card_id!=null || u.id!=null)) add(u.card_id ?? u.id); }
    }
    return lines.join('; ');
  } catch { return ''; }
}
