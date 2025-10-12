# 移动-攻击稳定架构方案 V2

## 设计原则

1. **LLM只做意图**：描述"想做什么"，不指定"怎么做"
2. **Unity做解释**：将意图翻译为合法动作
3. **状态同步**：每个动作后确保状态完全更新
4. **智能降级**：目标不可达时自动选择次优方案

---

## 三层架构

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: LLM (战略层)                                    │
│ - 输出高层意图                                           │
│ - 不关心具体坐标                                         │
└─────────────────┬───────────────────────────────────────┘
                  │ Intent JSON
                  ▼
┌─────────────────────────────────────────────────────────┐
│ Layer 2: Agent (翻译层)                                  │
│ - 将意图转换为动作描述符                                 │
│ - 提供多个候选方案                                       │
└─────────────────┬───────────────────────────────────────┘
                  │ ActionDescriptor[]
                  ▼
┌─────────────────────────────────────────────────────────┐
│ Layer 3: Unity (执行层)                                  │
│ - 智能选择最优可执行动作                                 │
│ - 处理状态同步和延迟                                     │
│ - 提供失败后的自动重试                                   │
└─────────────────────────────────────────────────────────┘
```

---

## 关键改进点

### 1. LLM 输出格式（只描述意图）

**旧方案（具体坐标）：**
```json
{
  "type": "move_then_attack",
  "unit_id": 17,
  "to": {"cell_index": 33},
  "target_unit_id": 5
}
```

**新方案（意图描述）：**
```json
{
  "type": "advance_and_attack",
  "unit": "Tryx#1",
  "intent": "move_closer",
  "target": "Cinda",
  "priority": "kill_priority_target"
}
```

### 2. Unity 智能执行器

```csharp
public class SmartActionExecutor
{
    // 核心：延迟执行链
    public IEnumerator ExecuteMoveAttackChain(
        string unitName, 
        string targetHint,
        string intent
    ) {
        // 1. 查找单位
        var unit = FindUnitByName(unitName);
        if (unit == null) yield break;

        // 2. 查找目标
        var target = FindBestTarget(targetHint, unit);
        if (target == null) yield break;

        // 3. 计算移动位置（当前状态）
        var bestMoveCell = FindBestMoveToAttack(unit, target);
        if (bestMoveCell == null) {
            // 降级：已经在范围内，直接攻击
            yield return ExecuteAttack(unit, target);
            yield break;
        }

        // 4. 执行移动
        bool moveOk = TryMove(unit, bestMoveCell);
        if (!moveOk) yield break;

        // 🔑 关键：等待状态刷新
        yield return new WaitForSeconds(0.15f);
        yield return new WaitForEndOfFrame();

        // 5. 重新计算攻击范围（使用新位置）
        var realUnit = BoardManager.GetUnitById(unit.unitID);
        var realCell = BoardManager.GetCellFromUnit(realUnit);
        var realTarget = FindBestTargetInRange(realUnit, realCell, targetHint);

        // 6. 执行攻击
        if (realTarget != null) {
            yield return ExecuteAttack(realUnit, realTarget);
        }
    }

    // 智能目标选择（带优先级）
    private UnitBase FindBestTarget(string hint, UnitBase attacker) {
        var enemies = BoardManager.AllUnitsOnBoard
            .Where(u => u.playerID != aiPlayerId)
            .ToList();

        // 优先级排序
        return enemies
            .OrderByDescending(e => ScoreTarget(e, hint, attacker))
            .FirstOrDefault();
    }

    private int ScoreTarget(UnitBase target, string hint, UnitBase attacker) {
        int score = 0;
        var name = target.Name.ToLower();
        
        // 名称匹配
        if (hint.ToLower().Contains(name) || name.Contains(hint.ToLower()))
            score += 100;

        // 优先级目标
        if (name.Contains("cinda")) score += 80;
        if (name.Contains("ash")) score += 70;
        if (name.Contains("hero")) score += 90;

        // 斩杀优先
        if (attacker.GetAttack() >= target.Hp) score += 150;

        // 距离惩罚
        var dist = GetDistance(attacker, target);
        score -= dist * 5;

        return score;
    }

    // 智能移动点选择
    private Cell FindBestMoveToAttack(UnitBase unit, UnitBase target) {
        var startCell = BoardManager.GetCellFromUnit(unit);
        var movableCells = unit.GetMovableCells(startCell);
        
        Cell bestCell = null;
        int bestScore = int.MinValue;

        foreach (var cell in movableCells) {
            if (cell.GetOccupyingUnit() != null) continue;

            int score = 0;

            // 移动后能否攻击到目标
            var rangeFromHere = unit.Skills.Action
                .GetCellsInRange(cell, unit.RangeBonus);
            var targetCell = BoardManager.GetCellFromUnit(target);

            if (rangeFromHere.Contains(targetCell)) {
                score += 200; // 最高优先级
            }

            // 靠近目标
            var distBefore = GetDistance(startCell, targetCell);
            var distAfter = GetDistance(cell, targetCell);
            score += (distBefore - distAfter) * 30;

            // 安全性（避开敌方攻击范围）
            var dangerZones = GetEnemyThreatCells();
            if (dangerZones.Contains(cell)) score -= 50;

            if (score > bestScore) {
                bestScore = score;
                bestCell = cell;
            }
        }

        return bestCell;
    }
}
```

---

## 完整流程示例

### Step 1: LLM 生成意图
```json
{
  "analysis": "Cinda is priority target. Tryx#1 can move and kill.",
  "steps": [
    {
      "type": "advance_and_attack",
      "unit": "Tryx#1",
      "target": "Cinda",
      "intent": "kill"
    },
    {
      "type": "defensive_play",
      "card": "Skeleton",
      "zone": "protect_hero"
    },
    {
      "type": "end_turn"
    }
  ]
}
```

### Step 2: Agent 翻译（生成候选动作）
```typescript
function translateIntent(intent: Intent): ActionDescriptor[] {
  if (intent.type === 'advance_and_attack') {
    return [
      {
        phase: 'move',
        unit: intent.unit,
        strategy: 'closest_to_target',
        target: intent.target
      },
      {
        phase: 'attack',
        unit: intent.unit,
        target: intent.target,
        fallback: 'best_in_range',
        delay: 150 // ms
      }
    ]
  }
}
```

### Step 3: Unity 执行（智能）
```csharp
// 收到 turn_plan
var plan = ParseIntentPlan(json);

foreach (var intent in plan.steps) {
    switch (intent.type) {
        case "advance_and_attack":
            yield return smartExecutor.ExecuteMoveAttackChain(
                intent.unit,
                intent.target,
                intent.intent
            );
            break;
    }
}
```

---

## 关键技术点

### 1. 状态同步策略

```csharp
// 方案A：延迟 + 轮询
yield return new WaitForSeconds(0.15f);
while (!IsBoardStable()) {
    yield return new WaitForEndOfFrame();
}

// 方案B：事件驱动
BoardManager.OnUnitMoved += (unit) => {
    if (unit.unitID == pendingAttacker) {
        TriggerDelayedAttack();
    }
};

// 方案C：强制刷新（最可靠）
private void ForceRefreshUnitPosition(UnitBase unit) {
    var cell = unit.CurrentCell;
    BoardManager.InvalidateCache();
    unit.RefreshPosition();
    return BoardManager.GetCellFromUnit(unit);
}
```

### 2. 失败重试机制

```csharp
private IEnumerator ExecuteAttackWithRetry(
    UnitBase attacker, 
    UnitBase target, 
    int maxRetries = 2
) {
    for (int i = 0; i < maxRetries; i++) {
        // 每次重新计算范围
        var currentCell = BoardManager.GetCellFromUnit(attacker);
        var inRange = attacker.Skills.Action
            .GetCellsInRange(currentCell, attacker.RangeBonus);

        var targetCell = BoardManager.GetCellFromUnit(target);

        if (!inRange.Contains(targetCell)) {
            // 尝试找替代目标
            var alternative = FindBestTargetInRange(attacker, currentCell);
            if (alternative != null) {
                target = alternative;
                targetCell = BoardManager.GetCellFromUnit(target);
            } else {
                yield return new WaitForSeconds(0.1f);
                continue;
            }
        }

        // 执行攻击
        int actionId = 400000 + attacker.unitID * 1000 + target.unitID;
        string reason;
        bool ok = TryApplyExternalAction(actionId, out reason);

        if (ok) {
            Debug.Log($"✅ Attack success on retry {i+1}");
            yield break;
        }

        yield return new WaitForSeconds(0.1f * (i + 1));
    }

    Debug.LogWarning("❌ Attack failed after all retries");
}
```

### 3. 智能降级策略

```csharp
// 当移动→攻击失败时，按优先级降级
private IEnumerator FallbackStrategy(Intent original) {
    // 1. 尝试直接攻击（不移动）
    if (CanAttackNow(original.unit, original.target)) {
        yield return ExecuteAttack(original.unit, original.target);
        yield break;
    }

    // 2. 移动但不攻击（占位）
    if (CanMoveCloser(original.unit, original.target)) {
        yield return ExecuteMove(original.unit, GetCloserCell());
        yield break;
    }

    // 3. 攻击其他目标
    var alternative = FindAlternativeTarget(original.unit);
    if (alternative != null) {
        yield return ExecuteMoveAttack(original.unit, alternative);
        yield break;
    }

    // 4. 完全跳过
    Debug.LogWarning($"Skip action for {original.unit}");
}
```

---

## LLM Prompt 优化

### 旧方案（过于具体）
```
你需要输出精确的 unit_id 和 cell_index...
```

### 新方案（意图导向）
```
你是战略AI，只需描述意图，不用关心具体ID和坐标。

输出格式：
{
  "analysis": "简要分析",
  "steps": [
    {
      "type": "advance_and_attack",
      "unit": "<单位名称，如 Tryx#1>",
      "target": "<目标名称，如 Cinda 或 Hero>",
      "intent": "kill|pressure|trade"
    },
    {
      "type": "defensive_play",
      "card": "<卡牌名称>",
      "zone": "protect_hero|frontline|backline"
    }
  ]
}

可用意图类型：
- advance_and_attack: 移动并攻击目标
- direct_attack: 直接攻击（不移动）
- defensive_play: 防守出牌
- reposition: 重新定位单位
- end_turn: 结束回合

示例：
{
  "steps": [
    {"type": "advance_and_attack", "unit": "Tryx#1", "target": "Cinda", "intent": "kill"},
    {"type": "defensive_play", "card": "Skeleton", "zone": "protect_hero"},
    {"type": "end_turn"}
  ]
}
```

---

## 实施优先级

### Phase 1: 紧急修复（1-2天）
1. ✅ Unity 端添加延迟：`move` 后等待 `0.15s` 再 `attack`
2. ✅ 添加位置刷新：`ForceRefreshUnitPosition()`
3. ✅ 智能降级：攻击失败时选择备选目标

### Phase 2: 架构升级（3-5天）
1. 🔄 实现 `SmartActionExecutor`
2. 🔄 修改 LLM prompt 为意图导向
3. 🔄 Agent 添加意图→动作翻译层

### Phase 3: 完整重构（1-2周）
1. 🚀 完整三层架构
2. 🚀 事件驱动的状态同步
3. 🚀 可视化调试工具

---

## 预期效果

| 指标 | 当前 | Phase 1 | Phase 2 | Phase 3 |
|------|------|---------|---------|---------|
| 移动攻击成功率 | ~30% | ~80% | ~95% | ~99% |
| LLM 推理时间 | 2-4s | 2-4s | 1-2s | 1-2s |
| 平均每回合动作数 | 1-2 | 2-3 | 3-4 | 4-5 |
| 代码可维护性 | 差 | 中 | 良 | 优 |


