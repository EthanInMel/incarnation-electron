# 快速参考：LLM 策略优化关键改动

## 🎯 核心改进

### 1️⃣ 英雄意识 (Hero Awareness)

**问题**: LLM 不知道英雄的重要性  
**解决**: 
- ✅ System prompt 明确说明：`WIN CONDITION: Reduce enemy Hero HP to 0 while protecting YOUR Hero`
- ✅ 每次决策显示双方英雄 HP 和位置
- ✅ 根据英雄 HP 给出战术建议（低血量→防守，敌方低血量→进攻）

**代码位置**: `llm.ts:85-93` (system prompt), `llm.ts:40-44` (game state)

---

### 2️⃣ 方位理解 (Spatial Awareness)

**问题**: front/back 方向混淆，保护英雄的单位下错位置  
**解决**:
- ✅ 使用 `defensive_*` 代替 `back_*` → 明确表示"保护己方英雄的后排"
- ✅ 使用 `offensive_*` 代替 `front_*` → 明确表示"进攻敌方英雄的前排"
- ✅ 添加说明：`🛡️ IMPORTANT: "defensive" = near YOUR Hero (back row)`

**代码位置**: `llm.ts:49-52` (hint 定义), `placement.ts:24-26` (scorer)

**新的 hint 选项**:
```
defensive_left | defensive_center | defensive_right  ← 保护己方英雄
mid_left | mid_center | mid_right                    ← 中场
offensive_left | offensive_center | offensive_right  ← 进攻敌方英雄
```

---

### 3️⃣ 移动攻击组合 (Move+Attack Combos)

**问题**: 移动后攻击很难执行，tactical_preview 被删除  
**解决**:
- ✅ 策略层提供移动攻击机会摘要（不含详细坐标）
- ✅ Prompt 中显示：`💡 Skeleton#1 can attack: Ash or Hero`
- ✅ LLM 知道某些单位可以移动后自动攻击

**代码位置**: 
- `AgentModule.ts:1720-1762` (提取摘要)
- `llm.ts:76-82` (显示机会)

**工作流程**:
1. Unity 发送 tactical_preview（详细数据）
2. `#buildPolicyObservation` 转换为简单摘要
3. LLM 看到摘要，选择攻击目标
4. 执行层自动处理移动（AgentModule.ts:585-603）

---

## 📊 改动前后对比

| 方面 | 改动前 ❌ | 改动后 ✅ |
|-----|---------|---------|
| **英雄概念** | "protecting face" (模糊) | "Reduce enemy Hero HP to 0 while protecting YOUR Hero" (明确) |
| **HP 显示** | 不显示 | `YOUR HERO HP: 8, ENEMY HERO HP: 12` |
| **方位 hint** | `back_center` (歧义) | `defensive_center` (明确=保护己方) |
| **移动攻击** | 禁止，看不到机会 | 显示机会："Skeleton can attack: Ash or Hero" |
| **单位信息** | `Skeleton(5/5)` | `Skeleton#1(hp:5/5, atk:2 ⚔️)` |

---

## 🧪 快速测试

### 测试英雄保护 (30秒)
```
1. 让己方英雄 HP < 5
2. 观察 LLM 输出的 hint
3. 期望：defensive_center / defensive_left / defensive_right
```

### 测试移动攻击 (1分钟)
```
1. 场上有己方单位 + 敌方单位
2. 打开控制台，搜索 "Move→Attack Opportunities"
3. 期望：显示 "Skeleton#1 can attack: Ash"
4. 观察 LLM 是否选择攻击 Ash
```

### 测试方位正确性 (1分钟)
```
1. 手动触发几次决策
2. 观察 defensive 单位是否下在后排（靠近己方英雄）
3. 观察 offensive 单位是否下在前排（靠近敌方英雄）
```

---

## 🔍 调试技巧

### 查看 LLM 看到的 Prompt
在 `llm.ts:76-83` 添加调试日志：
```typescript
console.log('[DEBUG] Policy Prompt:', rules)
```

### 查看移动攻击机会
在 `AgentModule.ts:1743` 添加日志：
```typescript
console.log('[DEBUG] Move-Attack Opportunities:', moveAttackOpps)
```

### 查看 hint 评分
在 `placement.ts:30` 添加日志：
```typescript
console.log(`[DEBUG] Hint "${txt}" → region=${regionPref}, score=${s}`)
```

---

## 💡 提示词示例

### LLM 现在看到的 Prompt（简化）

```
🎯 CRITICAL: Return ONLY valid JSON

🏆 GAME STATE:
- YOUR HERO HP: 8 (at r2c4)
- ENEMY HERO HP: 12 (at r8c4)
- ⚠️ If your Hero HP is low, prioritize DEFENSE!

📝 Step Types:
1. Play: { "type": "play", "card": "Skeleton", "hint": "defensive_center" }
   🛡️ "defensive" = near YOUR Hero (back row)
   
2. Attack: { "type": "attack", "attacker": "Skeleton#1", "target": "Ash#1" }
   💡 Some units can move-then-attack automatically

🎮 Available cards: Skeleton(cost:1), Tryx(cost:2)
    (Your mana: 5)

🎮 Your units: Skeleton#1(hp:5/5, atk:2 ⚔️)

🎯 Enemy units: Ash#1(hp:4/4, atk:3), Crossbowman#1(hp:2/2, atk:1)

💡 Move→Attack Opportunities:
- Skeleton#1 can attack: Ash#1 or Hero
  (These units can move AND attack in sequence!)
```

### LLM 输出示例

```json
{
  "analysis": "Enemy Ash threatens our Hero (only 2 rows away). Deploy Skeleton to block.",
  "steps": [
    {
      "type": "play",
      "card": "Skeleton",
      "hint": "defensive_center"
    },
    {
      "type": "attack",
      "attacker": "Skeleton#1",
      "target": "Ash#1"
    },
    {
      "type": "end_turn"
    }
  ]
}
```

---

## 📋 关键配置

### 默认配置 (AgentModule.ts:50-91)
```typescript
{
  model: 'gpt-4o-mini',
  temperature: 0.15,      // 较低 = 更稳定
  maxTokens: 512,         // prompt + response
  maxSteps: 6,            // 每回合最多 6 步
  decisionMode: 'intent', // 使用 intent 模式
}
```

### 推荐调整
- 如果 LLM 输出太保守 → `temperature: 0.2 - 0.25`
- 如果超时频繁 → `maxSteps: 4 - 5`
- 如果想要批量执行 → `decisionMode: 'hierarchical'`

---

## ⚠️ 注意事项

1. **英雄位置计算依赖 snapshot 数据正确**
   - 检查 `snapshot?.self?.hero_cell_index` 是否存在
   - 如果为 null，英雄位置不会显示

2. **移动攻击机会依赖 tactical_preview**
   - Unity 端需要发送 tactical_preview 数据
   - 检查 `this.#lastTacticalPreview` 是否有数据

3. **Hint 语义向后兼容**
   - `placement.ts` 仍支持旧的 front/back 关键词
   - 逐步迁移到 defensive/offensive

4. **Label 去重**
   - 相同名字的单位现在标记为 `Skeleton#1`, `Skeleton#2`
   - 确保 LLM 输出匹配这些 label

---

## 📚 相关文档

- **详细方案**: `OPTIMIZATION_PLAN.md`
- **改动总结**: `CHANGES_SUMMARY.md`
- **代码位置**: 
  - `llm.ts` - Prompt 构建
  - `placement.ts` - 位置评分
  - `AgentModule.ts` - 观察构建、执行流程

---

## 🚀 后续优化

如果当前改动效果好，可以继续：
- [ ] 添加单位战术角色标注 (`tactical_role: 'hero_protector'`)
- [ ] 优化批量执行，一次 LLM 调用规划整个回合
- [ ] 根据游戏阶段（early/mid/late）调整策略
- [ ] 为特定卡牌添加知识库（knowledge base）

---

**快速开始**: 运行游戏 → 观察控制台日志 → 检查 LLM 是否使用 `defensive_*` hint → 验证单位是否下在正确位置 ✅
