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
  decisionMode?: 'intent'|'policy_only';
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
  orientationOverride?: 'auto'|'as_is'|'flipped';
};

const DEFAULT_CFG: AgentConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: 'http://localhost:3000',
  bridgeToken: 'dev',
  temperature: 0.15,
  maxTokens: 512,
  maxSteps: 6,
  maxTurnMs: 12000,
  endpoint: 'chat/completions',
  decisionMode: 'intent',
  strategyProfile: 'balanced',
  adaptiveTemp: true,
  minTemp: 0.1,
  maxTemp: 0.7,
  nBest: 1,
  nBestParallel: false,
  maxActions: 24,
  knowledge: {weight: 0.6},
  systemPrompt: `你是策略卡牌战棋游戏的 AI，只基于给定战局信息做决策。

严格输出 JSON（不含任何多余文本）：
{
  "action": {
    "type": "play_card|move|unit_attack|hero_power|end_turn",
    // 当 type=play_card:  {"card_id": number, "to": {"row": number, "col": number}|"rXcY"|{"cell_index": number}}
    // 当 type=move:       {"unit_id": number, "to": {"row": number, "col": number}|"rXcY"|{"to_cell_index": number}}
    // 当 type=unit_attack:{"attacker_unit_id": number, "target_unit_id": number}
    // 当 type=hero_power: {"target"?: {"row": number, "col": number}|"rXcY"|{"cell_index": number}}
  },
  "rationale": "<=20字简要理由"
}

约束：
- 不要臆造手牌或单位；ID 与坐标必须来自观测。
- 若无法找到合理行动，输出 end_turn。
- 优先级：解威胁 > 站位安全 > 法力效率 > 场面收益。
- 禁止输出动作 id；禁止输出自由文本；严格遵循上述 JSON 结构。`
  ,
  orientationOverride: 'auto',
};

export class AgentModule implements AppModule {
  readonly #host: string;
  readonly #port: number;
  #socket: Socket | null = null;
  #buffer = '';
  #inflight: {reqId: string; ts: number} | null = null;
  #deciding = false;
  #actionsGen = 0;
  #axios: AxiosInstance;
  #cfg: AgentConfig = {...DEFAULT_CFG};
  #configPath = '';
  #lastActions: any[] | null = null;
  #lastSnapshot: any | null = null;
  #turn = {startedAt: 0, steps: 0};
  #paused = false;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #orientation: 'as_is'|'flipped' = 'as_is';

  constructor({host = '127.0.0.1', port = 17771}: {host?: string; port?: number} = {}) {
    this.#host = host;
    this.#port = port;
    this.#axios = axios.create({timeout: 15000, headers: {'Content-Type': 'application/json; charset=utf-8'}});
  }

  async enable({app}: ModuleContext): Promise<void> {
    await app.whenReady();
    this.#configPath = join(app.getPath('userData'), 'companion-config.json');
    this.#loadConfigFromDisk();
    this.#axios = axios.create({
      baseURL: this.#cfg.baseUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(this.#cfg.apiKey ? {Authorization: `Bearer ${this.#cfg.apiKey}`} : {})
      },
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
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(this.#cfg.apiKey ? {Authorization: `Bearer ${this.#cfg.apiKey}`} : {})
        },
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
        (this as any)._gameOver = false;
        break;
      case 'game_over':
        console.log('[agent] game_over');
        this.#inflight = null;
        (this as any)._gameOver = true;
        break;
      case 'state':
        this.#lastSnapshot = (msg as any).snapshot ?? null;
        this.#updateTurnState();
        try {
          const yhp = Number(this.#lastSnapshot?.you?.hero_hp);
          const ohp = Number(this.#lastSnapshot?.opponent?.hero_hp);
          if (Number.isFinite(yhp) && yhp <= 0) (this as any)._gameOver = true;
          if (Number.isFinite(ohp) && ohp <= 0) (this as any)._gameOver = true;
        } catch {}
        try { this.#broadcast('state', {snapshot: this.#lastSnapshot}); } catch {}
        break;
      case 'available_actions': {
        if ((this as any)._gameOver) { break; }
        const actions = (msg as any).actions || [];
        this.#lastActions = actions;
        // detect orientation if needed
        try { this.#updateOrientation(actions); } catch {}
        const gen = ++this.#actionsGen;
        try {
          const summary = this.#summarizeActions(actions);
          console.log('[agent] available_actions received', {gen, count: actions.length, summary});
          try { console.log('[agent] available_actions raw', this.#summarizeActionsVerbose(actions)); } catch {}
          const preview = Array.isArray(actions) ? actions.slice(0, 30) : [];
          this.#broadcast('available_actions', {gen, count: actions.length, preview});
        } catch {}
        this.#stepDecision(actions, gen).catch(console.error);
        break;
      }
      case 'action_result':
        this.#inflight = null;
        break;
      case 'error':
        console.error('[agent] error', (msg as any).message);
        break;
      case 'action_error': {
        const id = (msg as any).id;
        const reason = (msg as any).reason;
        try {
          this.#broadcast('decision_log', {actionId: id ?? null, error: reason || 'action error'});
        } catch {}
        break;
      }
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
        (this as any)._endedThisTurn = false;
      }
    } catch {}
  }

  #watchdog() {
    const cfgTimeout = Number(this.#cfg.maxTurnMs);
    const DECISION_TIMEOUT_MS = Number.isFinite(cfgTimeout) && cfgTimeout > 0 ? Math.max(2000, Math.min(60000, cfgTimeout)) : 6000;
    if (this.#inflight && Date.now() - this.#inflight.ts > DECISION_TIMEOUT_MS) {
      console.warn('[agent] decision timeout, trying fallback end_turn');
      this.#inflight = null;
      const endAct = this.#lastActions?.find(a => a && a.end_turn);
      if (endAct) this.#sendAction(endAct.id);
    }
  }

  #sendAction(actionId: number) {
    if (this.#inflight) { try { console.log('[agent] sendAction skipped: inflight'); } catch {} return; }
    const reqId = randomUUID();
    this.#send({type: 'select_action', id: actionId, req_id: reqId});
    this.#inflight = {reqId, ts: Date.now()};
    this.#turn.steps = (this.#turn.steps || 0) + 1;
    this.#broadcast('decision_log', {actionId, info: 'step++', steps: this.#turn.steps});
    try {
      const a = (this.#lastActions||[]).find((x:any)=>x&&x.id===actionId);
      if (a && a.end_turn) (this as any)._endedThisTurn = true;
    } catch {}
  }

  async #stepDecision(actions: any[], gen?: number) {
    if (!Array.isArray(actions) || actions.length === 0) return;
    if ((this as any)._gameOver) { try { console.log('[agent] stepDecision skipped: game_over'); } catch {} return; }
    if (this.#paused) { try { console.log('[agent] stepDecision skipped: paused'); } catch {} return; }
    if (this.#inflight) { try { console.log('[agent] stepDecision skipped: inflight'); } catch {} return; }
    if (this.#deciding) { try { console.log('[agent] stepDecision skipped: deciding'); } catch {} return; }
    // Short-circuit: only end_turn
    if (actions.length === 1 && actions[0] && actions[0].end_turn) {
      if ((this as any)._endedThisTurn) { try { console.log('[agent] skip end_turn: already ended this turn'); } catch {} return; }
      return this.#sendAction(actions[0].id);
    }
    this.#deciding = true;
    try { console.log('[agent] stepDecision start', {gen, actions: actions.length}); } catch {}

    try {
      const chosen = await this.#decide(actions);
      // Drop stale decision if a newer gen arrived meanwhile
      if (gen != null && gen !== this.#actionsGen) { try { console.log('[agent] decision dropped: stale', {gen, latest: this.#actionsGen}); } catch {} return; }
      if (chosen == null) return this.#autoPlay(actions);
      const exists = actions.some(a => a && a.id === chosen);
      if (!exists) return this.#autoPlay(actions);
      this.#broadcast('decision_explain', {mode: this.#cfg.decisionMode, turn: this.#lastSnapshot?.turn, steps: this.#turn.steps, gen});
      this.#sendAction(chosen);
    } catch (e) {
      console.error('[agent] decide error', e);
      this.#autoPlay(actions);
    } finally {
      this.#deciding = false;
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
    if (this.#cfg.decisionMode === 'policy_only') { this.#autoPlay(actions); return null; }
    return await this.#decideIntent(actions, this.#lastSnapshot);
  }

  async #decideIntent(actions: any[], snapshot: any): Promise<number | null> {
    try {
      const observation = this.#buildObservation(snapshot);
      const userContent = this.#buildIntentUserMessage(observation);
      const payload = {
        model: this.#cfg.model,
        messages: [
          {role: 'system', content: this.#cfg.systemPrompt || '严格输出 JSON 意图'},
          {role: 'user', content: userContent},
        ],
        temperature: this.#clampTemp(this.#cfg.temperature ?? 0.15),
        max_tokens: Math.max(192, this.#cfg.maxTokens || 256),
      };
      const res = await this.#callDispatcher(payload);
      const text = this.#extractText(res.data);
      const intent = this.#parseIntentObject(text);
      let compiled = this.#compileIntentToActionId(intent, actions, snapshot);
      console.log(`[agent] intent received:`, text);
      console.log(`[agent] intent parsed:`, intent);
      console.log(`[agent] compiled result:`, compiled);
      if (compiled && compiled.id != null) {
        const why = typeof intent?.rationale === 'string' ? String(intent.rationale).slice(0, 120) : undefined;
        const actionDetail = actions.find(a => a.id === compiled.id);
        console.log(`[agent] executing action ${compiled.id}: ${this.#serializeAction(actionDetail)} (${why || 'no rationale'})`);
        this.#broadcast('decision_log', {actionId: compiled.id, intent, compiled, rationale: why, action: actionDetail});
        if (why) this.#broadcast('decision_explain', {mode: 'intent', why});
        return compiled.id;
      }
      // one-shot self-correction
      const errMsg = compiled?.error || 'illegal or non-executable intent';
      const retryMessages = [
        {role: 'system', content: this.#cfg.systemPrompt || '严格输出 JSON 意图'},
        {role: 'user', content: userContent},
        {role: 'assistant', content: typeof text === 'string' ? text : ''},
        {role: 'user', content: `上一次的意图无法执行：${errMsg}。请基于相同观测重新给出可执行的意图，注意：不得臆造单位/手牌/坐标；若不确定则 end_turn。只输出严格 JSON。`},
      ];
      const res2 = await this.#callDispatcher({ model: this.#cfg.model, messages: retryMessages, temperature: this.#clampTemp(this.#cfg.temperature ?? 0.15), max_tokens: Math.max(192, this.#cfg.maxTokens || 256) });
      const text2 = this.#extractText(res2.data);
      const intent2 = this.#parseIntentObject(text2);
      compiled = this.#compileIntentToActionId(intent2, actions, snapshot);
      console.log(`[agent] retry intent received:`, text2);
      console.log(`[agent] retry compiled result:`, compiled);
      if (compiled && compiled.id != null) {
        const why = typeof intent2?.rationale === 'string' ? String(intent2.rationale).slice(0, 120) : undefined;
        const actionDetail = actions.find(a => a.id === compiled.id);
        console.log(`[agent] executing action ${compiled.id} (retry): ${this.#serializeAction(actionDetail)} (${why || 'no rationale'})`);
        this.#broadcast('decision_log', {actionId: compiled.id, intent: intent2, compiled, rationale: why, action: actionDetail, retry: true});
        if (why) this.#broadcast('decision_explain', {mode: 'intent', why, retry: true});
        return compiled.id;
      }
      console.log(`[agent] both attempts failed, returning null`);
      this.#broadcast('decision_log', {actionId: null, error: 'failed after retry', originalError: errMsg, intent: intent2});
      return null;
    } catch (e) {
      console.error('[agent] decideIntent error', e);
      return null;
    }
  }

  #buildObservation(snapshot: any) {
    try {
      const W = Number(snapshot?.board?.width ?? snapshot?.board?.W ?? snapshot?.W ?? 9);
      const orient = (this.#cfg.orientationOverride && this.#cfg.orientationOverride !== 'auto') ? (this.#cfg.orientationOverride as ('as_is'|'flipped')) : this.#orientation;
      const youRaw = orient === 'as_is' ? (snapshot?.self || {}) : (snapshot?.enemy || {});
      const enemyRaw = orient === 'as_is' ? (snapshot?.enemy || {}) : (snapshot?.self || {});
      const toRC = (idx: any) => {
        try { const n = Number(idx); if (!Number.isFinite(n)) return undefined; return {row: Math.floor(n / W), col: n % W}; } catch { return undefined; }
      };
      const fmtRC = (rc: any) => rc && Number.isFinite(rc.row) && Number.isFinite(rc.col) ? `r${rc.row}c${rc.col}` : undefined;

      // Derive placeable cells per card from latest available_actions
      const placesByCard: Record<number, Array<{cell_index:number; row:number; col:number; pos:string}>> = {};
      try {
        const acts = Array.isArray(this.#lastActions) ? this.#lastActions : [];
        for (const a of acts) {
          if (a?.play_card && Number.isFinite(Number(a.play_card.card_id)) && Number.isFinite(Number(a.play_card.cell_index))) {
            const cid = Number(a.play_card.card_id);
            const ci = Number(a.play_card.cell_index);
            const rc = toRC(ci);
            if (rc) {
              (placesByCard[cid] ||= []).push({cell_index: ci, row: rc.row, col: rc.col, pos: fmtRC(rc)!});
            }
          }
        }
      } catch {}

      const normUnit = (u: any, owner: 'self'|'enemy') => u ? ({
        unit_id: (u.unit_id ?? u.id),
        card_id: (u.card_id ?? null),
        name: u.name,
        hp: u.hp,
        atk: u.atk,
        cell_index: u.cell_index,
        row: toRC(u.cell_index)?.row,
        col: toRC(u.cell_index)?.col,
        pos: fmtRC(toRC(u.cell_index)),
        can_attack: u.can_attack,
        skills: Array.isArray(u.skills) ? u.skills : undefined,
      }) : u;
      const hand = Array.isArray(youRaw.hand) ? youRaw.hand.map((c: any) => ({
        card_id: (c.card_id ?? c.id),
        zone: 'hand',
        kind: 'card',
        name: c.name,
        mana_cost: c.mana_cost ?? c.cost,
        type: c.type,
        placeable: (() => {
          const cid = Number(c?.card_id ?? c?.id);
          const arr = Number.isFinite(cid) ? (placesByCard[cid] || []) : [];
          return arr;
        })(),
      })) : [];
      const srcSelfUnits = orient === 'as_is' ? (snapshot?.self_units || []) : (snapshot?.enemy_units || []);
      const srcEnemyUnits = orient === 'as_is' ? (snapshot?.enemy_units || []) : (snapshot?.self_units || []);
      const selfUnits = Array.isArray(srcSelfUnits) ? srcSelfUnits.map((u: any) => normUnit(u, 'self')) : [];
      const enemyUnits = Array.isArray(srcEnemyUnits) ? srcEnemyUnits.map((u: any) => normUnit(u, 'enemy')) : [];
      return {
        turn: snapshot?.turn,
        board: { width: W },
        you: { mana: (youRaw.mana ?? youRaw.energy), hero_hp: (youRaw.health ?? youRaw.hp), hand },
        opponent: { hero_hp: (enemyRaw.health ?? enemyRaw.hp) },
        self_units: selfUnits,
        enemy_units: enemyUnits,
      };
    } catch { return { turn: snapshot?.turn }; }
  }

  #buildIntentUserMessage(observation: any) {
    try {
      const obs = JSON.stringify(observation, null, 0);
      const hint = '规则提示: play_card.card_id 必须来自 you.hand；当出牌时，to 只能从对应手牌的 placeable 列表中选择 (支持 {row,col} / "rXcY" / cell_index)。unit_attack.attacker_unit_id 必须来自 self_units.unit_id；target_unit_id 必须来自 enemy_units.unit_id。不要将场上单位的 card_id 误当作手牌。';
      return `战局观测（JSON）：\n${obs}\n\n${hint}\n\n请输出严格 JSON 意图（不含多余文本）。`;
    } catch {
      return '请输出严格 JSON 意图';
    }
  }

  #parseIntentObject(text: string | null): any {
    if (!text) return null;
    if (typeof text !== 'string') return null as any;
    const t = text.trim();
    const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
    let obj = tryParse(t);
    if (!obj) {
      const i = t.indexOf('{'); const j = t.lastIndexOf('}');
      if (i >= 0 && j >= i) obj = tryParse(t.slice(i, j + 1));
    }
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  }

  #compileIntentToActionId(intent: any, actions: any[], snapshot: any): {id: number|null; error?: string} {
    try {
      if (!intent || typeof intent !== 'object') return {id: null, error: 'no intent'};
      const action = (intent as any).action;
      if (!action || typeof action !== 'object') return {id: null, error: 'no action field'};
      const type = String((action as any).type || '').toLowerCase();
      const by = (pred: (a:any)=>boolean) => actions.find(pred)?.id ?? null;
      const W = Number(snapshot?.board?.width ?? snapshot?.board?.W ?? snapshot?.W ?? 9);
      const toCellFromRC = (rc: any) => {
        try { const r = Number(rc?.row), c = Number(rc?.col); if (!Number.isFinite(r) || !Number.isFinite(c)) return null; return (r * W) + c; } catch { return null; }
      };
      const parseRxc = (s: any) => {
        try { const t = String(s||''); const m = /^r(\d+)c(\d+)$/i.exec(t); if (!m) return null; return {row: Number(m[1]), col: Number(m[2])}; } catch { return null; }
      };
      const resolveTargetCell = (obj: any, keys: {cell?: string; to?: string; target?: string}) => {
        // Accept forms: {cell_index}, {to_cell_index}, {to:{row,col}|"rXcY"|{cell_index}}, {target:{row,col}|"rXcY"|{cell_index}}
        if (!obj || typeof obj !== 'object') return null;
        const cellK = keys.cell || 'cell_index';
        const toCellK = keys.to || 'to_cell_index';
        const targetK = keys.target || 'target';
        if (obj[cellK] != null) { const n = Number(obj[cellK]); return Number.isFinite(n) ? n : null; }
        if (obj[toCellK] != null) { const n = Number(obj[toCellK]); return Number.isFinite(n) ? n : null; }
        const fromTo = obj.to != null ? obj.to : null;
        const fromTarget = obj[targetK] != null ? obj[targetK] : null;
        const candidate = fromTo != null ? fromTo : fromTarget;
        if (candidate == null) return null;
        if (typeof candidate === 'string') { const rc = parseRxc(candidate); return rc ? toCellFromRC(rc) : null; }
        if (typeof candidate === 'object') {
          if ((candidate as any).cell_index != null) { const n = Number((candidate as any).cell_index); return Number.isFinite(n) ? n : null; }
          const rc = parseRxc((candidate as any).pos) || {row: (candidate as any).row, col: (candidate as any).col};
          return toCellFromRC(rc);
        }
        return null;
      };
      switch (type) {
        case 'play_card': {
          const cid = Number((action as any).card_id);
          let cell = Number((action as any).to_cell_index ?? (action as any).cell_index);
          if (!Number.isFinite(cell)) cell = resolveTargetCell(action, {cell: 'cell_index', to: 'to_cell_index', target: 'target'}) ?? NaN;
          if (Number.isFinite(cid) && Number.isFinite(cell)) {
            const m = by(a => a?.play_card && a.play_card.card_id === cid && a.play_card.cell_index === cell);
            if (m != null) return {id: m};
            return {id: null, error: 'play_card not available at target cell'};
          }
          return {id: null, error: 'play_card missing card_id/cell'};
        }
        case 'move': {
          const uid = Number((action as any).unit_id);
          let cell = Number((action as any).to_cell_index);
          if (!Number.isFinite(cell)) cell = resolveTargetCell(action, {to: 'to_cell_index'}) ?? NaN;
          if (Number.isFinite(uid) && Number.isFinite(cell)) {
            const m = by(a => a?.move_unit && a.move_unit.unit_id === uid && a.move_unit.to_cell_index === cell);
            if (m != null) return {id: m};
          }
          return {id: null, error: 'move not available'};
        }
        case 'unit_attack': {
          const att = Number((action as any).attacker_unit_id);
          const tgt = Number((action as any).target_unit_id);
          if (Number.isFinite(att) && Number.isFinite(tgt)) {
            const m = by(a => a?.unit_attack && a.unit_attack.attacker_unit_id === att && a.unit_attack.target_unit_id === tgt);
            if (m != null) return {id: m};
          }
          return {id: null, error: 'unit_attack not available'};
        }
        case 'hero_power': {
          if ((action as any).cell_index != null || (action as any).to_cell_index != null || (action as any).target != null || (action as any).to != null) {
            const cell = resolveTargetCell(action, {cell: 'cell_index', to: 'to_cell_index', target: 'target'});
            const m = by(a => a?.hero_power && a.hero_power.cell_index === cell);
            if (m != null) return {id: m};
          }
          const any = by(a => a?.hero_power);
          if (any != null) return {id: any};
          return {id: null, error: 'hero_power not available'};
        }
        case 'end_turn': {
          const m = by(a => a?.end_turn);
          if (m != null) return {id: m};
          return {id: null, error: 'end_turn not available'};
        }
        default:
          return {id: null, error: `unknown type: ${type}`};
      }
    } catch (e:any) { return {id: null, error: String(e?.message||e)}; }
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

  #summarizeActions(actions: any[]) {
    try {
      const sum = {end:0, play:0, atk:0, move:0, skill:0, power:0, unknown:0};
      for (const a of (actions||[])) {
        if (a?.end_turn) sum.end++;
        else if (a?.play_card) sum.play++;
        else if (a?.unit_attack) sum.atk++;
        else if (a?.move_unit) sum.move++;
        else if (a?.use_skill) sum.skill++;
        else if (a?.hero_power) sum.power++;
        else sum.unknown++;
      }
      return sum;
    } catch { return null; }
  }

  #summarizeActionsVerbose(actions: any[]) {
    try {
      const cardNames = new Set<string>();
      const units = new Set<string>();
      const byType: Record<string, any[]> = {play: [], attack: [], move: [], skill: [], power: [], end: []};
      
      for (const a of (actions||[])) {
        if (a?.end_turn) byType.end.push(a);
        else if (a?.play_card) {
          byType.play.push(a);
          if (a.card_name) cardNames.add(a.card_name);
        }
        else if (a?.unit_attack) {
          byType.attack.push(a);
          if (a.unit_attack?.attacker?.name) units.add(a.unit_attack.attacker.name);
        }
        else if (a?.move_unit) {
          byType.move.push(a);
        }
        else if (a?.use_skill) byType.skill.push(a);
        else if (a?.hero_power) byType.power.push(a);
      }
      
      const summary = [];
      if (byType.play.length) summary.push(`play_card(${Array.from(cardNames).join(',')})x${byType.play.length}`);
      if (byType.attack.length) summary.push(`unit_attackx${byType.attack.length}`);
      if (byType.move.length) summary.push(`move_unitx${byType.move.length}`);
      if (byType.skill.length) summary.push(`use_skillx${byType.skill.length}`);
      if (byType.power.length) summary.push(`hero_powerx${byType.power.length}`);
      if (byType.end.length) summary.push(`end_turnx${byType.end.length}`);
      
      return summary.join(', ') || 'no actions';
    } catch { return 'parse error'; }
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
      (s as any).modePrefer = 'intent';
      return s;
    } catch { return {advantage: 0.5, profilePrefer: 'balanced', modePrefer: null}; }
  }

  #chooseMode(current: 'intent'|'policy_only'|undefined, situation: any) {
    try { return current || 'intent'; } catch { return 'intent'; }
  }

  #extractBriefReason(text: string | null) {
    try {
      if (!text) return undefined;
      const t = String(text);
      const m = t.match(/reason\s*[:：]\s*(.+)$/i);
      if (m && m[1]) return m[1].slice(0, 120);
      // fallback: first sentence
      const sent = t.split(/\n|\.|。/)[0];
      return sent ? sent.slice(0, 120) : undefined;
    } catch { return undefined; }
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
        tools.push({ type: 'function', function: { name: 'choose_action', description: 'Choose exactly one action by id from the allowed enum. Optionally provide a brief why (<=120 chars).', parameters: { type: 'object', properties: { action_id: { type: 'number', enum: actionIds }, why: { type: 'string' } }, required: ['action_id'] } } });
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
        if (id != null) {
          const why = typeof args?.why === 'string' ? String(args.why).slice(0,120) : undefined;
          if (why) { try { this.#broadcast('decision_explain', {why}); } catch {} }
          return id;
        }
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

  #updateOrientation(actions: any[]) {
    const override = this.#cfg.orientationOverride || 'auto';
    if (override === 'as_is') { this.#orientation = 'as_is'; return; }
    if (override === 'flipped') { this.#orientation = 'flipped'; return; }
    try {
      const snap = this.#lastSnapshot;
      if (!snap) return;
      const idsSelf = new Set<number>((Array.isArray(snap.self_units) ? snap.self_units : []).map((u: any) => Number(u?.unit_id ?? u?.id)).filter(Number.isFinite));
      const idsEnemy = new Set<number>((Array.isArray(snap.enemy_units) ? snap.enemy_units : []).map((u: any) => Number(u?.unit_id ?? u?.id)).filter(Number.isFinite));
      let cntSelf = 0, cntEnemy = 0;
      for (const a of actions || []) {
        const uid = a?.unit_attack?.attacker_unit_id ?? a?.move_unit?.unit_id ?? a?.use_skill?.unit_id;
        const n = Number(uid);
        if (!Number.isFinite(n)) continue;
        if (idsSelf.has(n)) cntSelf++;
        if (idsEnemy.has(n)) cntEnemy++;
      }
      const decided: 'as_is'|'flipped' = cntEnemy > cntSelf ? 'flipped' : 'as_is';
      if (this.#orientation !== decided) {
        this.#orientation = decided;
        try { console.log('[agent] orientation detected', {decided, cntSelf, cntEnemy}); } catch {}
      }
    } catch {}
  }
}

export function createAgentModule(...args: ConstructorParameters<typeof AgentModule>) {
  return new AgentModule(...args);
}

