# 基于历史对局的强化学习方案设计

## 一、系统架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         强化学习系统架构                                  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   对局数据收集   │────▶│  经验回放缓冲区  │────▶│   策略评估器     │
│   StateExtractor│     │ ExperienceReplay│     │ PolicyEvaluator │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                      │                       │
         │                      │                       │
         ▼                      ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    奖励计算      │     │   优先级采样     │     │   Q值表/建议    │
│  RewardFunction │     │   Prioritized   │     │  Recommendation │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                                              │
         │                                              │
         └──────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  决策增强/改进   │
                    │ Decision Boost  │
                    └─────────────────┘
```

## 二、核心组件

### 1. 状态表示 (GameState)

将复杂的游戏快照转换为结构化的状态表示：

```typescript
interface GameState {
  // 时间维度
  turn: number;
  phase: 'early' | 'mid' | 'late';
  
  // 己方状态向量
  selfHeroHp: number;           // 英雄血量
  selfMana: number;             // 法力值
  selfHandSize: number;         // 手牌数
  selfUnitCount: number;        // 场上单位数
  selfTotalAttack: number;      // 总攻击力
  selfTotalHealth: number;      // 总生命值
  selfCanAttackCount: number;   // 可攻击单位数
  
  // 敌方状态向量
  enemyHeroHp: number;
  enemyUnitCount: number;
  enemyTotalAttack: number;
  enemyTotalHealth: number;
  
  // 局势评估
  boardControl: number;         // 场面控制 [-1, 1]
  tempoAdvantage: number;       // 节奏优势
  materialAdvantage: number;    // 卡差优势
  
  // 关键状态标记
  hasLethalThreat: boolean;     // 是否面临斩杀
  canLethal: boolean;           // 是否可斩杀
  priorityTargetsOnBoard: string[];  // 高价值目标
}
```

### 2. 奖励函数设计

奖励信号分为三个层次：

#### 2.1 即时奖励 (Immediate Reward)

| 事件 | 奖励值 | 说明 |
|------|--------|------|
| 造成伤害 | +0.1 × 伤害值 | 鼓励输出 |
| 英雄直伤 | +0.2 × 伤害值 | 鼓励打脸 |
| 击杀单位 | +0.3 / 单位 | 鼓励解场 |
| 击杀高价值目标 | +0.5 | Cinda/Ash 等 |
| 损失单位 | -0.2 / 单位 | 惩罚送 |
| 英雄受伤 | -0.15 × 伤害值 | 保护英雄 |

#### 2.2 战略奖励 (Strategic Reward)

| 指标变化 | 奖励值 | 说明 |
|----------|--------|------|
| 场面控制提升 | +0.4 × Δ | 鼓励抢场面 |
| 节奏提升 | +0.2 × Δ | 鼓励节奏 |
| 卡差提升 | +0.3 × Δ | 鼓励赚卡 |
| 解除斩杀威胁 | +0.4 | 保命优先 |
| 错过斩杀 | -1.0 | 严厉惩罚 |

#### 2.3 终局奖励 (Terminal Reward)

| 结果 | 奖励值 | 说明 |
|------|--------|------|
| 胜利 | +1.0 | 基础胜利奖励 |
| 失败 | -1.0 | 基础失败惩罚 |
| 完美胜利 (HP≥25) | +0.5 | 额外奖励 |
| 翻盘胜利 (最低HP≤10) | +0.3 | 鼓励绝地反击 |

### 3. 经验回放缓冲区

采用 **优先级经验回放 (Prioritized Experience Replay)**：

```
优先级 P(i) = |δᵢ|^α + ε

其中:
- δᵢ: TD 误差或奖励绝对值
- α: 优先级指数 (默认 0.6)
- ε: 小常数防止零概率

采样概率: prob(i) = P(i)^α / Σ P(j)^α

重要性采样权重: w(i) = (N × prob(i))^(-β)
```

**优势**：
- 更频繁地学习高影响力的转换
- 加速收敛
- 减少对普通样本的过拟合

### 4. 策略评估 (Q-Learning)

使用表格型 Q-Learning：

```
Q(s, a) ← Q(s, a) + α × [r + γ × max_a' Q(s', a') - Q(s, a)]

其中:
- α: 学习率 (0.1)
- γ: 折扣因子 (0.95)
- r: 即时奖励
- s': 下一状态
```

**状态聚合**：
- 将连续状态离散化到桶中
- 状态键格式: `{phase}_{hpBucket}_{unitBucket}_{boardControl}_{flags}`
- 示例: `mid_sh20_eh15_su3_eu2_bc1_lt`

## 三、数据流程

### 1. 对局数据收集

```typescript
// 开始对局
rlSystem.startGame(sessionId);

// 每步决策后记录
const transition = rlSystem.recordStep({
  snapshot: currentSnapshot,
  action: selectedAction,
  nextSnapshot: newSnapshot,
  decisionMethod: 'llm',  // 或 'fast'
  confidence: 0.85,
  wasSuccessful: true
});

// 结束对局
const summary = rlSystem.endGame(won, finalSnapshot);
```

### 2. 离线学习

```typescript
// 批量学习（每 N 局或定时）
const result = rlSystem.batchLearn(64);
console.log(`学习了 ${result.samplesLearned} 个样本`);
```

### 3. 决策增强

```typescript
// 获取 RL 系统建议
const recommendation = rlSystem.getRecommendation(snapshot);

if (recommendation.confidence > 0.7) {
  // 使用 RL 建议
  console.log(`RL 建议: ${recommendation.recommended} (Q=${recommendation.qValue})`);
} else {
  // 继续使用 LLM 决策
}
```

## 四、与现有系统集成

### 1. 在 AgentModule 中集成

```typescript
import { getRLSystem, type GameSummary } from './agent/reinforcement-learning.js';

class AgentModule {
  private rlSystem = getRLSystem();
  private currentSessionId: string | null = null;
  
  // 游戏开始时
  onGameStart(sessionId: string) {
    this.currentSessionId = sessionId;
    this.rlSystem.startGame(sessionId);
  }
  
  // 每次决策时
  async decide(actions: any[], snapshot: any) {
    // 1. 获取 RL 建议
    const rlAdvice = this.rlSystem.getRecommendation(snapshot);
    
    // 2. 快速决策或 LLM 决策
    const decision = await this.makeDecision(actions, snapshot, rlAdvice);
    
    // 3. 记录转换
    if (this.currentSessionId) {
      this.rlSystem.recordStep({
        snapshot,
        action: this.actionToGameAction(decision.action),
        nextSnapshot: null,  // 下次决策时更新
        decisionMethod: decision.method,
        confidence: decision.confidence,
        wasSuccessful: true
      });
    }
    
    return decision;
  }
  
  // 游戏结束时
  onGameEnd(won: boolean, finalSnapshot: any) {
    if (this.currentSessionId) {
      const summary = this.rlSystem.endGame(won, finalSnapshot);
      this.broadcastGameSummary(summary);
      
      // 触发学习
      if (this.rlSystem.getStats().buffer.size > 100) {
        this.rlSystem.batchLearn(32);
      }
    }
  }
}
```

### 2. RL 建议与 LLM 决策融合

```typescript
async function makeDecision(actions, snapshot, rlAdvice) {
  // 策略 1: RL 建议作为 LLM 提示
  if (rlAdvice.recommended && rlAdvice.confidence > 0.5) {
    // 在 Prompt 中加入 RL 建议
    const systemPrompt = buildPromptWithRLHint(rlAdvice);
    // ...
  }
  
  // 策略 2: 高置信度直接采用
  if (rlAdvice.confidence > 0.85) {
    return {
      action: findActionByType(actions, rlAdvice.recommended),
      method: 'rl',
      confidence: rlAdvice.confidence
    };
  }
  
  // 策略 3: RL 作为 tie-breaker
  // 当 LLM 返回多个等价选项时，用 RL Q 值选择
}
```

## 五、数据持久化

### 1. SQLite 存储结构

```sql
-- 转换表
CREATE TABLE rl_transitions (
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
  was_successful INTEGER
);

-- Q 表
CREATE TABLE rl_q_table (
  state_key TEXT,
  action_type TEXT,
  q_value REAL,
  sample_count INTEGER,
  win_rate REAL,
  avg_reward REAL,
  updated_at INTEGER,
  PRIMARY KEY (state_key, action_type)
);

-- 对局摘要
CREATE TABLE rl_game_summaries (
  session_id TEXT PRIMARY KEY,
  start_time INTEGER,
  end_time INTEGER,
  won INTEGER,
  final_turn INTEGER,
  self_final_hp INTEGER,
  enemy_final_hp INTEGER,
  total_actions INTEGER,
  avg_reward REAL,
  total_reward REAL,
  decision_accuracy REAL,
  key_moments_json TEXT
);
```

### 2. 定期导出/导入

```typescript
// 导出学习数据
const data = rlSystem.exportData();
fs.writeFileSync('rl_data.json', JSON.stringify(data));

// 导入学习数据（应用启动时）
const data = JSON.parse(fs.readFileSync('rl_data.json', 'utf-8'));
rlSystem.importData(data);
```

## 六、进阶优化

### 1. 神经网络 Q 函数（DQN）

如果数据量足够大（>10000 局），可以升级为 DQN：

```typescript
// 使用 ONNX Runtime 进行推理
import * as ort from 'onnxruntime-node';

class NeuralQFunction {
  private session: ort.InferenceSession;
  
  async load(modelPath: string) {
    this.session = await ort.InferenceSession.create(modelPath);
  }
  
  async predict(state: GameState): Promise<Record<ActionType, number>> {
    const input = this.stateToTensor(state);
    const output = await this.session.run({ input });
    return this.outputToQValues(output);
  }
}
```

### 2. 对手建模

```typescript
interface OpponentModel {
  // 对手风格分类
  style: 'aggressive' | 'control' | 'combo' | 'unknown';
  
  // 预测对手下回合动作
  predictNextAction(): ActionProbability[];
  
  // 更新模型
  observe(action: GameAction): void;
}
```

### 3. 蒙特卡洛树搜索 (MCTS)

对于关键决策点，可以使用 MCTS 进行前瞻：

```typescript
class MCTSNode {
  state: GameState;
  children: Map<ActionType, MCTSNode>;
  visits: number;
  value: number;
  
  select(): MCTSNode {
    // UCB1 选择
    return this.children.values()
      .reduce((best, node) => {
        const ucb = node.value / node.visits + 
                    Math.sqrt(2 * Math.log(this.visits) / node.visits);
        return ucb > best.ucb ? { node, ucb } : best;
      }, { node: null, ucb: -Infinity }).node;
  }
}
```

## 七、监控与调试

### 1. 学习曲线监控

```typescript
// 定期输出学习统计
setInterval(() => {
  const stats = rlSystem.getStats();
  console.log(`[RL] Buffer: ${stats.buffer.size}, WinRate: ${stats.buffer.winRate}`);
  console.log(`[RL] States: ${stats.policy.totalStates}, AvgQ: ${stats.policy.averageQValue}`);
}, 60000);
```

### 2. 决策分析

```typescript
// 分析特定状态的决策分布
function analyzeDecisions(statePattern: string) {
  const qTable = rlSystem.exportData().qTable;
  const matching = Object.entries(qTable)
    .filter(([key]) => key.includes(statePattern));
  
  for (const [stateKey, actions] of matching) {
    console.log(`State: ${stateKey}`);
    for (const [action, eval_] of Object.entries(actions)) {
      console.log(`  ${action}: Q=${eval_.qValue}, samples=${eval_.sampleCount}`);
    }
  }
}
```

## 八、预期效果

| 指标 | 无 RL | 有 RL (1000局后) | 有 RL (10000局后) |
|------|-------|------------------|-------------------|
| 胜率 | ~50% | ~55-60% | ~60-65% |
| 平均决策时间 | 2-4s | 1-3s | 0.5-2s |
| 错过斩杀率 | ~15% | ~8% | ~3% |
| 低效交换率 | ~25% | ~15% | ~8% |

## 九、实施计划

### Phase 1: 基础数据收集 (1-2 周)
- [ ] 集成 StateExtractor
- [ ] 集成 RewardFunction
- [ ] 实现数据持久化

### Phase 2: 离线学习 (2-3 周)
- [ ] 实现 Q-Learning
- [ ] 实现优先级回放
- [ ] 添加学习监控

### Phase 3: 决策增强 (2-3 周)
- [ ] RL 建议融入 Prompt
- [ ] 高置信度直接决策
- [ ] A/B 测试对比

### Phase 4: 进阶优化 (持续)
- [ ] DQN 升级（数据量足够时）
- [ ] 对手建模
- [ ] MCTS 关键决策











