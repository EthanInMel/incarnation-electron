# 执行问题修复：Prompt 优化

## 问题总结

从实际运行日志发现：
1. **Hero power 失败**：LLM 输出 hero_power，但能量槽未满
2. **攻击失败**：Unity 线程错误
3. **单步执行**：concrete plan 是逐个动作发送，非批量

---

## 优化后的 Prompt

### 完整版本

```
你是策略卡牌战棋游戏的 AI，目标是击败对方英雄（Hero）并保护己方英雄。

🎯 游戏目标：
- 胜利条件：将敌方英雄 HP 降至 0
- 失败条件：己方英雄 HP 降至 0
- 英雄是场上固定单位，需要部署单位保护己方英雄、攻击敌方英雄

📊 当前战局：
- 己方英雄 HP：{you.hero_hp}/{you.hero_max_hp}，位置：cell_index {you.hero_cell_index}
- 敌方英雄 HP：{opponent.hero_hp}/{opponent.hero_max_hp}，位置：cell_index {opponent.hero_cell_index}
- 己方法力：{you.mana}/{you.max_mana}
- 回合数：{turn}

⚠️ 战术指导：
{tactical_advice}

🔍 CRITICAL - 可用动作检查：
在规划前，必须检查 available_actions 列表，确保每个步骤都有对应的可用动作：
- play_card: 确认 card_id 和 cell_index 在 available_actions 中存在
- move: 确认 unit_id 和 to_cell_index 在 available_actions 中存在
- unit_attack: 确认 attacker_unit_id 和 target_unit_id 的组合在 available_actions 中存在
- hero_power: 仅在 available_actions 包含 hero_power 动作时才输出（能量槽满时才可用）
- 若 available_actions 只有 end_turn，则 steps 只包含 end_turn

严格输出 JSON（不含任何多余文本）：
{
  "turn_plan": {
    "atomic": false,
    "auto_end": true,
    "steps": [
      // 推荐顺序：防御出牌 -> 进攻出牌 -> 移动 -> 攻击
      { "type": "play_card",   "card_id": number, "to": { "cell_index": number } },
      { "type": "move",        "unit_id": number, "to": { "cell_index": number } },
      { "type": "unit_attack", "attacker_unit_id": number, "target_unit_id": number }
      // 注意：不要输出 hero_power 除非 available_actions 明确包含它
      // 注意：不要输出 end_turn，auto_end=true 会自动追加
    ]
  },
  "rationale": "<=30字简要理由（需说明是防守还是进攻）"
}

📋 详细约束：

1. 动作合法性（最重要）：
   - 每个 step 必须对应 available_actions 中的一个具体动作
   - play_card: (card_id, cell_index) 组合必须在 available_actions 的 play_card 列表中
   - unit_attack: (attacker_unit_id, target_unit_id) 组合必须在 available_actions 的 unit_attack 列表中
   - hero_power: 仅当 available_actions 包含 hero_power 时才能使用（能量槽满才有）
   - 若不确定某动作是否可用，宁可不输出该动作

2. 坐标格式：
   - 只使用 {"cell_index": number}，不要用 rXcY / row,col

3. 💡 移动+攻击组合（利用 tactical_preview）：
   - 检查 tactical_preview：找到 unit_id 匹配的条目
   - 该条目的 to_cell_index 表示移动目标，attacks 列表表示移动后可攻击的目标
   - 先输出 move 步骤，再输出 unit_attack 步骤
   - 示例：
     tactical_preview: [{"unit_id":101, "from_cell_index":20, "to_cell_index":45, "attacks":[{"target_unit_id":201}]}]
     → step1: {"type":"move", "unit_id":101, "to":{"cell_index":45}}
     → step2: {"type":"unit_attack", "attacker_unit_id":101, "target_unit_id":201}
   - 重要：移动后攻击必须在同一 turn_plan 中，否则单位状态不一致

4. 出牌位置策略：
   - 防御型单位（高 HP 低攻击）：选择靠近己方英雄的 cell_index
     * 计算方法：从 available_actions 的 play_card 选项中，选择 cell_index 与 {you.hero_cell_index} 差值最小的
   - 进攻型单位（高攻击）：选择靠近敌方英雄的 cell_index
     * 计算方法：选择 cell_index 与 {opponent.hero_cell_index} 差值最小的

5. 攻击目标优先级：
   1. 若敌方英雄 HP <= 己方单位总攻击力 → 集火敌方英雄（target_unit_id 为敌方英雄单位 ID 或特殊值）
   2. 威胁己方英雄的敌方单位（距离近、攻击力高）→ 优先清除
   3. 高价值敌方单位（高攻击、低 HP 易击杀）→ 其次清除
   4. 若无明确威胁 → 削弱敌方场面或攻击英雄

6. 资源管理：
   - 法力限制：出牌总 mana_cost 不能超过 {you.mana}
   - 同一单位每回合最多移动一次、攻击一次（但可以先移动再攻击）
   - 优先使用高性价比动作（法力效率、场面收益）

7. 批量规划原则：
   - atomic=false: 步骤逐个执行，某步失败不影响后续步骤
   - auto_end=true: 自动在最后追加 end_turn，不需要手动输出
   - 建议每回合规划 2-5 个步骤（不含 end_turn）
   - 步骤顺序很重要：先出牌建立场面 → 再移动调整站位 → 最后攻击清除威胁

8. 禁止事项：
   - ❌ 不要输出 available_actions 中不存在的动作（如能量不足时的 hero_power）
   - ❌ 不要臆造 ID：所有 card_id, unit_id, cell_index, target_unit_id 必须来自输入数据
   - ❌ 不要输出 {"action": {...}} 或 "Action: <id>" 格式
   - ❌ 不要输出 end_turn（auto_end 会自动追加）
   - ❌ 不要在 move 之前 attack 同一单位（会失败）

9. 若 snapshot.is_my_turn=false，输出：
   {
     "turn_plan": { "atomic": false, "auto_end": false, "steps": [] },
     "rationale": "非我方回合"
   }
```

---

## 关键改进点

### 1. 强化动作合法性检查（解决 hero_power 问题）

```diff
+ 🔍 CRITICAL - 可用动作检查：
+ 在规划前，必须检查 available_actions 列表
+ - hero_power: 仅在 available_actions 包含 hero_power 动作时才输出（能量槽满时才可用）
+ - 若不确定某动作是否可用，宁可不输出该动作

+ 1. 动作合法性（最重要）：
+    - hero_power: 仅当 available_actions 包含 hero_power 时才能使用
+    - 若不确定某动作是否可用，宁可不输出该动作
```

**效果**：LLM 会先检查 available_actions，确认 hero_power 存在才输出

### 2. 改用批量模式 atomic=false（解决执行时序问题）

```diff
- "atomic": true,   // 全部成功或全部失败
+ "atomic": false,  // 逐个执行，某步失败不影响后续
```

**原因**：
- `atomic: true` 下，任何一步失败会导致整个计划回滚
- `atomic: false` 更宽容，部分成功也能推进游戏
- 从日志看，Unity 端已经在用 `atomic=false`，Prompt 应匹配

### 3. 强调移动+攻击必须在同一 turn_plan（解决状态同步问题）

```diff
+ - 重要：移动后攻击必须在同一 turn_plan 中，否则单位状态不一致
```

**原因**：如果 move 和 attack 分开发送，中间状态可能导致攻击失败

### 4. 移除 end_turn 输出（由 auto_end 处理）

```diff
+ - auto_end=true: 自动在最后追加 end_turn，不需要手动输出
+ - ❌ 不要输出 end_turn（auto_end 会自动追加）
```

**效果**：减少 LLM 输出错误，简化逻辑

---

## 代码层面优化

### 在 llm.ts 中添加动作过滤

```typescript
export function buildIntentPrompt(snapshot:any, observation:any, actions:any[], buildActionsForPrompt:(acts:any[])=>any[]) {
  try {
    // ... 原有逻辑
    
    // 新增：统计可用动作类型
    const actionTypes = {
      play_card: actions.filter(a => a?.play_card).length,
      move: actions.filter(a => a?.move_unit).length,
      unit_attack: actions.filter(a => a?.unit_attack).length,
      hero_power: actions.filter(a => a?.hero_power).length,
      end_turn: actions.filter(a => a?.end_turn).length,
    };
    
    // 战术建议（根据可用动作）
    let tacticalAdvice = '';
    const youHeroHP = snapshot?.you?.hero_hp || 0;
    const oppHeroHP = snapshot?.opponent?.hero_hp || 0;
    const yourMana = snapshot?.you?.mana || 0;
    
    if (youHeroHP < 10 && actionTypes.play_card > 0) {
      tacticalAdvice = '🛡️ 紧急防守！己方英雄受威胁，优先部署防御单位。';
    } else if (oppHeroHP <= 8 && actionTypes.unit_attack > 0) {
      tacticalAdvice = '⚔️ 进攻机会！敌方英雄低血量，集火攻击。';
    } else if (yourMana >= 5 && actionTypes.play_card > 0) {
      tacticalAdvice = '⚖️ 平衡发展：优先出牌建立场面，再考虑攻击。';
    } else if (actionTypes.unit_attack > 0) {
      tacticalAdvice = '🎯 利用场面：用现有单位攻击清除威胁。';
    } else {
      tacticalAdvice = '⏭️ 资源不足或无可行动作，准备结束回合。';
    }
    
    // 在 prompt 中显示可用动作统计
    const availableActionsSummary = `
可用动作统计：
- 出牌选项：${actionTypes.play_card} 个
- 移动选项：${actionTypes.move} 个
- 攻击选项：${actionTypes.unit_attack} 个
- 英雄技能：${actionTypes.hero_power > 0 ? '✅ 可用' : '❌ 未就绪（能量不足）'}
⚠️ 只能从以上可用动作中选择！
`;
    
    const parts: string[] = [];
    parts.push(promptTemplate); // 上面的完整 prompt
    parts.push(availableActionsSummary);
    parts.push('战局观测（JSON）:');
    parts.push(JSON.stringify(observation, null, 0));
    
    const pruned = buildActionsForPrompt(actions);
    parts.push('available_actions（精简JSON，必须从中选择）:');
    parts.push(JSON.stringify(pruned, null, 0));
    
    parts.push('请输出严格 JSON turn_plan。');
    return parts.join('\n');
  } catch {
    return '请输出严格 JSON 意图';
  }
}
```

### 在 AgentModule.ts 中添加执行前验证

```typescript
#validateTurnPlan(plan: any, actions: any[]): {valid: boolean; errors: string[]} {
  const errors: string[] = [];
  
  if (!plan?.steps || !Array.isArray(plan.steps)) {
    return {valid: false, errors: ['No steps array']};
  }
  
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const t = String(step?.type || '').toLowerCase();
    
    switch (t) {
      case 'play_card': {
        const cid = Number(step.card_id);
        const cell = Number(step?.to?.cell_index);
        const exists = actions.some(a => 
          a?.play_card && 
          Number(a.play_card.card_id) === cid && 
          Number(a.play_card.cell_index) === cell
        );
        if (!exists) {
          errors.push(`Step ${i}: play_card(${cid}, ${cell}) not in available_actions`);
        }
        break;
      }
      
      case 'hero_power': {
        const exists = actions.some(a => a?.hero_power);
        if (!exists) {
          errors.push(`Step ${i}: hero_power not available (energy not ready)`);
          // 可以选择跳过这一步，而不是整个计划失败
          plan.steps.splice(i, 1);
          i--;
        }
        break;
      }
      
      case 'unit_attack': {
        const att = Number(step.attacker_unit_id);
        const tgt = Number(step.target_unit_id);
        const exists = actions.some(a => 
          a?.unit_attack && 
          Number(a.unit_attack.attacker_unit_id) === att && 
          Number(a.unit_attack.target_unit_id) === tgt
        );
        if (!exists) {
          errors.push(`Step ${i}: unit_attack(${att} -> ${tgt}) not in available_actions`);
        }
        break;
      }
    }
  }
  
  return {valid: errors.length === 0, errors};
}

// 在发送 turn_plan 前调用
#tryHandleTurnPlan(intent: any, snapshot: any, actions: any[]) {
  try {
    const plan = intent?.turn_plan;
    if (!plan || !Array.isArray(plan.steps)) return false;
    
    // 验证计划
    const validation = this.#validateTurnPlan(plan, actions);
    if (!validation.valid) {
      console.warn('[agent] Turn plan validation failed:', validation.errors);
      try {
        this.#broadcast('decision_log', {
          warn: 'Turn plan has invalid steps',
          errors: validation.errors,
          plan
        });
      } catch {}
      
      // 可以选择：
      // 1. 拒绝整个计划：return false
      // 2. 移除无效步骤，继续执行有效部分（上面已在 validate 中处理）
    }
    
    // ... 其余发送逻辑
  } catch { return false; }
}
```

---

## 测试验证

### 测试场景 1: Hero Power 未就绪

**输入**:
```json
available_actions: [
  {"id": 1, "play_card": {...}},
  {"id": 2, "unit_attack": {...}},
  {"id": 999, "end_turn": true}
  // 注意：没有 hero_power
]
```

**期望输出**:
```json
{
  "turn_plan": {
    "atomic": false,
    "auto_end": true,
    "steps": [
      {"type": "play_card", "card_id": 10, "to": {"cell_index": 20}},
      {"type": "unit_attack", "attacker_unit_id": 5, "target_unit_id": 8}
      // ✅ 没有 hero_power
    ]
  },
  "rationale": "清除威胁单位"
}
```

### 测试场景 2: 移动+攻击组合

**输入**:
```json
tactical_preview: [
  {
    "unit_id": 31,
    "from_cell_index": 20,
    "to_cell_index": 45,
    "attacks": [
      {"target_unit_id": 5, "target_name": "Cinda"}
    ]
  }
]
```

**期望输出**:
```json
{
  "turn_plan": {
    "atomic": false,
    "auto_end": true,
    "steps": [
      {"type": "move", "unit_id": 31, "to": {"cell_index": 45}},
      {"type": "unit_attack", "attacker_unit_id": 31, "target_unit_id": 5}
      // ✅ 在同一 turn_plan 中，顺序正确
    ]
  },
  "rationale": "移动 Lycan 击杀 Cinda"
}
```

---

## Unity 端攻击失败问题

对于 Unity 线程错误：
```
FAIL(get_time can only be called from the main thread...)
```

这可能是执行器问题，建议 Unity 端检查：

1. **确保攻击动作在主线程执行**
```csharp
// 在 Unity 攻击处理中
void ExecuteUnitAttack(int attackerId, int targetId) {
    // 确保在主线程
    if (!UnityEngine.Application.isPlaying) return;
    
    // 使用 Dispatcher 或 MainThreadQueue
    MainThreadDispatcher.Enqueue(() => {
        var attacker = FindUnitById(attackerId);
        var target = FindUnitById(targetId);
        
        if (attacker != null && target != null) {
            attacker.Attack(target);
        }
    });
}
```

2. **添加状态检查**
```csharp
// 确保单位存在且可攻击
if (attacker == null || target == null) {
    SendActionError(actionId, "Unit not found");
    return;
}

if (!attacker.CanAttack) {
    SendActionError(actionId, "Unit cannot attack (already attacked or no energy)");
    return;
}
```

---

## 总结

优化要点：
1. ✅ **强化动作合法性检查**：LLM 必须从 available_actions 选择
2. ✅ **显示动作可用性**：明确告知 hero_power 是否可用
3. ✅ **改用 atomic=false**：部分失败不影响整体
4. ✅ **批量规划**：移动+攻击在同一 turn_plan
5. ✅ **添加验证层**：执行前检查，过滤无效步骤

预期效果：
- Hero power 只在可用时输出
- 攻击动作都是合法的（在 available_actions 中）
- 减少执行失败率
