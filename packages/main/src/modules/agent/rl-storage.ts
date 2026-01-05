/**
 * RL Storage - 强化学习数据持久化层
 * 
 * 功能：
 * 1. 存储转换（Transitions）到数据库
 * 2. 存储和加载 Q 表
 * 3. 存储对局摘要
 * 4. 支持增量加载和批量导出
 */

import { join } from 'node:path';
import { app } from 'electron';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import type { 
  Transition, 
  GameSummary, 
  PolicyEvaluation, 
  ActionType 
} from './reinforcement-learning.js';

// ==================== 类型定义 ====================

export interface RLStorageStats {
  transitionCount: number;
  gameCount: number;
  qTableSize: number;
  lastUpdated: number;
}

type QTableExport = Record<string, Partial<Record<ActionType, PolicyEvaluation>>>;

// ==================== 数据库加载 ====================

function loadDriver(): { kind: 'better' | 'raw'; Driver: any } | null {
  try {
    const req = createRequire(import.meta.url);
    try {
      const se = req('sqlite-electron');
      if (se && (se as any).Database) {
        return { kind: 'better', Driver: se };
      }
    } catch {}
    const mod = req('better-sqlite3');
    return { kind: 'raw', Driver: mod };
  } catch {
    return null;
  }
}

// ==================== RLStorage 类 ====================

export class RLStorage {
  private db: any = null;
  private jsonFile: string;
  private useJson: boolean = false;
  private jsonData: {
    transitions: Transition[];
    q_table: Record<string, Record<ActionType, PolicyEvaluation>>;
    game_summaries: GameSummary[];
    meta: Record<string, any>;
  } = {
    transitions: [],
    q_table: {},
    game_summaries: [],
    meta: {}
  };
  
  // Prepared statements
  private stmts: {
    insertTransition?: any;
    insertQValue?: any;
    insertGameSummary?: any;
    getTransitions?: any;
    getQTable?: any;
    getGameSummaries?: any;
    updateQValue?: any;
    getMeta?: any;
    setMeta?: any;
  } = {};
  
  constructor() {
    const userData = app.getPath('userData');
    const dbFile = join(userData, 'incarnation_rl.db');
    this.jsonFile = join(userData, 'incarnation_rl.json');
    
    const driverInfo = loadDriver();
    
    if (!driverInfo) {
      console.warn('[RLStorage] Using JSON fallback');
      this.useJson = true;
      this.loadJsonData();
      return;
    }
    
    try {
      this.db = driverInfo.kind === 'better' 
        ? new (driverInfo as any).Driver.Database(dbFile)
        : new (driverInfo as any).Driver(dbFile);
      
      this.db.pragma('journal_mode = WAL');
      this.initSchema();
      this.prepareStatements();
      console.log('[RLStorage] SQLite initialized at', dbFile);
    } catch (e) {
      console.warn('[RLStorage] SQLite init failed, using JSON:', e);
      this.useJson = true;
      this.loadJsonData();
    }
  }
  
  // ==================== Schema 初始化 ====================
  
  private initSchema(): void {
    this.db.exec(`
      -- 转换表
      CREATE TABLE IF NOT EXISTS rl_transitions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn INTEGER,
        timestamp INTEGER,
        state_json TEXT,
        action_json TEXT,
        next_state_json TEXT,
        reward REAL,
        immediate_reward REAL,
        strategic_reward REAL,
        terminal_reward REAL,
        decision_method TEXT,
        confidence REAL,
        was_successful INTEGER,
        created_at INTEGER
      );
      
      CREATE INDEX IF NOT EXISTS idx_transitions_session ON rl_transitions(session_id);
      CREATE INDEX IF NOT EXISTS idx_transitions_reward ON rl_transitions(reward);
      
      -- Q 表
      CREATE TABLE IF NOT EXISTS rl_q_table (
        state_key TEXT,
        action_type TEXT,
        q_value REAL,
        advantage REAL,
        sample_count INTEGER,
        win_rate REAL,
        avg_reward REAL,
        confidence_lower REAL,
        confidence_upper REAL,
        updated_at INTEGER,
        PRIMARY KEY (state_key, action_type)
      );
      
      -- 对局摘要
      CREATE TABLE IF NOT EXISTS rl_game_summaries (
        session_id TEXT PRIMARY KEY,
        start_time INTEGER,
        end_time INTEGER,
        duration INTEGER,
        won INTEGER,
        final_turn INTEGER,
        self_final_hp INTEGER,
        enemy_final_hp INTEGER,
        total_actions INTEGER,
        attack_actions INTEGER,
        play_actions INTEGER,
        move_actions INTEGER,
        avg_reward REAL,
        total_reward REAL,
        decision_accuracy REAL,
        key_moments_json TEXT,
        created_at INTEGER
      );
      
      -- 元数据
      CREATE TABLE IF NOT EXISTS rl_meta (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER
      );
    `);
  }
  
  private prepareStatements(): void {
    this.stmts.insertTransition = this.db.prepare(`
      INSERT OR REPLACE INTO rl_transitions 
      (id, session_id, turn, timestamp, state_json, action_json, next_state_json,
       reward, immediate_reward, strategic_reward, terminal_reward,
       decision_method, confidence, was_successful, created_at)
      VALUES (@id, @session_id, @turn, @timestamp, @state_json, @action_json, @next_state_json,
              @reward, @immediate_reward, @strategic_reward, @terminal_reward,
              @decision_method, @confidence, @was_successful, @created_at)
    `);
    
    this.stmts.insertQValue = this.db.prepare(`
      INSERT OR REPLACE INTO rl_q_table
      (state_key, action_type, q_value, advantage, sample_count, win_rate, avg_reward,
       confidence_lower, confidence_upper, updated_at)
      VALUES (@state_key, @action_type, @q_value, @advantage, @sample_count, @win_rate, @avg_reward,
              @confidence_lower, @confidence_upper, @updated_at)
    `);
    
    this.stmts.insertGameSummary = this.db.prepare(`
      INSERT OR REPLACE INTO rl_game_summaries
      (session_id, start_time, end_time, duration, won, final_turn,
       self_final_hp, enemy_final_hp, total_actions, attack_actions, play_actions, move_actions,
       avg_reward, total_reward, decision_accuracy, key_moments_json, created_at)
      VALUES (@session_id, @start_time, @end_time, @duration, @won, @final_turn,
              @self_final_hp, @enemy_final_hp, @total_actions, @attack_actions, @play_actions, @move_actions,
              @avg_reward, @total_reward, @decision_accuracy, @key_moments_json, @created_at)
    `);
    
    this.stmts.getTransitions = this.db.prepare(`
      SELECT * FROM rl_transitions ORDER BY timestamp DESC LIMIT ?
    `);
    
    this.stmts.getQTable = this.db.prepare(`
      SELECT * FROM rl_q_table
    `);
    
    this.stmts.getGameSummaries = this.db.prepare(`
      SELECT * FROM rl_game_summaries ORDER BY start_time DESC LIMIT ?
    `);
    
    this.stmts.getMeta = this.db.prepare(`
      SELECT value FROM rl_meta WHERE key = ?
    `);
    
    this.stmts.setMeta = this.db.prepare(`
      INSERT OR REPLACE INTO rl_meta (key, value, updated_at)
      VALUES (@key, @value, @updated_at)
    `);
  }
  
  // ==================== JSON 备用存储 ====================
  
  private loadJsonData(): void {
    try {
      if (fs.existsSync(this.jsonFile)) {
        const raw = fs.readFileSync(this.jsonFile, 'utf-8');
        this.jsonData = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[RLStorage] JSON load failed:', e);
    }
  }
  
  private saveJsonData(): void {
    try {
      fs.writeFileSync(this.jsonFile, JSON.stringify(this.jsonData), 'utf-8');
    } catch (e) {
      console.warn('[RLStorage] JSON save failed:', e);
    }
  }
  
  // ==================== 转换操作 ====================
  
  /**
   * 保存转换
   */
  saveTransition(transition: Transition): void {
    if (this.useJson) {
      this.jsonData.transitions.push(transition);
      // 保持合理大小
      if (this.jsonData.transitions.length > 50000) {
        this.jsonData.transitions = this.jsonData.transitions.slice(-40000);
      }
      this.saveJsonData();
      return;
    }
    
    try {
      this.stmts.insertTransition.run({
        id: transition.id,
        session_id: transition.sessionId,
        turn: transition.turn,
        timestamp: transition.timestamp,
        state_json: JSON.stringify(transition.state),
        action_json: JSON.stringify(transition.action),
        next_state_json: transition.nextState ? JSON.stringify(transition.nextState) : null,
        reward: transition.reward,
        immediate_reward: transition.immediateReward,
        strategic_reward: transition.strategicReward,
        terminal_reward: transition.terminalReward,
        decision_method: transition.decisionMethod,
        confidence: transition.confidence,
        was_successful: transition.wasSuccessful ? 1 : 0,
        created_at: Date.now()
      });
    } catch (e) {
      console.error('[RLStorage] saveTransition failed:', e);
    }
  }
  
  /**
   * 批量保存转换
   */
  saveTransitionBatch(transitions: Transition[]): void {
    if (this.useJson) {
      for (const t of transitions) {
        this.saveTransition(t);
      }
      return;
    }
    
    const insertMany = this.db.transaction((items: Transition[]) => {
      for (const t of items) {
        this.stmts.insertTransition.run({
          id: t.id,
          session_id: t.sessionId,
          turn: t.turn,
          timestamp: t.timestamp,
          state_json: JSON.stringify(t.state),
          action_json: JSON.stringify(t.action),
          next_state_json: t.nextState ? JSON.stringify(t.nextState) : null,
          reward: t.reward,
          immediate_reward: t.immediateReward,
          strategic_reward: t.strategicReward,
          terminal_reward: t.terminalReward,
          decision_method: t.decisionMethod,
          confidence: t.confidence,
          was_successful: t.wasSuccessful ? 1 : 0,
          created_at: Date.now()
        });
      }
    });
    
    try {
      insertMany(transitions);
    } catch (e) {
      console.error('[RLStorage] saveTransitionBatch failed:', e);
    }
  }
  
  /**
   * 加载转换
   */
  loadTransitions(limit: number = 10000): Transition[] {
    if (this.useJson) {
      return this.jsonData.transitions.slice(-limit);
    }
    
    try {
      const rows = this.stmts.getTransitions.all(limit);
      return rows.map((row: any) => ({
        id: row.id,
        sessionId: row.session_id,
        turn: row.turn,
        timestamp: row.timestamp,
        state: JSON.parse(row.state_json),
        action: JSON.parse(row.action_json),
        nextState: row.next_state_json ? JSON.parse(row.next_state_json) : null,
        reward: row.reward,
        immediateReward: row.immediate_reward,
        strategicReward: row.strategic_reward,
        terminalReward: row.terminal_reward,
        decisionMethod: row.decision_method as 'fast' | 'llm',
        confidence: row.confidence,
        wasSuccessful: row.was_successful === 1
      }));
    } catch (e) {
      console.error('[RLStorage] loadTransitions failed:', e);
      return [];
    }
  }
  
  // ==================== Q 表操作 ====================
  
  /**
   * 保存 Q 值
   */
  saveQValue(stateKey: string, actionType: ActionType, evaluation: PolicyEvaluation): void {
    if (this.useJson) {
      if (!this.jsonData.q_table[stateKey]) {
        this.jsonData.q_table[stateKey] = {} as Record<ActionType, PolicyEvaluation>;
      }
      this.jsonData.q_table[stateKey][actionType] = evaluation;
      this.saveJsonData();
      return;
    }
    
    try {
      this.stmts.insertQValue.run({
        state_key: stateKey,
        action_type: actionType,
        q_value: evaluation.qValue,
        advantage: evaluation.advantage,
        sample_count: evaluation.sampleCount,
        win_rate: evaluation.winRate,
        avg_reward: evaluation.averageReward,
        confidence_lower: evaluation.confidenceLower,
        confidence_upper: evaluation.confidenceUpper,
        updated_at: Date.now()
      });
    } catch (e) {
      console.error('[RLStorage] saveQValue failed:', e);
    }
  }
  
  /**
   * 批量保存 Q 表
   */
  saveQTable(qTable: QTableExport): void {
    if (this.useJson) {
      this.jsonData.q_table = qTable as any;
      this.saveJsonData();
      return;
    }
    
    const saveAll = this.db.transaction(() => {
      for (const [stateKey, actions] of Object.entries(qTable)) {
        for (const [actionType, eval_] of Object.entries(actions)) {
          if (!eval_) continue;
          this.stmts.insertQValue.run({
            state_key: stateKey,
            action_type: actionType,
            q_value: eval_.qValue,
            advantage: eval_.advantage,
            sample_count: eval_.sampleCount,
            win_rate: eval_.winRate,
            avg_reward: eval_.averageReward,
            confidence_lower: eval_.confidenceLower,
            confidence_upper: eval_.confidenceUpper,
            updated_at: Date.now()
          });
        }
      }
    });
    
    try {
      saveAll();
    } catch (e) {
      console.error('[RLStorage] saveQTable failed:', e);
    }
  }
  
  /**
   * 加载 Q 表
   */
  loadQTable(): QTableExport {
    if (this.useJson) {
      return this.jsonData.q_table as any;
    }
    
    try {
      const rows = this.stmts.getQTable.all();
      const qTable: Record<string, Record<ActionType, PolicyEvaluation>> = {};
      
      for (const row of rows) {
        if (!qTable[row.state_key]) {
          qTable[row.state_key] = {} as Record<ActionType, PolicyEvaluation>;
        }
        
        qTable[row.state_key][row.action_type as ActionType] = {
          stateKey: row.state_key,
          actionType: row.action_type as ActionType,
          qValue: row.q_value,
          advantage: row.advantage,
          sampleCount: row.sample_count,
          winRate: row.win_rate,
          averageReward: row.avg_reward,
          confidenceLower: row.confidence_lower,
          confidenceUpper: row.confidence_upper
        };
      }
      
      return qTable;
    } catch (e) {
      console.error('[RLStorage] loadQTable failed:', e);
      return {};
    }
  }
  
  // ==================== 对局摘要操作 ====================
  
  /**
   * 保存对局摘要
   */
  saveGameSummary(summary: GameSummary): void {
    if (this.useJson) {
      this.jsonData.game_summaries.push(summary);
      // 保持合理大小
      if (this.jsonData.game_summaries.length > 1000) {
        this.jsonData.game_summaries = this.jsonData.game_summaries.slice(-800);
      }
      this.saveJsonData();
      return;
    }
    
    try {
      this.stmts.insertGameSummary.run({
        session_id: summary.sessionId,
        start_time: summary.startTime,
        end_time: summary.endTime,
        duration: summary.duration,
        won: summary.won ? 1 : 0,
        final_turn: summary.finalTurn,
        self_final_hp: summary.selfFinalHp,
        enemy_final_hp: summary.enemyFinalHp,
        total_actions: summary.totalActions,
        attack_actions: summary.attackActions,
        play_actions: summary.playActions,
        move_actions: summary.moveActions,
        avg_reward: summary.averageReward,
        total_reward: summary.totalReward,
        decision_accuracy: summary.decisionAccuracy,
        key_moments_json: JSON.stringify(summary.keyMoments),
        created_at: Date.now()
      });
    } catch (e) {
      console.error('[RLStorage] saveGameSummary failed:', e);
    }
  }
  
  /**
   * 加载对局摘要
   */
  loadGameSummaries(limit: number = 100): GameSummary[] {
    if (this.useJson) {
      return this.jsonData.game_summaries.slice(-limit);
    }
    
    try {
      const rows = this.stmts.getGameSummaries.all(limit);
      return rows.map((row: any) => ({
        sessionId: row.session_id,
        startTime: row.start_time,
        endTime: row.end_time,
        duration: row.duration,
        won: row.won === 1,
        finalTurn: row.final_turn,
        selfFinalHp: row.self_final_hp,
        enemyFinalHp: row.enemy_final_hp,
        totalActions: row.total_actions,
        attackActions: row.attack_actions,
        playActions: row.play_actions,
        moveActions: row.move_actions,
        averageReward: row.avg_reward,
        totalReward: row.total_reward,
        decisionAccuracy: row.decision_accuracy,
        keyMoments: JSON.parse(row.key_moments_json || '[]')
      }));
    } catch (e) {
      console.error('[RLStorage] loadGameSummaries failed:', e);
      return [];
    }
  }
  
  // ==================== 元数据操作 ====================
  
  /**
   * 设置元数据
   */
  setMeta(key: string, value: any): void {
    if (this.useJson) {
      this.jsonData.meta[key] = value;
      this.saveJsonData();
      return;
    }
    
    try {
      this.stmts.setMeta.run({
        key,
        value: JSON.stringify(value),
        updated_at: Date.now()
      });
    } catch (e) {
      console.error('[RLStorage] setMeta failed:', e);
    }
  }
  
  /**
   * 获取元数据
   */
  getMeta<T = any>(key: string, defaultValue?: T): T | undefined {
    if (this.useJson) {
      return this.jsonData.meta[key] ?? defaultValue;
    }
    
    try {
      const row = this.stmts.getMeta.get(key);
      return row?.value ? JSON.parse(row.value) : defaultValue;
    } catch (e) {
      console.error('[RLStorage] getMeta failed:', e);
      return defaultValue;
    }
  }
  
  // ==================== 统计 ====================
  
  /**
   * 获取存储统计
   */
  getStats(): RLStorageStats {
    if (this.useJson) {
      return {
        transitionCount: this.jsonData.transitions.length,
        gameCount: this.jsonData.game_summaries.length,
        qTableSize: Object.keys(this.jsonData.q_table).length,
        lastUpdated: this.jsonData.meta.lastUpdated || Date.now()
      };
    }
    
    try {
      const transitionCount = this.db.prepare('SELECT COUNT(*) as cnt FROM rl_transitions').get().cnt;
      const gameCount = this.db.prepare('SELECT COUNT(*) as cnt FROM rl_game_summaries').get().cnt;
      const qTableSize = this.db.prepare('SELECT COUNT(DISTINCT state_key) as cnt FROM rl_q_table').get().cnt;
      const lastUpdatedRow = this.stmts.getMeta.get('lastUpdated');
      
      return {
        transitionCount,
        gameCount,
        qTableSize,
        lastUpdated: lastUpdatedRow?.value ? JSON.parse(lastUpdatedRow.value) : Date.now()
      };
    } catch (e) {
      console.error('[RLStorage] getStats failed:', e);
      return {
        transitionCount: 0,
        gameCount: 0,
        qTableSize: 0,
        lastUpdated: Date.now()
      };
    }
  }
  
  // ==================== 导出/导入 ====================
  
  /**
   * 导出所有数据
   */
  exportAll(): {
    transitions: Transition[];
    qTable: QTableExport;
    gameSummaries: GameSummary[];
  } {
    return {
      transitions: this.loadTransitions(100000),
      qTable: this.loadQTable(),
      gameSummaries: this.loadGameSummaries(1000)
    };
  }
  
  /**
   * 导入数据
   */
  importAll(data: {
    transitions?: Transition[];
    qTable?: QTableExport;
    gameSummaries?: GameSummary[];
  }): void {
    if (data.transitions) {
      this.saveTransitionBatch(data.transitions);
    }
    if (data.qTable) {
      this.saveQTable(data.qTable);
    }
    if (data.gameSummaries) {
      for (const summary of data.gameSummaries) {
        this.saveGameSummary(summary);
      }
    }
    
    this.setMeta('lastUpdated', Date.now());
  }
  
  /**
   * 清空所有数据
   */
  clearAll(): void {
    if (this.useJson) {
      this.jsonData = {
        transitions: [],
        q_table: {},
        game_summaries: [],
        meta: {}
      };
      this.saveJsonData();
      return;
    }
    
    try {
      this.db.exec('DELETE FROM rl_transitions');
      this.db.exec('DELETE FROM rl_q_table');
      this.db.exec('DELETE FROM rl_game_summaries');
      this.db.exec('DELETE FROM rl_meta');
    } catch (e) {
      console.error('[RLStorage] clearAll failed:', e);
    }
  }
}

// ==================== 全局实例 ====================

let globalRLStorage: RLStorage | null = null;

export function getRLStorage(): RLStorage {
  if (!globalRLStorage) {
    globalRLStorage = new RLStorage();
  }
  return globalRLStorage;
}




