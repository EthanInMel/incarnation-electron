# LLM Agent 优化整合指南

## 概述

本次优化引入了以下新模块：

1. **`prompt-templates.ts`** - Prompt 模板系统
2. **`name-resolver.ts`** - 增强版名称解析
3. **`fast-decision.ts`** - 快速决策引擎
4. **`decision-tracker.ts`** - 决策追溯系统
5. **`agent-core.ts`** - 核心集成模块

## 如何整合到 AgentModule.ts

### 步骤 1：导入新模块

在 `AgentModule.ts` 顶部添加导入：

```typescript
import {
  // Prompt 模板
  getPromptBuilder,
  PromptBuilder,
  
  // 名称解析
  resolveUnit,
  resolveCard,
  resolveUnitId,
  resolveCardId,
  isHeroTarget,
  generateUnitLabels,
  
  // 快速决策
  tryFastDecision,
  tryFastDecisionWithTracking,
  
  // 决策追踪
  decisionTracker,
  trackFastDecision,
  trackLLMDecision,
  getDecisionAnalysis,
  
  // 类型
  type FastDecisionResult,
  type DecisionRecord,
  type DecisionAnalysis
} from './agent/agent-core.js';

import { normalizeDecisionMode } from './agent/types.js';
```

### 步骤 2：在 #decide 方法中使用快速决策

修改 `#decide` 方法的开头：

```typescript
async #decide(actions: any[], snapshot: any): Promise<DecisionResult> {
  const turn = snapshot?.turn ?? 0;
  const normalizedMode = normalizeDecisionMode(this.#cfg.decisionMode);
  
  // 1. 检查是否启用快速决策
  if (normalizedMode !== 'llm_only' && this.#cfg.fastDecisionEnabled !== false) {
    const fastResult = tryFastDecisionWithTracking(snapshot, actions, {
      aggressiveness: this.#cfg.strategyProfile === 'aggressive' ? 0.8 : 
                      this.#cfg.strategyProfile === 'defensive' ? 0.2 : 0.5,
      safetyFirst: this.#cfg.strategyProfile === 'defensive'
    });
    
    if (!fastResult.shouldUseLLM && fastResult.actionId != null) {
      // 记录快速决策
      const record = trackFastDecision({
        turn,
        snapshot,
        actionId: fastResult.actionId,
        reason: fastResult.reason || 'fast_decision',
        confidence: fastResult.confidence
      });
      
      console.log(`[agent] ⚡ Fast decision: ${fastResult.reason} (confidence: ${fastResult.confidence})`);
      
      return {
        mode: 'smart',
        method: 'fast',
        actionId: fastResult.actionId,
        reason: fastResult.reason,
        confidence: fastResult.confidence,
        trackingId: record.id
      };
    }
  }
  
  // 2. 需要 LLM 决策
  // ... 原有的 LLM 调用逻辑 ...
}
```

### 步骤 3：使用新的 Prompt 构建器

替换 `buildPolicyPrompt` 调用：

```typescript
// 旧代码
const payload = buildPolicyPrompt(observation, snapshot, this.#cfg, this.#clampTemp.bind(this));

// 新代码
const promptBuilder = getPromptBuilder();
const systemPrompt = promptBuilder.buildSystemPrompt({
  strategyProfile: this.#cfg.strategyProfile,
  customRules: this.#cfg.systemPrompt ? [this.#cfg.systemPrompt] : []
});
const userPrompt = promptBuilder.buildUserPrompt(observation, {
  includeFeedback: !!feedback,
  feedback,
  maxSteps: this.#cfg.maxSteps
});
const payload = {
  model: this.#cfg.model,
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ],
  temperature: this.#clampTemp(this.#cfg.temperature ?? 0.15),
  max_tokens: this.#cfg.maxTokens || 384
};
```

### 步骤 4：使用增强版名称解析

替换 `resolveUnitId` 和 `resolveCardId` 调用：

```typescript
// 旧代码
const unitId = resolveUnitId(unitName, false);
const cardId = resolveCardId(cardName);

// 新代码
import { resolveUnit, resolveCard } from './agent/name-resolver.js';

const unitMatch = resolveUnit(snapshot.self_units, unitName);
if (unitMatch.matched) {
  const unitId = unitMatch.matchedItem.unit_id;
  console.log(`[agent] Resolved unit "${unitName}" → id=${unitId} (confidence: ${unitMatch.confidence})`);
}

const cardMatch = resolveCard(snapshot.you?.hand || [], cardName, {
  maxManaCost: snapshot.you?.mana
});
if (cardMatch.matched) {
  const cardId = cardMatch.matchedItem.card_id;
}
```

### 步骤 5：记录 LLM 决策

在 LLM 调用完成后：

```typescript
const startTime = Date.now();
const res = await callDispatcher(this.#cfg, payload);
const latencyMs = Date.now() - startTime;

// 记录决策
const record = trackLLMDecision({
  turn,
  snapshot,
  actionId: selectedActionId,
  reason: parsedPlan?.analysis || 'llm_decision',
  latencyMs,
  model: this.#cfg.model,
  prompt: userPrompt,
  response: extractText(res.data),
  parsedPlan
});
```

### 步骤 6：暴露分析 API

在 `#initIpc` 中添加：

```typescript
ipcMain.handle('get_decision_analysis', async (_e, options?: { lastN?: number }) => {
  try {
    return { ok: true, data: getDecisionAnalysis(options) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('get_recent_decisions', async (_e, count?: number) => {
  try {
    return { ok: true, data: decisionTracker.getRecentDecisions(count || 10) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});
```

## 配置示例

```typescript
const config: AgentConfig = {
  provider: 'siliconflow',
  model: 'Qwen/Qwen2.5-72B-Instruct',
  baseUrl: 'https://api.siliconflow.cn/v1',
  
  // 新的简化模式
  decisionMode: 'smart',  // 推荐：智能模式
  
  // 快速决策配置
  fastDecisionEnabled: true,
  fastDecisionConfidenceThreshold: 0.7,
  
  // 策略配置
  strategyProfile: 'balanced',
  
  // 追踪配置
  enableDecisionTracking: true,
  
  // 其他配置
  temperature: 0.2,
  maxTokens: 384,
  maxSteps: 6,
  maxTurnMs: 10000
};
```

## 预期效果

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 简单情况决策延迟 | 2-4s | <100ms |
| LLM 调用次数 | 100% | ~60-70% |
| 名称解析成功率 | ~80% | ~95% |
| 决策可追溯性 | 无 | 完整记录 |

## 调试技巧

### 查看快速决策统计

```typescript
import { fastDecisionTracker } from './agent/fast-decision.js';
console.log(fastDecisionTracker.getStats());
// { totalDecisions: 50, fastDecisions: 30, llmDecisions: 20, ... }
```

### 查看决策分析报告

```typescript
const analysis = getDecisionAnalysis({ lastN: 100 });
console.log('失败模式:', analysis.failurePatterns);
console.log('改进建议:', analysis.recommendations);
```

### 导出决策历史

```typescript
const history = decisionTracker.exportHistory();
// 保存到文件用于后续分析
```

## 渐进式迁移

建议按以下顺序逐步迁移：

1. **Phase 1**: 只启用快速决策（风险最低）
   - 设置 `fastDecisionEnabled: true`
   - 保持原有 LLM 逻辑不变

2. **Phase 2**: 切换到新的 Prompt 构建器
   - 可以热更新 Prompt 模板

3. **Phase 3**: 使用增强版名称解析
   - 提高解析成功率

4. **Phase 4**: 启用决策追踪
   - 收集数据用于后续优化











