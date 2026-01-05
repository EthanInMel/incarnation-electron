# 对局回放数据集成指南

## 概述

本模块实现了通过 Unity 客户端中转获取服务器对局历史数据的功能，用于支持 RL 训练和提示词优化。

## 架构

```
┌──────────────────┐      SignalR       ┌──────────────────┐
│   Game Server    │ ◄────────────────► │   Unity 客户端    │
│  (PostgreSQL)    │   (JWT 认证)       │  (认证 + 桥接)    │
│                  │                    │                  │
│  GameReplayAPI   │                    │ ReplayDataBridge │
└──────────────────┘                    └────────┬─────────┘
                                                 │
                                           本地 Socket
                                           (JSON 协议)
                                                 │
                                                 ▼
                                        ┌──────────────────┐
                                        │  Electron Agent  │
                                        │                  │
                                        │ ReplayDataClient │
                                        │ RL Training      │
                                        │ Prompt Optimizer │
                                        └──────────────────┘
```

## 消息协议

### Electron → Unity 请求

```typescript
// 获取完整回放
{ type: 'get_replay', reqId: string, gameId: number }

// 获取玩家对局列表
{ type: 'get_player_replays', reqId: string, page: number, pageSize: number }

// 获取对局信息
{ type: 'get_replay_info', reqId: string, gameId: number }

// 获取分页动作
{ type: 'get_replay_actions', reqId: string, gameId: number, startSequence?: number, count?: number }
```

### Unity → Electron 响应

```typescript
// 成功响应
{ type: 'replay_data', reqId: string, success: true, data: GameReplayData }

// 失败响应
{ type: 'replay_data', reqId: string, success: false, error: string }
```

## Electron 端使用

### IPC API

```typescript
// 获取完整对局回放
const result = await ipcRenderer.invoke('get_game_replay', gameId);
if (result.ok) {
  console.log('Replay:', result.data);
}

// 获取玩家对局列表
const result = await ipcRenderer.invoke('get_player_replays', { page: 0, pageSize: 20 });

// 批量获取回放
const result = await ipcRenderer.invoke('get_replays_batch', [101, 102, 103]);

// 将回放转换为训练数据
const result = await ipcRenderer.invoke('replay_to_training_data', { 
  gameId: 101, 
  myPlayerId: 42 
});

// 分析回放
const result = await ipcRenderer.invoke('analyze_replay', gameId);

// 批量加载回放到 RL 系统训练
const result = await ipcRenderer.invoke('load_replays_for_rl_training', {
  gameIds: [101, 102, 103, 104, 105],
  myPlayerId: 42,
  batchSize: 5
});
```

### 直接使用 Client

```typescript
import { getReplayDataClient, replayToTrainingData, analyzeReplay } from './agent/replay-data-client.js';

const client = getReplayDataClient();

// 获取回放
const replay = await client.getReplay(gameId);

// 转换为训练数据
const trainingPoints = replayToTrainingData(replay, myPlayerId);

// 分析回放
const analysis = analyzeReplay(replay);
console.log(`Game had ${analysis.totalActions} actions over ${analysis.totalTurns} turns`);
```

## Unity 端实现

### 1. 创建 ReplayDataBridge.cs

```csharp
using System;
using System.Threading.Tasks;
using UnityEngine;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

public class ReplayDataBridge
{
    private readonly IGameHub _gameHub;
    private readonly Action<string> _sendToElectron;

    public ReplayDataBridge(IGameHub gameHub, Action<string> sendToElectron)
    {
        _gameHub = gameHub;
        _sendToElectron = sendToElectron;
    }

    public bool HandleMessage(JObject msg)
    {
        var type = msg["type"]?.ToString();
        switch (type)
        {
            case "get_replay":
                HandleGetReplay(msg);
                return true;
            case "get_player_replays":
                HandleGetPlayerReplays(msg);
                return true;
            case "get_replay_info":
                HandleGetReplayInfo(msg);
                return true;
            case "get_replay_actions":
                HandleGetReplayActions(msg);
                return true;
            default:
                return false;
        }
    }

    private async void HandleGetReplay(JObject msg)
    {
        var reqId = msg["reqId"]?.ToString();
        var gameId = msg["gameId"]?.ToObject<int>() ?? 0;

        try
        {
            var replayJson = await _gameHub.GetGameReplayAsync(gameId);
            SendResponse(new
            {
                type = "replay_data",
                reqId = reqId,
                success = true,
                data = JsonConvert.DeserializeObject(replayJson)
            });
        }
        catch (Exception e)
        {
            SendResponse(new
            {
                type = "replay_data",
                reqId = reqId,
                success = false,
                error = e.Message
            });
        }
    }

    private async void HandleGetPlayerReplays(JObject msg)
    {
        var reqId = msg["reqId"]?.ToString();
        var page = msg["page"]?.ToObject<int>() ?? 0;
        var pageSize = msg["pageSize"]?.ToObject<int>() ?? 10;

        try
        {
            var replaysJson = await _gameHub.GetPlayerReplaysAsync(page, pageSize);
            SendResponse(new
            {
                type = "player_replays",
                reqId = reqId,
                success = true,
                data = JsonConvert.DeserializeObject(replaysJson)
            });
        }
        catch (Exception e)
        {
            SendResponse(new
            {
                type = "player_replays",
                reqId = reqId,
                success = false,
                error = e.Message
            });
        }
    }

    // ... 其他方法类似

    private void SendResponse(object response)
    {
        var json = JsonConvert.SerializeObject(response);
        _sendToElectron(json);
    }
}
```

### 2. 在 ElectronBridge 中集成

```csharp
public class ElectronBridge : MonoBehaviour
{
    private ReplayDataBridge _replayDataBridge;

    void Start()
    {
        _replayDataBridge = new ReplayDataBridge(gameHub, SendToElectron);
    }

    void HandleElectronMessage(string line)
    {
        var msg = JObject.Parse(line);
        
        // 先尝试回放数据桥接处理
        if (_replayDataBridge.HandleMessage(msg))
            return;
        
        // 其他消息处理...
    }
}
```

## 数据结构

### GameReplayData

```typescript
interface GameReplayData {
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
  player1Hero?: string;
  player2Hero?: string;
  
  // 对局结果
  winnerId: number;
  totalTurns: number;
  startTime: number;
  endTime?: number;
  
  // 动作列表
  actions: GameReplayAction[];
}
```

### TrainingDataPoint

```typescript
interface TrainingDataPoint {
  turn: number;
  actionType: GameActionType;
  actionData: any;
  timestamp: number;
  gameWon: boolean;
  playerId: number;
  gameId: number;
  stateSnapshot?: any;
}
```

### ReplayAnalysis

```typescript
interface ReplayAnalysis {
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
```

## 与 RL 系统集成

### 自动训练流程

```typescript
// 1. 获取最近的对局
const replays = await client.getPlayerReplays(0, 50);

// 2. 过滤出已完成的对局
const completedGames = replays.filter(r => r.endTime);

// 3. 批量加载到 RL 系统
const result = await ipcRenderer.invoke('load_replays_for_rl_training', {
  gameIds: completedGames.map(g => g.gameId),
  myPlayerId: currentPlayerId,
  batchSize: 10
});

console.log(`Loaded ${result.data.loaded} games for training`);
```

### 手动数据导入

```typescript
import { getRLSystem } from './reinforcement-learning.js';

const rlSystem = getRLSystem(storage);
const replay = await client.getReplay(gameId);
const trainingData = replayToTrainingData(replay, myPlayerId);

for (const point of trainingData) {
  rlSystem.recordStep({
    turn: point.turn,
    stateSnapshot: point.stateSnapshot,
    actionType: point.actionType,
    actionData: point.actionData
  });
}

rlSystem.onGameEnd({
  won: replay.winnerId === myPlayerId,
  turns: replay.totalTurns
});
```

## 注意事项

1. **认证**：所有数据请求都通过 Unity 客户端的已认证连接进行，无需在 Electron 端处理认证
2. **超时**：默认 30 秒超时，可在创建 client 时配置
3. **并发**：批量获取时串行处理以避免服务器压力
4. **内存**：大量训练数据请分批处理

## 错误处理

```typescript
try {
  const replay = await client.getReplay(gameId);
} catch (error) {
  if (error.message.includes('timeout')) {
    // 请求超时
  } else if (error.message.includes('not connected')) {
    // Unity 客户端未连接
  } else {
    // 其他错误（服务器错误、权限问题等）
  }
}
```











