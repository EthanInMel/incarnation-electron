import {scorePlayActionByHint} from './placement.js'
import {normName, findCardInHandByName} from './name-utils.js'
import type {PolicyStep} from './types.js'
// helper functions for name resolution, placement scoring, etc.

export type BatchExecResult = {stepsQueued: number}
export type SelectSafeActionFn = (actions:any[], snapshot:any, lastPreview:any)=>number|null

export function toStep(action:any): any | null {
  try {
    if (!action) return null
    if (action?.play_card) return {type:'play_card', card_id: action.play_card.card_id, to:{cell_index: action.play_card.cell_index}}
    if (action?.move_unit) return {type:'move', unit_id: action.move_unit.unit_id, to:{cell_index: action.move_unit.to_cell_index}}
    if (action?.unit_attack) return {type:'unit_attack', attacker_unit_id: action.unit_attack.attacker_unit_id, target_unit_id: action.unit_attack.target_unit_id}
    if (action?.hero_power) return {type:'hero_power'}
    if (action?.end_turn) return {type:'end_turn'}
    return null
  } catch { return null }
}

export function selectSafeAction(actions:any[], snapshot:any, lastPreview:any): number | null {
  try {
    const by = (pred:(a:any)=>boolean)=> actions.find(pred)?.id ?? null
    const preview = (snapshot && (snapshot as any).tactical_preview) || lastPreview || []
    const atk = by(a=>a?.unit_attack); if (atk!=null) return atk
    try {
      for (const a of actions) {
        if (!a?.move_unit) continue
        const uid = Number(a.move_unit.unit_id); const to = Number(a.move_unit.to_cell_index)
        const items = Array.isArray(preview) ? preview.filter((p:any)=> Number(p?.unit_id)===uid && Number(p?.to_cell_index)===to) : []
        const ok = items.some((p:any)=> Array.isArray(p?.attacks) && p.attacks.length>0)
        if (ok) return a.id
      }
    } catch {}
    const play = by(a=>a?.play_card); if (play!=null) return play
    const pow = by(a=>a?.hero_power); if (pow!=null) return pow
    const mv = by(a=>a?.move_unit); if (mv!=null) return mv
    const end = by(a=>a?.end_turn); if (end!=null) return end
    return null
  } catch { return null }
}

function isMyTurn(snapshot:any): boolean {
  try {
    if (!snapshot) return false
    if (typeof snapshot.is_my_turn === 'boolean') return snapshot.is_my_turn
    if (typeof snapshot?.self?.is_my_turn === 'boolean') return snapshot.self.is_my_turn === true
    if (typeof snapshot?.you?.is_my_turn === 'boolean') return snapshot.you.is_my_turn === true
    return false
  } catch { return false }
}

export function executePolicyPlanBatch(ctx:{
  plan:any,
  actions:any[],
  snapshot:any,
  policyState:any,
  lastTacticalPreview:any,
  sendAction:(id:number)=>void,
  log:(...args:any[])=>void,
}): BatchExecResult {
  const {plan, actions, snapshot, policyState, lastTacticalPreview, sendAction, log} = ctx
  if (!Array.isArray(actions) || actions.length===0) return {stepsQueued: 0}

  const steps = Array.isArray(policyState.steps) && policyState.steps.length>0 ? policyState.steps : (Array.isArray(plan?.steps) ? plan.steps : [])
  const myTurn = isMyTurn(snapshot)
  if (myTurn) log(`[agent] 🔄 Batch execution: processing ${steps.length} policy steps`)
  const observation = buildObservationCompat(snapshot, lastTacticalPreview)
  const boardW = Number(observation?.board?.width || 9)
  // Recompute can_attack from available actions for accuracy
  try {
    const attackerIds = new Set(actions.filter(a=>a?.unit_attack).map(a=>Number(a.unit_attack.attacker_unit_id)))
    if (Array.isArray((observation as any).self_units)) {
      ;(observation as any).self_units = (observation as any).self_units.map((u:any)=> ({...u, can_attack: attackerIds.has(Number(u?.unit_id))}))
    }
  } catch {}
  
  // 诊断：显示当前场上单位和实际可用的攻击动作 (只在己方回合显示)
  if (myTurn) {
    try {
      const selfUnits = (observation?.self_units || []).map((u:any) => u?.label || u?.name).filter(Boolean)
      const enemyUnits = (observation?.enemy_units || []).map((u:any) => u?.label || u?.name).filter(Boolean)
      log(`[agent] 📋 Self units on board: ${selfUnits.join(', ') || 'none'}`)
      log(`[agent] 📋 Enemy units on board: ${enemyUnits.join(', ') || 'none'}`)
      log(`[agent] 📋 Self units detail: ${(observation?.self_units||[]).map((u:any)=>`${u?.label||u?.name}(id:${u?.unit_id},can_attack:${u?.can_attack})`).join('; ')}`)
      
      // 🔍 关键诊断：列出游戏实际提供的所有攻击动作
      const availableAttacks = actions.filter(a => a?.unit_attack).map(a => {
        const attId = a.unit_attack.attacker_unit_id
        const tgtId = a.unit_attack.target_unit_id
        const attUnit = (observation?.self_units||[]).find((u:any)=>Number(u?.unit_id)===attId)
        const tgtUnit = (observation?.enemy_units||[]).find((u:any)=>Number(u?.unit_id)===tgtId)
        const attName = attUnit?.label || attUnit?.name || `Unit${attId}`
        const tgtName = tgtUnit?.label || tgtUnit?.name || (tgtId ? `Unit${tgtId}` : 'Hero')
        return `${attName}(${attId})→${tgtName}(${tgtId||'hero'})`
      })
      const preview = observation?.tactical_preview || lastTacticalPreview
      const moveOppCount = Array.isArray(preview) ? preview.filter((p:any)=>Array.isArray(p?.attacks) && p.attacks.length>0).length : 0
      log(`[agent] 🎯 Game provided attacks: ${availableAttacks.length > 0 ? availableAttacks.join('; ') : 'NONE'}`)
      if (moveOppCount > 0) log(`[agent] 💡 Move→Attack opportunities available: ${moveOppCount}`)
      
      // 🔍 额外诊断：对比Unity标记和实际攻击可用性
      const unitsMarkedCanAttack = (observation?.self_units||[]).filter((u:any)=>u?.can_attack)
      const actualAttackerIds = new Set(actions.filter(a=>a?.unit_attack).map(a=>Number(a.unit_attack.attacker_unit_id)))
      const markedButCantAttack = unitsMarkedCanAttack.filter((u:any)=>!actualAttackerIds.has(Number(u?.unit_id)))
      if (markedButCantAttack.length > 0) {
        const posInfo = markedButCantAttack.map((u:any)=>{
          const cellIdx = u?.cell_index
          const row = Number.isFinite(cellIdx) ? Math.floor(cellIdx / boardW) : '?'
          const col = Number.isFinite(cellIdx) ? cellIdx % boardW : '?'
          return `${u?.label||u?.name}(id:${u?.unit_id},cell:${cellIdx},r${row}c${col})`
        }).join('; ')
        log(`[agent] ⚠️  Units marked can_attack=true but NO attack actions: ${posInfo}`)
        
        // 🔍 检查是否有移动动作
        const moveActions = actions.filter(a => a?.move_unit)
        const moveCount = moveActions.length
        log(`[agent] 🔍 Available move actions: ${moveCount}`)
        
        // 🔍 检查tactical_preview（移动后攻击机会）
        const preview = observation?.tactical_preview || lastTacticalPreview
        if (Array.isArray(preview) && preview.length > 0) {
          const moveAttackOpps = preview.filter((p:any)=>Array.isArray(p?.attacks) && p.attacks.length>0).slice(0,5)
          if (moveAttackOpps.length > 0) {
            log(`[agent] 💡 Move→Attack opportunities found: ${moveAttackOpps.length}`)
            moveAttackOpps.forEach((p:any,i:number)=>{
              const unitId = p.unit_id
              const unit = unitsMarkedCanAttack.find((u:any)=>Number(u?.unit_id)===unitId)
              const unitName = unit?.label || unit?.name || `Unit${unitId}`
              const targets = (p.attacks||[]).slice(0,2).map((a:any)=>{
                const tgtId = a.target_unit_id
                const tgt = (observation?.enemy_units||[]).find((u:any)=>Number(u?.unit_id)===tgtId)
                return tgt?.label || tgt?.name || (tgtId ? `Enemy${tgtId}` : 'Hero')
              }).join(', ')
              log(`[agent]   ${i+1}. ${unitName} can move to cell ${p.to_cell_index} then attack: ${targets}`)
            })
          } else {
            log(`[agent] ⚠️  No move→attack opportunities in tactical_preview`)
          }
        } else {
          log(`[agent] ⚠️  No tactical_preview data available`)
        }
        
        if (moveCount === 0 && availableAttacks.length === 0) {
          log(`[agent] 💡 Likely reason: units are out of attack range and cannot move (or moved this turn already)`)
        }
      }
    } catch {}
  }

  const byId = (pred:(a:any)=>boolean)=> actions.find(pred)?.id ?? null
  const play = (cardId:number, cellIndex:number)=> byId(a=> a?.play_card && a.play_card.card_id===cardId && a.play_card.cell_index===cellIndex)
  const attack = (att:number, tgt:number)=> {
    const id = byId(a=> a?.unit_attack && a.unit_attack.attacker_unit_id===att && a.unit_attack.target_unit_id===tgt)
    if (id == null && myTurn) {
      // 诊断：列出所有可用的攻击动作 (只在己方回合显示)
      const allAttacks = actions.filter(a => a?.unit_attack).map(a => `${a.unit_attack.attacker_unit_id}→${a.unit_attack.target_unit_id}`)
      log(`[agent]   🔍 Attack ${att}→${tgt} not found. Available attacks: ${allAttacks.join(', ') || 'none'}`)
      try {
        const au = (observation?.self_units||[]).find((u:any)=>Number(u?.unit_id)===att)
        const tu = (observation?.enemy_units||[]).find((u:any)=>Number(u?.unit_id)===tgt)
        if (au && tu) {
          const aCell = Number(au?.cell_index)
          const tCell = Number(tu?.cell_index)
          const inRange = Number.isFinite(aCell) && Number.isFinite(tCell) // real range unknown here; Unity will verify
          log(`[agent]   🔎 Context: attacker cell=${aCell} target cell=${tCell} (Unity will validate range)`)
        }
      } catch {}
    }
    return id
  }
  const endTurn = ()=> byId(a=> a?.end_turn)

  const resolveCardId = (cardName:string): number | null => {
    try { const card = findCardInHandByName(observation, cardName); return card ? Number(card.card_id) : null } catch { return null }
  }
  const resolveUnitId = (unitName:string, isEnemy=false): number | null => {
    try {
      const units = isEnemy ? (observation?.enemy_units || []) : (observation?.self_units || [])
      const nm = normName(unitName)
      let u = units.find((x:any)=> normName(x?.label) === nm)
      if (!u) {
        u = units.find((x:any)=> {
          const baseName = normName(x?.name)
          return baseName && nm && (baseName.includes(nm) || nm.includes(baseName))
        })
      }
      if (!u && myTurn) {
        // 诊断：列出所有可用单位及其 label (只在己方回合显示)
        const available = units.map((x:any)=> {
          const label = x?.label || x?.name
          const id = x?.unit_id
          return `${label}(id:${id})`
        }).filter(Boolean).join(', ')
        log(`[agent]   ❌ Cannot find unit "${unitName}" (normalized: "${nm}") in ${isEnemy?'enemy':'self'} units.`)
        log(`[agent]      Available: ${available || 'none'}`)
      }
      return u ? Number(u.unit_id) : null
    } catch { return null }
  }
  const resolveCellHint = (hint:string, cardName?:string): number | null => {
    try {
      const cardId = cardName ? resolveCardId(cardName) : null
      if (!cardId) return null
      const candidates = actions.filter(a => a?.play_card && Number(a.play_card.card_id) === cardId)
      if (!candidates.length) return null
      let bestCell = null as any, bestScore = -999
      for (const a of candidates) {
        const score = scorePlayActionByHint(a, hint, snapshot, boardW)
        if (score > bestScore) { bestScore = score; bestCell = Number(a.play_card.cell_index) }
      }
      if (bestCell == null && candidates.length>0) bestCell = Number(candidates[0].play_card.cell_index)
      return bestCell
    } catch { return null }
  }
  
  const resolveMoveHint = (unitId:number, hint:string): number | null => {
    try {
      const moveActions = actions.filter(a => a?.move_unit && Number(a.move_unit.unit_id) === unitId)
      if (!moveActions.length) return null
      
      const unit = (observation?.self_units||[]).find((u:any)=>Number(u?.unit_id)===unitId)
      if (!unit || !Number.isFinite(unit.cell_index)) return null
      
      const currentRow = Math.floor(unit.cell_index / boardW)
      const currentCol = unit.cell_index % boardW
      const hintLower = String(hint||'').toLowerCase()
      
      // 根据hint选择最佳移动
      let bestMove = null as any
      let bestScore = -999
      
      for (const a of moveActions) {
        const toCell = Number(a.move_unit.to_cell_index)
        const toRow = Math.floor(toCell / boardW)
        const toCol = toCell % boardW
        
        let score = 0
        if (hintLower.includes('forward') || hintLower.includes('attack') || hintLower.includes('offensive')) {
          // 向前（减少row，朝敌人）
          score = (currentRow - toRow) * 10
        } else if (hintLower.includes('back') || hintLower.includes('defensive') || hintLower.includes('retreat')) {
          // 向后（增加row，远离敌人）
          score = (toRow - currentRow) * 10
        } else if (hintLower.includes('left')) {
          score = (currentCol - toCol) * 10
        } else if (hintLower.includes('right')) {
          score = (toCol - currentCol) * 10
        }
        
        // 优先选择能攻击的移动（tactical_preview）
        const preview = observation?.tactical_preview || lastTacticalPreview
        if (Array.isArray(preview)) {
          const hasAttackAfterMove = preview.some((p:any) => 
            Number(p?.unit_id)===unitId && Number(p?.to_cell_index)===toCell && Array.isArray(p?.attacks) && p.attacks.length>0
          )
          if (hasAttackAfterMove) score += 100
        }
        
        if (score > bestScore || bestMove == null) {
          bestScore = score
          bestMove = toCell
        }
      }
      
      return bestMove
    } catch { return null }
  }

  let queuedCount = 0
  const usedCells = new Set<number>() // 🔧 跟踪已使用的格子，避免重复放置
  
  for (let i=0; i<steps.length; i++) {
    const s = steps[i]; if (!s || typeof s !== 'object') continue
    if (s?.meta?.status==='queued' || s?.meta?.status==='executed') { if(myTurn) log(`[agent]   ⏭️  Skipping step ${i} (status: ${s.meta.status})`); continue }
    const t = String(s.type||'').toLowerCase()
    let actionId: number | null = null
    if (t==='play') {
      const cardName = s.card || s.card_name
      if (cardName) {
        const cardId = resolveCardId(cardName)
        if (cardId != null) {
          const hint = s.hint || s.position || 'mid_center'
          let cellIndex = resolveCellHint(hint, cardName)
          
          // 🔧 如果格子已被占用，尝试找相邻的空格子
          if (cellIndex != null && usedCells.has(cellIndex)) {
            if(myTurn) log(`[agent]   ⚠️  Cell ${cellIndex} already used, finding alternative...`)
            const alternatives = actions.filter(a => 
              a?.play_card && 
              Number(a.play_card.card_id) === cardId && 
              !usedCells.has(Number(a.play_card.cell_index))
            )
            if (alternatives.length > 0) {
              // 选择最接近原始位置的空格子
              let bestAlt = alternatives[0]
              let bestDist = Math.abs(Number(bestAlt.play_card.cell_index) - cellIndex)
              for (const alt of alternatives.slice(1)) {
                const dist = Math.abs(Number(alt.play_card.cell_index) - cellIndex)
                if (dist < bestDist) {
                  bestDist = dist
                  bestAlt = alt
                }
              }
              cellIndex = Number(bestAlt.play_card.cell_index)
              if(myTurn) log(`[agent]   ✅ Using alternative cell ${cellIndex}`)
            } else {
              if(myTurn) log(`[agent]   ❌ No alternative cells available`)
              cellIndex = null
            }
          }
          
          if (cellIndex != null) {
            actionId = play(cardId, cellIndex)
            if (actionId != null) usedCells.add(cellIndex) // 记录已用格子
          }
        }
      }
    } else if (t==='move') {
      const unitName = s.unit || s.unit_name
      if (unitName) {
        const unitId = resolveUnitId(unitName, false)
        if(myTurn) log(`[agent]   🔍 Move step ${i}: unit="${unitName}" → id=${unitId}`)
        if (unitId != null && Number.isFinite(unitId)) {
          const hint = s.hint || 'forward'
          const toCell = resolveMoveHint(unitId, hint)
          if (toCell != null && Number.isFinite(toCell)) {
            const moveAction = actions.find(a => a?.move_unit && Number(a.move_unit.unit_id)===unitId && Number(a.move_unit.to_cell_index)===toCell)
            if (moveAction) {
              actionId = moveAction.id
              if(myTurn) log(`[agent]   🎯 Move: ${unitName}(${unitId}) → cell ${toCell}, actionId=${actionId}`)
            } else {
              if(myTurn) log(`[agent]   ❌ Move action not found for unit ${unitId} → cell ${toCell}`)
            }
          } else {
            if(myTurn) log(`[agent]   ❌ Could not resolve move destination for unit ${unitId} with hint "${hint}"`)
          }
        } else {
          if(myTurn) log(`[agent]   ❌ Move step ${i}: cannot resolve unit "${unitName}"`)
        }
      }
    } else if (t==='attack') {
      const attackerName = s.attacker; const targetName = s.target
      if (attackerName && targetName) {
        const attackerId = resolveUnitId(attackerName, false)
        if(myTurn) log(`[agent]   🔍 Attack step ${i}: attacker="${attackerName}" → id=${attackerId}`)
        if (attackerId != null && Number.isFinite(attackerId)) {
          if (String(targetName).toLowerCase()==='hero') {
            const heroAtkAction = actions.find(a => a?.unit_attack && Number(a.unit_attack.attacker_unit_id) === attackerId && !a.unit_attack.target_unit_id)
            if (heroAtkAction) actionId = heroAtkAction.id
            if(myTurn) log(`[agent]   🎯 Hero attack: found=${!!heroAtkAction}`)
          } else {
            const targetId = resolveUnitId(targetName, true)
            if(myTurn) log(`[agent]   🔍 Attack step ${i}: target="${targetName}" → id=${targetId}`)
            if (targetId != null && Number.isFinite(targetId)) {
              actionId = attack(attackerId, targetId)
              if(myTurn) log(`[agent]   🎯 Unit attack: ${attackerId} → ${targetId}, actionId=${actionId}`)
            }
          }
        } else {
          if(myTurn) log(`[agent]   ❌ Attack step ${i}: cannot resolve attacker "${attackerName}"`)
        }
      }
    } else if (t==='end_turn') {
      actionId = endTurn()
    }
    if (actionId != null) {
      sendAction(actionId)
      if (s.meta) { s.meta.status='queued'; s.meta.pendingActionId=actionId; s.meta.updatedAt=Date.now(); s.meta.reason = s.meta?.reason || t }
      queuedCount++
      if(myTurn) log(`[agent]   ✅ Step ${i} (${t}) queued: actionId=${actionId}`)
    } else {
      if(myTurn) log(`[agent]   ⚠️  Batch step ${i} (${t}) could not be resolved, skipping (not stopping)`)
      // 不要 break，继续尝试后续步骤
    }
  }
  if(myTurn) log(`[agent] 🔄 Batch execution complete: ${queuedCount} steps queued (out of ${steps.length} total)`)
  return {stepsQueued: queuedCount}
}

export function executePolicyPlanSingle(ctx:{
  plan:any,
  actions:any[],
  snapshot:any,
  policyState:any,
  lastTacticalPreview:any,
  buildObservation:(snapshot:any)=>any,
  broadcast:(channel:string, payload:any)=>void,
  markStepByAction:(actionId:number, rawStep?:any)=>PolicyStep|null,
  selectSafeAction:SelectSafeActionFn,
  log?:(...args:any[])=>void,
  toStep?:(action:any)=>any | null,
}): {actionId: number | null; reason?: string; step?: PolicyStep | null; metadata?: any; defer?: boolean} | null {
  const {plan, actions, snapshot, policyState, lastTacticalPreview, buildObservation, broadcast, markStepByAction, selectSafeAction, toStep: customToStep} = ctx
  const log = (...args:any[]) => {
    if (ctx.log) { try { ctx.log(...args) } catch {} }
    else { try { console.log(...args) } catch {} }
  }
  const safeBroadcast = (channel:string, payload:any) => { try { broadcast(channel, payload) } catch {} }
  try {
    if (!Array.isArray(actions) || actions.length === 0) return {actionId: null, reason: 'no_actions', step: null, metadata: {}}
    const preview = (snapshot && (snapshot as any).tactical_preview) || lastTacticalPreview || []
    const byId = (pred:(a:any)=>boolean)=> actions.find(pred)?.id ?? null
    const observation = buildObservation(snapshot)
    const boardW = Number(observation?.board?.width || 9)
    const play = (cardId:number, cellIndex:number)=> byId(a=> a?.play_card && a.play_card.card_id===cardId && a.play_card.cell_index===cellIndex)
    const move = (unitId:number, cellIndex:number)=> byId(a=> a?.move_unit && a.move_unit.unit_id===unitId && a.move_unit.to_cell_index===cellIndex)
    const attack = (att:number, tgt:number)=> byId(a=> a?.unit_attack && a.unit_attack.attacker_unit_id===att && a.unit_attack.target_unit_id===tgt)
    const endTurn = ()=> byId(a=> a?.end_turn)
    const resolveCardId = (cardName:string): number | null => {
      try { const card = findCardInHandByName(observation, cardName); return card ? Number(card.card_id) : null } catch { return null }
    }
    const resolveUnitId = (unitName:string, isEnemy=false): number | null => {
      try {
        const units = isEnemy ? (observation?.enemy_units || []) : (observation?.self_units || [])
        const nm = normName(unitName)
        let u = units.find((x:any)=> normName(x?.label) === nm)
        if (!u) {
          u = units.find((x:any)=> {
            const baseName = normName(x?.name)
            return baseName && nm && (baseName.includes(nm) || nm.includes(baseName))
          })
        }
        if (!u && units.length>0) {
          const candidates = units.filter((x:any)=> {
            const baseName = normName(x?.name)
            return baseName && nm && baseName.includes(nm)
          })
          if (candidates.length>0) {
            u = candidates.reduce((best:any, curr:any)=> (curr?.hp||0) > (best?.hp||0) ? curr : best)
          }
        }
        return u ? Number(u.unit_id) : null
      } catch { return null }
    }
    const resolveCellHint = (hint:string, cardName?:string): number | null => {
      try {
        const cardId = cardName ? resolveCardId(cardName) : null
        if (!cardId) return null
        const candidates = actions.filter(a => a?.play_card && Number(a.play_card.card_id) === cardId)
        if (!candidates.length) return null
        let bestCell:any = null; let bestScore = -999
        for (const a of candidates) {
          const score = scorePlayActionByHint(a, hint, snapshot, boardW)
          if (score > bestScore) { bestScore = score; bestCell = Number(a.play_card.cell_index) }
        }
        if (bestCell == null && candidates.length>0) {
          bestCell = Number(candidates[0].play_card.cell_index)
          log(`[agent]   ⚠️  No good cell for hint "${hint}", using first available: ${bestCell}`)
        }
        return bestCell
      } catch { return null }
    }
    const chooseFromPreview = (unitId:number, targetId?:number) => {
      try {
        const items = Array.isArray(preview) ? preview.filter((p:any)=> Number(p?.unit_id)===Number(unitId)) : []
        for (const p of items) {
          const mId = move(Number(unitId), Number(p?.to_cell_index))
          if (mId == null) continue
          const atks = Array.isArray(p?.attacks) ? p.attacks : []
          if (targetId != null) {
            const ok = atks.some((x:any)=> Number(x?.target_unit_id)===Number(targetId))
            if (!ok) continue
            const aId = attack(Number(unitId), Number(targetId))
            if (aId != null) return {moveId: mId, attackId: aId}
          } else if (atks.length) {
            const tgt = Number(atks[0]?.target_unit_id)
            const aId = attack(Number(unitId), tgt)
            if (aId != null) return {moveId: mId, attackId: aId}
          }
        }
      } catch {}
      return null
    }
    const steps = Array.isArray(policyState?.steps) && policyState.steps.length>0 ? policyState.steps : (Array.isArray(plan?.steps) ? plan.steps : [])
    const stepsStatus = steps.map((s:any,i:number)=> `${i}:${s?.type}(${s?.meta?.status || 'unknown'})`)
    log(`[agent] 📋 Executing policy plan with ${steps.length} steps: ${stepsStatus.join(', ')}`)
    log(`[agent] 📋 Policy state: cursor=${policyState?.cursor}, revision=${policyState?.revision}`)
    for (let i=0;i<steps.length;i++) {
      const s = steps[i]
      if (!s || typeof s !== 'object') continue
      if (s?.meta?.status==='queued' || s?.meta?.status==='executed') {
        log(`[agent]   ⏭️  Skipping step ${i} (status: ${s.meta.status})`)
        continue
      }
      const t = String(s.type||'').toLowerCase()
      safeBroadcast('decision_log', {step_index: i, type: t, raw: s})
      if (t==='play') {
        log(`[agent] 🃏 Processing play step ${i}:`, s)
        const cardName = s.card || s.card_name
        if (!cardName) {
          log(`[agent]   ❌ Missing card name in step ${i}`)
          safeBroadcast('decision_log', {warn: `Step ${i}: Missing card name`, step: s})
          continue
        }
        const cardId = resolveCardId(cardName)
        log(`[agent]   Card "${cardName}" → card_id=${cardId}`)
        if (!cardId) {
          log(`[agent]   ❌ Cannot resolve card "${cardName}"`)
          safeBroadcast('decision_log', {warn: `Step ${i}: Cannot resolve card "${cardName}" to card_id`})
          continue
        }
        const hint = s.hint || s.position || 'mid_center'
        const cellIndex = resolveCellHint(hint, cardName)
        log(`[agent]   Hint "${hint}" → cell_index=${cellIndex}`)
        if (cellIndex == null) {
          log(`[agent]   ❌ Cannot resolve hint "${hint}" for card "${cardName}" (card_id=${cardId})`)
          safeBroadcast('decision_log', {warn: `Step ${i}: Cannot resolve hint "${hint}" for card "${cardName}" (card_id=${cardId})`})
          continue
        }
        const id = play(cardId, cellIndex)
        if (id != null) {
          log(`[agent]   ✅ Step ${i} resolved: play ${cardName} (id=${cardId}) @ cell=${cellIndex} → actionId=${id}`)
          safeBroadcast('decision_log', {success: `✅ Step ${i} resolved: play ${cardName} (id=${cardId}) @ cell=${cellIndex} → actionId=${id}`})
          return {actionId: id, reason: 'policy_play_resolved', step: markStepByAction(id, s), metadata: {source: 'policy_step_name_resolved', cardName, cardId, cellIndex}}
        } else {
          log(`[agent]   ❌ play(${cardId}, ${cellIndex}) returned null`)
          safeBroadcast('decision_log', {warn: `Step ${i}: play(${cardId}, ${cellIndex}) returned null - no matching action`})
        }
      } else if (t==='attack') {
        log(`[agent] 🎯 Processing attack step ${i}:`, s)
        let attackerId = Number(s.attacker_unit_id)
        let targetId = Number(s.target_unit_id)
        if (!Number.isFinite(attackerId) && s.attacker) {
          const resolvedAtt = resolveUnitId(s.attacker, false)
          log(`[agent]   Attacker "${s.attacker}" → unit_id=${resolvedAtt}`)
          if (!resolvedAtt) {
          log(`[agent]   ❌ Cannot resolve attacker "${s.attacker}"`)
          safeBroadcast('decision_log', {warn: `Step ${i}: Cannot resolve attacker "${s.attacker}"`})
            continue
          }
          attackerId = resolvedAtt
        }
        if (!Number.isFinite(targetId) && s.target) {
          if (String(s.target).toLowerCase()==='hero') {
            log(`[agent]   Target "Hero" → looking for face attack from attacker ${attackerId}`)
            const heroAtkAction = actions.find(a => a?.unit_attack && Number(a.unit_attack.attacker_unit_id) === attackerId && !a.unit_attack.target_unit_id)
            if (heroAtkAction) {
              log(`[agent]   ✅ Found hero attack: actionId=${heroAtkAction.id}`)
              safeBroadcast('decision_log', {success: `✅ Step ${i} resolved: attack Hero with ${s.attacker || attackerId} → actionId=${heroAtkAction.id}`})
              return {actionId: heroAtkAction.id, reason: 'policy_attack_hero_resolved', step: markStepByAction(heroAtkAction.id, s), metadata: {source: 'policy_step_name_resolved', attackerId}}
            } else {
              log(`[agent]   ❌ No valid hero attack from attacker ${attackerId}`)
              safeBroadcast('decision_log', {warn: `Step ${i}: No valid attack to Hero from attacker ${attackerId}`})
              continue
            }
          } else {
            const resolvedTgt = resolveUnitId(s.target, true)
            log(`[agent]   Target "${s.target}" → unit_id=${resolvedTgt}`)
            if (!resolvedTgt) {
              log(`[agent]   ❌ Cannot resolve target "${s.target}"`)
              safeBroadcast('decision_log', {warn: `Step ${i}: Cannot resolve target "${s.target}"`})
              continue
            }
            targetId = resolvedTgt
          }
        }
        if (Number.isFinite(attackerId) && Number.isFinite(targetId)) {
          log(`[agent]   Looking for attack action: attacker=${attackerId} → target=${targetId}`)
          const id = attack(attackerId, targetId)
          if (id != null) {
            log(`[agent]   ✅ Step ${i} resolved: attack ${s.attacker || attackerId} → ${s.target || targetId} (actionId=${id})`)
            safeBroadcast('decision_log', {success: `✅ Step ${i} resolved: attack ${s.attacker || attackerId} → ${s.target || targetId} (actionId=${id})`})
            return {actionId: id, reason: 'policy_attack_resolved', step: markStepByAction(id, s), metadata: {source: 'policy_step_name_resolved', attackerId, targetId}}
          } else {
            log(`[agent]   ❌ attack(${attackerId}, ${targetId}) returned null - no matching action available`)
            safeBroadcast('decision_log', {warn: `Step ${i}: attack(${attackerId}, ${targetId}) returned null - no valid action`})
          }
        }
      } else if (t==='play_card') {
        const cid = Number(s.card_id); const cell = Number(s?.to?.cell_index)
        const id = Number.isFinite(cid) && Number.isFinite(cell) ? play(cid, cell) : null
        if (id != null) { return {actionId: id, reason: 'policy_step_play', step: markStepByAction(id, s), metadata: {source: 'policy_step'}} }
      } else if (t==='move_then_attack') {
        const uid = Number(s.unit_id)
        const tgt = s.target_unit_id != null ? Number(s.target_unit_id) : undefined
        const candidate = chooseFromPreview(uid, tgt)
        if (candidate?.moveId != null) {
          return {actionId: candidate.moveId, reason: 'policy_step_move_then_attack', step: markStepByAction(candidate.moveId, s), metadata: {source: 'policy_step', followup: candidate.attackId ?? null}}
        }
      } else if (t==='end_turn') {
        const id = endTurn()
        if (id != null) { return {actionId: id, reason: 'policy_end_turn', step: markStepByAction(id, s), metadata: {source: 'policy_step'}} }
      }
    }
    const choicePlay = choosePlayFromPolicy(plan, actions, snapshot)
    if (choicePlay != null) {
      return {actionId: choicePlay, reason: 'policy_play', step: markStepByAction(choicePlay), metadata: {source: 'policy_play'}}
    }
    const choiceMove = chooseMoveFromPolicy(plan, actions, snapshot, lastTacticalPreview)
    if (choiceMove != null) {
      return {actionId: choiceMove, reason: 'policy_move_section', step: markStepByAction(choiceMove), metadata: {source: 'policy_move'}}
    }
    const choiceAtk = chooseAttackFromPolicy(plan, actions)
    if (choiceAtk != null) {
      return {actionId: choiceAtk, reason: 'policy_attack_section', step: markStepByAction(choiceAtk), metadata: {source: 'policy_attack'}}
    }
    const fb = selectSafeAction(actions, snapshot, lastTacticalPreview)
    return {actionId: fb, reason: 'safe_fallback', step: null, metadata: {}}
  } catch (e:any) {
    const fb = selectSafeAction(ctx.actions, ctx.snapshot, ctx.lastTacticalPreview)
    return {actionId: fb, reason: 'policy_execute_error', step: null, metadata: {error: String(e?.message || e)}}
  }
}

function buildObservationCompat(snapshot:any, lastPreview:any) {
  try {
    const W = Number(snapshot?.board?.width ?? snapshot?.board?.W ?? snapshot?.W ?? 9)
    
    // 添加 labelize 来匹配 LLM 输出的 Name#N 格式
    const labelize = (arr:any[], nameKey:string, labelKey:string) => {
      const cnt: Record<string, number> = {}
      return (arr||[]).map(it=>{
        const n = String(it?.[nameKey]||'')
        const k = n.toLowerCase()
        const i = (cnt[k]||0) + 1; cnt[k] = i
        return {...it, [labelKey]: n ? `${n}#${i}` : undefined}
      })
    }
    
  const mapUnit = (u:any) => {
      if (!u) return u
    const unitId = (u.unit_id ?? u.unitID ?? u.unitId ?? u.id)
      const name = u.name ?? u?.Name ?? u?.title
      return {
        ...u,
        unit_id: unitId,
        name,
      }
    }
    const selfRaw = Array.isArray(snapshot?.self_units) ? snapshot.self_units.map(mapUnit) : []
    const enemyRaw = Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units.map(mapUnit) : []

    const markHero = (units:any[], heroCellIdx:number) => units.map(u => {
      if (!u) return u
      const cellIdx = Number(u.cell_index ?? u.CellIndex ?? u.cell_idx)
      const isHeroUnit = Number.isFinite(heroCellIdx) && Number.isFinite(cellIdx) && cellIdx === heroCellIdx
      return {
        ...u,
        can_attack: isHeroUnit ? false : u.can_attack,
        role: isHeroUnit ? 'hero' : (u.role ?? 'unit'),
        is_hero: isHeroUnit,
      }
    })

    const yourHeroIdx = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index)
    const enemyHeroIdx = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index)

    const selfMarked = markHero(selfRaw, yourHeroIdx)
    const enemyMarked = markHero(enemyRaw, enemyHeroIdx)

    const selfUnits = labelize(selfMarked, 'name', 'label')
    const enemyUnits = labelize(enemyMarked, 'name', 'label')
    
    return {
      board:{width:W}, 
      you: snapshot?.you || snapshot?.self, 
      enemy: snapshot?.enemy || snapshot?.opponent, 
      self_units: selfUnits, 
      enemy_units: enemyUnits, 
      tactical_preview: lastPreview
    }
  } catch { return {board:{width:9}} }
}

// Policy selectors (extracted)
export function choosePlayFromPolicy(plan:any, actions:any[], snapshot:any): number | null {
  try {
    const observation = buildObservationCompat(snapshot, null)
    const W = Number(observation?.board?.width || 9)
    const tryOne = (cardName:string, hint?:any) => {
      const inHand = findCardInHandByName(observation, cardName)
      if (!inHand) return null
      const cid = Number(inHand?.card_id)
      const candidates = (actions||[]).filter(a=> a?.play_card && Number(a.play_card.card_id)===cid)
      let bestId: number | null = null; let bestS = -1
      for (const a of candidates) {
        const s = scorePlayActionByHint(a, hint, snapshot, W)
        if (s > bestS) { bestS = s; bestId = a.id }
      }
      const id = bestId
      return Number.isFinite(id) ? id : null
    }
    if (Array.isArray(plan?.sequence)) {
      for (const s of plan.sequence) {
        const a = normName(s?.action)
        if (a==='summon' || a==='play' || a==='deploy') {
          const nm = s?.card || s?.unit || s?.name
          const id = tryOne(nm, s)
          if (id!=null) return id
        }
      }
    }
    if (Array.isArray(plan?.curve)) {
      for (const nm of plan.curve) { const id = tryOne(nm); if (id!=null) return id }
    }
    if (Array.isArray(plan?.plan?.mana_usage)) {
      for (const s of plan.plan.mana_usage) {
        const act = normName(s?.action)
        if (act.startsWith('summon_') || act.startsWith('play_')) {
          const nm = act.replace(/^\w+_/, '')
          const id = tryOne(nm, s)
          if (id!=null) return id
        }
      }
    }
    const txt = normName(plan?.plan || plan?.strategy || '')
    if (txt) {
      for (const nm of ['tryx','skeleton','fairy','lycan']) { if (txt.includes(nm)) { const id = tryOne(nm); if (id!=null) return id } }
    }
  } catch {}
  return null
}

export function moveEnablesAttack(a:any, snapshot:any, lastPreview:any) {
  try {
    if (!a?.move_unit) return false
    const preview = (snapshot && (snapshot as any).tactical_preview) || lastPreview || []
    const uid = Number(a.move_unit.unit_id); const to = Number(a.move_unit.to_cell_index)
    const items = Array.isArray(preview) ? preview.filter((p:any)=> Number(p?.unit_id)===uid && Number(p?.to_cell_index)===to) : []
    return items.some((p:any)=> Array.isArray(p?.attacks) && p.attacks.length>0)
  } catch { return false }
}

export function chooseMoveFromPolicy(plan:any, actions:any[], snapshot:any, lastPreview:any): number | null {
  try {
    const obs = buildObservationCompat(snapshot, lastPreview)
    const units = (obs?.self_units)||[]
    const pickMoveForUnit = (unitName:string) => {
      const nm = normName(unitName)
      const u = units.find((x:any)=> normName(x?.label)===nm) || units.find((x:any)=> normName(x?.name).includes(nm))
      if (!u) return null
      const id = actions.find(a=> a?.move_unit && a.move_unit.unit_id===u.unit_id && moveEnablesAttack(a, snapshot, lastPreview))?.id
      return Number.isFinite(id) ? id : (actions.find(a=> a?.move_unit && a.move_unit.unit_id===u.unit_id)?.id ?? null)
    }
    if (Array.isArray(plan?.plan?.movement)) {
      for (const mv of plan.plan.movement) {
        const id = pickMoveForUnit(mv?.unit||mv?.name)
        if (id!=null) return id
      }
    }
    if (Array.isArray(plan?.sequence)) {
      for (const s of plan.sequence) {
        const a = normName(s?.action)
        if (a==='move' || a==='advance') { const id = pickMoveForUnit(s?.unit||s?.name); if (id!=null) return id }
      }
    }
  } catch {}
  return null
}

export function chooseAttackFromPolicy(plan:any, actions:any[]): number | null {
  try {
    const nameHints: string[] = []
    if (plan?.plan?.combat_focus) nameHints.push(String(plan.plan.combat_focus))
    if (Array.isArray(plan?.targets)) { for (const t of plan.targets) nameHints.push(String(t)) }
    const txt = normName(plan?.plan || '')
    if (txt) nameHints.push(txt)
    const want = (nm:string) => {
      const n = normName(nm)
      for (const a of (actions||[])) {
        if (!a?.unit_attack) continue
        const an = normName(a?.unit_attack?.target?.name)
        if ((an && n && (an.includes(n) || n.includes(an))) || String(a?.unit_attack?.target_unit_id)===nm) return a.id
      }
      return null
    }
    for (const blob of nameHints) {
      for (const key of ['ash','cinda','crossbowman','archer','minotaur']) {
        if (normName(blob).includes(key)) { const id = want(key); if (id!=null) return id }
      }
    }
  } catch {}
  return null
}

export function deriveTargetPreferenceFromPolicy(plan:any) {
  try {
    const txt = normName(plan?.plan || '')
    const prefs: string[] = []
    if (txt.includes('face') || txt.includes('hero')) prefs.push('hero')
    for (const key of ['cinda','ash','crossbowman','archer','manavault']) { if (txt.includes(key)) prefs.push(key) }
    if (Array.isArray(plan?.targets)) { for (const t of plan.targets) prefs.push(normName(t)) }
    return prefs
  } catch { return [] as string[] }
}

export function pickAttackFromList(atks:any[], prefs:string[]) {
  try {
    const n = (s:any)=> normName(s)
    if (prefs.some(p=> p==='hero')) {
      const h = atks.find(x=> n(x?.target_name).includes('hero'))
      if (h) return h
    }
    for (const p of prefs) {
      const m = atks.find(x=> n(x?.target_name).includes(p))
      if (m) return m
    }
    return atks[0]
  } catch { return atks && atks[0] }
}


