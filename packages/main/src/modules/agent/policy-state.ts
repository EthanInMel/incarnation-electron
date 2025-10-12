import type {PolicyBaseline} from './types.js'
import {createHash} from 'node:crypto'

export function buildPolicySummary(snapshot:any) {
  try {
    if (!snapshot) return {myUnits: 0, enemyUnits: 0, myHP: 0, enemyHP: 0, myHand: 0}
    const myUnits = Array.isArray(snapshot?.self_units) ? snapshot.self_units.length : Array.isArray(snapshot?.you?.units) ? snapshot.you.units.length : 0
    const enemyUnits = Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units.length : Array.isArray(snapshot?.opponent?.units) ? snapshot.opponent.units.length : 0
    const myHP = Number(snapshot?.you?.hero_hp ?? snapshot?.self?.hero_hp ?? snapshot?.you?.hp ?? 0) || 0
    const enemyHP = Number(snapshot?.opponent?.hero_hp ?? snapshot?.enemy?.hero_hp ?? snapshot?.opponent?.hp ?? 0) || 0
    const myHand = Array.isArray(snapshot?.you?.hand ?? snapshot?.self?.hand) ? (snapshot?.you?.hand ?? snapshot?.self?.hand).length : 0
    return {myUnits, enemyUnits, myHP, enemyHP, myHand}
  } catch { return {myUnits: 0, enemyUnits: 0, myHP: 0, enemyHP: 0, myHand: 0} }
}

export function policySnapshotDigest(snapshot:any): string | null {
  try {
    if (!snapshot) return null
    const picked = {
      turn: snapshot?.turn ?? null,
      you: {
        hero_hp: snapshot?.you?.hero_hp ?? snapshot?.self?.hero_hp ?? null,
        mana: snapshot?.you?.mana ?? snapshot?.self?.mana ?? null,
        hand: Array.isArray(snapshot?.you?.hand ?? snapshot?.self?.hand) ? (snapshot?.you?.hand ?? snapshot?.self?.hand).map((c: any) => ({id: c?.card_id ?? c?.id, name: c?.name})) : null,
      },
      opponent: {
        hero_hp: snapshot?.opponent?.hero_hp ?? snapshot?.enemy?.hero_hp ?? null,
        hand_size: Array.isArray(snapshot?.opponent?.hand ?? snapshot?.enemy?.hand) ? (snapshot?.opponent?.hand ?? snapshot?.enemy?.hand).length : null,
      },
      self_units: Array.isArray(snapshot?.self_units) ? snapshot.self_units.map((u: any) => ({id: u?.unit_id ?? u?.id, card: u?.card_id ?? null, hp: u?.hp, atk: u?.atk, cell: u?.cell_index})) : null,
      enemy_units: Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units.map((u: any) => ({id: u?.unit_id ?? u?.id, card: u?.card_id ?? null, hp: u?.hp, atk: u?.atk, cell: u?.cell_index})) : null,
    }
    return createHash('sha1').update(JSON.stringify(picked)).digest('hex')
  } catch { return null }
}

export function buildPolicyBaseline(snapshot:any): PolicyBaseline | null {
  try {
    if (!snapshot) return null
    const turn = Number(snapshot?.turn ?? 0)
    const summary = buildPolicySummary(snapshot)
    const digest = policySnapshotDigest(snapshot) || `${Date.now()}`
    return {turn, summary, digest, createdAt: Date.now()}
  } catch { return null }
}

export function policyDriftExceeded(baseline: PolicyBaseline | null, snapshot: any) {
  try {
    if (!baseline || !snapshot) return false
    const current = buildPolicySummary(snapshot)
    const diffUnits = Math.abs(current.myUnits - baseline.summary.myUnits) + Math.abs(current.enemyUnits - baseline.summary.enemyUnits)
    const hpDelta = Math.max(Math.abs(current.myHP - baseline.summary.myHP), Math.abs(current.enemyHP - baseline.summary.enemyHP))
    const handDelta = Math.abs(current.myHand - baseline.summary.myHand)
    const turnDelta = Math.abs(Number(snapshot?.turn ?? baseline.turn) - baseline.turn)
    if (diffUnits >= 3) return true
    if (hpDelta >= 10) return true
    if (handDelta >= 4) return true
    if (turnDelta >= 3) return true
    const digest = policySnapshotDigest(snapshot)
    if (digest && baseline.digest && digest !== baseline.digest && (diffUnits >= 1 || hpDelta >= 5)) return true
    return false
  } catch { return false }
}



