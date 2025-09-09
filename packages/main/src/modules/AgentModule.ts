import type {AppModule} from '../AppModule.js';
import type {ModuleContext} from '../ModuleContext.js';
import {BrowserWindow, ipcMain} from 'electron';
import {createConnection, type Socket} from 'node:net';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import axios, {type AxiosInstance} from 'axios';

type AgentSocketMessage =
  | {type: 'subscribe_ack'}
  | {type: 'game_ready'}
  | {type: 'game_over'}
  | {type: 'state'; snapshot: any}
  | {type: 'available_actions'; actions: any[]}
  | {type: 'action_result'; id: number}
  | {type: 'error'; message?: string}
  | Record<string, unknown>;

type AgentConfig = {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl: string;
  bridgeToken?: string;
  temperature: number;
  maxTokens: number;
  maxSteps: number;
  maxTurnMs: number;
  endpoint?: string;
  systemPrompt?: string;
  decisionMode?: 'json_strict'|'tool_call'|'rank_then_choose'|'policy_only';
  strategyProfile?: 'balanced'|'aggressive'|'defensive';
  adaptiveTemp?: boolean;
  minTemp?: number;
  maxTemp?: number;
  fewshot?: string;
  nBest?: number;
  nBestParallel?: boolean;
  maxActions?: number;
  knowledge?: {
    weight?: number;
    global?: string;
    phase?: string;
    cards?: string;
  };
  paused?: boolean;
};

const DEFAULT_CFG: AgentConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: 'http://localhost:3000',
  bridgeToken: 'dev',
  temperature: 0.2,
  maxTokens: 512,
  maxSteps: 6,
  maxTurnMs: 12000,
  endpoint: 'chat/completions',
  decisionMode: 'json_strict',
  strategyProfile: 'balanced',
  adaptiveTemp: true,
  minTemp: 0.1,
  maxTemp: 0.7,
  nBest: 1,
  nBestParallel: false,
  maxActions: 24,
  knowledge: {weight: 0.6},
};

export class AgentModule implements AppModule {
  readonly #host: string;
  readonly #port: number;
  #socket: Socket | null = null;
  #buffer = '';
  #inflight: {reqId: string; ts: number} | null = null;
  #axios: AxiosInstance;
  #cfg: AgentConfig = {...DEFAULT_CFG};
  #configPath = '';
  #lastActions: any[] | null = null;
  #lastSnapshot: any | null = null;
  #turn = {startedAt: 0, steps: 0};
  #paused = false;
  #reconnectTimer: NodeJS.Timeout | null = null;

  constructor({host = '127.0.0.1', port = 17771}: {host?: string; port?: number} = {}) {
    this.#host = host;
    this.#port = port;
    this.#axios = axios.create({timeout: 15000});
  }

  async enable({app}: ModuleContext): Promise<void> {
    await app.whenReady();
    this.#configPath = join(app.getPath('userData'), 'companion-config.json');
    this.#loadConfigFromDisk();
    this.#axios = axios.create({
      baseURL: this.#cfg.baseUrl,
      timeout: 15000,
      headers: this.#cfg.apiKey ? {Authorization: `Bearer ${this.#cfg.apiKey}`} : undefined,
    });

    this.#initIpc();
    try { this.#broadcast('cfg_loaded', this.#cfg); console.log('[agent] cfg_loaded broadcasted'); } catch {}
    this.#connect();

    // Watchdog for long decisions
    setInterval(() => this.#watchdog(), 500);
  }

  #initIpc() {
    console.log('[agent] IPC init')

    ipcMain.on('cfg', (_e, cfg: AgentConfig) => {
      try {
        const {provider, model, baseUrl, endpoint} = cfg || ({} as any)
        console.log('[agent] cfg (on) received', {provider, model, baseUrl, endpoint})
      } catch {}
      this.#updateConfig(cfg);
      const p = this.#saveConfigToDisk();
      this.#broadcast('cfg_saved', {path: p});
    });

    ipcMain.handle('cfg', async (_e, cfg: AgentConfig) => {
      try {
        const {provider, model, baseUrl, endpoint} = cfg || ({} as any)
        console.log('[agent] cfg (invoke) received', {provider, model, baseUrl, endpoint})
      } catch {}
      this.#updateConfig(cfg);
      const p = this.#saveConfigToDisk();
      console.log('[agent] cfg saved', {path: p});
      this.#broadcast('cfg_saved', {path: p});
      return {ok: true, path: p};
    });

    ipcMain.handle('get_cfg', async () => {
      console.log('[agent] get_cfg requested')
      return this.#cfg;
    });
  }

  #broadcast(channel: string, payload: unknown) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }

  // config path resolved in enable()

  #loadConfigFromDisk() {
    try {
      if (existsSync(this.#configPath)) {
        const raw = readFileSync(this.#configPath, 'utf8');
        const parsed = JSON.parse(raw);
        this.#updateConfig(parsed);
      }
    } catch {}
  }

  #saveConfigToDisk(): string | null {
    try {
      writeFileSync(this.#configPath, JSON.stringify(this.#cfg, null, 2), 'utf8');
      console.log('[agent] cfg written to disk', {path: this.#configPath})
      return this.#configPath;
    } catch {
      console.warn('[agent] failed to write cfg to disk', {path: this.#configPath})
      return null;
    }
  }

  #updateConfig(partial: Partial<AgentConfig>) {
    this.#cfg = {...this.#cfg, ...partial, knowledge: {...(this.#cfg.knowledge||{}), ...(partial.knowledge||{})}};
    this.#paused = !!this.#cfg.paused;
    if (partial.baseUrl || partial.apiKey) {
      this.#axios = axios.create({
        baseURL: this.#cfg.baseUrl,
        timeout: 15000,
        headers: this.#cfg.apiKey ? {Authorization: `Bearer ${this.#cfg.apiKey}`} : undefined,
      });
    }
  }

  #connect() {
    if (this.#socket) {
      this.#socket.destroy();
      this.#socket = null;
    }

    const sock = createConnection({host: this.#host, port: this.#port}, () => {
      this.#send({type: 'subscribe', token: this.#cfg.bridgeToken || 'dev'});
    });

    sock.on('data', (buf) => {
      this.#buffer += buf.toString('utf8');
      while (true) {
        const idx = this.#buffer.indexOf('\n');
        if (idx < 0) break;
        const line = this.#buffer.slice(0, idx);
        this.#buffer = this.#buffer.slice(idx + 1);
        this.#handleLine(line);
      }
    });

    sock.on('error', (err) => console.error('[agent] socket error', err));
    sock.on('close', () => {
      this.#socket = null;
      if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = setTimeout(() => this.#connect(), 1000);
    });

    this.#socket = sock;
  }

  #send(obj: unknown) {
    try {
      this.#socket?.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      console.error('[agent] send error', e);
    }
  }

  #handleLine(line: string) {
    const s = line.trim();
    if (!s) return;
    let msg: AgentSocketMessage;
    try { msg = JSON.parse(s) as AgentSocketMessage; } catch (e) { console.error('[agent] bad json', e); return; }

    switch (msg.type) {
      case 'subscribe_ack':
        console.log('[agent] subscribed');
        break;
      case 'game_ready':
        console.log('[agent] game_ready');
        break;
      case 'game_over':
        console.log('[agent] game_over');
        this.#inflight = null;
        break;
      case 'state':
        this.#lastSnapshot = (msg as any).snapshot ?? null;
        this.#updateTurnState();
        try { this.#broadcast('state', {snapshot: this.#lastSnapshot}); } catch {}
        break;
      case 'available_actions': {
        const actions = (msg as any).actions || [];
        this.#lastActions = actions;
        this.#stepDecision(actions).catch(console.error);
        break;
      }
      case 'action_result':
        this.#inflight = null;
        break;
      case 'error':
        console.error('[agent] error', (msg as any).message);
        break;
      default:
        break;
    }
  }

  #updateTurnState() {
    try {
      const t = Number(this.#lastSnapshot?.turn ?? 0);
      if (!Number.isFinite(t)) return;
      if (String(t) !== String((this as any)._lastTurnId || '')) {
        (this as any)._lastTurnId = String(t);
        this.#turn = {startedAt: Date.now(), steps: 0};
      }
    } catch {}
  }

  #watchdog() {
    const DECISION_TIMEOUT_MS = 6000;
    if (this.#inflight && Date.now() - this.#inflight.ts > DECISION_TIMEOUT_MS) {
      console.warn('[agent] decision timeout, trying fallback end_turn');
      this.#inflight = null;
      const endAct = this.#lastActions?.find(a => a && a.end_turn);
      if (endAct) this.#sendAction(endAct.id);
    }
  }

  #sendAction(actionId: number) {
    const reqId = randomUUID();
    this.#send({type: 'select_action', id: actionId, req_id: reqId});
    this.#inflight = {reqId, ts: Date.now()};
    this.#turn.steps = (this.#turn.steps || 0) + 1;
    this.#broadcast('decision_log', {actionId, info: 'step++', steps: this.#turn.steps});
  }

  async #stepDecision(actions: any[]) {
    if (!Array.isArray(actions) || actions.length === 0) return;
    if (this.#paused) return;
    if (this.#inflight) return;

    try {
      const chosen = await this.#decide(actions);
      if (chosen == null) return this.#autoPlay(actions);
      const exists = actions.some(a => a && a.id === chosen);
      if (!exists) return this.#autoPlay(actions);
      this.#broadcast('decision_explain', {mode: this.#cfg.decisionMode, turn: this.#lastSnapshot?.turn, steps: this.#turn.steps});
      this.#sendAction(chosen);
    } catch (e) {
      console.error('[agent] decide error', e);
      this.#autoPlay(actions);
    }
  }

  #autoPlay(actions: any[]) {
    const choice = actions.find(a => a && a.hero_power)
      || actions.find(a => a && a.use_skill)
      || actions.find(a => a && a.unit_attack)
      || actions.find(a => a && a.move_unit)
      || actions.find(a => a && a.play_card)
      || actions.find(a => a && a.end_turn);
    if (choice) this.#sendAction(choice.id);
  }

  async #decide(actions: any[]): Promise<number | null> {
    if (!this.#cfg.baseUrl || !this.#cfg.provider) return null;

    const situation = this.#scoreSituation(this.#lastSnapshot, actions);
    const modeUse = this.#chooseMode(this.#cfg.decisionMode || 'json_strict', situation);

    if (modeUse === 'policy_only') {
      this.#autoPlay(actions);
      return null;
    }

    const pruned = this.#pruneActions(actions, this.#cfg.maxActions || 24);
    const prompt = this.#buildDecisionPrompt(this.#lastSnapshot, pruned);
    const temp = this.#computeTemperature(this.#lastSnapshot, pruned, situation);

    // N-best if configured
    const nbestN = Math.max(1, Math.min(8, Math.floor(this.#cfg.nBest || 1)));
    if (nbestN > 1) {
      const nres = await this.#nbestDecide(pruned, this.#lastSnapshot, prompt, temp, {
        n: nbestN,
        parallel: !!this.#cfg.nBestParallel,
      });
      if (nres && nres.actionId != null && pruned.some(a => a.id === nres.actionId)) {
        this.#broadcast('decision_log', {actionId: nres.actionId, text: String(nres.text||'').slice(0,120)});
        this.#broadcast('decision_explain', {mode: modeUse, temp: nres.temp, turn: this.#lastSnapshot?.turn, steps: this.#turn.steps, nBest: nbestN, parallel: !!this.#cfg.nBestParallel, explain: nres.explain, situation});
        return nres.actionId;
      }
    }

    // Rank-then-choose
    if (modeUse === 'rank_then_choose') {
      const payload = {
        model: this.#cfg.model,
        messages: [
          {role: 'system', content: 'Rank actions from best to worst. Output JSON {"ranking":[id,...]} only.'},
          {role: 'user', content: this.#buildRankingPrompt(this.#lastSnapshot, pruned)},
        ],
        temperature: Math.min(temp, 0.3),
        max_tokens: Math.max(128, this.#cfg.maxTokens || 256),
      };
      const res = await this.#callDispatcher(payload);
      const text = this.#extractText(res.data);
      const ranking = this.#parseRankingList(text, pruned) || [];
      const chosenId = this.#selectFromRankingWithKnowledge(pruned, ranking, this.#turn, this.#lastSnapshot);
      if (chosenId != null) {
        this.#broadcast('decision_log', {actionId: chosenId, ranking, text: String(text||'').slice(0,120)});
        this.#broadcast('decision_explain', {mode: 'rank_then_choose', temp, turn: this.#lastSnapshot?.turn, steps: this.#turn.steps, ranking, situation});
        return chosenId;
      }
      // fallback to strict
    }

    // json_strict or tool_call
    const payload = {
      model: this.#cfg.model,
      messages: [
        {role: 'system', content: this.#cfg.systemPrompt || 'Return strictly: Action: <id>'},
        {role: 'user', content: prompt},
      ],
      temperature: temp,
      max_tokens: this.#cfg.maxTokens || 256,
      tools: modeUse === 'tool_call' ? this.#buildToolFunctions(pruned) : undefined,
      tool_choice: modeUse === 'tool_call' ? 'auto' as const : undefined,
    };
    const res = await this.#callDispatcher(payload);
    const fromTool = this.#parseToolChoiceFromResponse(res.data, pruned);
    const text = fromTool == null ? this.#extractText(res.data) : null;
    let id = fromTool != null ? fromTool : this.#parseActionId(text, pruned);
    if (id != null) {
      // avoid very early end_turn if there are other options
      const chosen = pruned.find(a => a.id === id);
      if (chosen?.end_turn && this.#isPrematureEndTurn(this.#turn)) {
        const alt = pruned.find(a => !a.end_turn);
        if (alt) id = alt.id;
      }
      if (id != null) {
        this.#broadcast('decision_log', {actionId: id, text: String(text||'').slice(0,120)});
        this.#broadcast('decision_explain', {mode: modeUse, temp, turn: this.#lastSnapshot?.turn, steps: this.#turn.steps, situation});
      }
    }
    return id;
  }

  #pruneActions(actions: any[], maxActions: number) {
    try {
      if (!Array.isArray(actions)) return actions;
      const maxA = Math.max(6, Math.min(64, Number(maxActions) || 24));
      if (actions.length <= maxA) return actions;
      const keep: any[] = [];
      const ends = actions.filter(a => a && a.end_turn);
      if (ends.length) keep.push(ends[0]);
      const pushSome = (arr: any[], n: number) => { for (let i=0;i<arr.length && keep.length<maxA && i<n;i++) keep.push(arr[i]); };
      pushSome(actions.filter(a => a && a.hero_power), 1);
      pushSome(actions.filter(a => a && a.use_skill), 6);
      pushSome(actions.filter(a => a && a.unit_attack), 12);
      pushSome(actions.filter(a => a && a.play_card), 10);
      pushSome(actions.filter(a => a && a.move_unit), 6);
      for (const a of actions) { if (keep.length>=maxA) break; if (!keep.includes(a)) keep.push(a); }
      return keep;
    } catch { return actions; }
  }

  #buildDecisionPrompt(snapshot: any, actions: any[]) {
    const lines: string[] = [];
    if (snapshot?.turn != null) lines.push(`Turn: ${snapshot.turn}`);
    lines.push('Available actions:');
    for (const a of (actions||[])) {
      lines.push(`- ${a.id}. ${this.#serializeAction(a)}`);
    }
    if (this.#cfg.fewshot) {
      lines.push('Examples:');
      for (const ln of String(this.#cfg.fewshot).split('\n')) { const t = ln.trim(); if (t) lines.push(t); }
    }
    const k = this.#buildKnowledgeSnippet(snapshot, actions);
    if (k) { lines.push('Knowledge:'); lines.push(k); }
    lines.push('Return strictly: Action: <id>');
    return lines.join('\n');
  }

  #buildKnowledgeSnippet(snapshot: any, actions: any[]) {
    try {
      const k = this.#cfg.knowledge || {};
      const w = Number.isFinite(k.weight) ? Number(k.weight) : 0.6;
      const parts: string[] = [];
      if (k.global) parts.push(`[Global:${w}] ${k.global}`);
      if (k.phase && snapshot && typeof snapshot.turn === 'number') {
        const map = this.#parseKeyedLines(k.phase);
        const t = Number(snapshot.turn)||0;
        const phase = t < 6 ? 'early' : (t < 12 ? 'mid' : 'late');
        const note = map[phase];
        if (note) parts.push(`[Phase:${w}] (${phase}) ${note}`);
      }
      if (k.cards) {
        const map = this.#parseKeyedLines(k.cards);
        const related = this.#collectRelatedCardNotes(snapshot, map);
        if (related) parts.push(`[Cards:${w}] ${related}`);
      }
      return parts.join('\n');
    } catch { return ''; }
  }

  #parseKeyedLines(text: string): Record<string,string> {
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

  #collectRelatedCardNotes(snapshot: any, cardMap: Record<string,string>) {
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

  #extractText(data: any): string | null {
    try {
      const d = data && data.data;
      const c = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (typeof c === 'string') return c;
      const tool = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.tool_calls && d.choices[0].message.tool_calls[0];
      if (tool && tool.function && typeof tool.function.arguments === 'string') return tool.function.arguments;
      if (typeof d === 'string') return d;
      return JSON.stringify(d);
    } catch { return null; }
  }

  #parseActionId(text: string | null, actions: any[]): number | null {
    if (!text) return null;
    try {
      const obj = JSON.parse(text);
      if (typeof obj === 'object' && obj !== null) {
        if (typeof (obj as any).action_id === 'number') return (obj as any).action_id;
        if ((obj as any).action && typeof (obj as any).action.id === 'number') return (obj as any).action.id;
      }
    } catch {}
    const m = /Action:\s*(\d+)/i.exec(text);
    if (m) return Number(m[1]);
    const num = Number(String(text).trim());
    if (!Number.isNaN(num)) return num;
    return actions && actions[0] && actions[0].id || null;
  }

  #serializeAction(a: any) {
    if (a?.hero_power) return `Hero Power @ ${a.hero_power.cell_index}`;
    if (a?.use_skill) return `UseSkill unit=${a.use_skill.unit_id} @ ${a.use_skill.cell_index}`;
    if (a?.unit_attack) return `Attack ${a.unit_attack.attacker_unit_id} -> ${a.unit_attack.target_unit_id}`;
    if (a?.move_unit) return `Move unit=${a.move_unit.unit_id} -> ${a.move_unit.to_cell_index}`;
    if (a?.play_card) return `Play card=${a.play_card.card_id} @ ${a.play_card.cell_index}`;
    if (a?.end_turn) return 'End Turn';
    return 'Unknown';
  }

  // --- Advanced decision helpers ---

  #buildRankingPrompt(snapshot: any, actions: any[]) {
    const lines: string[] = [];
    if (snapshot?.turn != null) lines.push(`Turn: ${snapshot.turn}`);
    lines.push('Available actions:');
    for (const a of (actions||[])) lines.push(`- ${a.id}. ${this.#serializeAction(a)}`);
    const k = this.#buildKnowledgeSnippet(snapshot, actions);
    if (k) { lines.push('Knowledge:'); lines.push(k); }
    lines.push('Return strictly JSON like: {"ranking":[3,12,5]}');
    return lines.join('\n');
  }

  #parseRankingList(text: string | null, actions: any[]) {
    if (!text) return null as number[] | null;
    try {
      const obj = JSON.parse(text);
      if (obj && Array.isArray((obj as any).ranking)) return (obj as any).ranking.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n));
      if (Array.isArray(obj)) return obj.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n));
      if (typeof obj === 'object' && obj) {
        if (typeof (obj as any).action_id === 'number') return [(obj as any).action_id];
      }
    } catch {}
    const csv = String(text).match(/\d+/g);
    if (csv && csv.length) return csv.map(Number).filter(n => Number.isFinite(n));
    const single = this.#parseActionId(text, actions);
    return single != null ? [single] : null;
  }

  #selectFromRanking(actions: any[], ranking: number[] | null, turnStateRef: {steps: number}) {
    if (!ranking || !ranking.length) return null as number | null;
    const valid = new Set(actions.map(a => a.id));
    const hasNonEnd = actions.some(a => !a.end_turn);
    const seen = new Set<number>();
    for (const id of ranking) {
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      if (!valid.has(id)) continue;
      const act = actions.find(a => a.id === id);
      if (!act) continue;
      if (act.end_turn && hasNonEnd && this.#isPrematureEndTurn(turnStateRef)) continue;
      return id;
    }
    const fb = actions.find(a => !a.end_turn) || actions.find(a => a.end_turn);
    return fb ? fb.id : null;
  }

  #selectFromRankingWithKnowledge(actions: any[], ranking: number[] | null, turnStateRef: {steps: number}, snapshot: any) {
    try {
      if (!ranking || !ranking.length) return null as number | null;
      const topK: {id: number; act: any; idx: number}[] = [];
      const valid = new Set(actions.map(a => a.id));
      const hasNonEnd = actions.some(a => !a.end_turn);
      const seen = new Set<number>();
      for (let i=0;i<ranking.length && topK.length<5;i++){
        const id = ranking[i];
        if (!Number.isFinite(id) || seen.has(id)) continue;
        seen.add(id);
        if (!valid.has(id)) continue;
        const act = actions.find(a => a.id === id);
        if (!act) continue;
        if (act.end_turn && hasNonEnd && this.#isPrematureEndTurn(turnStateRef)) continue;
        topK.push({id, act, idx: i});
      }
      if (!topK.length) return this.#selectFromRanking(actions, ranking, turnStateRef);
      const phaseMap = this.#cfg.knowledge?.phase ? this.#parseKeyedLines(this.#cfg.knowledge.phase) : {} as Record<string,string>;
      const cardMap = this.#cfg.knowledge?.cards ? this.#parseKeyedLines(this.#cfg.knowledge.cards) : {} as Record<string,string>;
      const phase = this.#getPhaseFromTurn(snapshot?.turn);
      const globalTxt = this.#cfg.knowledge?.global || '';
      const phaseTxt = (phaseMap && (phaseMap as any)[phase]) || '';
      const w = Math.max(0, Math.min(1, Number.isFinite(this.#cfg.knowledge?.weight as number) ? (this.#cfg.knowledge?.weight as number) : 0));
      let best = topK[0];
      let bestScore = -1;
      for (const cand of topK) {
        const base = 1 - (cand.idx / Math.max(1, (ranking?.length||1) - 1));
        const kscore = this.#knowledgeScoreForAction(snapshot, cand.act, {globalTxt, phaseTxt, cardMap});
        const score = (1 - w) * base + w * kscore;
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      return best ? best.id : this.#selectFromRanking(actions, ranking, turnStateRef);
    } catch {
      return this.#selectFromRanking(actions, ranking, turnStateRef);
    }
  }

  #knowledgeScoreForAction(snapshot: any, act: any, ctx: {globalTxt?: string; phaseTxt?: string; cardMap?: Record<string,string>}) {
    try {
      const {globalTxt = '', phaseTxt = '', cardMap = {}} = ctx || {};
      let s = 0;
      if (act?.play_card?.card_id != null) {
        if (this.#hasCardNote(cardMap, act.play_card.card_id)) s += 0.6;
      }
      if (act?.use_skill?.unit_id != null) {
        const cid = this.#resolveUnitCardId(snapshot, act.use_skill.unit_id);
        if (cid != null && this.#hasCardNote(cardMap, cid)) s += 0.5;
      }
      if (act?.unit_attack?.attacker_unit_id != null) {
        const cidA = this.#resolveUnitCardId(snapshot, act.unit_attack.attacker_unit_id);
        if (cidA != null && this.#hasCardNote(cardMap, cidA)) s += 0.3;
      }
      const allTxt = `${String(globalTxt).toLowerCase()} ${String(phaseTxt).toLowerCase()}`;
      if (allTxt.includes('铺场')) { if (act.play_card) s += 0.3; else if (act.move_unit) s += 0.05; }
      if (allTxt.includes('控场')) { if (act.unit_attack) s += 0.3; else if (act.use_skill) s += 0.25; }
      if (allTxt.includes('斩杀')) { if (act.unit_attack) s += 0.3; else if (act.hero_power) s += 0.2; else if (act.play_card) s += 0.1; }
      return Math.max(0, Math.min(1, s));
    } catch { return 0; }
  }

  #hasCardNote(cardMap: Record<string,string>, id: any) {
    try { return Boolean(cardMap[String(id)] || cardMap[Number(id)]); } catch { return false; }
  }

  #resolveUnitCardId(snapshot: any, unitId: any) {
    try {
      if (!snapshot || unitId == null) return null;
      const scan = (list: any[]) => {
        if (!Array.isArray(list)) return null;
        for (const u of list) { if (!u) continue; const uid = (u as any).unit_id ?? (u as any).id; if (uid === unitId) return (u as any).card_id ?? null; }
        return null;
      };
      return scan(snapshot?.self_units) ?? scan(snapshot?.enemy_units);
    } catch { return null; }
  }

  #getPhaseFromTurn(turn: any) {
    try { const t = Number(turn)||0; return t < 6 ? 'early' : (t < 12 ? 'mid' : 'late'); } catch { return 'mid'; }
  }

  #isPrematureEndTurn(turnStateRef: {steps: number}) {
    try { const steps = turnStateRef?.steps || 0; return steps < Math.max(1, Math.floor((this.#cfg.maxSteps||6) / 2)); } catch { return false; }
  }

  async #nbestDecide(actions: any[], snapshot: any, promptBase: string, tempBase: number, cfg: {n: number; parallel: boolean}) {
    try {
      const n = Math.max(1, Math.min(8, Number(cfg.n)||1));
      const parallel = !!cfg.parallel;
      const variants: {payload: any; temp: number; prompt: string}[] = [];
      for (let i=0;i<n;i++){
        const t = this.#clamp(tempBase + (-0.05 + (0.1 * (i/(Math.max(1,n-1))))), this.#cfg.minTemp ?? 0.1, this.#cfg.maxTemp ?? 0.7);
        const prompt = `${promptBase}\nVariant:${i+1}`;
        variants.push({
          prompt,
          temp: t,
          payload: {
            model: this.#cfg.model,
            messages: [
              {role: 'system', content: this.#cfg.systemPrompt || 'Return strictly: Action: <id>'},
              {role: 'user', content: prompt},
            ],
            temperature: t,
            max_tokens: this.#cfg.maxTokens || 256,
            tools: (this.#cfg.decisionMode === 'tool_call') ? this.#buildToolFunctions(actions) : undefined,
            tool_choice: (this.#cfg.decisionMode === 'tool_call') ? 'auto' as const : undefined,
          },
        });
      }
      const runOne = async (v: {payload:any; temp:number; prompt:string}) => {
        try {
          const res = await this.#callDispatcher(v.payload);
          const fromTool = this.#parseToolChoiceFromResponse(res.data, actions);
          const text = fromTool == null ? this.#extractText(res.data) : null;
          const actionId = fromTool != null ? fromTool : this.#parseActionId(text, actions);
          return {actionId, text, temp: v.temp, prompt: v.prompt};
        } catch (e: any) {
          return {actionId: null as number | null, text: String(e?.message||e), temp: v.temp, prompt: v.prompt};
        }
      };
      const results = parallel ? await Promise.all(variants.map(runOne)) : await (async()=>{ const arr:any[]=[]; for (const v of variants){ arr.push(await runOne(v)); } return arr; })();
      const valid = results.filter(r => r && r.actionId != null && actions.some(a => a.id === r.actionId));
      if (!valid.length) return null as any;
      const byId = new Map<number, {count:number; items:any[]}>();
      for (const r of valid) { const prev = byId.get(r.actionId as number) || {count:0, items:[]}; prev.count += 1; prev.items.push(r); byId.set(r.actionId as number, prev); }
      let bestId: number | null = null; let bestScore = -1; const explain = {candidates: [] as any[]};
      for (const [id, ag] of byId.entries()) {
        const freq = ag.count / valid.length;
        const score = freq; // simple aggregation here
        if (score > bestScore) { bestScore = score; bestId = id; }
        explain.candidates.push({id, freq, samples: ag.items.slice(0,2)});
      }
      return {actionId: bestId, text: valid[0]?.text, temp: tempBase, explain};
    } catch { return null; }
  }

  #computeTemperature(snapshot: any, actions: any[], situation: {advantage: number; profilePrefer: string} | null) {
    try {
      if (!this.#cfg.adaptiveTemp) return this.#clampTemp(this.#cfg.temperature ?? 0.2);
      const profile = (situation && (situation as any).profilePrefer) || this.#cfg.strategyProfile || 'balanced';
      const minT = Number.isFinite(this.#cfg.minTemp) ? (this.#cfg.minTemp as number) : 0.1;
      const maxT = Number.isFinite(this.#cfg.maxTemp) ? (this.#cfg.maxTemp as number) : 0.7;
      const tBase = this.#clamp(this.#cfg.temperature ?? 0.2, minT, maxT);
      const n = Array.isArray(actions) ? actions.length : 0;
      const k = Math.max(1, Math.min(10, Math.floor(n / 3)));
      let adj = tBase;
      switch (profile) {
        case 'aggressive': adj = tBase + 0.1 + 0.02 * k; break;
        case 'defensive': adj = tBase - 0.05 - 0.02 * k; break;
        case 'balanced':
        default: adj = tBase + 0.01 * k; break;
      }
      adj -= 0.02 * Math.max(0, (this.#turn?.steps || 0) - 1);
      if (situation && Number.isFinite((situation as any).advantage)) {
        adj += 0.05 * (((situation as any).advantage) - 0.5);
      }
      return this.#clamp(adj, minT, maxT);
    } catch { return this.#cfg.temperature ?? 0.2; }
  }

  #scoreSituation(snapshot: any, actions: any[]) {
    try {
      const s = {advantage: 0.5, profilePrefer: 'balanced' as 'balanced'|'aggressive'|'defensive', modePrefer: null as any};
      if (!snapshot) return s;
      const myHp = snapshot?.self && (snapshot.self.health ?? snapshot.self.hp ?? 0);
      const opHp = snapshot?.enemy && (snapshot.enemy.health ?? snapshot.enemy.hp ?? 0);
      const myUnits = Array.isArray(snapshot?.self_units) ? snapshot.self_units.length : 0;
      const opUnits = Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units.length : 0;
      const myHand = snapshot?.self && Array.isArray(snapshot.self.hand) ? snapshot.self.hand.length : 0;
      const opHand = snapshot?.enemy && Array.isArray(snapshot.enemy.hand) ? snapshot.enemy.hand.length : 0;
      const myMana = snapshot?.self && (snapshot.self.mana ?? snapshot.self.energy ?? 0);
      let adv = 0.5;
      adv += 0.1 * Math.tanh(((myHp||0) - (opHp||0)) / 20);
      adv += 0.1 * Math.tanh((myUnits - opUnits) / 3);
      adv += 0.05 * Math.tanh((myHand - opHand) / 3);
      adv += 0.05 * Math.tanh((myMana) / 5);
      adv = Math.max(0, Math.min(1, adv));
      (s as any).advantage = adv;
      (s as any).profilePrefer = adv > 0.6 ? 'aggressive' : (adv < 0.4 ? 'defensive' : 'balanced');
      const nActs = Array.isArray(actions) ? actions.length : 0;
      (s as any).modePrefer = nActs > 18 ? 'tool_call' : (nActs > 8 ? 'rank_then_choose' : 'json_strict');
      return s;
    } catch { return {advantage: 0.5, profilePrefer: 'balanced', modePrefer: null}; }
  }

  #chooseMode(current: 'json_strict'|'tool_call'|'rank_then_choose'|'policy_only'|undefined, situation: any) {
    try { if (current === 'policy_only') return current; return situation?.modePrefer || current || 'json_strict'; } catch { return current || 'json_strict'; }
  }

  #buildToolFunctions(actions: any[]) {
    try {
      const playCards = actions.filter(a => a?.play_card);
      const unitAttacks = actions.filter(a => a?.unit_attack);
      const moves = actions.filter(a => a?.move_unit);
      const skills = actions.filter(a => a?.use_skill);
      const powers = actions.filter(a => a?.hero_power);
      const ends = actions.filter(a => a?.end_turn);
      const uniq = (arr: any[]) => Array.from(new Set(arr.filter(x => x != null)));
      const tools: any[] = [];
      if (playCards.length) {
        const cardIds = uniq(playCards.map((a:any) => a.play_card.card_id));
        const cells = uniq(playCards.map((a:any) => a.play_card.cell_index));
        tools.push({ type: 'function', function: { name: 'play_card', description: 'Play a card to a target cell.', parameters: { type: 'object', properties: { card_id: { type: 'number', enum: cardIds }, cell_index: { type: 'number', enum: cells } }, required: ['card_id','cell_index'] } } });
      }
      if (unitAttacks.length) {
        const attackers = uniq(unitAttacks.map((a:any) => a.unit_attack.attacker_unit_id));
        const targets = uniq(unitAttacks.map((a:any) => a.unit_attack.target_unit_id));
        tools.push({ type: 'function', function: { name: 'unit_attack', description: 'Attack a target unit with an attacker unit.', parameters: { type: 'object', properties: { attacker_unit_id: { type: 'number', enum: attackers }, target_unit_id: { type: 'number', enum: targets } }, required: ['attacker_unit_id','target_unit_id'] } } });
      }
      if (moves.length) {
        const uids = uniq(moves.map((a:any) => a.move_unit.unit_id));
        const cells = uniq(moves.map((a:any) => a.move_unit.to_cell_index));
        tools.push({ type: 'function', function: { name: 'move_unit', description: 'Move a unit to a reachable cell index.', parameters: { type: 'object', properties: { unit_id: { type: 'number', enum: uids }, to_cell_index: { type: 'number', enum: cells } }, required: ['unit_id','to_cell_index'] } } });
      }
      if (skills.length) {
        const uids = uniq(skills.map((a:any) => a.use_skill.unit_id));
        const cells = uniq(skills.map((a:any) => a.use_skill.cell_index));
        tools.push({ type: 'function', function: { name: 'use_skill', description: 'Use a unit skill on a target cell if applicable.', parameters: { type: 'object', properties: { unit_id: { type: 'number', enum: uids }, cell_index: { type: 'number', enum: cells } }, required: ['unit_id','cell_index'] } } });
      }
      if (powers.length) {
        const cellsAll = uniq(powers.map((a:any) => a.hero_power && a.hero_power.cell_index));
        const hasCells = cellsAll.filter((x:any) => x != null).length > 0;
        tools.push({ type: 'function', function: { name: 'hero_power', description: 'Use hero power. If target cell required, provide it.', parameters: { type: 'object', properties: { cell_index: hasCells ? { type: 'number', enum: cellsAll.filter((x:any) => x != null) } : { type: 'number' } }, required: hasCells ? ['cell_index'] : [] } } });
      }
      if (ends.length) {
        tools.push({ type: 'function', function: { name: 'end_turn', description: 'End the turn when no better actions remain.', parameters: { type: 'object', properties: {}, required: [] } } });
      }
      const actionIds = Array.from(new Set((actions||[]).map((a:any) => a?.id).filter((x:any) => Number.isFinite(x))));
      if (actionIds.length) {
        tools.push({ type: 'function', function: { name: 'choose_action', description: 'Choose exactly one action by id from the allowed enum.', parameters: { type: 'object', properties: { action_id: { type: 'number', enum: actionIds } }, required: ['action_id'] } } });
      }
      return tools;
    } catch { return []; }
  }

  #parseToolChoiceFromResponse(data: any, actions: any[]) {
    try {
      const d = data && (data as any).data;
      const calls = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.tool_calls;
      if (!Array.isArray(calls) || !calls.length) return null as number | null;
      for (const c of calls) {
        if (!c || !c.function || typeof c.function.name !== 'string') continue;
        let args: any = {};
        try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch {}
        const id = this.#mapToolCallToActionId(c.function.name, args, actions);
        if (id != null) return id;
      }
      return null as number | null;
    } catch { return null; }
  }

  #mapToolCallToActionId(name: string, args: any, actions: any[]) {
    try {
      switch (name) {
        case 'choose_action': {
          const id = Number(args?.action_id);
          return Number.isFinite(id) && actions.some(a => a.id === id) ? id : null;
        }
        case 'play_card': {
          const cid = Number(args?.card_id);
          const cell = Number(args?.cell_index);
          let match = actions.find(a => a?.play_card && a.play_card.card_id === cid && a.play_card.cell_index === cell);
          if (!match && Number.isFinite(cid)) match = actions.find(a => a?.play_card && a.play_card.card_id === cid);
          return match ? match.id : null;
        }
        case 'unit_attack': {
          const att = Number(args?.attacker_unit_id);
          const tgt = Number(args?.target_unit_id);
          const match = actions.find(a => a?.unit_attack && a.unit_attack.attacker_unit_id === att && a.unit_attack.target_unit_id === tgt);
          return match ? match.id : null;
        }
        case 'move_unit': {
          const uid = Number(args?.unit_id);
          const cell = Number(args?.to_cell_index);
          const match = actions.find(a => a?.move_unit && a.move_unit.unit_id === uid && a.move_unit.to_cell_index === cell);
          return match ? match.id : null;
        }
        case 'use_skill': {
          const uid = Number(args?.unit_id);
          const cell = Number(args?.cell_index);
          let match = actions.find(a => a?.use_skill && a.use_skill.unit_id === uid && a.use_skill.cell_index === cell);
          if (!match && Number.isFinite(uid)) match = actions.find(a => a?.use_skill && a.use_skill.unit_id === uid);
          return match ? match.id : null;
        }
        case 'hero_power': {
          if (args && args.cell_index != null) {
            const cell = Number(args.cell_index);
            const match = actions.find(a => a?.hero_power && a.hero_power.cell_index === cell);
            if (match) return match.id;
          }
          const any = actions.find(a => a?.hero_power);
          return any ? any.id : null;
        }
        case 'end_turn': {
          const match = actions.find(a => a?.end_turn);
          return match ? match.id : null;
        }
        default:
          return null;
      }
    } catch { return null; }
  }

  async #callDispatcher(payload: any) {
    const url = '/dispatch';
    let attempt = 0; let lastErr: any = null;
    while (attempt < 2) {
      try {
        return await this.#axios.post(url, {
          provider: this.#cfg.provider,
          model: this.#cfg.model,
          endpoint: this.#cfg.endpoint || 'chat/completions',
          payload,
          source: 'electron-agent',
        });
      } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 500 * (attempt + 1))); attempt++; }
    }
    throw lastErr || new Error('dispatcher failed');
  }

  #clampTemp(val: number) {
    try { return this.#clamp(val, this.#cfg.minTemp ?? 0.1, this.#cfg.maxTemp ?? 0.7); } catch { return val; }
  }
  #clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)); }
}

export function createAgentModule(...args: ConstructorParameters<typeof AgentModule>) {
  return new AgentModule(...args);
}

