import {normName, aliasName, parseRC, matchCardInHandByAlias, findCardInHandByName, findUnitByAlias} from './agent/name-utils.js'
import {computeForward, scorePlayActionByHint} from './agent/placement.js'
import {buildPolicySummary, policySnapshotDigest, buildPolicyBaseline, policyDriftExceeded} from './agent/policy-state.js'
import {executePolicyPlanBatch, executePolicyPlanSingle, choosePlayFromPolicy, chooseMoveFromPolicy, chooseAttackFromPolicy, deriveTargetPreferenceFromPolicy, pickAttackFromList, moveEnablesAttack, selectSafeAction, toStep, type SelectSafeActionFn} from './agent/executor.js'
import {buildPolicyPrompt, buildIntentPrompt, callDispatcher, extractText, parseActionId, parseStrategyJson, parseIntentObject} from './agent/llm.js'
import {buildKnowledgeSnippet, parseKeyedLines, collectRelatedCardNotes} from './agent/knowledge.js'
import type {AppModule} from '../AppModule.js';
import type {ModuleContext} from '../ModuleContext.js';
import type {AgentConfig, PolicyStep, PolicyBaseline, PolicyRuntimeState, DecisionResult} from './agent/types.js';
import {BrowserWindow, ipcMain} from 'electron';
import {createConnection, type Socket} from 'node:net';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {createDb} from './DB.js'

type AgentSocketMessage =
  | {type: 'subscribe_ack'}
  | {type: 'game_ready'}
  | {type: 'game_over'}
  | {type: 'state'; snapshot: any}
  | {type: 'available_actions'; actions: any[]}
  | {type: 'action_result'; id: number}
  | {type: 'error'; message?: string}
  | Record<string, unknown>;

// moved to ./agent/types

type StrategyState = {
  version: number;
  turn_started: number;
  horizon_turns: number;
  posture: 'aggressive'|'balanced'|'defensive';
  primary_goal: string;
  secondary_goals?: string[];
  target_regions?: string[];
  commitments?: any[];
  constraints?: any;
  success_metrics?: any;
  last_revision_reason?: string;
};

// moved to ./agent/types

// moved to ./agent/types

// moved to ./agent/types

// moved to ./agent/types

const DEFAULT_CFG: AgentConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  bridgeToken: 'dev',
  temperature: 0.2,
  maxTokens: 512,
  maxSteps: 6,
  maxTurnMs: 12000,
  policyTimeoutMs: 30000,
  endpoint: 'chat/completions',
  decisionMode: 'intent_driven', // NEW: Default to intent-driven mode
  requireLLMTargetForAttack: true,
  alwaysCallLLMOnOwnTurn: true,
  strategyProfile: 'balanced',
  adaptiveTemp: true,
  minTemp: 0.1,
  maxTemp: 0.7,
  nBest: 1,
  nBestParallel: false,
  maxActions: 24,
  knowledge: {weight: 0.6},
  systemPrompt: '', // Will be dynamically set based on mode
  orientationOverride: 'auto',
};

export class AgentModule implements AppModule {
  readonly #host: string;
  readonly #port: number;
  #socket: Socket | null = null;
  #buffer = '';
  #inflight: {reqId: string; ts: number} | null = null;
  #batchInflight: {reqId: string; ts: number} | null = null;
  #retriedThisTurn: boolean = false;
  #deciding = false;
  #actionsGen = 0;
  #cfg: AgentConfig = {...DEFAULT_CFG};
  #configPath = '';
  #lastActions: any[] | null = null;
  #lastSnapshot: any | null = null;
  #lastTacticalPreview: any | null = null;
  #turn = {startedAt: 0, steps: 0};
  #paused = false;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #orientation: 'as_is'|'flipped' = 'as_is';
  #strategy: StrategyState | null = null;
  #strategyPath: string = '';
  #pendingEval: {pre: {pressure:number; threat:number; myHP:number; enemyHP:number}; predicted?: {pressure?:number; threat?:number}; actionId: number; ts: number} | null = null;
  #db = createDb();
  // Local turn-plan accumulator (hierarchical mode)
  #turnPlanSteps: any[] = [];
  #planTimer: NodeJS.Timeout | null = null;
  #lastPolicyPlan: any | null = null;
  #policyState: PolicyRuntimeState = {
    plan: null,
    steps: [],
    cursor: 0,
    revision: 0,
    lastTurn: undefined,
    lastOutcome: undefined,
    baseline: null,
  };
  #pendingPolicyActions: Map<number, PolicyStep> = new Map();
  #chainQueue: Array<{attacker: number; preferredTarget?: number|null; moveId?: number|null; attackId?: number|null; gen?: number; queuedAt?: number; tries?: number}> = [];
  #moveSentThisTurn: Set<string> = new Set();

  constructor({host = '127.0.0.1', port = 17771}: {host?: string; port?: number} = {}) {
    this.#host = host;
    this.#port = port;
  }

  async enable({app}: ModuleContext): Promise<void> {
    await app.whenReady();
    this.#configPath = join(app.getPath('userData'), 'companion-config.json');
    this.#strategyPath = join(app.getPath('userData'), 'companion-strategy.json');
    this.#loadConfigFromDisk();
    this.#loadStrategyFromDisk();

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

    ipcMain.handle('db_list_sessions', async (_e, {limit=100, offset=0}={}) => {
      try { return {ok:true, data: this.#db.listSessions(limit, offset)} } catch (e:any) { return {ok:false, error:String(e?.message||e)} }
    })
    ipcMain.handle('db_get_replay', async (_e, {sessionId}) => {
      try { return {ok:true, data: this.#db.getReplay(String(sessionId))} } catch (e:any) { return {ok:false, error:String(e?.message||e)} }
    })

    ipcMain.handle('test_llm', async (_e, params?: any) => {
      const override = params && typeof params === 'object' ? (params.override || params) : {}
      const merged = {...this.#cfg, ...(override||{})} as AgentConfig
      const started = Date.now()
      try {
        if (!(merged as any).apiKey) throw new Error('missing_api_key')
        const userContent = typeof params?.content === 'string' ? params.content
          : (typeof params?.prompt === 'string' ? params.prompt : 'Reply with OK')
        const payload = {
          model: merged.model,
          messages: [
            {role: 'system', content: 'You are a simple probe. Reply concisely.'},
            {role: 'user', content: userContent}
          ],
          temperature: 0,
          max_tokens: 8,
        }
        const res = await callDispatcher(merged, payload)
        const elapsedMs = Date.now() - started
        const usage = (res as any)?.data?.usage || (res as any)?.data?.data?.usage
        const text = extractText(res.data)
        return {
          ok: true,
          provider: merged.provider,
          model: merged.model,
          elapsedMs,
          usage,
          snippet: typeof text === 'string' ? text.slice(0, 120) : String(text)
        }
      } catch (err:any) {
        const elapsedMs = Date.now() - started
        // Surface provider/http errors better
        const resp = err?.response
        const code = resp?.status
        const headers = resp?.headers
        const raw = resp?.data
        const msg = String(
          raw?.error?.message || raw?.message || err?.message || err
        )
        return { ok: false, elapsedMs, error: msg, status: code, headers, detail: raw }
      }
    })
  }

  #broadcast(channel: string, payload: unknown) {
    try {
      const FILTER = new Set<string>(['llm_io','plan_result','decision_log','available_actions','action_batch_summary','strategy_outcome','decision_explain'])
      const snapshot = this.#lastSnapshot
      const ov = (this as any)._isMyTurnOverride
      const isMy = (ov === true) ? true : this.#isMyTurnStrict(snapshot)
      if (FILTER.has(channel) && !isMy) {
        return
      }
    } catch {}
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

  #loadStrategyFromDisk() {
    try {
      if (existsSync(this.#strategyPath)) {
        const raw = readFileSync(this.#strategyPath, 'utf8');
        this.#strategy = JSON.parse(raw);
        this.#broadcast('strategy_updated', this.#strategy);
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

  #saveStrategyToDisk() {
    try {
      if (this.#strategy) writeFileSync(this.#strategyPath, JSON.stringify(this.#strategy, null, 2), 'utf8');
    } catch {}
  }

  #updateConfig(partial: Partial<AgentConfig>) {
    this.#cfg = {...this.#cfg, ...partial, knowledge: {...(this.#cfg.knowledge||{}), ...(partial.knowledge||{})}};
    this.#paused = !!(((partial as any)||{}).paused ?? ((this.#cfg as any)||{}).paused);
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
          // Track session and state event
          const sessId = String((this as any)._sessionId || 'default')
          if (!(this as any)._sessionId) (this as any)._sessionId = sessId
          this.#db.ensureSession(sessId, {createdBy: 'agent'})
          this.#db.addEvent(sessId, 'state', this.#lastSnapshot)
        } catch {}
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
        try {
          const sessId = String((this as any)._sessionId || 'default')
          this.#db.addEvent(sessId, 'available_actions', {actions, snapshot: (msg as any).snapshot})
        } catch {}
        
        // 🔧 关键修复：available_actions 消息可能包含 snapshot，优先使用
        const msgSnapshot = (msg as any).snapshot
        if (msgSnapshot && typeof msgSnapshot === 'object') {
          console.log('[agent] 🔧 Updating snapshot from available_actions message')
          this.#lastSnapshot = msgSnapshot
          this.#updateTurnState()
        }
        
        // detect orientation if needed
        try { this.#updateOrientation(actions); } catch {}
        const gen = ++this.#actionsGen;
        
        // 🔧 新增：检查turn是否刚变化（可能snapshot还没更新）
        const lastKnownTurn = (this as any)._lastTurnId
        const currentTurn = String(this.#lastSnapshot?.turn ?? '')
        const turnJustChanged = lastKnownTurn && currentTurn && lastKnownTurn !== currentTurn
        
        // 检查回合状态（基于 ids 强判定），避免对手回合触发决策
        const myTurn = this.#isMyTurnStrict()
        // 如果 actions 内的 actor_player_id 全部不是自己，也视为不是我的回合
        try {
          const apid = Number(this.#lastSnapshot?.ai_player_id)
          const hasMyActions = Array.isArray(actions) && actions.some(a => Number(a?.actor_player_id) === apid)
          if (Number.isFinite(apid)) {
            if (hasMyActions && !myTurn) {
              console.log('[agent] 🔍 isMyTurn override: actions for my actor exist while snapshot says false; treating as my turn')
              ;(this as any)._isMyTurnOverride = true
            } else {
              // 不要强行判定为非己方回合，保持严格判定结果
              ;(this as any)._isMyTurnOverride = undefined
            }
          } else {
            // 没有有效的 ai_player_id，如果有可用动作则倾向认为是己方回合
            if (Array.isArray(actions) && actions.length > 0) {
              console.log('[agent] 🔍 isMyTurn override: no ai_player_id but actions exist; treating as my turn')
              ;(this as any)._isMyTurnOverride = true
            } else {
              ;(this as any)._isMyTurnOverride = undefined
            }
          }
        } catch {}
        try {
          const summary = this.#summarizeActions(actions);
          const turnInfo = {gen, count: actions.length, summary, is_my_turn: myTurn, turn: this.#lastSnapshot?.turn, turnJustChanged}
          console.log('[agent] available_actions received', turnInfo);
          if (!myTurn) {
            console.log('[agent] ⚠️  Not my turn (is_my_turn=false) - skipping decision')
          }
          if (turnJustChanged && myTurn) {
            console.log('[agent] ⚠️  Turn just changed, snapshot might be stale - extra caution needed')
          }
          try { console.log('[agent] available_actions sample', Array.isArray(actions)? actions.slice(0,5): actions); } catch {}
          try {
            const maxLog = Math.min(20, Array.isArray(actions)? actions.length : 0);
            for (let i=0;i<maxLog;i++) {
              const a = actions[i]; if (!a) continue;
              console.log(`[agent] #${a.id}: ${this.#serializeAction(a)}`);
            }
          } catch {}
          const preview = Array.isArray(actions) ? actions.slice(0, 30) : [];
          const ui = this.#summarizeActionsForUI(actions);
          this.#broadcast('available_actions', {gen, count: actions.length, preview, summary: ui});
        } catch {}
        // Precompute finalMyTurn for subsequent logic blocks
        const finalMyTurn = ((this as any)._isMyTurnOverride === true) ? true : (((this as any)._isMyTurnOverride === false) ? false : myTurn);

      // If we have queued chain attacks after moves, try to execute them immediately when actions arrive
      try {
        const canSend = finalMyTurn && !this.#inflight && !this.#batchInflight
        if (canSend && Array.isArray(this.#chainQueue) && this.#chainQueue.length > 0) {
          const remain: Array<{attacker: number; preferredTarget?: number|null; moveId?: number|null; attackId?: number|null; gen?: number; queuedAt?: number; tries?: number}> = []
          for (const chain of this.#chainQueue) {
            // 过期/退避：超过 800ms 或 gen 落后太多则放弃
            try {
              const tooOld = (chain.queuedAt && (Date.now() - (chain.queuedAt as number) > 800))
              const genLag = (chain.gen != null && Math.abs(this.#actionsGen - (chain.gen as number)) > 3)
              if (tooOld || genLag) continue
            } catch {}
            const targetPreferred = Number.isFinite(Number(chain.preferredTarget)) ? Number(chain.preferredTarget) : null
            let atk: any = null
            if (targetPreferred != null) {
              atk = (actions||[]).find((a:any)=> a?.unit_attack && Number(a.unit_attack.attacker_unit_id)===Number(chain.attacker) && Number(a.unit_attack.target_unit_id)===targetPreferred)
            }
            if (!atk) {
              atk = (actions||[]).find((a:any)=> a?.unit_attack && Number(a.unit_attack.attacker_unit_id)===Number(chain.attacker))
            }
            if (atk) {
              console.log('[agent] 🎯 Chained attack after move:', {attacker: chain.attacker, target: atk.unit_attack?.target_unit_id})
              if (Number.isFinite(Number(atk.id))) {
                // Prefer immediate select of the exact legal action id (bridge adaptive mode will accept it)
                try { console.log('[agent] ⚔️  immediate attack select (chain)', {id: Number(atk.id)}) } catch {}
                this.#sendImmediateActionId(Number(atk.id))
              }
            } else {
              // 尝试一次基于 attackId 的直接执行（某些桥不回传完整 attack 对象，仅有 id）
              try {
                if (chain.attackId && Number.isFinite(Number(chain.attackId)) && Number.isFinite(Number(chain.attacker)) && Number.isFinite(Number(chain.preferredTarget))) {
                  // Build a unit_attack step and flush
                  const step = {type:'unit_attack', attacker_unit_id: Number(chain.attacker), target_unit_id: Number(chain.preferredTarget)}
                  try { console.log('[agent] 🗂 chain fallback -> plan unit_attack', step) } catch {}
                  this.#turnPlanSteps.push(step as any)
                  this.#flushPlan('chain_fallback')
                } else {
                  remain.push({...chain, tries: (chain.tries||0)+1})
                }
              } catch { remain.push({...chain, tries: (chain.tries||0)+1}) }
            }
          }
          this.#chainQueue = remain
        }
      } catch {}

        // 只在己方回合时才触发决策
        // 先尝试立即攻击或移动→攻击（无需LLM）
        let skipSchedule = false;
        try {
          const canActNow = finalMyTurn && !this.#inflight && !this.#batchInflight && !this.#deciding
          if (canActNow) {
            if (this.#maybeImmediateAttack(actions)) {
              skipSchedule = true
            } else if (this.#maybeAutoMoveThenAttack(actions, this.#lastSnapshot)) {
              skipSchedule = true
            }
          }
        } catch {}
        // 🔧 额外保险：延迟执行，确保 state 消息有机会先处理
        if (finalMyTurn && !skipSchedule) {
          // 如果turn刚变化，用更长的延迟确保snapshot更新
          const delay = turnJustChanged ? 100 : 0
          setTimeout(() => {
            // 再次检查回合状态（使用最新的 snapshot），优先尊重 override=true
            const ov = (this as any)._isMyTurnOverride
            const allow = (ov === true) ? true : (ov === false ? false : this.#isMyTurnStrict())
            if (allow) {
              this.#stepDecision(actions, gen).catch(console.error);
            } else {
              console.log('[agent] ⚠️  stepDecision cancelled: turn changed (is_my_turn became false)')
            }
          }, delay)
        } else {
          console.log('[agent] ⚠️  Skipping stepDecision: not my turn')
        }
        break;
      }
      case 'tactical_preview': {
        try {
          const tp = (msg as any);
          this.#lastTacticalPreview = (tp && (tp.preview || tp.combos)) ? (tp.preview || tp.combos) : tp;
          this.#broadcast('tactical_preview', this.#lastTacticalPreview);
        } catch {}
        break;
      }
      case 'action_result':
        this.#inflight = null;
        // When batch is applied, action_result events will stream per action; clear batch when we see end_turn result shortly after
        try {
          const a = (this.#lastActions||[]).find((x:any)=>x&&x.id===(msg as any).id);
          if (a && a.end_turn) {
            this.#batchInflight = null;
            // 🔧 关键修复：end_turn后清除policy plan缓存，避免被下一回合（可能是对手回合）重用
            console.log('[agent] 🔧 end_turn executed, clearing policy plan cache to prevent reuse in opponent turn')
            this.#policyState.plan = null;
            this.#policyState.steps = [];
          }
        } catch {}
        try { this.#broadcast('action_result', {id: (msg as any).id}); } catch {}
        try { if (this.#pendingEval && this.#lastSnapshot) {
          const post = {pressure: this.#estimatePressure(this.#lastSnapshot), threat: this.#estimateThreat(this.#lastSnapshot), myHP: Number(this.#lastSnapshot?.you?.hero_hp), enemyHP: Number(this.#lastSnapshot?.opponent?.hero_hp)};
          const pre = this.#pendingEval.pre; const delta = {pressure: post.pressure-pre.pressure, threat: post.threat-pre.threat, myHP: post.myHP-pre.myHP, enemyHP: post.enemyHP-pre.enemyHP};
          this.#broadcast('strategy_outcome', {actionId: (msg as any).id, pre, post, delta});
          this.#pendingEval = null;
        } } catch {}
        break;
      case 'error':
        console.error('[agent] error', (msg as any).message);
        break;
      case 'action_error': {
        const id = (msg as any).id;
        const reason = (msg as any).reason;
        try {
          this.#broadcast('decision_log', {actionId: id ?? null, error: reason || 'action error'});
          // Clear inflight on any action error so we don't get stuck
          this.#inflight = null;
          if (String(reason).includes('batch')) {
            this.#batchInflight = null;
            // If batch was required and we have accumulated steps, flush them
            try { if (this.#turnPlanSteps && this.#turnPlanSteps.length) this.#flushPlan('batch_required_retry'); } catch {}
          }
        } catch {}
        break;
      }
      case 'plan_result': {
        try {
          this.#batchInflight = null;
          const pr = msg as any;
          this.#broadcast('plan_result', pr);
          try {
            const steps = Array.isArray(pr?.steps) ? pr.steps : [];
            for (let i=0;i<steps.length;i++) {
              const s = steps[i] || {}; const id = s.id; const ok = s.ok; const reason = s.reason; const desc = s.desc;
              console.log(`[agent] plan step #${i+1}: id=${id} ok=${ok} desc=${desc || this.#findActionDescById(id)}${reason?` reason=${reason}`:''}`);
              try { this.#broadcast('decision_log', {actionId: id ?? null, ok, reason: reason||null, desc: desc || this.#findActionDescById(id)}); } catch {}
            }
          } catch {}
          const steps = Array.isArray(pr?.steps) ? pr.steps : [];
          const total = steps.length;
          const okCnt = steps.filter((s:any)=> !!s?.ok).length;
          const allFailed = total > 0 && okCnt === 0;
          const aborted = String(pr?.note||'').includes('aborted');
          const myTurn = !!(this.#lastSnapshot && (this.#lastSnapshot as any).is_my_turn === true);
          if (myTurn && !this.#retriedThisTurn && (aborted || allFailed)) {
            this.#retriedThisTurn = true;
            setTimeout(()=>{ try { this.#stepDecision(this.#lastActions||[], this.#actionsGen).catch(()=>{}); } catch {} }, 120);
          }
        } catch {}
        break;
      }
      case 'action_batch_summary': {
        try { this.#batchInflight = null; } catch {}
        try {
          this.#broadcast('action_batch_summary', msg);
          // Also surface human reasons for failures if available
          if (Array.isArray((msg as any)?.failed) && (this as any)._lastFailedReasons) {
            const reasons = (this as any)._lastFailedReasons as Record<number,string>
            for (const id of (msg as any).failed) {
              if (reasons && reasons[id]) {
                try { this.#broadcast('decision_log', {actionId: id, error: reasons[id]}); } catch {}
              }
            }
          }
        } catch {}
        break;
      }
      case 'action_batch_result': {
        try { this.#broadcast('action_batch_result', msg); } catch {}
        break;
      }
      case 'plan_error': {
        try { this.#batchInflight = null; this.#broadcast('plan_result', {atomic:false, steps:[], note:'plan_error'}); } catch {}
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
        this.#retriedThisTurn = false;
        // Reset local plan accumulator on new turn
        this.#turnPlanSteps = [];
        if (this.#planTimer) { clearTimeout(this.#planTimer); this.#planTimer = null; }
        this.#resetPolicyForNewTurn(t);
        try { this.#moveSentThisTurn.clear(); } catch {}
        try { this.#chainQueue = []; } catch {}
        // Clear any previous isMyTurn override on turn change; will be re-evaluated on next available_actions
        try { (this as any)._isMyTurnOverride = undefined } catch {}
      }
    } catch {}
  }

  #snapshotTurnId(snapshot: any) {
    try {
      if (!snapshot) return null;
      if (snapshot.turn != null) return String(snapshot.turn);
      if (snapshot?.state?.turn != null) return String(snapshot.state.turn);
      return null;
    } catch { return null; }
  }

  #policySnapshotDigest(snapshot: any): string | null { return policySnapshotDigest(snapshot) }

  #resetPolicyForNewTurn(turn: number) {
    try {
      this.#policyState.lastTurn = String(turn);
      if (this.#lastSnapshot) {
        (this.#policyState as any).digest = this.#policySnapshotDigest(this.#lastSnapshot);
        if (!this.#policyState.baseline) {
          this.#policyState.baseline = this.#buildPolicyBaseline(this.#lastSnapshot);
        }
      }
      const steps = Array.isArray(this.#policyState.steps) ? this.#policyState.steps : [];
      for (const step of steps) {
        if (!step || !step.meta) continue;
        if (step.meta.status === 'queued') {
          step.meta.status = 'pending';
          step.meta.pendingActionId = undefined;
          step.meta.updatedAt = Date.now();
          step.meta.reason = 'turn_reset';
        }
      }
      this.#pendingPolicyActions.clear();
      this.#recomputePolicyCursor();
    } catch {}
  }

  #buildPolicySummary(snapshot: any) { return buildPolicySummary(snapshot) }

  #buildPolicyBaseline(snapshot: any): PolicyBaseline | null { return buildPolicyBaseline(snapshot) }

  #policyDriftExceeded(baseline: PolicyBaseline | null, snapshot: any) { return policyDriftExceeded(baseline, snapshot) }

  #clearPolicyState(reason?: string) {
    try {
      if (reason) { try { this.#broadcast('decision_log', {policy_reset: reason}); } catch {} }
    } catch {}
    this.#policyState = {
      plan: null,
      steps: [],
      cursor: 0,
      revision: (this.#policyState?.revision ?? 0) + 1,
      lastTurn: undefined,
      lastOutcome: undefined,
      baseline: null,
    };
    this.#pendingPolicyActions.clear();
  }

  #recomputePolicyCursor() {
    try {
      const steps = Array.isArray(this.#policyState.steps) ? this.#policyState.steps : [];
      let cursor = steps.findIndex((s: PolicyStep) => s?.meta?.status === 'pending');
      if (cursor < 0) cursor = steps.length;
      this.#policyState.cursor = cursor;
    } catch {}
  }

  #loadPolicySteps(plan: any) {
    try {
      const steps = Array.isArray(plan?.steps) ? plan.steps : [];
      const mapped: PolicyStep[] = steps.map((raw: any, index: number): PolicyStep => ({
        type: ((): PolicyStep['type'] => {
          const t = String(raw?.type || '').toLowerCase();
          if (t==='play' || t==='move' || t==='attack' || t==='move_then_attack' || t==='hero_power' || t==='end_turn') return t;
          return 'end_turn';
        })(),
        card: raw?.card,
        unit: raw?.unit,
        attacker: raw?.attacker,
        target: raw?.target,
        hint: raw?.hint,
        raw,
        meta: {
          index,
          status: 'pending',
          revision: this.#policyState.revision,
          updatedAt: Date.now(),
        },
      }));
      this.#policyState.steps = mapped;
      this.#recomputePolicyCursor();
    } catch {}
  }

  #markStepByAction(actionId: number, rawStep?: any): PolicyStep | null {
    try {
      const steps = Array.isArray(this.#policyState.steps) ? this.#policyState.steps : [];
      const step = (steps.find((s: PolicyStep) => s?.meta?.status === 'pending') as PolicyStep | undefined) || null;
      if (step && step.meta) {
        step.meta.status = 'queued';
        step.meta.pendingActionId = actionId;
        step.meta.updatedAt = Date.now();
        if (rawStep) step.raw = rawStep;
        this.#pendingPolicyActions.set(actionId, step);
        return step;
      }
    } catch {}
    return null;
  }

  #shouldRefreshPolicyPlan(snapshot: any) {
    try {
      const baseline = this.#policyState.baseline;
      if (!baseline || !snapshot) return true;
      if (this.#policyState.lastTurn && this.#policyState.lastTurn !== String(snapshot?.turn ?? '')) return true;
      return this.#policyDriftExceeded(baseline, snapshot);
    } catch { return true; }
  }

  #isMyTurn(snapshot: any = this.#lastSnapshot) {
    try {
      if (!snapshot) {
        console.log('[agent] 🔍 isMyTurn: no snapshot, returning false')
        return false;
      }
      
      // 诊断：显示所有可能的回合标记（仅在回合变化时显示，减少日志量）
      const shouldLog = (this as any)._lastLoggedTurnCheck !== snapshot.turn
      if (shouldLog) (this as any)._lastLoggedTurnCheck = snapshot.turn
      
      const checks = shouldLog ? {
        'snapshot.is_my_turn': snapshot.is_my_turn,
        'snapshot.turn_player_id': snapshot.turn_player_id,
        'snapshot.ai_player_id': snapshot.ai_player_id,
        'derived_turn_player': (Number.isFinite(Number(snapshot?.turn_player_id)) && Number.isFinite(Number(snapshot?.ai_player_id))) ? (Number(snapshot.turn_player_id) === Number(snapshot.ai_player_id) ? 'self' : 'enemy') : 'unknown',
      } : null
      
      // 1) 强优先：基于 turn_player_id/ai_player_id
      try {
        const tpid = Number(snapshot?.turn_player_id)
        const apid = Number(snapshot?.ai_player_id)
        if (Number.isFinite(tpid) && Number.isFinite(apid)) {
          const mine = tpid === apid
          if (shouldLog) console.log('[agent] 🔍 isMyTurn by ids:', {tpid, apid, mine})
          return mine
        }
      } catch {}

      if (typeof snapshot.is_my_turn === 'boolean') {
        if (shouldLog) console.log('[agent] 🔍 isMyTurn checks:', checks, '→ result:', snapshot.is_my_turn)
        return snapshot.is_my_turn;
      }
      if (typeof snapshot?.self?.is_my_turn === 'boolean') {
        console.log('[agent] 🔍 isMyTurn checks:', checks, '→ result:', snapshot.self.is_my_turn === true)
        return snapshot.self.is_my_turn === true;
      }
      if (typeof snapshot?.you?.is_my_turn === 'boolean') {
        console.log('[agent] 🔍 isMyTurn checks:', checks, '→ result:', snapshot.you.is_my_turn === true)
        return snapshot.you.is_my_turn === true;
      }
      if (typeof snapshot?.turn_owner === 'string') {
        const result = String(snapshot.turn_owner).toLowerCase() === 'self'
        console.log('[agent] 🔍 isMyTurn checks:', checks, '→ result:', result)
        return result
      }
      if (typeof snapshot?.active_player === 'string') {
        const result = String(snapshot.active_player).toLowerCase() === 'self'
        console.log('[agent] 🔍 isMyTurn checks:', checks, '→ result:', result)
        return result
      }
      if (typeof snapshot?.current_player === 'string') {
        const result = String(snapshot.current_player).toLowerCase() === 'self'
        console.log('[agent] 🔍 isMyTurn checks:', checks, '→ result:', result)
        return result
      }
      if (typeof snapshot?.self?.turn_active === 'boolean') {
        console.log('[agent] 🔍 isMyTurn checks:', checks, '→ result:', snapshot.self.turn_active === true)
        return snapshot.self.turn_active === true;
      }
      
      console.log('[agent] 🔍 isMyTurn: no valid turn indicator found', checks, '→ returning false')
      return false;
    } catch (e) { 
      console.log('[agent] 🔍 isMyTurn error:', e)
      return false; 
    }
  }

  #isMyTurnStrict(snapshot: any = this.#lastSnapshot) {
    try {
      if (!snapshot) return false
      const tpid = Number(snapshot?.turn_player_id)
      const apid = Number(snapshot?.ai_player_id)
      if (Number.isFinite(tpid) && Number.isFinite(apid)) return tpid === apid
      if (typeof snapshot?.is_my_turn === 'boolean') return snapshot.is_my_turn === true
      if (typeof snapshot?.self?.is_my_turn === 'boolean') return snapshot.self.is_my_turn === true
      if (typeof snapshot?.you?.is_my_turn === 'boolean') return snapshot.you.is_my_turn === true
      return false
    } catch { return false }
  }

  #watchdog() {
    const cfgTimeout = Number(this.#cfg.maxTurnMs);
    const DECISION_TIMEOUT_MS = Number.isFinite(cfgTimeout) && cfgTimeout > 0 ? Math.max(2000, Math.min(60000, cfgTimeout)) : 6000;
    if ((this.#inflight || this.#batchInflight) && Date.now() - ((this.#batchInflight?.ts || this.#inflight?.ts) as number) > DECISION_TIMEOUT_MS) {
      console.warn('[agent] decision timeout, trying fallback end_turn');
      this.#inflight = null;
      this.#batchInflight = null;
      this.#flushPlan('timeout');
      const endAct = this.#lastActions?.find(a => a && a.end_turn);
      if (endAct) this.#sendAction(endAct.id);
    }
  }

  #sendAction(actionId: number) {
    // Accumulate into local turn-plan (hierarchical mode) and coalesce send
    if (this.#cfg.alwaysCallLLMOnOwnTurn && this.#isMyTurnStrict()) {
      // Defer local immediate sends; force LLM-driven plan first
      try { console.log('[agent] alwaysCallLLMOnOwnTurn: deferring direct send, will request LLM plan'); } catch {}
      try { this.#decideIntentDriven(this.#lastActions||[], this.#lastSnapshot||{}).catch(()=>{}); } catch {}
      return;
    }
    const a = (this.#lastActions||[]).find((x:any)=>x&&x.id===actionId);
    const step = toStep(a)
    if (step) this.#turnPlanSteps.push(step)
    // If it's a move, schedule a chained attack using latest tactical preview (do not append now; wait for actions refresh)
    try {
      if (a?.move_unit) {
        const uid = Number(a.move_unit.unit_id)
        const to = Number(a.move_unit.to_cell_index)
        const preview = (this.#lastSnapshot && (this.#lastSnapshot as any).tactical_preview) || this.#lastTacticalPreview || []
        const items = Array.isArray(preview) ? preview.filter((p:any)=> Number(p?.unit_id)===uid && Number(p?.to_cell_index)===to) : []
        const want = this.#deriveTargetPreferenceFromPolicy(this.#lastPolicyPlan)
        let targetId: number | null = null
        for (const it of items) {
          const atks = Array.isArray(it?.attacks) ? it.attacks : []
          if (!atks.length) continue
          const pick = this.#pickAttackFromList(atks, want)
          if (pick && Number.isFinite(Number(pick.target_unit_id))) { targetId = Number(pick.target_unit_id); break }
        }
        const moveId = Number(a?.id)
        if (targetId != null) {
          const attackId = 400000 + (uid * 1000) + (targetId as number)
          this.#chainQueue.push({attacker: uid, preferredTarget: targetId, moveId, attackId})
            try { console.log('[agent] 🔗 queue chain after move', {uid, to, moveId, preferredTarget: targetId, attackId}) } catch {}
        } else if (items.length) {
          this.#chainQueue.push({attacker: uid, preferredTarget: null, moveId, attackId: null})
            try { console.log('[agent] 🔗 queue chain (move-only, no preferred target)', {uid, to, moveId}) } catch {}
        }
      }
    } catch {}
    this.#turn.steps = (this.#turn.steps || 0) + 1;
    this.#broadcast('decision_log', {actionId, info: 'queued', steps: this.#turn.steps});
    // Debounce flush
    if (this.#planTimer) clearTimeout(this.#planTimer)
    this.#planTimer = setTimeout(()=> this.#flushPlan('debounce'), 100);
  }

  #sendImmediateActionId(id: number) {
    try {
      if (!Number.isFinite(Number(id))) return
      this.#send({type: 'select_action', id: Number(id)})
      this.#inflight = {reqId: `sel_${id}`, ts: Date.now()}
      this.#broadcast('decision_log', {actionId: id, info: 'immediate_select'})
    } catch {}
  }

  #flushPlan(note: string) {
    try {
      if (!this.#turnPlanSteps.length) return
      if (this.#batchInflight) { try { console.log('[agent] flushPlan skipped: inflight'); } catch {} return; }
      const reqId = randomUUID();
      const steps0 = this.#turnPlanSteps.slice();
      const steps1 = this.#augmentPlanWithMoveThenAttack(steps0, this.#lastSnapshot)
      const steps = this.#attachUidsToSteps(steps1, this.#lastSnapshot)
      const payload = { atomic: false, auto_end: false, steps }
      this.#send({type: 'turn_plan', turn_plan: payload, req_id: reqId})
      this.#batchInflight = {reqId, ts: Date.now()}
      this.#broadcast('decision_log', {plan: payload, info: `turn_plan submitted (acc:${note})`})
      // surface a concrete view
      try { this.#broadcast('llm_io', {turn: this.#lastSnapshot?.turn, phase: 'concrete', raw: JSON.stringify({turn_plan: payload})}) } catch {}
      this.#turnPlanSteps = []
    } catch {}
  }

  #augmentPlanWithMoveThenAttack(steps: any[], snapshot: any): any[] {
    try {
      if (!Array.isArray(steps) || !steps.length) return steps || []
      const preview = (this.#lastSnapshot && (this.#lastSnapshot as any).tactical_preview) || this.#lastTacticalPreview || []
      if (!Array.isArray(preview) || preview.length === 0) return steps
      const want = this.#deriveTargetPreferenceFromPolicy(this.#lastPolicyPlan)
      // Skip hero-only reposition unless enables attack or improves safety (heuristic)
      // Detect who can attack now
      const attackerIds = new Set<number>()
      try {
        const acts = Array.isArray(this.#lastActions) ? this.#lastActions : []
        for (const a of acts) { if (a && a.unit_attack && Number.isFinite(Number(a.unit_attack.attacker_unit_id))) attackerIds.add(Number(a.unit_attack.attacker_unit_id)) }
      } catch {}
      const canAttackById = new Set<number>()
      try {
        const all = ([] as any[]).concat(Array.isArray(snapshot?.self_units)? snapshot.self_units: [])
        for (const u of all) { const id = Number(u?.unit_id ?? u?.id); if (Number.isFinite(id) && (u?.can_attack === true)) canAttackById.add(id) }
      } catch {}
      const resolveCell = (obj:any) => {
        try {
          if (!obj) return null
          if (obj.cell_index != null) { const n = Number(obj.cell_index); return Number.isFinite(n) ? n : null }
          const cand = obj.to ?? obj.target ?? null
          if (cand == null) return null
          if (typeof cand === 'object' && (cand as any).cell_index != null) {
            const n = Number((cand as any).cell_index)
            return Number.isFinite(n) ? n : null
          }
          return null
        } catch { return null }
      }
      const augmented: any[] = []
      for (const s of steps) {
        try {
          if (s && String(s.type||'').toLowerCase() === 'move') {
            const uid = Number((s as any).unit_id)
            const toCell = resolveCell(s) ?? resolveCell((s as any).to) ?? Number((s as any).cell_index)
            if (Number.isFinite(uid) && Number.isFinite(toCell)) {
              // Guard: avoid hero-only reposition (treat unit_id 0 as hero sentinel in several bridges)
              if (uid === 0) {
                const candHero = (preview as any[]).find((p:any)=> Number(p?.unit_id)===uid && Number(p?.to_cell_index)===toCell)
                const hasAtk = Array.isArray((candHero as any)?.attacks) && (candHero as any).attacks.length>0
                if (!hasAtk) { augmented.push(s); continue }
              }
              const cand = (preview as any[]).find((p:any)=> Number(p?.unit_id)===uid && Number(p?.to_cell_index)===toCell)
              const canNow = attackerIds.has(uid) || canAttackById.has(uid)
              if (cand && canNow) {
                const atks = Array.isArray((cand as any).attacks) ? (cand as any).attacks : []
                let pick: any = null
                if (atks.length) { pick = this.#pickAttackFromList(atks, want) }
                const tgt = Number.isFinite(Number(pick?.target_unit_id)) ? Number(pick.target_unit_id) : (Number.isFinite(Number((cand as any).target_unit_id)) ? Number((cand as any).target_unit_id) : null)
                if (tgt != null) {
                  const step = { type: 'move_then_attack', unit_id: uid, to: { cell_index: toCell }, target_unit_id: tgt }
                  augmented.push(step)
                  try { (this as any)._metric_mtaQueued = ((this as any)._metric_mtaQueued||0) + 1 } catch {}
                  try { console.log('[agent] ✳ augment move→move_then_attack', {unit_id: uid, to: toCell, target_unit_id: tgt}) } catch {}
                  continue
                }
              }
              // Heuristic: if move leads to future attack (by preview entries with any attacks), still include move
              if (cand && Array.isArray((cand as any).attacks) && (cand as any).attacks.length>0) {
                const step = { type: 'move', unit_id: uid, to: { cell_index: toCell } }
                augmented.push(step)
                try { console.log('[agent] ✳ augment move (future attack potential)', {unit_id: uid, to: toCell}) } catch {}
                continue
              }
            }
          }
        } catch {}
        augmented.push(s)
      }
      return augmented
    } catch { return steps || [] }
  }

  #chooseProactiveAdvanceMove(actions: any[], snapshot: any): number | null {
    try {
      if (!Array.isArray(actions) || actions.length === 0) return null
      const W = Number(snapshot?.board?.width ?? snapshot?.board?.W ?? snapshot?.W ?? 9)
      const fwd = computeForward(snapshot, W)
      const youIdx = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index)
      const enemyIdx = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index)
      if (!Number.isFinite(youIdx) || !Number.isFinite(enemyIdx)) return null
      const yRow = Math.floor(youIdx / W), yCol = youIdx % W
      const eRow = Math.floor(enemyIdx / W), eCol = enemyIdx % W
      let best: any = null; let bestScore = -9999
      const preview = (snapshot && (snapshot as any).tactical_preview) || this.#lastTacticalPreview || []
      for (const a of (actions||[])) {
        if (!a?.move_unit) continue
        const uid = Number(a.move_unit.unit_id)
        const to = Number(a.move_unit.to_cell_index)
        if (!Number.isFinite(uid) || !Number.isFinite(to)) continue
        if (uid === 0) continue // avoid hero non-attacking reposition
        const r = Math.floor(to / W), c = to % W
        const drs = r - yRow, dcs = c - yCol
        const u_f = (drs * (fwd?.dr||1)) + (dcs * (fwd?.dc||0))
        const dirLen = Math.max(1, Math.hypot(W, W))
        const u_n = u_f / dirLen
        const distEnemy = Math.hypot(r - eRow, c - eCol)
        const distNorm = distEnemy / Math.max(1, Math.hypot(W, W))
        let score = 0
        score += 2.0 * u_n
        score += -1.0 * distNorm
        try {
          const items = Array.isArray(preview) ? preview.filter((p:any)=> Number(p?.unit_id)===uid && Number(p?.to_cell_index)===to) : []
          const canAttack = items.some((p:any)=> Array.isArray(p?.attacks) && p.attacks.length>0)
          if (canAttack) score += 0.5
        } catch {}
        if (score > bestScore) { bestScore = score; best = a }
      }
      return best ? Number(best.id) : null
    } catch { return null }
  }

  #attachUidsToSteps(steps: any[], snapshot: any): any[] {
    try {
      if (!Array.isArray(steps) || steps.length === 0) return steps || []
      const uidById = new Map<number, string>()
      try {
        const all = ([] as any[])
          .concat(Array.isArray(snapshot?.self_units) ? snapshot.self_units : [])
          .concat(Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units : [])
        for (const u of all) {
          const id = Number(u?.unit_id ?? u?.id)
          const uid = typeof u?.uid === 'string' ? u.uid : null
          if (Number.isFinite(id) && uid) uidById.set(id, uid)
        }
      } catch {}
      const withUids: any[] = []
      for (const s of steps) {
        try {
          const t = String(s?.type||'').toLowerCase()
          if (t === 'unit_attack') {
            const att = Number((s as any).attacker_unit_id)
            const tgt = Number((s as any).target_unit_id)
            const au = uidById.get(att)
            const tu = uidById.get(tgt)
            withUids.push(au || tu ? {...s, attacker_uid: au ?? undefined, target_uid: tu ?? undefined} : s)
            continue
          }
          if (t === 'move' || t === 'move_then_attack') {
            const uid = uidById.get(Number((s as any).unit_id))
            const tu = uidById.get(Number((s as any).target_unit_id))
            withUids.push(uid || tu ? {...s, unit_uid: uid ?? undefined, target_uid: tu ?? undefined} : s)
            continue
          }
        } catch {}
        withUids.push(s)
      }
      return withUids
    } catch { return steps || [] }
  }

  async #stepDecision(actions: any[], gen?: number) {
    if (!Array.isArray(actions) || actions.length === 0) return;
    if ((this as any)._gameOver) { try { console.log('[agent] stepDecision skipped: game_over'); } catch {} return; }
    if (this.#paused) { try { console.log('[agent] stepDecision skipped: paused'); } catch {} return; }
    // 🔧 关键修复：检查回合状态，避免在对手回合触发决策
    if (!(((this as any)._isMyTurnOverride === true) ? true : this.#isMyTurnStrict())) { 
      try { 
        const turn = this.#lastSnapshot?.turn
        const isMy = this.#lastSnapshot?.is_my_turn
        console.log('[agent] stepDecision skipped: not my turn', {turn, is_my_turn: isMy}) 
      } catch {} 
      return; 
    }
    if (this.#inflight || this.#batchInflight) { try { console.log('[agent] stepDecision skipped: inflight'); } catch {} return; }
    if (this.#deciding) { try { console.log('[agent] stepDecision skipped: deciding'); } catch {} return; }
    // Short-circuit: only end_turn
    if (actions.length === 1 && actions[0] && actions[0].end_turn) {
      if ((this as any)._endedThisTurn) { try { console.log('[agent] skip end_turn: already ended this turn'); } catch {} return; }
      return this.#sendAction(actions[0].id);
    }
    this.#deciding = true;
    try { console.log('[agent] stepDecision start', {gen, actions: actions.length}); } catch {}

    try {
      const decision = await this.#decide(actions);
      // Drop stale decision if a newer gen arrived meanwhile
      if (gen != null && gen !== this.#actionsGen) { try { console.log('[agent] decision dropped: stale', {gen, latest: this.#actionsGen}); } catch {} return; }
      if (!decision || typeof decision !== 'object') return this.#autoPlay(actions);
      if (decision.mode === 'hierarchical' && decision.nextStep && decision.nextStep.type) {
        this.#broadcast('decision_explain', {mode: 'hierarchical', turn: this.#lastSnapshot?.turn, steps: this.#turn.steps, gen});
        this.#consumePolicyStep(decision.nextStep, decision.reason);
        if (Number.isFinite(decision.actionId) && decision.actionId != null && actions.some(a => a && a.id === decision.actionId)) {
          this.#sendAction(decision.actionId);
        } else if (!decision.deferExecution) {
          this.#autoPlay(actions);
        }
        return;
      }
      const chosen = Number.isFinite(decision?.actionId) ? decision.actionId : null;
      if (chosen == null) return this.#autoPlay(actions);
      const exists = actions.some(a => a && a.id === chosen);
      if (!exists) return this.#autoPlay(actions);
      this.#broadcast('decision_explain', {mode: decision.mode || this.#cfg.decisionMode, turn: this.#lastSnapshot?.turn, steps: this.#turn.steps, gen, why: decision.reason});
      if (decision.mode === 'hierarchical') {
        this.#consumePolicyStep(decision.nextStep ?? null, decision.reason);
      }
      this.#sendAction(chosen);
    } catch (e) {
      console.error('[agent] decide error', e);
      this.#autoPlay(actions);
    } finally {
      this.#deciding = false;
    }
  }

  #autoPlay(actions: any[]) {
    const choice = actions.find(a => a && a.unit_attack)
      || actions.find(a => a && a.move_unit)
      || actions.find(a => a && a.use_skill)
      || actions.find(a => a && a.hero_power)
      || actions.find(a => a && a.play_card)
      || actions.find(a => a && a.end_turn);
    if (choice) this.#sendAction(choice.id);
  }

  async #decide(actions: any[]): Promise<DecisionResult | null> {
    const snapshot = this.#lastSnapshot;
    if (!this.#cfg.baseUrl || !this.#cfg.provider) {
      return {mode: 'auto', actionId: null, reason: 'dispatcher_disabled'};
    }

    const mode = this.#cfg.decisionMode || 'intent_driven';

    // Intent-driven is now the primary mode
    if (mode === 'intent_driven') {
      // Always call LLM on own turn if configured
      if (this.#cfg.alwaysCallLLMOnOwnTurn && this.#isMyTurnStrict(snapshot)) {
        return await this.#decideIntentDriven(actions, snapshot);
      }
      return await this.#decideIntentDriven(actions, snapshot);
    }

    // Fallback to legacy modes if needed
    if (mode === 'hierarchical') {
      return await this.#decideHierarchical(actions, snapshot);
    }
    
    if (mode === 'intent') {
      return await this.#decideIntent(actions, snapshot);
    }

    if (mode === 'policy_only') {
      this.#autoPlay(actions);
      return {mode: 'policy_only', actionId: null, reason: 'policy_only_auto', deferExecution: true};
    }

    // Mixed mode: try intent_driven first, then fallback
    try {
      const intent = await this.#decideIntentDriven(actions, snapshot);
      if (intent && (intent.actionId != null || intent.deferExecution)) return intent;
    } catch {}

    const safe = selectSafeAction(actions, snapshot, this.#lastTacticalPreview);
    return {mode: 'auto', actionId: safe, reason: 'safe_fallback'};
  }

  async #decideIntent(actions: any[], snapshot: any): Promise<DecisionResult | null> {
    try {
      // 🔧 双重检查：确保是己方回合
      if (!this.#isMyTurn(snapshot)) {
        console.log('[agent] decideIntent aborted: not my turn')
        return null
      }
      
      await this.#maybeReviseStrategy(snapshot);
      const observation = this.#buildObservation(snapshot);
      const prunedForPrompt = this.#pruneActions(actions, this.#cfg.maxActions || 24);
      const userContent = buildIntentPrompt(snapshot, observation, prunedForPrompt, acts => this.#buildActionsForPrompt(acts));
      const tools = this.#buildToolFunctions(prunedForPrompt);
      const situation = this.#scoreSituation(snapshot, actions);
      const temp = this.#computeTemperature(snapshot, actions, situation);
      const payload = {
        model: this.#cfg.model,
        messages: [
          {role: 'system', content: this.#cfg.systemPrompt || '严格输出 JSON 意图'},
          {role: 'user', content: (this.#strategy ? `策略（JSON）：\n${JSON.stringify(this.#strategy)}\n\n` : '') + userContent},
        ],
        tools,
        tool_choice: tools && tools.length ? 'auto' : undefined,
        temperature: this.#clampTemp(temp ?? (this.#cfg.temperature ?? 0.15)),
        max_tokens: Math.max(256, this.#cfg.maxTokens || 384),
      } as any;
      const t0 = Date.now()
      const res = await callDispatcher(this.#cfg, payload);
      try {
        const elapsed = Date.now() - t0
        const sessId = String((this as any)._sessionId || 'default')
        this.#db.addLLMCall({
          sessionId: sessId,
          turn: Number(snapshot?.turn),
          phase: 'intent_initial',
          provider: this.#cfg.provider,
          model: this.#cfg.model,
          request: payload,
          response: res?.data,
          elapsedMs: elapsed,
        })
      } catch {}
      const chosenByTool = this.#parseToolChoiceFromResponse(res.data, actions);
      if (chosenByTool != null && actions.some(a => a && a.id === chosenByTool)) {
        const actionDetail = actions.find(a => a.id === chosenByTool);
        this.#capturePreOutcome(snapshot, chosenByTool);
        this.#broadcast('decision_log', {actionId: chosenByTool, rationale: 'tool_choice', action: actionDetail, strategy: this.#strategy});
        return {mode: 'intent', actionId: chosenByTool, reason: 'tool_choice'};
      }
      const text = extractText(res.data);
      const intent = parseIntentObject(text);
      try { const cyan='\x1b[36m',reset='\x1b[0m'; console.log(`${cyan}[LLM][intent][initial] text:${reset}`, text) } catch {}
      try {
        const usage = (res as any)?.data?.data?.usage || (res as any)?.data?.usage || undefined;
        this.#broadcast('llm_io', {turn: this.#lastSnapshot?.turn, phase: 'initial', usage, raw: text});
      } catch {}
      // If model returns a full turn plan, compile and send batch once
      if (intent && typeof intent === 'object' && (intent as any).turn_plan && Array.isArray((intent as any).turn_plan.steps)) {
        const handled = this.#tryHandleTurnPlan(intent, snapshot, actions);
        if (handled) {
          this.#broadcast('decision_log', {plan: intent.turn_plan, info: 'turn_plan submitted'});
          return null;
        }
      }
      // Minimal JSON acceptance: {"action_id": <id>}
      const idFromMinimal = parseActionId(text, actions);
      if (idFromMinimal != null && actions.some(a => a && a.id === idFromMinimal)) {
        const actionDetail = actions.find(a => a.id === idFromMinimal);
        this.#capturePreOutcome(snapshot, idFromMinimal);
        this.#broadcast('decision_log', {actionId: idFromMinimal, intent, compiled: {id: idFromMinimal, minimal: true}, action: actionDetail, strategy: this.#strategy});
        return {mode: 'intent', actionId: idFromMinimal, reason: 'minimal_json'};
      }
      let compiled = this.#compileIntentToActionId(intent, actions, snapshot);
      try { const green='\x1b[32m',reset='\x1b[0m'; console.log(`${green}[LLM][intent][parsed]${reset}`, intent); console.log(`${green}[LLM][intent][compiled]${reset}`, compiled) } catch {}
      if (compiled && compiled.id != null) {
        const why = typeof intent?.rationale === 'string' ? String(intent.rationale).slice(0, 120) : undefined;
        const actionDetail = actions.find(a => a.id === compiled.id);
        this.#capturePreOutcome(snapshot, compiled.id);
        console.log(`[agent] executing action ${compiled.id}: ${this.#serializeAction(actionDetail)} (${why || 'no rationale'})`);
        this.#broadcast('decision_log', {actionId: compiled.id, intent, compiled, rationale: why, action: actionDetail, strategy: this.#strategy});
        if (why) this.#broadcast('decision_explain', {mode: 'intent', why});
        return {mode: 'intent', actionId: compiled.id, reason: why, metadata: {intent}};
      }
      // one-shot self-correction
      const errMsg = compiled?.error || 'illegal or non-executable intent';
      const retryMessages = [
        {role: 'system', content: this.#cfg.systemPrompt || '严格输出 JSON 意图'},
        {role: 'user', content: (this.#strategy ? `策略（JSON）：\n${JSON.stringify(this.#strategy)}\n\n` : '') + userContent},
        {role: 'assistant', content: typeof text === 'string' ? text : ''},
        {role: 'user', content: `上一次的意图无法执行：${errMsg}。请基于相同观测重新给出可执行的意图，注意：不得臆造单位/手牌/坐标；若不确定则 end_turn。只输出严格 JSON。`},
      ];
      const t1 = Date.now()
      const res2 = await callDispatcher(this.#cfg, { model: this.#cfg.model, messages: retryMessages, tools, tool_choice: tools && tools.length ? 'auto' : undefined, temperature: this.#clampTemp(temp ?? (this.#cfg.temperature ?? 0.15)), max_tokens: Math.max(256, this.#cfg.maxTokens || 384) });
      try {
        const elapsed = Date.now() - t1
        const sessId = String((this as any)._sessionId || 'default')
        this.#db.addLLMCall({
          sessionId: sessId,
          turn: Number(snapshot?.turn),
          phase: 'intent_retry',
          provider: this.#cfg.provider,
          model: this.#cfg.model,
          request: { model: this.#cfg.model, messages: retryMessages },
          response: res2?.data,
          elapsedMs: elapsed,
        })
      } catch {}
      const chosenByTool2 = this.#parseToolChoiceFromResponse(res2.data, actions);
      if (chosenByTool2 != null && actions.some(a => a && a.id === chosenByTool2)) {
        const actionDetail2 = actions.find(a => a.id === chosenByTool2);
        this.#capturePreOutcome(snapshot, chosenByTool2);
        this.#broadcast('decision_log', {actionId: chosenByTool2, rationale: 'tool_choice_retry', action: actionDetail2, retry: true, strategy: this.#strategy});
        return {mode: 'intent', actionId: chosenByTool2, reason: 'tool_choice_retry'};
      }
      const text2 = extractText(res2.data);
      try { const cyan='\x1b[36m',reset='\x1b[0m'; console.log(`${cyan}[LLM][intent][retry] text:${reset}`, text2) } catch {}
      const intent2 = parseIntentObject(text2);
      try {
        const usage2 = (res2 as any)?.data?.data?.usage || (res2 as any)?.data?.usage || undefined;
        this.#broadcast('llm_io', {turn: this.#lastSnapshot?.turn, phase: 'retry', usage: usage2, raw: text2});
      } catch {}
      const idFromMinimal2 = parseActionId(text2, actions);
      if (idFromMinimal2 != null && actions.some(a => a && a.id === idFromMinimal2)) {
        const actionDetail2b = actions.find(a => a.id === idFromMinimal2);
        this.#capturePreOutcome(snapshot, idFromMinimal2);
        this.#broadcast('decision_log', {actionId: idFromMinimal2, intent: intent2, compiled: {id: idFromMinimal2, minimal: true}, action: actionDetail2b, retry: true, strategy: this.#strategy});
        return {mode: 'intent', actionId: idFromMinimal2, reason: 'minimal_json_retry'};
      }
      if (intent2 && typeof intent2 === 'object' && (intent2 as any).turn_plan && Array.isArray((intent2 as any).turn_plan.steps)) {
        const handled2 = this.#tryHandleTurnPlan(intent2, snapshot, actions);
        if (handled2) {
          this.#broadcast('decision_log', {plan: intent2.turn_plan, info: 'turn_plan submitted (retry)'});
          return null;
        }
      }
      compiled = this.#compileIntentToActionId(intent2, actions, snapshot);
      try { const yellow='\x1b[33m',reset='\x1b[0m'; console.log(`${yellow}[LLM][intent][retry][compiled]${reset}`, compiled) } catch {}
      if (compiled && compiled.id != null) {
        const why = typeof intent2?.rationale === 'string' ? String(intent2.rationale).slice(0, 120) : undefined;
        const actionDetail = actions.find(a => a.id === compiled.id);
        this.#capturePreOutcome(snapshot, compiled.id);
        console.log(`[agent] executing action ${compiled.id} (retry): ${this.#serializeAction(actionDetail)} (${why || 'no rationale'})`);
        this.#broadcast('decision_log', {actionId: compiled.id, intent: intent2, compiled, rationale: why, action: actionDetail, retry: true, strategy: this.#strategy});
        if (why) this.#broadcast('decision_explain', {mode: 'intent', why, retry: true});
        return {mode: 'intent', actionId: compiled.id, reason: why, metadata: {intent: intent2}};
      }
      // n-best fallback majority vote
      try {
        const promptBase = this.#buildRankingPrompt(snapshot, actions);
        const n = Math.max(3, Number(this.#cfg.nBest || 3));
        const nb = await this.#nbestDecide(actions, snapshot, promptBase, temp, {n, parallel: !!this.#cfg.nBestParallel});
        if (nb && nb.actionId != null && actions.some(a => a && a.id === nb.actionId)) {
          const actionDetail = actions.find(a => a.id === nb.actionId);
          this.#capturePreOutcome(snapshot, nb.actionId);
          this.#broadcast('decision_log', {actionId: nb.actionId, rationale: 'nbest', action: actionDetail, strategy: this.#strategy});
          return {mode: 'intent', actionId: nb.actionId, reason: 'nbest'};
        }
      } catch {}
      console.log(`[agent] both attempts failed, falling back`);
      const safe = selectSafeAction(actions, snapshot, this.#lastTacticalPreview);
      if (safe != null) {
        this.#capturePreOutcome(snapshot, safe);
        const actionDetail = actions.find(a => a.id === safe);
        this.#broadcast('decision_log', {actionId: safe, rationale: 'safe_fallback', action: actionDetail, strategy: this.#strategy});
        return {mode: 'intent', actionId: safe, reason: 'safe_fallback'};
      }
      this.#broadcast('decision_log', {actionId: null, error: 'failed after retry', originalError: errMsg, intent: intent2, strategy: this.#strategy});
      return {mode: 'intent', actionId: null, reason: 'llm_intent_invalid', metadata: {errMsg}};
    } catch (e) {
      console.error('[agent] decideIntent error', e);
      return {mode: 'intent', actionId: null, reason: 'intent_exception'};
    }
  }

  #capturePreOutcome(snapshot: any, actionId: number) {
    try {
      const pressure = this.#estimatePressure(snapshot);
      const threat = this.#estimateThreat(snapshot);
      const myHP = Number(snapshot?.you?.hero_hp);
      const enemyHP = Number(snapshot?.opponent?.hero_hp);
      this.#pendingEval = {pre: {pressure, threat, myHP, enemyHP}, actionId, ts: Date.now()};
    } catch {}
  }

  #estimatePressure(snapshot: any) {
    try {
      const sum = (arr:any[]) => arr.reduce((s,v)=> s + Math.max(0, Number(v?.atk)||0), 0);
      return sum(snapshot?.self_units||[]) - sum(snapshot?.enemy_units||[]);
    } catch { return 0; }
  }
  #estimateThreat(snapshot: any) {
    try {
      const near = (arr:any[], heroIdx:number)=> arr.filter(u=> Math.abs((Number(u?.row)||0) - Math.floor(heroIdx / (Number(snapshot?.board?.width)||9))) <= 1).length;
      const hero = Number(snapshot?.you?.hero_cell_index ?? snapshot?.self?.hero_cell_index ?? -1);
      return hero>=0 ? near(snapshot?.enemy_units||[], hero) : 0;
    } catch { return 0; }
  }

  #maybeReviseStrategy = async (snapshot: any) => {
    try {
      const t = Number(snapshot?.turn||0);
      const needInit = !this.#strategy;
      const needRotate = this.#strategy && (t - (this.#strategy.turn_started||t)) >= (this.#strategy.horizon_turns||3);
      const heroLow = Number(snapshot?.you?.hero_hp) <= 4;
      if (!(needInit || needRotate || heroLow)) return;
      const stratObs = this.#buildStrategyObservation(snapshot);
      const messages = [
        {role:'system', content:'你是策略规划模块。根据概要信息，输出严格 JSON 的策略（参考 schema）。'},
        {role:'user', content: JSON.stringify(stratObs)},
      ];
      const res = await callDispatcher(this.#cfg, { model: this.#cfg.model, messages, temperature: 0.2, max_tokens: 256 });
      const text = extractText(res.data);
      const parsed = parseStrategyJson(text);
      if (parsed && typeof parsed==='object') {
        this.#strategy = {
          version: Number(parsed.version)||1,
          turn_started: t,
          horizon_turns: Number(parsed.horizon_turns)||3,
          posture: parsed.posture||this.#cfg.strategyProfile||'balanced',
          primary_goal: String(parsed.primary_goal||'develop_board'),
          secondary_goals: parsed.secondary_goals||[],
          target_regions: parsed.target_regions||[],
          commitments: parsed.commitments||[],
          constraints: parsed.constraints||{},
          success_metrics: parsed.success_metrics||{},
          last_revision_reason: parsed.last_revision_reason||undefined,
        } as StrategyState;
        this.#saveStrategyToDisk();
        this.#broadcast('strategy_updated', this.#strategy);
      }
    } catch {}
  }

  #buildStrategyObservation(snapshot: any) {
    try {
      const pressure = this.#estimatePressure(snapshot);
      const threat = this.#estimateThreat(snapshot);
      return {
        turn: snapshot?.turn,
        you: {hero_hp: snapshot?.you?.hero_hp, mana: snapshot?.you?.mana, hand_size: (snapshot?.you?.hand||[]).length},
        opponent: {hero_hp: snapshot?.opponent?.hero_hp},
        metrics: {pressure, threat},
        posture_hint: this.#cfg.strategyProfile||'balanced',
      };
    } catch { return {turn: snapshot?.turn}; }
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
      const placesByCard: Record<number, Array<{cell_index:number; row:number; col:number; pos:string; 
        dr_self?:number; dc_self?:number; dr_enemy?:number; dc_enemy?:number; dist_self?:number; dist_enemy?:number;
        ahead?:boolean; ahead_score?:number; lateral?:'left'|'right'|'center';
        u?:number; v?:number; u_n?:number; v_n?:number; bearing_deg?:number; bearing_oct?:string; lane5?:number; lane?:'far_left'|'left'|'center'|'right'|'far_right'; region?:'backline'|'mid'|'frontline' }>> = {};
      let selfHeroRow: number | null = null; let enemyHeroRow: number | null = null;
      let selfHeroCol: number | null = null; let enemyHeroCol: number | null = null;
      try {
        const yHeroIndex = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index);
        if (Number.isFinite(yHeroIndex)) { const rc = toRC(yHeroIndex); if (rc) { selfHeroRow = rc.row; selfHeroCol = rc.col; } }
        const eHeroIndex = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index);
        if (Number.isFinite(eHeroIndex)) { const rc = toRC(eHeroIndex); if (rc) { enemyHeroRow = rc.row; enemyHeroCol = rc.col; } }
      } catch {}
      const toOct = (deg: number) => {
        // Map angle to 8 octants relative to forward (u axis): F, F-R, R, B-R, B, B-L, L, F-L
        let a = ((deg % 360) + 360) % 360;
        const idx = Math.round(a / 45) % 8;
        return ['F','F-R','R','B-R','B','B-L','L','F-L'][idx];
      };
      try {
        const acts = Array.isArray(this.#lastActions) ? this.#lastActions : [];
        const hasHeroes = (selfHeroRow != null && selfHeroCol != null && enemyHeroRow != null && enemyHeroCol != null);
        const dir = hasHeroes ? {dr: (enemyHeroRow! - selfHeroRow!), dc: (enemyHeroCol! - selfHeroCol!)} : null;
        const dirLen = dir ? Math.hypot(dir.dr, dir.dc) : 0;
        const dirU = dirLen > 0 ? {dr: dir!.dr / dirLen, dc: dir!.dc / dirLen} : null;
        const normV = dirU ? {dr: -dirU.dc, dc: dirU.dr} : null; // left-hand normal
        const diagLen = Math.max(1, Math.hypot(W, W));
        for (const a of acts) {
          if (a?.play_card && Number.isFinite(Number(a.play_card.card_id)) && Number.isFinite(Number(a.play_card.cell_index))) {
            const cid = Number(a.play_card.card_id);
            const ci = Number(a.play_card.cell_index);
            const rc = toRC(ci);
            if (rc) {
              let drs:number|undefined, dcs:number|undefined, dre:number|undefined, dce:number|undefined,
                  dss:number|undefined, dse:number|undefined, ahead:boolean|undefined, aheadScore:number|undefined, lateral:'left'|'right'|'center'|undefined,
                  u:number|undefined, v:number|undefined, u_n:number|undefined, v_n:number|undefined, bearing_deg:number|undefined, bearing_oct:string|undefined,
                  lane5:number|undefined, lane: 'far_left'|'left'|'center'|'right'|'far_right'|undefined, region: 'backline'|'mid'|'frontline'|undefined;
              if (hasHeroes && dirU && normV) {
                drs = rc.row - (selfHeroRow as number);
                dcs = rc.col - (selfHeroCol as number);
                dre = rc.row - (enemyHeroRow as number);
                dce = rc.col - (enemyHeroCol as number);
                dss = Math.abs(drs) + Math.abs(dcs);
                dse = Math.abs(dre) + Math.abs(dce);
                // Continuous (u,v) basis
                const u_f = drs * dirU.dr + dcs * dirU.dc;
                const v_f = drs * normV.dr + dcs * normV.dc;
                u = Math.round(u_f);
                v = Math.round(v_f);
                u_n = u_f / Math.max(1, dirLen);
                v_n = v_f / Math.max(1, W);
                bearing_deg = Math.atan2(v_f, u_f) * 180 / Math.PI;
                bearing_oct = toOct(bearing_deg);
                aheadScore = (u_f) / Math.max(1, dirLen);
                ahead = aheadScore > 0;
                // Lateral and lane
                const cross = (dirU.dr * dcs) - (dirU.dc * drs);
                lateral = Math.abs(cross) < 1e-6 ? 'center' : (cross > 0 ? 'left' : 'right');
                lane5 = Math.max(-2, Math.min(2, Math.round((v_n || 0) * 2)));
                lane = lane5 === 0 ? 'center' : (lane5 < 0 ? (lane5 === -1 ? 'right' : 'far_right') : (lane5 === 1 ? 'left' : 'far_left'));
                // Region by u_n
                region = (u_n||0) > 0.66 ? 'frontline' : ((u_n||0) > 0.33 ? 'mid' : 'backline');
              }
              (placesByCard[cid] ||= []).push({
                cell_index: ci, row: rc.row, col: rc.col, pos: fmtRC(rc)!,
                dr_self: drs, dc_self: dcs, dr_enemy: dre, dc_enemy: dce,
                dist_self: dss, dist_enemy: dse, ahead, ahead_score: aheadScore, lateral,
                u, v, u_n, v_n, bearing_deg, bearing_oct, lane5, lane, region,
              });
            }
          }
        }
      } catch {}

      const yourHeroIdx = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index);
      const enemyHeroIdx = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index);

      const normUnit = (u: any, owner: 'self'|'enemy') => {
        if (!u) return u
        const unitId = (u.unit_id ?? u.id)
        const heroIdx = owner === 'self' ? yourHeroIdx : enemyHeroIdx
        const cellIdx = Number(u.cell_index ?? u.CellIndex ?? u.cell_idx)
        const isHeroUnit = Number.isFinite(heroIdx) && Number.isFinite(cellIdx) && cellIdx === heroIdx
        return {
          unit_id: unitId,
          card_id: (u.card_id ?? null),
          name: u.name,
          hp: u.hp,
          atk: u.atk,
          cell_index: u.cell_index,
          row: toRC(u.cell_index)?.row,
          col: toRC(u.cell_index)?.col,
          pos: fmtRC(toRC(u.cell_index)),
          can_attack: u.can_attack, // Use actual game value (heroes can attack too)
          skills: Array.isArray(u.skills) ? u.skills : undefined,
          role: isHeroUnit ? 'hero' : 'unit',
          is_hero: isHeroUnit,
        }
      };
      const handBase = Array.isArray(youRaw.hand) ? youRaw.hand.map((c: any) => ({
        card_id: (c.card_id ?? c.id),
        zone: 'hand',
        kind: 'card',
        name: c.name,
        mana_cost: c.mana_cost ?? c.cost,
        type: c.type,
      })) : [];
      const srcSelfUnits = orient === 'as_is' ? (snapshot?.self_units || []) : (snapshot?.enemy_units || []);
      const srcEnemyUnits = orient === 'as_is' ? (snapshot?.enemy_units || []) : (snapshot?.self_units || []);
      const selfUnitsBase = Array.isArray(srcSelfUnits) ? srcSelfUnits.map((u: any) => normUnit(u, 'self')) : [];
      const enemyUnitsBase = Array.isArray(srcEnemyUnits) ? srcEnemyUnits.map((u: any) => normUnit(u, 'enemy')) : [];

      // Deterministic labels for duplicates: Name#1, Name#2 (per list)
      const labelize = (arr:any[], nameKey:string, labelKey:string) => {
        const cnt: Record<string, number> = {}
        return (arr||[]).map(it=>{
          const n = String(it?.[nameKey]||'')
          const k = n.toLowerCase()
          if (it?.role === 'hero') {
            return {...it, [labelKey]: n ? `${n}#Hero` : 'Hero'}
          }
          const i = (cnt[k]||0) + 1; cnt[k] = i
          return {...it, [labelKey]: n ? `${n}#${i}` : undefined}
        })
      }
      const hand = labelize(handBase, 'name', 'label')
      let selfUnits = labelize(selfUnitsBase, 'name', 'label')
      const enemyUnits = labelize(enemyUnitsBase, 'name', 'label')
      // 英雄位置信息
      const yourHeroPos = Number.isFinite(yourHeroIdx) ? toRC(yourHeroIdx) : null;
      const enemyHeroPos = Number.isFinite(enemyHeroIdx) ? toRC(enemyHeroIdx) : null;
      
      const obs = {
        turn: snapshot?.turn,
        board: { width: W },
        you: { 
          mana: (youRaw.mana ?? youRaw.energy), 
          hero_hp: (youRaw.health ?? youRaw.hp),
          hero_position: fmtRC(yourHeroPos),
          hero_cell_index: Number.isFinite(yourHeroIdx) ? yourHeroIdx : undefined,
          hand 
        },
        opponent: { 
          hero_hp: (enemyRaw.health ?? enemyRaw.hp),
          hero_position: fmtRC(enemyHeroPos),
          hero_cell_index: Number.isFinite(enemyHeroIdx) ? enemyHeroIdx : undefined,
        },
        self_units: selfUnits,
        enemy_units: enemyUnits,
      } as any;
      // Attach compact placement geometry for playable cards to improve spatial understanding
      try {
        const byCard: any = {};
        const keys = Object.keys(placesByCard || {});
        for (const k of keys) {
          const cid = Number(k);
          const list = (placesByCard as any)[k] as any[];
          if (!Array.isArray(list) || list.length === 0) continue;
          // Prefer forward/ahead positions; stable sort by ahead_score desc then lane then region
          const ranked = list.slice().sort((a,b)=> {
            const as = Number(a?.ahead_score)||0, bs = Number(b?.ahead_score)||0;
            if (bs !== as) return bs - as;
            const laneRank = (x:any)=> ({'far_left':-2,'left':-1,'center':0,'right':1,'far_right':2}[String(x?.lane)||'center'] || 0);
            const ar = laneRank(a), br = laneRank(b);
            if (br !== ar) return br - ar;
            const regRank = (x:any)=> ({'frontline':2,'mid':1,'backline':0}[String(x?.region)||'mid'] || 0);
            return regRank(b) - regRank(a);
          }).slice(0, 6);
          byCard[cid] = ranked.map(p => ({ pos: p?.pos, u: p?.u, v: p?.v, ahead: !!p?.ahead, lane: p?.lane, region: p?.region, bearing: p?.bearing_oct }));
        }
        if (Object.keys(byCard).length) (obs as any).places_by_card = byCard;
      } catch {}
      try {
        if (this.#lastTacticalPreview && Array.isArray(this.#lastTacticalPreview) && this.#lastTacticalPreview.length) {
          const top = this.#lastTacticalPreview.slice(0, 24);
          obs.tactical_preview = top;
        }
      } catch {}
      // Recompute can_attack from available actions
      try {
        const attackerIds = new Set((Array.isArray(this.#lastActions)? this.#lastActions : []).filter(a=>a?.unit_attack).map((a:any)=> Number(a.unit_attack.attacker_unit_id)).filter(Number.isFinite))
        if (Array.isArray(obs.self_units)) {
          obs.self_units = obs.self_units.map((u:any)=> ({...u, can_attack: attackerIds.has(Number(u?.unit_id))}))
        }
      } catch {}
      // Summarize move→attack opportunities for intent + threat map and lanes
      try {
        const preview = (obs as any).tactical_preview
        if (Array.isArray(preview) && preview.length > 0) {
          const moveAttackOpps = preview
            .filter((p:any) => Array.isArray(p?.attacks) && p.attacks.length > 0)
            .slice(0, 6)
            .map((p:any) => {
              try {
                const unitName = this.#findUnitNameById(snapshot, p.unit_id)
                const targets = (p.attacks || []).slice(0, 2).map((a:any) => {
                  const tgtName = this.#findUnitNameById(snapshot, a.target_unit_id)
                  return tgtName || 'Hero'
                }).filter(Boolean)
                return unitName && targets.length > 0 ? {unit: unitName, can_attack: targets} : null
              } catch { return null }
            })
            .filter(Boolean)
          if (moveAttackOpps.length > 0) {
            ;(obs as any).move_attack_opportunities = moveAttackOpps
          }
        }
      } catch {}
      // Build simple threat map and lane pressure
      try {
        const width = Number((obs as any)?.board?.width || 9)
        const W = Math.max(1, width)
        const rows = new Array(Math.max(1, Math.ceil((Math.max(0, ...[(obs as any)?.self_units||[], (obs as any)?.enemy_units||[]].flat().map((u:any)=> Math.floor((u?.cell_index||0)/W)))) + 1))).fill(0).map(()=> ({self:0, enemy:0}))
        for (const u of ((obs as any).self_units||[])) { if (Number.isFinite(u?.cell_index)) { const r = Math.floor(u.cell_index/W); rows[r] = rows[r]||{self:0,enemy:0}; rows[r].self += (u.atk||1) } }
        for (const u of ((obs as any).enemy_units||[])) { if (Number.isFinite(u?.cell_index)) { const r = Math.floor(u.cell_index/W); rows[r] = rows[r]||{self:0,enemy:0}; rows[r].enemy += (u.atk||1) } }
        const lanePressure = { left: 0, center: 0, right: 0 }
        for (const u of ((obs as any).self_units||[])) {
          const col = Number.isFinite(u?.col) ? u.col : (Number.isFinite(u?.cell_index) ? (u.cell_index % W) : null)
          if (col == null) continue
          if (col < Math.floor(W/3)) lanePressure.left += (u.atk||1)
          else if (col > Math.floor(2*W/3)) lanePressure.right += (u.atk||1)
          else lanePressure.center += (u.atk||1)
        }
        ;(obs as any).threat_map = rows.map((r:any,i:number)=> ({row:i, self:r.self, enemy:r.enemy}))
        ;(obs as any).lane_pressure = lanePressure
      } catch {}
      return obs;
    } catch { return { turn: snapshot?.turn }; }
  }

  #buildActionsForPrompt(actions: any[]) {
    try {
      const keep: any[] = [];
      const lim = Math.min(120, Array.isArray(actions) ? actions.length : 0);
      for (let i=0;i<lim;i++) {
        const a = actions[i]; if (!a) continue;
        if (a.play_card) keep.push({ type: 'play_card', card_id: a.play_card.card_id, cell_index: a.play_card.cell_index });
        else if (a.move_unit) keep.push({ type: 'move', unit_id: a.move_unit.unit_id, to_cell_index: a.move_unit.to_cell_index });
        else if (a.unit_attack) keep.push({ type: 'unit_attack', attacker_unit_id: a.unit_attack.attacker_unit_id, target_unit_id: a.unit_attack.target_unit_id });
        else if (a.hero_power) keep.push({ type: 'hero_power', cell_index: (a.hero_power.cell_index ?? undefined) });
        else if (a.end_turn) keep.push({ type: 'end_turn' });
      }
      return keep;
    } catch { return []; }
  }

  #compileIntentToActionId(intent: any, actions: any[], snapshot: any) {
      if (!intent || typeof intent !== 'object') return {id: null, error: 'no intent'};
    if (intent.turn_plan) {
      const result = this.#compileTurnPlanToIds(intent.turn_plan, actions, snapshot);
      if (result.ids.length) return {id: result.ids[0]};
      return {id: null, error: result.error || 'turn_plan_unresolved'};
    }
    if (intent.action && typeof intent.action === 'object') {
      const result = this.#compileTurnPlanToIds({steps: [intent.action]}, actions, snapshot);
      if (result.ids.length) return {id: result.ids[0]};
      return {id: null, error: result.error || 'action_unresolved'};
    }
    return {id: null, error: 'no action field'};
  }

  #compileTurnPlanToIds(plan: any, actions: any[], snapshot: any): {ids: number[]; error?: string} {
    try {
      if (!plan || !Array.isArray(plan.steps)) return {ids: [], error: 'no steps'};
      const ids: number[] = [];
      const by = (pred:(a:any)=>boolean)=> actions.find(pred)?.id ?? null;
      const W = Number(snapshot?.board?.width ?? snapshot?.board?.W ?? snapshot?.W ?? 9);
      const toCellFromRC = (rc:any) => {
        try { const r = Number(rc?.row), c = Number(rc?.col); if (!Number.isFinite(r) || !Number.isFinite(c)) return null; return (r * W) + c; } catch { return null; }
      };
      const parseRxc = (s:any) => { try { const t = String(s||''); const m = /^r(\d+)c(\d+)$/i.exec(t); if (!m) return null; return {row:Number(m[1]), col:Number(m[2])}; } catch { return null; } };
      const resolveCell = (obj:any) => {
        if (!obj) return null;
        if (obj.cell_index != null) { const n = Number(obj.cell_index); return Number.isFinite(n) ? n : null; }
        const cand = obj.to ?? obj.target ?? null;
        if (cand == null) return null;
        if (typeof cand === 'string') { const rc = parseRxc(cand); return rc ? toCellFromRC(rc) : null; }
        if (typeof cand === 'object') {
          if ((cand as any).cell_index != null) { const n = Number((cand as any).cell_index); return Number.isFinite(n) ? n : null; }
          const rc = parseRxc((cand as any).pos) || {row: (cand as any).row, col: (cand as any).col};
          return toCellFromRC(rc);
        }
        return null;
      };
      for (const step of plan.steps) {
        if (!step || typeof step !== 'object') continue;
        const t = String(step.type||'').toLowerCase();
        switch (t) {
          case 'play_card': {
            const cid = Number(step.card_id);
            const cell = resolveCell(step.to || step);
            if (Number.isFinite(cid) && Number.isFinite(cell)) {
              const m = by(a => a?.play_card && a.play_card.card_id === cid && a.play_card.cell_index === cell);
              if (m != null) ids.push(m);
            }
            break;
          }
          case 'move_then_attack': {
            const uid = Number((step as any).unit_id);
            const cell = resolveCell((step as any).to || step);
            if (Number.isFinite(uid) && Number.isFinite(cell)) {
              const mMove = by(a => a?.move_unit && a.move_unit.unit_id === uid && a.move_unit.to_cell_index === cell);
              if (mMove != null) ids.push(mMove);
              const tgt = Number((step as any).target_unit_id);
              let mAtk = null as number | null;
              if (Number.isFinite(tgt)) {
                mAtk = by(a => a?.unit_attack && a.unit_attack.attacker_unit_id === uid && a.unit_attack.target_unit_id === tgt);
              } else {
                mAtk = by(a => a?.unit_attack && a.unit_attack.attacker_unit_id === uid);
              }
              if (mAtk != null) ids.push(mAtk);
            }
            break;
          }
          case 'move': {
            const uid = Number(step.unit_id);
            const cell = resolveCell(step.to || step);
            if (Number.isFinite(uid) && Number.isFinite(cell)) {
              const m = by(a => a?.move_unit && a.move_unit.unit_id === uid && a.move_unit.to_cell_index === cell);
              if (m != null) ids.push(m);
            }
            break;
          }
          case 'unit_attack': {
            const att = Number(step.attacker_unit_id);
            const tgt = Number(step.target_unit_id);
            const m = by(a => a?.unit_attack && a.unit_attack.attacker_unit_id === att && a.unit_attack.target_unit_id === tgt);
            if (m != null) ids.push(m);
            break;
          }
          case 'hero_power': {
            const cell = resolveCell(step);
            let m = null as number | null;
            if (cell != null) m = by(a => a?.hero_power && a.hero_power.cell_index === cell);
            if (m == null) m = by(a => a?.hero_power);
            if (m != null) ids.push(m);
            break;
          }
          case 'end_turn': {
            const m = by(a => a?.end_turn);
            if (m != null) ids.push(m);
            break;
          }
        }
      }
      if (plan.auto_end) {
        const hasEnd = ids.some(id => {
          const a = actions.find(x => x && x.id === id);
          return a && a.end_turn;
        });
        if (!hasEnd) {
          const end = actions.find(a => a && a.end_turn);
          if (end) ids.push(end.id);
        }
      }
      return {ids};
    } catch (e:any) {
      return {ids: [], error: String(e?.message || e)};
    }
  }

  #tryHandleTurnPlan(intent: any, snapshot: any, actions: any[]) {
    try {
      const plan = intent?.turn_plan;
      if (!plan || !Array.isArray(plan.steps)) return false;
      if (this.#batchInflight) { try { console.log('[agent] batch skipped: inflight'); } catch {} return true; }
      // If we already queued local steps, merge
      try { if (this.#turnPlanSteps.length) { plan.steps = [...this.#turnPlanSteps, ...plan.steps] } } catch {}
      const reqId = randomUUID();
      // Augment: convert simple move into move_then_attack if preview shows a target
      const augmentedSteps = this.#augmentPlanWithMoveThenAttack(Array.isArray(plan.steps) ? plan.steps : [], snapshot);
      const withUids = this.#attachUidsToSteps(augmentedSteps, snapshot)
      const planPayload = { atomic: false, auto_end: !!plan.auto_end, steps: withUids };
      try { console.log('[agent] 🚚 turn_plan submit', {orig: (plan.steps||[]).length, augmented: (augmentedSteps||[]).length}); } catch {}
      this.#send({type: 'turn_plan', turn_plan: planPayload, req_id: reqId});
      this.#batchInflight = {reqId, ts: Date.now()};
      this.#broadcast('decision_log', {plan: planPayload, info: 'turn_plan submitted (bridge)'});
      this.#turnPlanSteps = []
      return true;
    } catch { return false; }
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

  #buildKnowledgeSnippet(snapshot: any, actions: any[]) {
    return buildKnowledgeSnippet(this.#cfg, snapshot, actions, parseKeyedLines, collectRelatedCardNotes);
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

  #attackNameWeight(name: string | null | undefined) {
    try {
      const n = String(name||'').toLowerCase()
      if (!n) return 0
      if (n.includes('cinda')) return 6
      if (n.includes('ash')) return 5
      if (n.includes('archer') || n.includes('crossbow')) return 4
      if (n.includes('halberd')) return 3
      if (n.includes('mage') || n.includes('ranged')) return 3
      return 1
    } catch { return 0 }
  }

  #computeAttackScore(act: any) {
    try {
      if (!act || !act.unit_attack) return -1
      const attacker = (act as any).attacker || (act as any).unit_attack?.attacker || null
      const target = (act as any).target || (act as any).unit_attack?.target || null
      const atk = Number(attacker?.atk)
      const thp = Number(target?.hp)
      const kill = Number.isFinite(atk) && Number.isFinite(thp) && atk >= thp
      let s = 0
      if (kill) s += 10
      s += this.#attackNameWeight(target?.name)
      // prefer higher attacker atk as tie-breaker
      if (Number.isFinite(atk)) s += Math.min(3, Math.max(0, Math.floor(atk/2)))
      // prefer lower target hp (easier to finish)
      if (Number.isFinite(thp)) s += Math.max(0, 3 - Math.min(3, Math.floor(thp/4)))
      return s
    } catch { return 0 }
  }

  #maybeImmediateAttack(actions: any[]): boolean {
    try {
      if (this.#cfg.alwaysCallLLMOnOwnTurn && this.#isMyTurnStrict()) return false;
      // If config requires LLM-approved target, skip local immediate attacks
      if (this.#cfg.requireLLMTargetForAttack) return false;
      const cands = (actions||[]).filter((a:any)=> a?.unit_attack)
      if (cands && cands.length) {
        let best:any = null; let bestScore = -1
        for (const a of cands) {
          const sc = this.#computeAttackScore(a)
          if (sc > bestScore) { bestScore = sc; best = a }
        }
        if (best && Number.isFinite(Number(best.id))) {
          // Prefer batching via turn_plan to satisfy bridges that require batch-per-turn
          try {
            const step = this.#toStep(best)
            if (step) {
              this.#turnPlanSteps.push(step)
              try { console.log('[agent] ⚔️  batching immediate attack via turn_plan', {id: Number(best.id), step}) } catch {}
              this.#flushPlan('immediate_attack')
              return true
            }
          } catch {}
          // Fallback to immediate if batching failed
          try { console.log('[agent] ⚔️  immediate attack select (fallback)', {id: Number(best.id)}) } catch {}
          this.#sendImmediateActionId(Number(best.id))
          return true
        }
      }
      return false
    } catch { return false }
  }

  #maybeAutoMoveThenAttack(actions: any[], snapshot: any): boolean {
    try {
      if (this.#cfg.alwaysCallLLMOnOwnTurn && this.#isMyTurnStrict()) return false;
      // If config requires LLM-approved target, allow only when preview provides explicit target
      const requireLLM = !!this.#cfg.requireLLMTargetForAttack;
      // 使用 tactical_preview，若发现任意“移动→攻击”机会，则优先执行该移动
      const preview = this.#lastTacticalPreview || (snapshot && (snapshot as any).tactical_preview) || []
      if (!Array.isArray(preview) || !preview.length) return false
      // 同时兼容两种结构：
      // 1) 原始结构：[{ unit_id, to_cell_index, id_move, attacks:[{target_unit_id,target_name,target_hp,attacker_atk,id_attack?}] }]
      // 2) 扁平结构（combos）：[{ unit_id, to_cell_index, id_move, id_attack, target_unit_id, ... }]
      const scoreCombo = (entry:any) => {
        let s = 0
        const tname = entry?.target_name || this.#findUnitNameById(snapshot, entry?.target_unit_id) || ''
        s += this.#attackNameWeight(tname)
        const att = Number(entry?.attacker_atk)
        const thp = Number(entry?.target_hp)
        const kill = (entry?.kill === true) || (Number.isFinite(att) && Number.isFinite(thp) && att >= thp)
        if (kill) s += 10
        return s
      }
      // 展开成统一的候选列表
      const flat: any[] = []
      for (const p of preview) {
        const idMove = Number((p as any)?.id_move)
        const unitId = Number((p as any)?.unit_id)
        const toCell = Number((p as any)?.to_cell_index)
        if (!Number.isFinite(unitId) || !Number.isFinite(toCell)) continue
        if (Array.isArray((p as any)?.attacks) && (p as any).attacks.length > 0) {
          for (const a of (p as any).attacks) {
            flat.push({ unit_id: unitId, to_cell_index: toCell, id_move: idMove, id_attack: Number((a as any)?.id_attack), target_unit_id: Number((a as any)?.target_unit_id), target_name: (a as any)?.target_name, target_hp: Number((a as any)?.target_hp), attacker_atk: Number((a as any)?.attacker_atk), kill: (a as any)?.kill === true })
          }
        } else if (Number.isFinite(Number((p as any)?.id_attack))) {
          flat.push({ unit_id: unitId, to_cell_index: toCell, id_move: idMove, id_attack: Number((p as any)?.id_attack), target_unit_id: Number((p as any)?.target_unit_id), target_name: (p as any)?.target_name, target_hp: Number((p as any)?.target_hp), attacker_atk: Number((p as any)?.attacker_atk), kill: (p as any)?.kill === true })
        }
      }
      if (!flat.length) return false
      flat.sort((a:any,b:any)=> scoreCombo(b)-scoreCombo(a))
      for (const it of flat) {
        // 英雄移动除非能攻击，否则不移动
        if (Number(it.unit_id) === 0 && !Number.isFinite(Number(it.id_attack))) continue
        const mv = (actions||[]).find((a:any)=> a?.move_unit && Number(a.move_unit.unit_id)===Number(it.unit_id) && Number(a.move_unit.to_cell_index)===Number(it.to_cell_index))
        if (!mv || !Number.isFinite(Number(mv.id))) continue
        try {
          const key = `${it.unit_id}->${it.to_cell_index}`
          if (this.#moveSentThisTurn.has(key)) continue
          this.#moveSentThisTurn.add(key)
        } catch {}
        // Prefer batching as a mini plan: move_then_attack when target known; else move only (if LLM target not required)
        try {
          const unitId = Number(it.unit_id)
          const toCell = Number(it.to_cell_index)
          const tgtId = Number.isFinite(Number(it.target_unit_id)) ? Number(it.target_unit_id) : null
          if (Number.isFinite(unitId) && Number.isFinite(toCell)) {
            if (requireLLM && tgtId == null) continue
            const step = tgtId != null
              ? { type: 'move_then_attack', unit_id: unitId, to: { cell_index: toCell }, target_unit_id: tgtId }
              : { type: 'move', unit_id: unitId, to: { cell_index: toCell } }
            this.#turnPlanSteps.push(step as any)
            try { console.log('[agent] 🧭 auto move→attack plan', {unitId, toCell, tgtId, step}) } catch {}
            this.#flushPlan('auto_move_then_attack')
            return true
          }
        } catch {}
        // Fallback: immediate select then chain (skip when LLM target required and no target)
        if (requireLLM && !Number.isFinite(Number(it.id_attack))) continue
        try { console.log('[agent] 🧭 fallback immediate move select; will chain', {mv: Number(mv.id), unit: Number(it.unit_id), to: Number(it.to_cell_index), id_attack: Number(it.id_attack), tgt: Number(it.target_unit_id)}) } catch {}
        this.#sendImmediateActionId(Number(mv.id))
        const attackId = Number.isFinite(Number(it.id_attack)) ? Number(it.id_attack) : null
        const tgtPref = Number.isFinite(Number(it.target_unit_id)) ? Number(it.target_unit_id) : null
        this.#chainQueue.push({attacker: Number(it.unit_id), preferredTarget: tgtPref, moveId: Number(mv.id), attackId: attackId, gen: this.#actionsGen, queuedAt: Date.now(), tries: 0})
        return true
      }
      return false
    } catch { return false }
  }

  #findActionDescById(id: any) {
    try {
      const n = Number(id); if (!Number.isFinite(n)) return undefined;
      const a = (this.#lastActions||[]).find((x:any)=>x&&x.id===n);
      return a ? this.#serializeAction(a) : undefined;
    } catch { return undefined; }
  }

  /**
   * 🎯 NEW: Intent-Driven Decision (Phase 2)
   * LLM only outputs high-level intents, Unity intelligently executes
   */
  async #decideIntentDriven(actions: any[], snapshot: any): Promise<DecisionResult | null> {
    try {
      // Import intent translator (dynamic to avoid circular deps)
      const { translateIntentPlan } = await import('./agent/intent-translator.js');
      const { buildIntentPrompt } = await import('./agent/prompts.js');

      // Build simplified observation (no detailed coordinates)
      const obs = this.#buildIntentObservation(snapshot);

      // Call LLM for intent
      const prompt = buildIntentPrompt(obs);
      const t0 = Date.now()
      const res = await callDispatcher(this.#cfg, prompt);
      try {
        const elapsed = Date.now() - t0
        const sessId = String((this as any)._sessionId || 'default')
        this.#db.addLLMCall({
          sessionId: sessId,
          turn: Number(snapshot?.turn),
          phase: 'intent_driven',
          provider: this.#cfg.provider,
          model: this.#cfg.model,
          request: prompt,
          response: res?.data,
          elapsedMs: elapsed,
        })
      } catch {}
      const text = extractText(res.data);

      try {
        const cyan = '\x1b[36m', reset = '\x1b[0m';
        console.log(`${cyan}[LLM][intent_driven] response:${reset}`, text);
      } catch {}

      // Parse intent JSON
      let intentPlan: any = null;
      try {
        intentPlan = parseIntentObject(text);
      } catch {
        console.warn('[agent] Failed to parse intent JSON');
        return { mode: 'intent_driven', actionId: null, reason: 'parse_error' };
      }

      if (!intentPlan || !Array.isArray(intentPlan.steps)) {
        console.warn('[agent] Invalid intent plan structure');
        return { mode: 'intent_driven', actionId: null, reason: 'invalid_structure' };
      }

      // Translate intents to concrete turn_plan
      const turnPlan = translateIntentPlan(intentPlan, snapshot, actions);

      if (!turnPlan.steps || turnPlan.steps.length === 0) {
        console.warn('[agent] Intent translation produced no steps');
        return { mode: 'intent_driven', actionId: null, reason: 'no_steps' };
      }

      // Send turn_plan to Unity
      try {
        const reqId = randomUUID();
        const payload = {
          atomic: turnPlan.atomic,
          auto_end: turnPlan.auto_end,
          steps: turnPlan.steps
        };

        this.#send({ type: 'turn_plan', turn_plan: payload, req_id: reqId });
        this.#batchInflight = { reqId, ts: Date.now() };

        const green = '\x1b[32m', reset = '\x1b[0m';
        console.log(`${green}[agent] Intent-driven plan submitted:${reset}`, {
          analysis: intentPlan.analysis,
          steps: turnPlan.steps.length
        });

        this.#broadcast('decision_log', {
          mode: 'intent_driven',
          plan: payload,
          analysis: intentPlan.analysis,
          info: 'turn_plan submitted'
        });

        return {
          mode: 'intent_driven',
          actionId: null,
          reason: 'intent_plan_submitted',
          deferExecution: true,
          metadata: { intentPlan, turnPlan }
        };
      } catch (e) {
        console.error('[agent] Failed to send intent plan:', e);
        return { mode: 'intent_driven', actionId: null, reason: 'send_error' };
      }
    } catch (e) {
      console.error('[agent] decideIntentDriven error:', e);
      return { mode: 'intent_driven', actionId: null, reason: 'exception' };
    }
  }

  /**
   * Build simplified observation for intent-driven mode
   */
  #buildIntentObservation(snapshot: any): any {
    try {
      const obs = this.#buildObservation(snapshot);
      
      // Simplify: remove detailed coordinates, keep only strategic info
      const simplified = {
        turn: obs?.turn,
        you: {
          hero_hp: obs?.you?.hero_hp,
          mana: obs?.you?.mana,
          hand: (obs?.you?.hand || []).map((c: any) => ({
            name: c.label || c.name,
            cost: c.mana_cost || c.cost
          }))
        },
        opponent: {
          hero_hp: obs?.opponent?.hero_hp
        },
        self_units: (obs?.self_units || []).map((u: any) => ({
          name: u.label || u.name,
          hp: u.hp,
          atk: u.atk,
          can_attack: u.can_attack,
          position: u.pos
        })),
        enemy_units: (obs?.enemy_units || []).map((u: any) => ({
          name: u.label || u.name,
          hp: u.hp,
          atk: u.atk,
          position: u.pos
        })),
        // Include move-attack opportunities (summary only)
        move_attack_opportunities: obs?.move_attack_opportunities || []
      };

      return simplified;
    } catch {
      return snapshot;
    }
  }

  async #decideHierarchical(actions: any[], snapshot: any): Promise<DecisionResult | null> {
    try {
      // 🔧 双重检查：确保是己方回合
      if (!this.#isMyTurnStrict(snapshot)) {
        console.log('[agent] decideHierarchical aborted: not my turn')
        return null
      }
      
      const requireRefresh = this.#shouldRefreshPolicyPlan(snapshot)
      let plan = this.#policyState.plan
      if (!plan || requireRefresh) {
      const observation = this.#buildPolicyObservation(snapshot)
      
      // 🔧 关键修复：根据游戏实际提供的攻击动作，修正 can_attack 状态
      try {
        const attackerIds = new Set(actions.filter(a=>a?.unit_attack).map(a=>Number(a.unit_attack.attacker_unit_id)))
        if (observation?.self_units) {
          observation.self_units = observation.self_units.map((u:any) => ({
            ...u,
            can_attack: attackerIds.has(Number(u?.unit_id)) // 只有游戏提供了攻击动作的单位才标记为 can_attack
          }))
        }
      } catch {}
      
      // 诊断：显示 LLM 看到的单位
      try {
        const selfUnits = (observation?.self_units || []).map((u:any) => u?.label || u?.name).filter(Boolean)
        const canAttackUnits = (observation?.self_units || []).filter((u:any)=>u?.can_attack).map((u:any) => u?.label || u?.name).filter(Boolean)
        const hasAtkActs = Array.isArray(actions) && actions.some((a:any)=>a?.unit_attack)
        const mvActs = Array.isArray(actions) ? actions.filter((a:any)=>a?.move_unit).length : 0
        console.log(`[agent] 🔍 LLM sees self units: ${selfUnits.join(', ') || 'none'}`)
        console.log(`[agent] ⚔️  Units that CAN attack: ${canAttackUnits.join(', ') || 'NONE'} | attack_actions=${hasAtkActs? 'YES':'NO'} move_actions=${mvActs}`)
      } catch {}
      const intentPrompt = buildPolicyPrompt(observation, snapshot, this.#cfg, v => this.#clampTemp(v))
      try {
        // Extra safety: don't dispatch if not our turn at send-time
        if (!(((this as any)._isMyTurnOverride === true) ? true : this.#isMyTurnStrict(snapshot))) {
          return {mode:'hierarchical', actionId:null, reason:'not_my_turn_suppress'}
        }
        const res = await callDispatcher(this.#cfg, intentPrompt);
        const text = extractText(res.data)
        plan = parseIntentObject(text)
        this.#lastPolicyPlan = plan
        try { const magenta='\x1b[35m',reset='\x1b[0m'; console.log(`${magenta}[LLM][hier_policy] text:${reset}`, text) } catch {}
          this.#loadPolicySteps(plan)
          this.#policyState.plan = plan
        this.#broadcast('llm_io', {turn: snapshot?.turn, phase: 'hier_policy', raw: text})
      } catch (e:any) {
          this.#policyState.lastOutcome = {kind:'failure', ts: Date.now(), detail: {stage:'policy', error: String(e?.message||'dispatcher_failed')}}
        try { this.#broadcast('llm_io', {turn: snapshot?.turn, phase: 'hier_policy', raw: JSON.stringify({analysis:'(policy error)', steps:[], error: String(e?.message||'dispatcher_failed')})}) } catch {}
      }
      if (!plan) {
        try { this.#broadcast('llm_io', {turn: snapshot?.turn, phase: 'hier_policy', raw: JSON.stringify({analysis:'(no policy)', steps:[]})}) } catch {}
        }
      }

      // NEW: Try to batch-execute all pending steps
      if (this.#isMyTurnStrict(snapshot)) {
        try {
          const stepsCount = Array.isArray(this.#policyState.steps) ? this.#policyState.steps.length : 0
          const planStepsCount = Array.isArray(plan?.steps) ? plan.steps.length : 0
          console.log(`[agent] 🔍 Batch exec prep: policyState.steps=${stepsCount}, plan.steps=${planStepsCount}`)
          if (stepsCount > 0) {
            console.log(`[agent] 🔍 Policy steps:`, this.#policyState.steps.map((s:any,i:number)=>`${i}:${s?.type}(${s?.meta?.status})`))
          }
        } catch {}
      }
      // EARLY: if no attack actions in available_actions but tactical preview shows move→attack chances, queue a best move→attack first
      try {
        const hasAtkActs = Array.isArray(actions) && actions.some((a:any)=>a?.unit_attack)
        const preview = this.#lastTacticalPreview || (this.#lastSnapshot && (this.#lastSnapshot as any).tactical_preview) || []
        if (!hasAtkActs && Array.isArray(preview)) {
          // choose the first opportunity that targets a high-threat enemy like Cinda/Ash/Hero
          const priority = ['cinda','ash','hero']
          let pick: any = null
          for (const p of preview) {
            const atks = Array.isArray(p?.attacks) ? p.attacks : []
            const target = atks.find((x:any)=> priority.some(k=> String((this.#findUnitNameById(snapshot, x?.target_unit_id)||'')).toLowerCase().includes(k))) || atks[0]
            if (target) { pick = {uid: p.unit_id, to: p.to_cell_index, tgt: target.target_unit_id}; break }
          }
          if (pick) {
            const mv = (actions||[]).find((a:any)=> a?.move_unit && Number(a.move_unit.unit_id)===Number(pick.uid) && Number(a.move_unit.to_cell_index)===Number(pick.to))
            if (mv) {
              this.#sendAction(mv.id)
              // Queue preferred chained attack and flush move only
              this.#chainQueue.push({attacker: Number(pick.uid), preferredTarget: Number.isFinite(Number(pick.tgt)) ? Number(pick.tgt) : null})
              this.#flushPlan('early_move')
              return {mode:'hierarchical', actionId: null, reason:'early_move', nextStep:null, deferExecution:true}
            }
          }
        }
      } catch {}

      const batchResult = executePolicyPlanBatch({
        plan,
        actions,
        snapshot,
        policyState: this.#policyState,
        lastTacticalPreview: this.#lastTacticalPreview,
        sendAction: (id:number)=> this.#sendAction(id),
        log: (...args:any[])=> { try { console.log(...args) } catch {} },
      })
      if (batchResult && batchResult.stepsQueued > 0) {
        if (this.#isMyTurnStrict(snapshot)) {
          console.log(`[agent] 🎯 Batch execution: ${batchResult.stepsQueued} steps queued, flushing turn_plan`)
        }
        this.#flushPlan('policy_batch')
        return {
          mode: 'hierarchical',
          actionId: null,
          reason: 'policy_batch_executed',
          nextStep: null,
          deferExecution: true,
          metadata: {stepsQueued: batchResult.stepsQueued}
        }
      }

      // Fallback: single-step execution (for backward compatibility)
      const execution = executePolicyPlanSingle({
        plan,
        actions,
        snapshot,
        policyState: this.#policyState,
        lastTacticalPreview: this.#lastTacticalPreview,
        buildObservation: (snap:any)=> this.#buildObservation(snap),
        broadcast: (channel:string, payload:any)=> { try { this.#broadcast(channel, payload) } catch {} },
        markStepByAction: (id:number, raw?:any)=> this.#markStepByAction(id, raw),
        selectSafeAction: selectSafeAction as SelectSafeActionFn,
        toStep: toStep,
        log: (...args:any[])=> { try { console.log(...args) } catch {} },
      })
      if (execution && execution.actionId != null) {
        return {
          mode: 'hierarchical',
          actionId: execution.actionId,
          reason: execution.reason,
          nextStep: execution.step,
          metadata: execution.metadata,
        }
      }
      if (execution && execution.defer) {
        return {
          mode: 'hierarchical',
          actionId: null,
          reason: execution.reason,
          nextStep: execution.step,
          deferExecution: true,
          metadata: execution.metadata,
        }
      }

      const fb = selectSafeAction(actions, snapshot, this.#lastTacticalPreview)
      if (fb != null) {
        return {mode:'hierarchical', actionId: fb, reason:'safe_fallback', nextStep: null}
      }
      // Proactive advance when no attack/plan: choose best forward move
      const adv = this.#chooseProactiveAdvanceMove(actions, snapshot)
      if (adv != null) {
        return {mode:'hierarchical', actionId: adv, reason:'proactive_advance', nextStep: null}
      }
      return {mode:'hierarchical', actionId: null, reason:'no_action'}
    } catch (e) {
      return {mode:'hierarchical', actionId: selectSafeAction(actions, snapshot, this.#lastTacticalPreview), reason:'hierarchical_exception'}
    }
  }

  #toStep(a: any): any | null {
    try {
      if (!a) return null
      if (a?.play_card) return {type:'play_card', card_id: a.play_card.card_id, to:{cell_index: a.play_card.cell_index}}
      if (a?.move_unit) return {type:'move', unit_id: a.move_unit.unit_id, to:{cell_index: a.move_unit.to_cell_index}}
      if (a?.unit_attack) return {type:'unit_attack', attacker_unit_id: a.unit_attack.attacker_unit_id, target_unit_id: a.unit_attack.target_unit_id}
      if (a?.hero_power) return {type:'hero_power'}
      if (a?.end_turn) return {type:'end_turn'}
      return null
    } catch { return null }
  }

  #choosePlayFromPolicy(plan:any, actions:any[], snapshot:any): number | null { return choosePlayFromPolicy(plan, actions, snapshot) }

  #chooseMoveFromPolicy(plan:any, actions:any[], snapshot:any): number | null { return chooseMoveFromPolicy(plan, actions, snapshot, this.#lastTacticalPreview) }

  #moveEnablesAttack(a:any, snapshot:any) { return moveEnablesAttack(a, snapshot, this.#lastTacticalPreview) }

  #chooseAttackFromPolicy(plan:any, actions:any[]): number | null { return chooseAttackFromPolicy(plan, actions) }

  #deriveTargetPreferenceFromPolicy(plan:any) { return deriveTargetPreferenceFromPolicy(plan) }

  #pickAttackFromList(atks:any[], prefs:string[]) { return pickAttackFromList(atks, prefs) }

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

  #summarizeActionsForUI(actions: any[]) {
    try {
      const counts = this.#summarizeActions(actions) || {} as any;
      const byType: Record<string, any[]> = {play: [], attack: [], move: [], skill: [], power: [], end: []};
      for (const a of (actions||[])) {
        if (a?.end_turn) byType.end.push(a);
        else if (a?.play_card) byType.play.push(a);
        else if (a?.unit_attack) byType.attack.push(a);
        else if (a?.move_unit) byType.move.push(a);
        else if (a?.use_skill) byType.skill.push(a);
        else if (a?.hero_power) byType.power.push(a);
      }
      const top = (arr: any[], n: number) => arr.slice(0, Math.max(0, n));
      const playCards = top(byType.play.map(a => ({card_id: a.play_card?.card_id, cell_index: a.play_card?.cell_index, card_name: a.card_name, mana_cost: a.mana_cost})), 10);
      const moves = top(byType.move.map(a => ({unit_id: a.move_unit?.unit_id, to: a.move_unit?.to_cell_index})), 12);
      const attacks = top(byType.attack.map(a => ({attacker: a.unit_attack?.attacker_unit_id, target: a.unit_attack?.target_unit_id})), 12);
      try {
        const preview = (this.#lastSnapshot && (this.#lastSnapshot as any).tactical_preview) || this.#lastTacticalPreview || []
        const moveAttack = Array.isArray(preview) ? preview.filter((p:any)=> Array.isArray(p?.attacks) && p.attacks.length>0).slice(0,6).map((p:any)=>({unit_id:p.unit_id, to_cell_index:p.to_cell_index, targets:p.attacks.map((x:any)=>x.target_unit_id)})) : []
        return {counts, groups: {playCards, moves, attacks, moveAttack}}
      } catch {}
      const heroPower = byType.power.length;
      return {counts, groups: {playCards, moves, attacks, heroPower}};
    } catch { return {counts: null, groups: {}}; }
  }

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
    const single = parseActionId(text, actions);
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
      const phaseMap = this.#cfg.knowledge?.phase ? parseKeyedLines(this.#cfg.knowledge.phase) : {} as Record<string,string>;
      const cardMap = this.#cfg.knowledge?.cards ? parseKeyedLines(this.#cfg.knowledge.cards) : {} as Record<string,string>;
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
          const res = await callDispatcher(this.#cfg, v.payload);
          const fromTool = this.#parseToolChoiceFromResponse(res.data, actions);
          const text = fromTool == null ? extractText(res.data) : null;
          const actionId = fromTool != null ? fromTool : parseActionId(text, actions);
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
      (s as any).modePrefer = 'hierarchical';
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
        tools.push({
          type: 'function',
          function: {
            name: 'hero_power',
            description: 'Use hero power. If target cell required, provide it.',
            parameters: {
              type: 'object',
              properties: {
                cell_index: hasCells
                  ? { type: 'number', enum: cellsAll.filter((x:any) => x != null) }
                  : { type: 'number' }
              },
              required: hasCells ? ['cell_index'] : []
            }
          }
        });
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

  #clampTemp(val: number) {
    try { return this.#clamp(val, this.#cfg.minTemp ?? 0.1, this.#cfg.maxTemp ?? 0.7); } catch { return val; }
  }
  #clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)); }

  #buildPolicyObservation(snapshot:any) {
    try {
      const obs = this.#buildObservation(snapshot)
      // 保留移动攻击机会的摘要，而非完全删除 tactical_preview
      if (obs && typeof obs==='object') {
        const preview = (obs as any).tactical_preview
        if (Array.isArray(preview) && preview.length > 0) {
          // 转换为"移动→攻击"机会提示（仅摘要，不包含详细坐标）
          const moveAttackOpps = preview
            .filter((p:any) => Array.isArray(p?.attacks) && p.attacks.length > 0)
            .slice(0, 6) // 限制数量避免 token 过多
            .map((p:any) => {
              try {
                const unitName = this.#findUnitNameById(snapshot, p.unit_id)
                const targets = (p.attacks || []).slice(0, 2).map((a:any) => {
                  const tgtName = this.#findUnitNameById(snapshot, a.target_unit_id)
                  return tgtName || 'Hero'
                }).filter(Boolean)
                return unitName && targets.length > 0 ? {unit: unitName, can_attack: targets} : null
              } catch { return null }
            })
            .filter(Boolean)
          
          if (moveAttackOpps.length > 0) {
            ;(obs as any).move_attack_opportunities = moveAttackOpps
          }
        }
        delete (obs as any).tactical_preview // 删除详细的坐标数据
        // Attach simple advance_targets to guide proactive offense
        try {
          const W = Number((obs as any)?.board?.width || 9)
          const youIdx = Number((obs as any)?.you?.hero_cell_index)
          const enemyIdx = Number((obs as any)?.opponent?.hero_cell_index)
          const yourRow = Number.isFinite(youIdx) ? Math.floor(youIdx / W) : null
          const enemyRow = Number.isFinite(enemyIdx) ? Math.floor(enemyIdx / W) : null
          const forwardDir = (yourRow!=null && enemyRow!=null) ? Math.sign(enemyRow - yourRow) || 1 : 1
          const selfUnits = Array.isArray((obs as any)?.self_units) ? (obs as any).self_units : []
          const candidates = selfUnits.filter((u:any)=> u && u.role !== 'hero').map((u:any)=> ({unit: u.label || u.name, hint: forwardDir>0 ? 'forward' : 'back'})).slice(0, 3)
          if (candidates.length) (obs as any).advance_targets = candidates
        } catch {}
      }
      return obs
    } catch { return this.#buildObservation(snapshot) }
  }

  #findUnitNameById(snapshot:any, unitId:number): string | null {
    try {
      const allUnits = [
        ...(snapshot?.self_units || []),
        ...(snapshot?.enemy_units || [])
      ]
      const u = allUnits.find((x:any) => Number(x?.unit_id) === Number(unitId))
      return u?.label || u?.name || null
    } catch { return null }
  }

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

  #consumePolicyStep(step: PolicyStep | null, reason?: string) {
    try {
      if (!step || !step.meta) return;
      step.meta.status = 'queued';
      step.meta.updatedAt = Date.now();
      if (reason) step.meta.reason = reason;
      this.#policyState.lastOutcome = {kind: 'success', ts: Date.now(), detail: {reason}};
    } catch {}
  }

}

export function createAgentModule(...args: ConstructorParameters<typeof AgentModule>) {
  return new AgentModule(...args);
}

