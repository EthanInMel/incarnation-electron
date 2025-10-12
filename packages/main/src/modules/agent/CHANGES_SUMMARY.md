# LLM 策略优化改动总结

## 已实施的改动 (Phase 1 完成)

### ✅ 1. 增强英雄感知和游戏目标

**文件**: `llm.ts`

#### 改动 1.1: 强化 system prompt
- **位置**: `buildPolicyPrompt()` 的 systemPrompt (行 85-93)
- **改动**:
  ```typescript
  // 之前：
  'You are a tactical AI for a card battler game.'
  'Focus on: playing key threats, removing dangerous enemies, protecting face.'
  
  // 现在：
  'You are a tactical AI for a HERO-BASED card battler game.'
  '🎯 WIN CONDITION: Reduce enemy Hero HP to 0 while protecting YOUR Hero.'
  'Heroes are fixed units on the board - deploy units to SHIELD your Hero and STRIKE enemy Hero.'
  'Strategy priority: 1) Protect your Hero from enemy units, 2) Remove threats, 3) Attack enemy Hero.'
  ```
- **效果**: LLM 现在明确知道游戏目标是保护己方英雄并杀死对方英雄

#### 改动 1.2: 在 prompt 中显示英雄状态
- **位置**: `buildPolicyPrompt()` 的 rules (行 40-44)
- **新增内容**:
  ```typescript
  '🏆 GAME STATE:',
  `- YOUR HERO HP: ${observation?.you?.hero_hp || 0} (at ${observation.you.hero_position})`,
  `- ENEMY HERO HP: ${observation?.opponent?.hero_hp || 0} (at ${observation.opponent.hero_position})`,
  '- ⚠️ If your Hero HP is low, prioritize DEFENSE! Deploy units to block enemy attacks.',
  '- 🎯 If enemy Hero HP is low, prioritize OFFENSE! Attack enemy Hero to win!',
  ```
- **效果**: LLM 每次决策时都能看到双方英雄的 HP 和位置，并有明确的战术指导

#### 改动 1.3: 改进单位信息展示
- **位置**: rules 中的单位列表 (行 70-74)
- **改动**:
  ```typescript
  // 之前：
  '🎮 Your units: Skeleton(5/5), Tryx(3/3)'
  
  // 现在：
  '🎮 Your units: Skeleton#1(hp:5/5, atk:2 ⚔️), Tryx#1(hp:3/3, atk:1)'
  // 显示攻击力、是否能攻击、使用 label (Name#N) 避免重复
  ```
- **效果**: LLM 能更好地区分相同名字的单位，了解攻击能力

---

### ✅ 2. 修复方位感知混乱

**文件**: `llm.ts`, `placement.ts`

#### 改动 2.1: 使用 defensive/offensive 代替 front/back
- **位置**: `llm.ts` 的 rules (行 47-52)
- **改动**:
  ```typescript
  // 之前：
  '   - hint: back_center | front_left | front_center | front_right'
  
  // 现在：
  '   - hint: defensive_center | defensive_left | defensive_right (to protect YOUR Hero)',
  '           mid_center | mid_left | mid_right (middle ground)',
  '           offensive_center | offensive_left | offensive_right (to attack ENEMY Hero)',
  '   🛡️ IMPORTANT: "defensive" = near YOUR Hero (back row), "offensive" = near ENEMY Hero (front row)',
  ```
- **效果**: 
  - "defensive" 明确表示保护己方英雄的后排位置
  - "offensive" 明确表示进攻敌方英雄的前排位置
  - 消除了 "front/back" 的方向歧义

#### 改动 2.2: 更新 placement scorer
- **位置**: `placement.ts` 的 `scorePlayActionByHint()` (行 24-26)
- **改动**:
  ```typescript
  // 新增支持 defensive/offensive 关键词
  const regionPref = txt.includes('offensive')||txt.includes('attack') ? 'frontline' 
    : (txt.includes('defensive')||txt.includes('protect')||txt.includes('shield') ? 'backline' 
    : (txt.includes('mid') ? 'mid' : null))
  ```
- **效果**: 执行层能正确理解 LLM 的 defensive/offensive 指令

---

### ✅ 3. 支持移动+攻击组合

**文件**: `AgentModule.ts`, `llm.ts`

#### 改动 3.1: 在 observation 中添加英雄位置
- **位置**: `AgentModule.ts` 的 `#buildObservation()` (行 979-1002)
- **新增**:
  ```typescript
  you: { 
    mana: ...,
    hero_hp: ...,
    hero_position: 'r2c4',          // 新增
    hero_cell_index: 22,             // 新增
    hand: ...
  },
  opponent: {
    hero_hp: ...,
    hero_position: 'r8c4',          // 新增
    hero_cell_index: 76,             // 新增
  }
  ```
- **效果**: 策略层可以看到英雄位置，做出更好的站位决策

#### 改动 3.2: 保留移动攻击机会摘要
- **位置**: `AgentModule.ts` 的 `#buildPolicyObservation()` (行 1720-1762)
- **改动**:
  ```typescript
  // 之前：完全删除 tactical_preview
  delete (obs as any).tactical_preview
  
  // 现在：转换为摘要
  if (moveAttackOpps.length > 0) {
    obs.move_attack_opportunities = [
      {unit: 'Skeleton#1', can_attack: ['Ash', 'Hero']},
      {unit: 'Tryx#1', can_attack: ['Crossbowman']}
    ]
  }
  delete (obs as any).tactical_preview // 删除详细坐标
  ```
- **新增辅助方法**: `#findUnitNameById()` (行 1753-1762)
- **效果**: 
  - 策略层知道哪些单位可以移动后攻击
  - 不会因为过多坐标数据混淆 LLM
  - 只保留对决策有用的高层信息

#### 改动 3.3: 在 prompt 中显示移动攻击机会
- **位置**: `llm.ts` 的 rules (行 76-82)
- **新增**:
  ```typescript
  '💡 Move→Attack Opportunities:',
  '- Skeleton#1 can attack: Ash or Hero',
  '- Tryx#1 can attack: Crossbowman',
  '  (These units can move AND attack in sequence - prioritize if good targets!)',
  ```
- **效果**: LLM 知道某些单位可以"移动→攻击"组合，会优先利用

#### 改动 3.4: 更新 attack 步骤说明
- **位置**: `llm.ts` 的 rules (行 54-57)
- **改动**:
  ```typescript
  // 新增提示：
  '   💡 Some units can move-then-attack automatically - focus on choosing good targets',
  ```
- **效果**: LLM 不需要手动指定 move，只需要指定 attack 目标即可

---

## 改动前后对比

### 场景 1: 英雄受威胁

**之前的 LLM 输出**:
```json
{
  "analysis": "Deploy units",
  "steps": [
    {"type": "play", "card": "Skeleton", "hint": "front_center"}  // ❌ 下在前排，没保护英雄
  ]
}
```

**现在的 LLM 输出**:
```json
{
  "analysis": "YOUR HERO HP: 8 is threatened, deploy defenders",
  "steps": [
    {"type": "play", "card": "Skeleton", "hint": "defensive_center"}  // ✅ 下在后排保护英雄
  ]
}
```

---

### 场景 2: 移动攻击机会

**之前的 prompt**:
```
🎮 Your units: Skeleton(5/5), Tryx(3/3)
🎯 Enemy units: Ash(4/4), Crossbowman(2/2)
❌ NEVER use: move_then_attack
```
→ LLM 不知道移动攻击的机会

**现在的 prompt**:
```
🎮 Your units: Skeleton#1(hp:5/5, atk:2 ⚔️), Tryx#1(hp:3/3, atk:1)
🎯 Enemy units: Ash#1(hp:4/4, atk:3), Crossbowman#1(hp:2/2, atk:1)

💡 Move→Attack Opportunities:
- Skeleton#1 can attack: Ash#1 or Hero
  (These units can move AND attack in sequence - prioritize if good targets!)
```
→ LLM 知道 Skeleton 可以移动后攻击 Ash 或英雄

---

### 场景 3: 方位选择

**之前的 hint**:
```
"hint": "back_center"  // 模糊，LLM 可能理解成"棋盘后方"
```

**现在的 hint**:
```
"hint": "defensive_center"  // 明确，表示"保护己方英雄的位置"
```

---

## 如何测试

### 测试 1: 英雄保护
1. 启动游戏，让己方英雄 HP 降到 5 以下
2. 观察 LLM 决策日志（UI 或控制台）
3. **预期**: 
   - prompt 中会显示 "⚠️ If your Hero HP is low, prioritize DEFENSE!"
   - LLM 输出包含 `"hint": "defensive_*"` 的步骤
   - 单位会下在靠近己方英雄的位置

### 测试 2: 英雄攻击
1. 将敌方英雄 HP 降到 5 以下
2. 观察 LLM 决策
3. **预期**:
   - prompt 中会显示 "🎯 If enemy Hero HP is low, prioritize OFFENSE!"
   - LLM 输出包含 `{"type": "attack", "target": "Hero"}` 的步骤
   - 会尝试直接攻击敌方英雄

### 测试 3: 移动攻击组合
1. 场上有己方单位，敌方有可攻击目标
2. 打开开发者控制台，搜索 "Move→Attack Opportunities"
3. **预期**:
   - prompt 中会显示哪些单位可以移动后攻击
   - LLM 会优先选择这些单位进行攻击
   - 执行层会自动触发移动+攻击序列 (AgentModule.ts:585-603 的逻辑)

### 测试 4: 方位理解
1. 手牌中有防守型单位（高 HP 低攻击）
2. 观察 LLM 的 hint 选择
3. **预期**:
   - 防守型单位使用 `"hint": "defensive_*"`
   - 进攻型单位使用 `"hint": "offensive_*"`
   - placement scorer 正确计算分数

---

## 监控指标

运行几局游戏后，检查以下指标：

| 指标 | 目标 | 检查方法 |
|-----|------|---------|
| 英雄保护率 | >80% | 统计"己方英雄受威胁时，是否下防守单位" |
| 方位正确率 | >90% | 统计 defensive/offensive hint 与实际位置的匹配度 |
| 移动攻击利用率 | >50% | 统计"有移动攻击机会时，是否利用" |
| 平均决策延迟 | <3秒 | 测量从 available_actions 到 sendAction 的时间 |
| 策略执行成功率 | >80% | 统计 policy steps 解析成功的比例 |

---

## 下一步优化 (Phase 2-4)

见 `OPTIMIZATION_PLAN.md` 中的详细规划：

- **Phase 2**: 添加单位战术角色标注 (`tactical_role: 'hero_protector'`)
- **Phase 3**: 优化批量执行逻辑，减少 LLM 调用次数
- **Phase 4**: 调整超参数（temperature, max_tokens）

---

## 文件清单

已修改的文件：
- ✅ `incarnation-electron/packages/main/src/modules/agent/llm.ts`
- ✅ `incarnation-electron/packages/main/src/modules/agent/placement.ts`
- ✅ `incarnation-electron/packages/main/src/modules/AgentModule.ts`

新增的文档：
- 📄 `OPTIMIZATION_PLAN.md` - 详细优化方案
- 📄 `CHANGES_SUMMARY.md` - 本文档

---

## 回滚方法

如果改动导致问题，可以使用 git 回滚：

```bash
cd incarnation-electron/packages/main/src/modules/agent
git checkout HEAD -- llm.ts placement.ts
cd ../
git checkout HEAD -- AgentModule.ts
```

或者手动恢复关键部分：
1. `llm.ts` 的 systemPrompt: 去掉 "HERO-BASED" 相关描述
2. `llm.ts` 的 rules: 去掉 "🏆 GAME STATE" 和 "💡 Move→Attack" 部分
3. `placement.ts`: 恢复原来的 regionPref 逻辑
4. `AgentModule.ts`: 恢复 `#buildPolicyObservation` 的简单删除逻辑
