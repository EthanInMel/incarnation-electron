/**
 * 对局回放数据客户端
 * 
 * 通过 Unity 客户端中转获取服务器上的对局历史数据
 * 用于 RL 训练和提示词优化
 */

import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';

// ==================== 类型定义 ====================

/** 完整的回放数据 */
export interface GameReplayData {
  gameId: number;
  replayVersion: number;
  
  // 玩家信息
  player1Id: number;
  player2Id: number;
  player1Name: string;
  player2Name: string;
  
  // 初始状态
  mapId: number;
  gameType: number;
  player1InitialDeck: number[];
  player2InitialDeck: number[];
  player1Hero?: string;  // JSON
  player2Hero?: string;  // JSON
  player1Colour?: string;
  player2Colour?: string;
  
  // 对局结果
  winnerId: number;
  totalTurns: number;
  startTime: number;
  endTime?: number;
  
  // 动作列表
  actions: GameReplayAction[];
}

/** 回放动作 */
export interface GameReplayAction {
  sequenceNumber: number;
  playerId: number;
  turn: number;
  actionType: number;
  actionData: string;  // JSON
  timestamp: number;
}

/** 回放摘要（列表用） */
export interface GameReplaySummary {
  gameId: number;
  player1Id: number;
  player2Id: number;
  player1Name: string;
  player2Name: string;
  winnerId: number;
  totalTurns: number;
  mapId: number;
  gameType: number;
  startTime: number;
  endTime: number;
  duration: number;  // 秒
}

/** 动作类型枚举 */
export enum GameActionType {
  // 基础动作
  MoveCard = 0,
  Attack = 1,
  EndTurn = 2,
  GameReady = 3,
  PlayCard = 4,
  
  // 扩展动作类型 (用于完整回放)
  GameStart = 10,
  UnitSpawned = 11,
  UnitDied = 12,
  UnitMoved = 13,
  UnitDamaged = 14,
  UnitHealed = 15,
  BuffApplied = 16,
  BuffRemoved = 17,
  PlayerHPChanged = 18,
  PlayerManaChanged = 19,
  CardDrawn = 20,
  GameEnd = 21,
  HeroDamaged = 22,
  Emotion = 23,
  StateSnapshot = 99
}

// ==================== 请求/响应消息 ====================

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// ==================== 回放数据客户端 ====================

export class ReplayDataClient {
  #socket: Socket | null = null;
  #pendingRequests = new Map<string, PendingRequest<any>>();
  #requestTimeoutMs = 30000;  // 30秒超时
  #onMessage: ((line: string) => void) | null = null;
  
  constructor(options?: { timeoutMs?: number }) {
    if (options?.timeoutMs) {
      this.#requestTimeoutMs = options.timeoutMs;
    }
  }
  
  /**
   * 设置 Socket 连接（复用 AgentModule 的连接）
   */
  setSocket(socket: Socket | null) {
    this.#socket = socket;
  }
  
  /**
   * 处理来自 Unity 的响应消息
   * 需要在 AgentModule 的消息处理中调用
   */
  handleMessage(msg: any): boolean {
    const reqId = msg.reqId;
    if (!reqId) return false;
    
    const pending = this.#pendingRequests.get(reqId);
    if (!pending) return false;
    
    // 清理
    clearTimeout(pending.timeout);
    this.#pendingRequests.delete(reqId);
    
    // 处理响应
    if (msg.success === false) {
      pending.reject(new Error(msg.error || 'Unknown error'));
    } else {
      pending.resolve(msg.data);
    }
    
    return true;
  }
  
  /**
   * 发送请求并等待响应
   */
  #sendRequest<T>(type: string, params: Record<string, any>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.#socket) {
        reject(new Error('Socket not connected'));
        return;
      }
      
      const reqId = randomUUID();
      
      // 设置超时
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(reqId);
        reject(new Error(`Request timeout: ${type}`));
      }, this.#requestTimeoutMs);
      
      // 注册等待响应
      this.#pendingRequests.set(reqId, { resolve, reject, timeout });
      
      // 发送请求
      const msg = { type, reqId, ...params };
      this.#socket.write(JSON.stringify(msg) + '\n');
    });
  }
  
  // ==================== 公开 API ====================
  
  /**
   * 获取完整的对局回放数据
   */
  async getReplay(gameId: number): Promise<GameReplayData> {
    return this.#sendRequest<GameReplayData>('get_replay', { gameId });
  }
  
  /**
   * 获取玩家最近的对局列表
   */
  async getPlayerReplays(page = 0, pageSize = 10): Promise<GameReplaySummary[]> {
    return this.#sendRequest<GameReplaySummary[]>('get_player_replays', { page, pageSize });
  }
  
  /**
   * 获取对局信息（不含完整动作）
   */
  async getReplayInfo(gameId: number): Promise<{
    gameId: number;
    actionCount: number;
    player1Name: string;
    player2Name: string;
    winner: number;
    turns: number;
    startTime: number;
    endTime?: number;
    mapId: number;
    gameType: number;
  }> {
    return this.#sendRequest('get_replay_info', { gameId });
  }
  
  /**
   * 分页获取对局动作（用于大型对局）
   */
  async getReplayActions(
    gameId: number, 
    startSequence = 0, 
    count = 100
  ): Promise<GameReplayAction[]> {
    return this.#sendRequest<GameReplayAction[]>('get_replay_actions', { 
      gameId, 
      startSequence, 
      count 
    });
  }
  
  /**
   * 批量获取多个对局回放
   */
  async getReplaysBatch(gameIds: number[]): Promise<GameReplayData[]> {
    const results: GameReplayData[] = [];
    
    // 串行获取以避免服务器压力
    for (const gameId of gameIds) {
      try {
        const replay = await this.getReplay(gameId);
        results.push(replay);
      } catch (e) {
        console.warn(`[ReplayDataClient] Failed to get replay ${gameId}:`, e);
      }
    }
    
    return results;
  }
  
  /**
   * 清理所有等待中的请求
   */
  cleanup() {
    for (const [reqId, pending] of this.#pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Client cleanup'));
    }
    this.#pendingRequests.clear();
  }
}

// ==================== 训练数据处理 ====================

/**
 * 将回放数据转换为 RL 训练数据格式
 */
export function replayToTrainingData(replay: GameReplayData, myPlayerId: number): TrainingDataPoint[] {
  const points: TrainingDataPoint[] = [];
  const won = replay.winnerId === myPlayerId;
  
  // 解析每个动作
  let currentState: any = null;
  
  for (const action of replay.actions) {
    // 跳过非玩家动作
    if (action.playerId !== myPlayerId) continue;
    
    // 跳过非决策动作
    if (![GameActionType.MoveCard, GameActionType.Attack, GameActionType.PlayCard, GameActionType.EndTurn]
        .includes(action.actionType)) {
      // 但要更新状态
      if (action.actionType === GameActionType.StateSnapshot) {
        try {
          const data = JSON.parse(action.actionData);
          currentState = data.GameStateSnapshot ? JSON.parse(data.GameStateSnapshot) : null;
        } catch {}
      }
      continue;
    }
    
    try {
      const actionData = JSON.parse(action.actionData);
      
      points.push({
        turn: action.turn,
        actionType: action.actionType,
        actionData: actionData,
        timestamp: action.timestamp,
        gameWon: won,
        playerId: myPlayerId,
        gameId: replay.gameId,
        // 状态快照（如果有）
        stateSnapshot: currentState
      });
    } catch (e) {
      console.warn('[replayToTrainingData] Failed to parse action:', e);
    }
  }
  
  return points;
}

/** 训练数据点 */
export interface TrainingDataPoint {
  turn: number;
  actionType: GameActionType;
  actionData: any;
  timestamp: number;
  gameWon: boolean;
  playerId: number;
  gameId: number;
  stateSnapshot?: any;
}

/**
 * 统计回放数据
 */
export function analyzeReplay(replay: GameReplayData): ReplayAnalysis {
  const actionCounts: Record<number, number> = {};
  let player1Actions = 0;
  let player2Actions = 0;
  
  for (const action of replay.actions) {
    actionCounts[action.actionType] = (actionCounts[action.actionType] || 0) + 1;
    
    if (action.playerId === replay.player1Id) player1Actions++;
    else if (action.playerId === replay.player2Id) player2Actions++;
  }
  
  return {
    gameId: replay.gameId,
    totalActions: replay.actions.length,
    totalTurns: replay.totalTurns,
    durationMs: replay.endTime ? replay.endTime - replay.startTime : 0,
    winner: replay.winnerId === replay.player1Id ? 'player1' : 'player2',
    player1Actions,
    player2Actions,
    actionCounts,
    actionsPerTurn: replay.totalTurns > 0 ? replay.actions.length / replay.totalTurns : 0
  };
}

export interface ReplayAnalysis {
  gameId: number;
  totalActions: number;
  totalTurns: number;
  durationMs: number;
  winner: 'player1' | 'player2';
  player1Actions: number;
  player2Actions: number;
  actionCounts: Record<number, number>;
  actionsPerTurn: number;
}

// ==================== 单例导出 ====================

let _client: ReplayDataClient | null = null;

export function getReplayDataClient(): ReplayDataClient {
  if (!_client) {
    _client = new ReplayDataClient();
  }
  return _client;
}











