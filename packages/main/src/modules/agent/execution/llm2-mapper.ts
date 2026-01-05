/**
 * LLM2 Mapper (v1)
 *
 * Purpose:
 * - Take "strategy contract" (intent steps) + a compact list of candidates that are already legal,
 *   and ask an LLM to ONLY choose among those candidates (no strategy rewrite).
 *
 * This file is intentionally self-contained and uses a minimal OpenAI-compatible call
 * so it can work with the user's gateway.
 */
import type { AgentConfig } from '../types.js';

export type Candidate = {
  id: string;
  intentIndex: number;
  summary: string;
  action_ids: number[];
  signals?: Record<string, any>;
};

export type LLM2Selection = {
  ok: boolean;
  ordered_action_ids: number[];
  picks: Array<{ intentIndex: number; candidateId: string | null; reason?: string }>;
  rawText?: string | null;
  error?: string | null;
};

function buildMapperPrompt(params: {
  turn?: number;
  strict: boolean;
  maxActions: number;
  intentSteps: any[];
  candidates: Candidate[];
}): string {
  const { turn, strict, maxActions, intentSteps, candidates } = params;
  const contract = {
    turn: Number.isFinite(Number(turn)) ? Number(turn) : undefined,
    strict,
    maxActions,
    intents: (intentSteps || []).map((s: any, i: number) => ({
      intentIndex: i,
      type: s?.type,
      unit: s?.unit ?? null,
      target: s?.target ?? null,
      card: s?.card ?? null,
      zone: s?.zone ?? null,
      intent: s?.intent ?? null,
    })),
  };
  const compactCandidates = candidates.map(c => ({
    id: c.id,
    intentIndex: c.intentIndex,
    action_ids: c.action_ids,
    summary: c.summary,
    signals: c.signals ?? undefined,
  }));

  return [
    'You are a strict "compiler assistant".',
    'Your job is to choose among PRE-COMPUTED legal candidates only.',
    '',
    'Rules (HARD):',
    '- You MUST NOT rewrite strategy, invent new actions, or change units/targets/cards.',
    '- You MUST ONLY pick from the provided candidates by id.',
    '- You MUST output STRICT JSON only (no markdown).',
    `- Total output actions must be <= ${maxActions}.`,
    strict ? '- strict=true: do not pick risky/guessy candidates; prefer safe, directly legal actions.' : '',
    '',
    'Strategy contract (read-only):',
    JSON.stringify(contract, null, 2),
    '',
    'Candidates (pick at most 1 per intentIndex, or null):',
    JSON.stringify(compactCandidates, null, 2),
    '',
    'Output JSON schema:',
    '{',
    '  "picks": [{"intentIndex":0,"candidateId":"c0" | null, "reason":"..."}],',
    '  "ordered_action_ids": [123,456],',
    '  "notes": "optional"',
    '}',
  ].filter(Boolean).join('\n');
}

async function callOpenAICompatible(cfg: AgentConfig, prompt: string): Promise<{ text: string; raw: any }> {
  const baseUrl = (cfg.baseUrl && cfg.baseUrl.trim().length > 0)
    ? cfg.baseUrl.replace(/\/+$/, '')
    : (String(cfg.provider || '').toLowerCase() === 'siliconflow'
      ? 'https://api.siliconflow.cn/v1'
      : 'https://api.openai.com/v1');

  const url = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;
  // Routing headers (gateway)
  if (cfg.bridgeToken) headers['x-bridge-token'] = String(cfg.bridgeToken);
  if (cfg.upstreamProvider) {
    headers['x-upstream-provider'] = String(cfg.upstreamProvider);
    headers['x-provider'] = String(cfg.upstreamProvider);
  } else if (cfg.provider) {
    headers['x-provider'] = String(cfg.provider);
  }

  const payload: any = {
    model: String(cfg.model || ''),
    messages: [
      { role: 'system', content: 'Return JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 600,
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const raw = await res.json().catch(() => null);
  const text =
    raw?.choices?.[0]?.message?.content ??
    raw?.choices?.[0]?.text ??
    '';
  return { text: String(text || ''), raw };
}

export async function runLLM2Mapper(params: {
  cfg: AgentConfig;
  turn?: number;
  strict: boolean;
  maxActions: number;
  intentSteps: any[];
  candidates: Candidate[];
}): Promise<LLM2Selection> {
  const { cfg, turn, strict, maxActions, intentSteps, candidates } = params;
  try {
    const prompt = buildMapperPrompt({ turn, strict, maxActions, intentSteps, candidates });
    const { text } = await callOpenAICompatible(cfg, prompt);
    let obj: any = null;
    try { obj = JSON.parse(text); } catch { obj = null; }
    if (!obj || typeof obj !== 'object') {
      return { ok: false, ordered_action_ids: [], picks: [], rawText: text, error: 'parse_error' };
    }
    const picks = Array.isArray(obj.picks) ? obj.picks : [];
    const ordered = Array.isArray(obj.ordered_action_ids) ? obj.ordered_action_ids : [];
    const orderedIds = ordered.map((x: any) => Number(x)).filter((x: any) => Number.isFinite(x) && x > 0);
    return {
      ok: orderedIds.length > 0,
      ordered_action_ids: orderedIds.slice(0, Math.max(0, maxActions)),
      picks: picks.map((p: any) => ({
        intentIndex: Number(p?.intentIndex),
        candidateId: (p?.candidateId == null ? null : String(p.candidateId)),
        reason: p?.reason != null ? String(p.reason) : undefined,
      })).filter((p: any) => Number.isFinite(p.intentIndex)),
      rawText: text,
      error: null,
    };
  } catch (e: any) {
    return { ok: false, ordered_action_ids: [], picks: [], rawText: null, error: String(e?.message || e) };
  }
}





