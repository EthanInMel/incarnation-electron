# 基于强化学习的提示词自动优化系统

## 一、研究背景

### 相关论文

| 论文 | 年份 | 核心思想 | 链接 |
|------|------|----------|------|
| **RLPrompt** | 2022 | 使用策略梯度优化离散提示词 | [arXiv:2205.12548](https://arxiv.org/abs/2205.12548) |
| **APO** | 2023 | "梯度下降" + 束搜索自动优化提示 | [arXiv:2305.03495](https://arxiv.org/abs/2305.03495) |
| **AutoHint** | 2023 | 从错误中学习，自动生成提示 | [arXiv:2307.07415](https://arxiv.org/abs/2307.07415) |
| **OPRO** | 2023 | LLM 作为优化器，自我反思改进 | Google DeepMind |
| **PROMST** | 2024 | 多步骤任务提示优化 | [arXiv:2402.08702](https://arxiv.org/abs/2402.08702) |

### 核心洞察

1. **提示词对 LLM 输出影响巨大**：细微的表述差异可能导致性能差异 10-20%
2. **人工优化效率低**：专家也难以预测最优提示
3. **自动优化可行**：通过试错 + 反馈可以自动发现更好的提示
4. **LLM 可以自我改进**：让 LLM 分析自己的失败并提出改进

---

## 二、系统设计

### 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    提示词自动优化系统                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ 提示词变体库  │◀──▶│  UCB 选择器   │◀──▶│  性能追踪器   │      │
│  │ PromptVariants│    │ Multi-Armed  │    │ Performance  │      │
│  │              │    │   Bandit     │    │   Tracker    │      │
│  └──────┬───────┘    └──────────────┘    └──────┬───────┘      │
│         │                                       │               │
│         │          ┌──────────────┐             │               │
│         └─────────▶│  失败分析器   │◀────────────┘               │
│                    │FailureAnalyzer│                            │
│                    └──────┬───────┘                             │
│                           │                                     │
│                           ▼                                     │
│                    ┌──────────────┐                             │
│                    │ LLM 反思器   │                             │
│                    │(OPRO 风格)   │                             │
│                    └──────┬───────┘                             │
│                           │                                     │
│                           ▼                                     │
│                    ┌──────────────┐                             │
│                    │  变异生成器   │                             │
│                    │ Mutation Gen │                             │
│                    └──────────────┘                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 核心算法：多臂老虎机 + LLM 自我反思

#### 1. UCB (Upper Confidence Bound) 变体选择

```typescript
UCB(variant) = winRate + c × √(ln(N) / n)

其中:
- winRate: 该变体的历史胜率
- c: 探索参数（默认 √2 ≈ 1.41）
- N: 总试验次数
- n: 该变体的试验次数
```

**优势**：
- 平衡**利用**（选择已知好的）和**探索**（尝试未知的）
- 理论保证收敛到最优
- 计算简单，无需复杂训练

#### 2. OPRO 风格的 LLM 自我反思

```
输入: 失败案例列表
     ↓
LLM 分析: "这些失败的共同原因是..."
     ↓
LLM 建议: "应该添加这条规则..."
     ↓
输出: 新的提示词变体
```

**反思提示模板**：

```
你是提示词优化专家。分析以下失败案例并提出改进建议。

当前规则:
[当前提示词内容]

失败案例:
案例 1: [状态] [输出] [失败原因] [期望行为]
案例 2: ...

请分析根本原因，提出一条简洁的改进规则。
```

---

## 三、提示词变体管理

### 变体结构

```typescript
interface PromptVariant {
  id: string;                    // 唯一标识
  version: number;               // 版本号
  systemPrompt: string;          // 系统提示
  ruleSnippets: string[];        // 规则片段
  fewShotExamples: string[];     // 示例
  parentId: string | null;       // 父变体（用于追溯）
  mutationType: MutationType;    // 变异类型
  stats: PromptStats;            // 性能统计
}
```

### 变异类型

| 类型 | 说明 | 触发条件 |
|------|------|----------|
| `add_rule` | 添加新规则 | 特定类型失败 >= 3 次 |
| `remove_rule` | 删除冗余规则 | 规则无效或冲突 |
| `emphasize` | 强调关键点 | 重要规则被忽视 |
| `clarify` | 澄清歧义 | 输出格式错误 |
| `simplify` | 简化复杂规则 | 解析失败率高 |
| `add_example` | 添加示例 | 复杂场景处理不当 |
| `fix_failure` | 针对性修复 | 特定失败模式 |

---

## 四、失败分析与学习

### 失败类型定义

```typescript
type FailureType = 
  | 'parse_error'        // JSON 解析失败
  | 'invalid_action'     // 无效动作
  | 'name_mismatch'      // 名称解析失败
  | 'missed_lethal'      // 错过斩杀
  | 'inefficient_trade'  // 低效交换
  | 'ignored_threat'     // 忽视威胁
  | 'wrong_priority';    // 优先级错误
```

### 自动修复策略

| 失败类型 | 自动修复 |
|----------|----------|
| `parse_error` | 简化输出格式要求，强调"严格 JSON" |
| `name_mismatch` | 强调使用精确名称，包括 #N 后缀 |
| `missed_lethal` | 添加"斩杀检查"为最高优先级规则 |
| `inefficient_trade` | 添加价值交换评估指南 |
| `ignored_threat` | 强调威胁评估优先于进攻 |

---

## 五、实现示例

### 1. 初始化与使用

```typescript
import { getPromptOptimizer } from './agent/prompt-optimizer.js';

// 初始化优化器
const optimizer = getPromptOptimizer();

// 设置 LLM 调用函数（用于自我反思）
optimizer.setLLMCaller(async (prompt) => {
  const response = await callYourLLM(prompt);
  return response;
});

// 游戏开始时，选择提示词变体
const variant = optimizer.selectVariant();
console.log(`使用提示词变体: ${variant.id}, UCB=${variant.stats.ucbScore}`);

// 构建实际提示
const systemPrompt = [
  variant.systemPrompt,
  ...variant.ruleSnippets
].join('\n');
```

### 2. 记录结果与失败

```typescript
// 游戏结束时记录结果
optimizer.recordGameResult({
  won: true,
  reward: 1.5,
  turnsToEnd: 12,
  parseErrors: 0,
  totalActions: 15,
  failedActions: 2
});

// 记录失败案例（用于学习）
optimizer.recordFailure({
  gameState: 'Turn 5, Hero HP: 20 vs 25',
  llmInput: '当前状态...',
  llmOutput: '{"steps":[{"type":"attack","attacker":"Tryx","target":"Cinda"}]}',
  failureType: 'name_mismatch',
  failureReason: '单位名称缺少 #N 后缀',
  expectedBehavior: '应该使用 Tryx#1',
  rewardLoss: 0.3
});
```

### 3. 运行优化循环

```typescript
// 每 N 局后运行优化
async function maybeOptimize() {
  const stats = optimizer.getStats();
  
  // 条件：至少 50 局，失败案例 >= 10
  if (stats.activeVariant?.totalGames >= 50 && 
      Object.values(stats.failureCounts).reduce((a, b) => a + b, 0) >= 10) {
    
    console.log('[Optimizer] Running optimization cycle...');
    const result = await optimizer.runOptimizationCycle();
    
    console.log(`生成了 ${result.newVariants.length} 个新变体`);
    for (const v of result.newVariants) {
      console.log(`- ${v.id}: ${v.mutationType}`);
    }
  }
}
```

### 4. 监控与分析

```typescript
// 获取优化状态
const stats = optimizer.getStats();
console.log(`
总变体数: ${stats.totalVariants}
当前变体: ${stats.activeVariant?.id} (胜率: ${(stats.activeVariant?.winRate * 100).toFixed(1)}%)
最佳变体: ${stats.bestVariant?.id} (胜率: ${(stats.bestVariant?.winRate * 100).toFixed(1)}%)
失败分布: ${JSON.stringify(stats.failureCounts)}
最近改进: ${stats.recentImprovements} 个变体超越了父代
`);
```

---

## 六、与现有系统集成

### 在 AgentModule 中集成

```typescript
import { getPromptOptimizer, type PromptVariant } from './agent/prompt-optimizer.js';

class AgentModule {
  private promptOptimizer = getPromptOptimizer();
  private currentVariant: PromptVariant | null = null;
  
  // 游戏开始时选择变体
  onGameStart() {
    this.currentVariant = this.promptOptimizer.selectVariant();
    console.log(`[Agent] Using prompt variant: ${this.currentVariant.id}`);
  }
  
  // 构建提示时使用当前变体
  buildPrompt(observation: any): { system: string; user: string } {
    const variant = this.currentVariant || this.promptOptimizer.selectVariant();
    
    const system = [
      variant.systemPrompt,
      '',
      '规则:',
      ...variant.ruleSnippets.map((r, i) => `${i + 1}. ${r}`),
      '',
      '示例:',
      ...variant.fewShotExamples
    ].join('\n');
    
    const user = this.buildUserPrompt(observation);
    
    return { system, user };
  }
  
  // 记录失败
  onActionFailed(context: any, reason: string) {
    this.promptOptimizer.recordFailure({
      gameState: this.summarizeState(context.snapshot),
      llmInput: context.prompt,
      llmOutput: context.response,
      failureType: this.classifyFailure(reason),
      failureReason: reason,
      expectedBehavior: this.inferExpectedBehavior(context),
      rewardLoss: 0.2
    });
  }
  
  // 游戏结束时
  async onGameEnd(won: boolean, stats: any) {
    this.promptOptimizer.recordGameResult({
      won,
      reward: won ? 1.0 : -1.0,
      turnsToEnd: stats.turns,
      parseErrors: stats.parseErrors,
      totalActions: stats.totalActions,
      failedActions: stats.failedActions
    });
    
    // 每 50 局尝试优化
    const optimizerStats = this.promptOptimizer.getStats();
    if (optimizerStats.activeVariant?.totalGames % 50 === 0) {
      await this.promptOptimizer.runOptimizationCycle();
    }
  }
}
```

---

## 七、预期效果

### 性能提升预期

| 指标 | 初始 | 100 局后 | 500 局后 |
|------|------|----------|----------|
| 胜率 | ~50% | ~55% | ~60% |
| 解析成功率 | ~90% | ~95% | ~98% |
| 动作成功率 | ~80% | ~88% | ~93% |
| 错过斩杀率 | ~15% | ~8% | ~3% |

### 自动发现的典型改进

1. **格式强调**：从"输出 JSON"变为"严格输出 JSON，不要任何额外文本"
2. **名称规范**：发现 #N 后缀经常遗漏后自动添加强调
3. **优先级调整**：根据实际失败自动调整攻击目标优先级
4. **简化规则**：自动移除无效或冲突的规则

---

## 八、进阶方向

### 1. 神经网络嵌入 (Future)

将提示词变体编码为向量，使用深度强化学习：

```
提示词 → Embedding → Policy Network → 选择/变异
```

### 2. 元学习 (Meta-Learning)

从多个游戏类型中学习通用的提示词优化策略。

### 3. 对抗训练

生成"困难"的游戏状态来测试和强化提示词。

### 4. 可解释性

分析哪些规则变化带来了性能提升，建立因果关系。

---

## 九、参考资料

1. RLPrompt: Optimizing Discrete Text Prompts with Reinforcement Learning
   - https://arxiv.org/abs/2205.12548

2. Automatic Prompt Optimization with "Gradient Descent" and Beam Search
   - https://arxiv.org/abs/2305.03495

3. Large Language Models as Optimizers (OPRO)
   - https://arxiv.org/abs/2309.03409

4. AutoHint: Automatic Prompt Optimization with Hint Generation
   - https://arxiv.org/abs/2307.07415

5. PROMST: Prompt Optimization in Multi-Step Tasks
   - https://arxiv.org/abs/2402.08702











