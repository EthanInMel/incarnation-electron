# LLM 策略到执行一致性优化方案

## 问题总结
1. LLM 不知道英雄的重要性和游戏目标
2. 方位感知混乱（前后位置颠倒）
3. 移动+攻击连续动作难以执行
4. 策略到执行步骤延迟高

---

## 优化方案

### 🎯 优先级 1：增强英雄信息（解决问题1）

#### 1.1 改进 buildPolicyPrompt 的 system prompt
**文件**: `llm.ts:66-72`

**当前**:
```typescript
'You are a tactical AI for a card battler game.',
'Your job: Generate a concise, EXECUTABLE action plan in strict JSON.',
'The executor will translate card/unit NAMES to IDs automatically.',
'Focus on: playing key threats, removing dangerous enemies, protecting face.',
```

**改为**:
```typescript
'You are a tactical AI for a hero-based card battler.',
'🎯 WIN CONDITION: Reduce enemy Hero HP to 0 while keeping your Hero alive.',
'Heroes are at fixed positions on the board - units should PROTECT your Hero and ATTACK enemy Hero.',
'Your job: Generate EXECUTABLE action plan in JSON.',
'Strategy: Deploy units in FRONT of your Hero → Attack dangerous enemies → Strike enemy Hero when safe.',
```

#### 1.2 在 observation 中标注英雄位置
**文件**: `AgentModule.ts:855-995` (#buildObservation)

在 observation 返回对象中添加：
```typescript
obs = {
  turn: snapshot?.turn,
  board: { width: W },
  you: { 
    mana: youRaw.mana,
    hero_hp: youRaw.hero_hp,
    hero_position: fmtRC(toRC(youRaw.hero_cell_index)), // 新增
    hero_cell_index: youRaw.hero_cell_index,            // 新增
    hand 
  },
  opponent: { 
    hero_hp: enemyRaw.hero_hp,
    hero_position: fmtRC(toRC(enemyRaw.hero_cell_index)), // 新增
    hero_cell_index: enemyRaw.hero_cell_index              // 新增
  },
  self_units: selfUnits,
  enemy_units: enemyUnits,
  // 新增：方位参考
  spatial_reference: {
    forward_direction: '向敌方英雄方向',
    your_hero_row: selfHeroRow,
    enemy_hero_row: enemyHeroRow,
    lanes: {
      center: Math.floor(W/2),
      left: '<' + Math.floor(W/2),
      right: '>' + Math.floor(W/2),
    }
  }
}
```

#### 1.3 在 buildPolicyPrompt 中强调英雄保护
**文件**: `llm.ts:56-63`

添加到 rules 中：
```typescript
const rules = [
  '🎯 CRITICAL: Return ONLY valid JSON in this EXACT format:',
  '{ "analysis": "brief situation summary", "steps": [Step1, Step2, ...] }',
  '',
  '🏆 GAME OBJECTIVE:',
  `- YOUR HERO: ${observation?.you?.hero_position || 'N/A'} (HP: ${observation?.you?.hero_hp || 0})`,
  `- ENEMY HERO: ${observation?.opponent?.hero_position || 'N/A'} (HP: ${observation?.opponent?.hero_hp || 0})`,
  '- WIN: Reduce enemy Hero HP to 0',
  '- LOSE: Your Hero HP reaches 0',
  '',
  // ... rest of rules
]
```

---

### 🧭 优先级 2：修复方位感知（解决问题2）

#### 2.1 改进 hint 系统的语义
**文件**: `llm.ts:40-43`

**当前**:
```typescript
'   - hint: back_center | front_left | front_center | front_right | mid_left | mid_center | mid_right',
```

**改为**:
```typescript
'   - hint: defensive_center | defensive_left | defensive_right |',
'           mid_center | mid_left | mid_right |',
'           offensive_center | offensive_left | offensive_right',
'   Explanation:',
'   - defensive_* = Close to YOUR Hero (for protection)',
'   - offensive_* = Close to ENEMY Hero (for aggression)',
'   - mid_* = Middle ground',
```

并修改 `scorePlayActionByHint` (placement.ts) 的解析逻辑：
```typescript
const regionPref = txt.includes('offensive')||txt.includes('forward') ? 'frontline' 
  : (txt.includes('defensive')||txt.includes('protect') ? 'backline' 
  : (txt.includes('mid') ? 'mid' : null))
```

#### 2.2 在单位信息中添加战术上下文
**文件**: `AgentModule.ts:940-952` (normUnit)

```typescript
const normUnit = (u: any, owner: 'self'|'enemy') => {
  const cellIdx = u.cell_index
  const rc = toRC(cellIdx)
  let tacticalRole: string | undefined
  
  // 计算与英雄的相对位置
  if (owner === 'self' && selfHeroRow != null && rc?.row != null) {
    const deltaRow = rc.row - selfHeroRow
    // 假设敌方在更大的 row 方向
    if (deltaRow > 1) tacticalRole = 'frontline_attacker'
    else if (deltaRow < -1) tacticalRole = 'backline_support'
    else if (Math.abs(deltaRow) <= 1) tacticalRole = 'hero_protector'
  }
  
  return {
    unit_id: u.unit_id ?? u.id,
    card_id: u.card_id ?? null,
    name: u.name,
    hp: u.hp,
    atk: u.atk,
    cell_index: cellIdx,
    row: rc?.row,
    col: rc?.col,
    pos: fmtRC(rc),
    tactical_role: tacticalRole, // 新增
    can_attack: u.can_attack,
    skills: Array.isArray(u.skills) ? u.skills : undefined,
  }
}
```

---

### ⚔️ 优先级 3：支持移动+攻击组合（解决问题3）

#### 3.1 移除 prompt 中的禁令
**文件**: `llm.ts:51`

**删除**:
```typescript
'❌ NEVER use: card_id, unit_id, cell_index, rXcY coordinates, move_then_attack',
```

**改为**:
```typescript
'❌ NEVER use: card_id, unit_id, cell_index, rXcY coordinates',
'✅ Move actions: The executor will AUTO-ATTACK if the unit can reach enemies after moving',
```

#### 3.2 在策略层保留 tactical_preview 的摘要
**文件**: `AgentModule.ts:1704-1713` (#buildPolicyObservation)

**当前**:
```typescript
#buildPolicyObservation(snapshot:any) {
  try {
    const obs = this.#buildObservation(snapshot)
    if (obs && typeof obs==='object') {
      delete (obs as any).tactical_preview  // 删除了！
    }
    return obs
  } catch { return this.#buildObservation(snapshot) }
}
```

**改为**:
```typescript
#buildPolicyObservation(snapshot:any) {
  try {
    const obs = this.#buildObservation(snapshot)
    if (obs && typeof obs==='object') {
      // 保留 tactical_preview 的高层摘要，而非删除
      const preview = (obs as any).tactical_preview
      if (Array.isArray(preview) && preview.length > 0) {
        // 转换为更简洁的"移动→攻击"提示
        const moveAttackOpportunities = preview
          .filter((p:any) => Array.isArray(p?.attacks) && p.attacks.length > 0)
          .slice(0, 8) // 限制数量
          .map((p:any) => {
            const unitName = this.#findUnitNameById(snapshot, p.unit_id)
            const targets = (p.attacks || []).slice(0, 3).map((a:any) => 
              this.#findUnitNameById(snapshot, a.target_unit_id) || 'Hero'
            )
            return {
              unit: unitName,
              can_attack_after_move: targets
            }
          })
        
        ;(obs as any).move_attack_opportunities = moveAttackOpportunities
        delete (obs as any).tactical_preview // 删除详细数据
      }
    }
    return obs
  } catch { return this.#buildObservation(snapshot) }
}

// 辅助方法
#findUnitNameById(snapshot:any, unitId:number): string | null {
  try {
    const allUnits = [
      ...(snapshot?.self_units || []),
      ...(snapshot?.enemy_units || [])
    ]
    const u = allUnits.find((x:any) => Number(x?.unit_id) === Number(unitId))
    return u?.label || u?.name || null
  } catch { return null }
}
```

#### 3.3 在 prompt 中说明移动→攻击机制
**文件**: `llm.ts:56-63`

添加到 rules:
```typescript
'🎮 Available cards in hand:',
(Array.isArray(observation?.you?.hand) ? observation.you.hand.map((c:any)=> c?.name).filter(Boolean).join(', ') : 'none'),
'',
'🎮 Your units on board:',
(Array.isArray(observation?.self_units) ? observation.self_units.map((u:any)=> `${u?.name}(${u?.hp}/${u?.max_hp})`).filter(Boolean).join(', ') : 'none'),
'',
'🎯 Enemy units:',
(Array.isArray(observation?.enemy_units) ? observation.enemy_units.map((u:any)=> `${u?.name}(${u?.hp}/${u?.max_hp})`).filter(Boolean).join(', ') : 'none'),
'',
// 新增
'💡 Move→Attack opportunities:',
(observation?.move_attack_opportunities?.length 
  ? observation.move_attack_opportunities.map((o:any) => 
      `${o.unit} can attack: ${o.can_attack_after_move.join(', ')}`
    ).join(' | ')
  : 'None visible'),
```

---

### ⚡ 优先级 4：降低执行延迟（解决问题4）

#### 4.1 默认启用批量执行
**文件**: `AgentModule.ts:1194-1215`

确保批量执行优先级高于单步：

```typescript
// 当前已经有批量执行逻辑，确保它优先执行
const batchResult = executePolicyPlanBatch({...})
if (batchResult && batchResult.stepsQueued > 0) {
  console.log(`[agent] 🎯 Batch execution: ${batchResult.stepsQueued} steps queued`)
  this.#flushPlan('policy_batch')
  return {
    mode: 'hierarchical',
    actionId: null,
    reason: 'policy_batch_executed',
    nextStep: null,
    deferExecution: true,
    metadata: {stepsQueued: batchResult.stepsQueued}
  }
}
// 单步执行作为 fallback
```

#### 4.2 优化 LLM 调用次数
在 `executePolicyPlanBatch` 中，如果所有步骤都能成功解析，就一次性提交整个 turn_plan，而不是逐个发送。

当前的实现已经做到了这一点（executor.ts:131-132 调用 `sendAction`），但可以进一步优化：

- 确保 `maxSteps` 配置合理（当前默认 6）
- LLM 返回的 steps 数量控制在 3-5 个以内（llm.ts:54）

---

## 实施优先级

1. **Phase 1 (立即实施)**:
   - 1.1: 改进 system prompt，明确游戏目标
   - 1.3: 在 prompt 中显示英雄位置和 HP
   - 2.1: 修改 hint 语义（defensive/offensive）

2. **Phase 2 (短期)**:
   - 1.2: 在 observation 中添加英雄位置
   - 3.1: 移除 move_then_attack 禁令
   - 3.3: 在 prompt 中说明移动攻击机制

3. **Phase 3 (中期)**:
   - 2.2: 添加单位战术角色标注
   - 3.2: 策略层保留 tactical_preview 摘要

4. **Phase 4 (优化)**:
   - 4.1: 确保批量执行优先
   - 调整 temperature、max_tokens 等超参数

---

## 预期效果

- ✅ LLM 理解英雄是游戏核心，会保护己方英雄、攻击敌方英雄
- ✅ 方位描述清晰：defensive=后排保护，offensive=前排进攻
- ✅ LLM 知道移动后可能触发攻击，会利用这个机制
- ✅ 批量执行减少来回延迟，提升响应速度

---

## 监控指标

实施后观察以下指标：
1. 是否出现"英雄面临威胁时，单位下在后排"的错误
2. 是否能识别并执行"移动到攻击范围→自动攻击"的组合
3. 每回合的平均决策时间（目标：<3秒）
4. 策略层 plan 的步骤执行成功率（目标：>80%）
