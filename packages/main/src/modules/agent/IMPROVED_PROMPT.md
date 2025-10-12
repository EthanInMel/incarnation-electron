# 改进版提示词

## 优化后的版本

```
你是策略卡牌战棋游戏的 AI，目标是击败对方英雄（Hero）并保护己方英雄。

🎯 游戏目标：
- 胜利条件：将敌方英雄 HP 降至 0
- 失败条件：己方英雄 HP 降至 0
- 英雄是场上固定单位，需要部署单位保护己方英雄、攻击敌方英雄

📊 当前战局（从 snapshot 获取）：
- 己方英雄 HP：{you.hero_hp}，位置：{you.hero_cell_index}
- 敌方英雄 HP：{opponent.hero_hp}，位置：{opponent.hero_cell_index}
- 己方法力：{you.mana}
- 回合数：{turn}

⚠️ 战术指导：
- 若己方英雄 HP < 敌方单位总攻击力，优先部署防御单位（在己方英雄附近的 cell_index）
- 若敌方英雄 HP < 己方单位总攻击力，优先发动进攻（攻击敌方英雄或其保护单位）
- 优先利用 tactical_preview 中"移动后可攻击"的机会

严格输出 JSON（不含任何多余文本）：
{
  "turn_plan": {
    "atomic": true,
    "auto_end": true,
    "steps": [
      // 推荐顺序：防御出牌 -> 进攻出牌 -> 移动 -> 攻击 -> 英雄技能
      { "type": "play_card",   "card_id": number, "to": { "cell_index": number } },
      { "type": "move",        "unit_id": number, "to": { "cell_index": number } },
      { "type": "unit_attack", "attacker_unit_id": number, "target_unit_id": number },
      { "type": "hero_power" },
      { "type": "end_turn" }
    ]
  },
  "rationale": "<=30字简要理由（需说明是防守还是进攻）"
}

约束：
- 只使用 snapshot、available_actions、tactical_preview 中出现的 ID 与坐标；不要臆造。
- 坐标仅使用 {"cell_index": number}；不要输出 rXcY / row,col。
- 每一步必须可执行：
  * play_card：card_id 必须在 snapshot.you.hand 中，cell_index 必须在 available_actions 的对应 play_card 动作中
  * move：unit_id 必须是己方单位，to_cell_index 必须在 available_actions 中
  * unit_attack：attacker_unit_id 必须是己方单位且可攻击，target_unit_id 必须是敌方单位或不填（攻击英雄）
  
- 💡 移动+攻击组合技巧：
  * 检查 tactical_preview：找到 unit_id 匹配的条目
  * 该条目显示从某位置移动到 to_cell_index 后，可以攻击 attacks 列表中的目标
  * 先输出 move 步骤（to: {cell_index: to_cell_index}）
  * 再输出 unit_attack 步骤（target_unit_id 从 attacks 列表选择）
  * 示例：
    tactical_preview: [{"unit_id":101, "to_cell_index":45, "attacks":[{"target_unit_id":201}]}]
    → step1: {"type":"move", "unit_id":101, "to":{"cell_index":45}}
    → step2: {"type":"unit_attack", "attacker_unit_id":101, "target_unit_id":201}

- 出牌位置策略：
  * 防御型单位（高 HP 低攻击）：选择靠近己方英雄 cell_index 的位置
  * 进攻型单位（高攻击）：选择靠近敌方英雄 cell_index 的位置
  * 可从 available_actions 的 play_card 列表中选择合适的 cell_index

- 攻击目标优先级：
  1. 若敌方英雄 HP 低且可击杀 → 优先攻击敌方英雄（target_unit_id 留空或为 null）
  2. 威胁己方英雄的近距离敌方单位 → 优先清除
  3. 高价值/高攻击的敌方单位 → 其次清除
  4. 若无明确威胁 → 攻击敌方英雄

- 资源管理：
  * 法力限制：出牌总 mana_cost 不能超过 snapshot.you.mana
  * 同一单位每回合最多移动一次、攻击一次（但可以先移动再攻击）
  * 若法力不足以做有意义的动作，考虑保留法力并 end_turn

- 必须以 end_turn 收尾；若没有合理行动，steps 为空（auto_end=true 自动追加 end_turn）

- 禁止输出动作 id；禁止输出 { "action": {...} } 或 "Action: <id>"；只输出上述 JSON 结构

- 若 snapshot.is_my_turn=false，输出：
  {
    "turn_plan": { "atomic": true, "auto_end": false, "steps": [] },
    "rationale": "非我方回合"
  }
```

---

## 关键改进点

### 1. 明确游戏目标（解决问题1）
```diff
+ 🎯 游戏目标：
+ - 胜利条件：将敌方英雄 HP 降至 0
+ - 失败条件：己方英雄 HP 降至 0
+ - 英雄是场上固定单位，需要部署单位保护己方英雄、攻击敌方英雄
```

**效果**：LLM 明确知道英雄的重要性和游戏目标

### 2. 显示英雄状态（解决问题1）
```diff
+ 📊 当前战局（从 snapshot 获取）：
+ - 己方英雄 HP：{you.hero_hp}，位置：{you.hero_cell_index}
+ - 敌方英雄 HP：{opponent.hero_hp}，位置：{opponent.hero_cell_index}
```

**实现**：在构建 prompt 时动态填充实际数值
```typescript
const prompt = systemPrompt
  .replace('{you.hero_hp}', String(snapshot?.you?.hero_hp || 0))
  .replace('{opponent.hero_hp}', String(snapshot?.opponent?.hero_hp || 0))
  .replace('{you.hero_cell_index}', String(snapshot?.you?.hero_cell_index || 'N/A'))
  // ...
```

### 3. 战术指导（解决问题1+2）
```diff
+ ⚠️ 战术指导：
+ - 若己方英雄 HP < 敌方单位总攻击力，优先部署防御单位（在己方英雄附近的 cell_index）
+ - 若敌方英雄 HP < 己方单位总攻击力，优先发动进攻（攻击敌方英雄或其保护单位）
```

**效果**：LLM 根据血量自动选择防守/进攻策略

### 4. 出牌位置策略（解决问题2）
```diff
+ - 出牌位置策略：
+   * 防御型单位（高 HP 低攻击）：选择靠近己方英雄 cell_index 的位置
+   * 进攻型单位（高攻击）：选择靠近敌方英雄 cell_index 的位置
+   * 可从 available_actions 的 play_card 列表中选择合适的 cell_index
```

**效果**：虽然只有 cell_index，但 LLM 知道要根据"距离英雄远近"选择位置

### 5. 移动+攻击详细示例（解决问题3）
```diff
+ - 💡 移动+攻击组合技巧：
+   * 检查 tactical_preview：找到 unit_id 匹配的条目
+   * 先输出 move 步骤（to: {cell_index: to_cell_index}）
+   * 再输出 unit_attack 步骤（target_unit_id 从 attacks 列表选择）
+   * 示例：
+     tactical_preview: [{"unit_id":101, "to_cell_index":45, "attacks":[{"target_unit_id":201}]}]
+     → step1: {"type":"move", "unit_id":101, "to":{"cell_index":45}}
+     → step2: {"type":"unit_attack", "attacker_unit_id":101, "target_unit_id":201}
```

**效果**：LLM 清楚知道如何利用 tactical_preview，先 move 再 attack

### 6. 攻击目标优先级（综合优化）
```diff
+ - 攻击目标优先级：
+   1. 若敌方英雄 HP 低且可击杀 → 优先攻击敌方英雄
+   2. 威胁己方英雄的近距离敌方单位 → 优先清除
+   3. 高价值/高攻击的敌方单位 → 其次清除
+   4. 若无明确威胁 → 攻击敌方英雄
```

**效果**：明确的决策框架

---

## 对比：原版 vs 改进版

| 方面 | 原版 ❌ | 改进版 ✅ |
|-----|---------|---------|
| **游戏目标** | 没有提及 | 明确"击败敌方英雄，保护己方英雄" |
| **英雄状态** | 没有显示 | 显示双方英雄 HP 和位置 |
| **战术指导** | 没有 | 根据血量给出防守/进攻建议 |
| **位置策略** | 只说"cell_index" | 明确"防御=靠近己方英雄，进攻=靠近敌方英雄" |
| **移动攻击** | 有约束但无示例 | 详细示例+步骤说明 |
| **攻击优先级** | 没有 | 4 级优先级框架 |
| **rationale** | "<=20字" | "<=30字（需说明防守/进攻）" |

---

## 实现示例

### 在代码中使用

```typescript
// 在 AgentModule.ts 或 llm.ts 中
function buildTurnPlanPrompt(snapshot: any, actions: any[], tacticalPreview: any[]) {
  // 基础模板（如上）
  const template = `你是策略卡牌战棋游戏的 AI，目标是击败对方英雄（Hero）并保护己方英雄。
  
🎯 游戏目标：...（省略）
  
📊 当前战局：
- 己方英雄 HP：{you.hero_hp}，位置：{you.hero_cell_index}
- 敌方英雄 HP：{opponent.hero_hp}，位置：{opponent.hero_cell_index}
- 己方法力：{you.mana}
- 回合数：{turn}

⚠️ 战术指导：
{tactical_advice}

...（其余约束）`;

  // 动态填充
  const youHeroHP = snapshot?.you?.hero_hp || 0;
  const oppHeroHP = snapshot?.opponent?.hero_hp || 0;
  const yourMana = snapshot?.you?.mana || 0;
  
  // 计算威胁度
  const enemyTotalATK = (snapshot?.enemy_units || [])
    .reduce((sum: number, u: any) => sum + (Number(u?.atk) || 0), 0);
  
  let tacticalAdvice = '';
  if (youHeroHP < enemyTotalATK && youHeroHP < 10) {
    tacticalAdvice = '🛡️ 紧急防守！己方英雄受威胁，优先部署防御单位在靠近己方英雄的位置。';
  } else if (oppHeroHP <= 5) {
    tacticalAdvice = '⚔️ 进攻机会！敌方英雄低血量，优先攻击敌方英雄。';
  } else if (yourMana >= 5) {
    tacticalAdvice = '⚖️ 平衡发展：优先出牌建立场面优势，再考虑攻击。';
  } else {
    tacticalAdvice = '🎯 节约资源：法力不足，优先利用现有单位攻击。';
  }
  
  const prompt = template
    .replace('{you.hero_hp}', String(youHeroHP))
    .replace('{you.hero_cell_index}', String(snapshot?.you?.hero_cell_index || 'N/A'))
    .replace('{opponent.hero_hp}', String(oppHeroHP))
    .replace('{opponent.hero_cell_index}', String(snapshot?.opponent?.hero_cell_index || 'N/A'))
    .replace('{you.mana}', String(yourMana))
    .replace('{turn}', String(snapshot?.turn || 0))
    .replace('{tactical_advice}', tacticalAdvice);
  
  // 添加数据部分
  const dataSection = `
  
📦 数据（JSON 格式）：

snapshot: ${JSON.stringify({
    turn: snapshot?.turn,
    is_my_turn: snapshot?.is_my_turn,
    you: {
      hero_hp: youHeroHP,
      hero_cell_index: snapshot?.you?.hero_cell_index,
      mana: yourMana,
      hand: snapshot?.you?.hand
    },
    opponent: {
      hero_hp: oppHeroHP,
      hero_cell_index: snapshot?.opponent?.hero_cell_index
    },
    self_units: snapshot?.self_units,
    enemy_units: snapshot?.enemy_units
  }, null, 2)}

available_actions (sample): ${JSON.stringify(actions.slice(0, 30), null, 2)}

tactical_preview: ${JSON.stringify(tacticalPreview.slice(0, 10), null, 2)}
`;
  
  return prompt + dataSection;
}
```

---

## 测试对比

### 测试场景 1：己方英雄低血量

**原版输出可能**:
```json
{
  "turn_plan": {
    "steps": [
      {"type": "play_card", "card_id": 1, "to": {"cell_index": 70}},  // ❌ 位置随机
      {"type": "end_turn"}
    ]
  },
  "rationale": "出牌"
}
```

**改进版输出**:
```json
{
  "turn_plan": {
    "steps": [
      {"type": "play_card", "card_id": 1, "to": {"cell_index": 20}},  // ✅ 靠近己方英雄(18)
      {"type": "end_turn"}
    ]
  },
  "rationale": "防守：己方英雄8HP受威胁，部署防御"
}
```

### 测试场景 2：移动攻击机会

**原版输出可能**:
```json
{
  "turn_plan": {
    "steps": [
      {"type": "unit_attack", "attacker_unit_id": 101, "target_unit_id": 201}  // ❌ 忽略移动
    ]
  }
}
```

**改进版输出**:
```json
{
  "turn_plan": {
    "steps": [
      {"type": "move", "unit_id": 101, "to": {"cell_index": 45}},              // ✅ 先移动
      {"type": "unit_attack", "attacker_unit_id": 101, "target_unit_id": 201}, // ✅ 再攻击
      {"type": "end_turn"}
    ]
  },
  "rationale": "进攻：利用移动+攻击清除威胁单位"
}
```

---

## 额外建议

### 1. 添加"负面案例"示例
在约束中添加错误示例：
```
❌ 错误示例（不要模仿）：
- {"type":"play_card", "card_id":999, ...}  // 臆造 ID
- {"type":"move", "unit_id":101, "to":{"row":5,"col":3}}  // 错误格式
- 先攻击再移动  // 违反逻辑（攻击后无法移动）
```

### 2. 强调 atomic=true 的含义
```
- atomic: true 表示所有步骤要么全部执行，要么全部回滚
- 因此每一步必须确保可执行，否则整个计划失败
```

### 3. 限制步骤数量
```
- 推荐每回合规划 3-6 个步骤（不含 end_turn）
- 步骤过多可能导致执行失败或超时
```

---

## 总结

改进版提示词的核心优化：
1. ✅ **英雄意识**：明确游戏目标，显示英雄状态，战术指导
2. ✅ **方位感知**：虽然只有 cell_index，但指导"靠近/远离英雄"
3. ✅ **移动攻击**：详细示例+步骤说明+优先级提示
4. ✅ **决策框架**：攻击优先级、资源管理、位置策略

建议在 `buildIntentPrompt` 或类似函数中应用这些改进。
