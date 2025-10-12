import { Box, Button, Flex, Heading, Separator, Text } from '@radix-ui/themes'
import { useEffect, useMemo, useState } from 'react'

export default function Logs() {
  const [rows, setRows] = useState<Array<{ts:number; gen?:number; turn?:string; actionId?:number; why?:string; summary?:string}>>([])
  const [live, setLive] = useState<string[]>([])
  const [strategy, setStrategy] = useState<any>(null)
  const [outcomes, setOutcomes] = useState<Array<{ts:number; actionId:number; delta:any}>>([])
  const [actionsSummary, setActionsSummary] = useState<any|null>(null)
  const [llmIO, setLlmIO] = useState<Array<{ts:number; turn?:number; phase?:string; usage?:any; raw?:string}>>([])
  const [planResults, setPlanResults] = useState<Array<{ts:number; turn?:number; atomic:boolean; note?:string; steps:Array<{id:number; ok:boolean; reason?:string|null; desc?:string}>}>>([])
  const [turnSnapshots, setTurnSnapshots] = useState<Array<{turn:number; snapshot:any}>>([])
  const [idDesc, setIdDesc] = useState<Record<number, string>>({})
  const [batchSummaries, setBatchSummaries] = useState<Array<{ts:number; turn?:number; atomic:boolean; applied:number[]; failed:number[]; note?:string}>>([])

  useEffect(() => {
    const b64On = typeof btoa === 'function' ? btoa('ipcOn') : 'aXBjT24='
    const b64Off = typeof btoa === 'function' ? btoa('ipcOff') : 'aXBjT2Zm'
    const on = (window as any)[b64On] as ((ch: string, fn: (data: any) => void) => void) | undefined
    const off = (window as any)[b64Off] as ((ch: string, fn: (data: any) => void) => void) | undefined
    if (!on || !off) {
      setLive(prev => [...(Array.isArray(prev) ? prev.slice(-500) : []), '[Warn] preload IPC not available'])
      return
    }

    const pushLive = (line: string) => {
      setLive(prev => {
        const base = Array.isArray(prev) ? prev : []
        const last = base.length ? base[base.length - 1] : undefined
        if (last === line) return base
        return [...base.slice(-500), line]
      })
    }

    const onExplain = (d: any) => {
      const r = { ts: Date.now(), gen: d?.gen, turn: d?.turn != null ? String(d.turn) : undefined, actionId: d?.actionId, why: d?.why, summary: `mode=${d?.mode ?? ''} temp=${d?.temp ?? ''}` }
      setRows(prev => [...prev, r].slice(-2000))
      pushLive(`[Explain] ${r.summary}${r.why ? ` why=${r.why}` : ''}`)
    }
    const toDesc = (a: any) => {
      try {
        if (a?.end_turn) return 'End Turn'
        if (a?.hero_power) return `Hero Power${a?.hero_power?.cell_index!=null?` @ ${a.hero_power.cell_index}`:''}`
        if (a?.use_skill) return `UseSkill unit=${a.use_skill.unit_id} @ ${a.use_skill.cell_index}`
        if (a?.unit_attack) {
          const attName = a?.unit_attack?.attacker?.name || a?.unit_attack?.attacker_unit_id
          const tgtName = a?.unit_attack?.target?.name || a?.unit_attack?.target_unit_id
          return `Attack ${attName} -> ${tgtName}`
        }
        if (a?.move_unit) {
          const nm = a?.unit_name || a?.move_unit?.unit_name || a?.move_unit?.unit_id
          return `Move ${nm} -> ${a?.move_unit?.to_cell_index}`
        }
        if (a?.play_card) {
          const nm = a?.card_name || a?.play_card?.card_name || a?.play_card?.card_id
          return `Play ${nm} @ ${a?.play_card?.cell_index}`
        }
      } catch {}
      return 'Unknown'
    }
    const onAvail = (d: any) => {
      const head = (d?.preview && Array.isArray(d.preview) && d.preview.length > 0) ? (JSON.stringify(d.preview[0]) ?? '') : ''
      if (d?.summary) setActionsSummary(d.summary)
      try {
        const map: Record<number,string> = {}
        const prev = Array.isArray(d?.preview) ? d.preview : []
        for (const a of prev) {
          if (!a || typeof a.id !== 'number') continue
          map[a.id] = toDesc(a)
        }
        if (Object.keys(map).length) setIdDesc(map)
      } catch {}
      pushLive(`[Actions] gen=${d?.gen ?? ''} count=${d?.count ?? ''} ${String(head).slice(0, 120)}`)
    }
    const onLog = (e: any) => {
      const actionDesc = e?.action ? (e.action.play_card ? `play_card(${e.action.card_name || e.action.card_id})` : 
                                     e.action.unit_attack ? `attack(${e.action.unit_attack.attacker?.name || e.action.unit_attack.attacker_unit_id} -> ${e.action.unit_attack.target?.name || e.action.unit_attack.target_unit_id})` :
                                     e.action.move_unit ? `move(${e.action.move_unit.unit_id})` :
                                     e.action.use_skill ? `skill(${e.action.skill_name || 'unknown'})` :
                                     e.action.hero_power ? 'hero_power' : 
                                     e.action.end_turn ? 'end_turn' : 'unknown') : '';
      const rationale = e?.rationale ? ` | ${e.rationale}` : '';
      const retry = e?.retry ? ' [RETRY]' : '';
      const err = e?.error ? ` [ERROR: ${e.error}]` : '';
      const prefix = e?.error ? '[Decision❌]' : '[Decision]';
      pushLive(`${prefix} id=${e?.actionId ?? 'null'} ${actionDesc}${rationale}${retry}${err}`)
      if (e?.strategy) setStrategy(e.strategy)
    }
    const onLlmIO = (d: any) => {
      setLlmIO(prev => [...prev.slice(-99), {ts: Date.now(), turn: d?.turn, phase: d?.phase, usage: d?.usage, raw: d?.raw}])
      const pt = d?.usage?.prompt_tokens ?? d?.usage?.promptTokens
      const ct = d?.usage?.completion_tokens ?? d?.usage?.completionTokens
      pushLive(`[LLM] turn=${d?.turn ?? ''} phase=${d?.phase ?? ''} usage p=${pt ?? ''} c=${ct ?? ''}`)
      // Ensure turn card exists
      try {
        const turn = Number(d?.turn)
        if (Number.isFinite(turn)) {
          setTurnSnapshots(prev => {
            const exists = prev.some(x => x.turn === turn)
            if (exists) return prev
            const filtered = prev.slice(-29)
            return [...filtered, {turn, snapshot: null}]
          })
        }
      } catch {}
    }
    const onPlan = (p: any) => {
      const steps = Array.isArray(p?.steps) ? p.steps.map((s:any)=>({id: s?.id, ok: !!s?.ok, reason: s?.reason, desc: s?.desc})) : []
      const turn = (typeof p?.turn === 'number' && Number.isFinite(p.turn)) ? p.turn : ((window as any).__lastTurn || undefined)
      setPlanResults(prev => [...prev.slice(-19), {ts: Date.now(), turn, atomic: !!p?.atomic, note: p?.note, steps}])
      const okCnt = steps.filter((s:any)=>s.ok).length
      const failCnt = steps.length - okCnt
      pushLive(`[Plan] atomic=${!!p?.atomic} steps=${steps.length} ok=${okCnt} fail=${failCnt} ${p?.note ? '('+p.note+')' : ''}`)
      // Ensure turn card exists
      try {
        if (Number.isFinite(turn)) {
          setTurnSnapshots(prev => {
            const exists = prev.some(x => x.turn === turn)
            if (exists) return prev
            const filtered = prev.slice(-29)
            return [...filtered, {turn, snapshot: null}]
          })
        }
      } catch {}
    }
    const onState = (d:any) => {
      try {
        const turn = Number(d?.snapshot?.turn)
        if (Number.isFinite(turn)) {
          ;(window as any).__lastTurn = turn
          setTurnSnapshots(prev => {
            const next = [...prev]
            // keep last 30 snapshots
            const filtered = next.filter(x => x.turn !== turn).slice(-29)
            return [...filtered, {turn, snapshot: d.snapshot}]
          })
        }
      } catch {}
    }
    const onStrat = (s: any) => {
      setStrategy(s)
      pushLive('[Strategy] updated')
    }
    const onOutcome = (o: any) => {
      setOutcomes(prev => [...prev.slice(-49), {ts: Date.now(), actionId: o?.actionId, delta: o?.delta}])
      const d = o?.delta || {}
      pushLive(`[Outcome] id=${o?.actionId} Δpressure=${d.pressure ?? ''} Δthreat=${d.threat ?? ''}`)
    }

    on('decision_explain', onExplain)
    on('available_actions', onAvail)
    on('decision_log', onLog)
    on('llm_io', onLlmIO)
    on('plan_result', onPlan)
    on('state', onState)
    on('strategy_updated', onStrat)
    on('strategy_outcome', onOutcome)
    on('action_batch_summary', (p:any)=>{
      const turn = (window as any).__lastTurn
      setBatchSummaries(prev => [...prev.slice(-29), {ts: Date.now(), turn, atomic: !!p?.atomic, applied: Array.isArray(p?.applied)?p.applied:[], failed: Array.isArray(p?.failed)?p.failed:[], note: p?.note}])
      const a = Array.isArray(p?.applied)?p.applied.length:0
      const f = Array.isArray(p?.failed)?p.failed.length:0
      pushLive(`[Batch] applied=${a} failed=${f} ${p?.note? '('+p.note+')':''}`)
    })

    return () => {
      off('decision_explain', onExplain)
      off('available_actions', onAvail)
      off('decision_log', onLog)
      off('llm_io', onLlmIO)
      off('plan_result', onPlan)
      off('state', onState)
      off('strategy_updated', onStrat)
      off('strategy_outcome', onOutcome)
      // action_batch_summary unhooked implicitly
    }
  }, [])

  const csv = useMemo(() => toCSV(rows), [rows])

  return (
    <Flex direction="column" className="h-full min-h-screen p-4">
      <Heading mb="3">Logs</Heading>
      <Flex gap="3" align="center" mb="2">
        <Button onClick={() => download('logs.csv', csv)}>Export CSV</Button>
        <Button onClick={() => download('logs.json', JSON.stringify(rows, null, 2))}>Export JSON</Button>
        <Button color="red" onClick={() => { /* reset */ setRows([]); setLive([]); setOutcomes([]); }}>Clear</Button>
      </Flex>
      <Separator size="4" my="2" />
      {strategy && (
        <Box className="mb-3 text-xs font-mono p-2 rounded bg-black/30">
          <Text weight="bold">Strategy</Text>
          <pre className="whitespace-pre-wrap">{JSON.stringify(strategy, null, 2)}</pre>
        </Box>
      )}
      {/* 移除回合外的冗余块，统一在回合卡片中查看 */}
      {turnSnapshots.length > 0 && (
        <div className="mb-3">
          <div className="text-sm font-semibold mb-2">Turns Timeline</div>
          {turnSnapshots.sort((a,b)=>a.turn-b.turn).map((t,i)=>{
            // Deduplicate IO by phase+raw signature
            const ioRaw = llmIO.filter(e=> e.turn === t.turn)
            const ioSeen = new Set<string>()
            const relatedIO = ioRaw.filter(e=>{ const key = `${e.phase}|${e.raw||''}`; if (ioSeen.has(key)) return false; ioSeen.add(key); return true; })
            const highLevel = relatedIO.filter(e=> e.phase === 'hier_policy')
            const initialIO = relatedIO.filter(e=> e.phase === 'initial' || e.phase === 'retry' || e.phase === 'concrete')
            // Deduplicate plans by note+steps signature
            const plansRaw = planResults.filter(p=> p.turn === t.turn)
            const planSeen = new Set<string>()
            const relatedPlans = plansRaw.filter(p=>{ const sig = JSON.stringify({note:p.note, steps:p.steps?.map(s=>`${s.id}:${s.ok}`)}); if (planSeen.has(sig)) return false; planSeen.add(sig); return true; })
            const batchesRaw = batchSummaries.filter(b=> b.turn === t.turn)
            const batchSeen = new Set<string>()
            const relatedBatches = batchesRaw.filter(b=>{ const sig = JSON.stringify({atomic:b.atomic, a:(b.applied||[]), f:(b.failed||[]), n:b.note||''}); if (batchSeen.has(sig)) return false; batchSeen.add(sig); return true; })
            return (
              <details key={i} className="mb-2 border rounded p-2">
                <summary className="cursor-pointer text-sm font-medium">Turn {t.turn} — IO:{relatedIO.length} Plan:{relatedPlans.length}</summary>
                <div className="text-xs font-mono mt-2">
                  <div className="mb-2">
                    <div className="font-semibold">1) Unity Snapshot</div>
                    <pre className="whitespace-pre-wrap overflow-auto max-h-60 p-2 bg-black/10 rounded">{JSON.stringify(t.snapshot, null, 2)}</pre>
                  </div>
                  <div className="mb-2">
                    <div className="font-semibold">2) LLM Responses</div>
                    <div className="pl-2">
                      <div className="font-medium">2.1) High-level Policy</div>
                      {highLevel.length === 0 ? <div className="opacity-70">(none)</div> : highLevel.map((e,idx)=>(
                        <div key={idx} className="mt-1 p-2 bg-black/10 rounded">
                          <div>phase={e.phase} usage={e.usage ? JSON.stringify(e.usage) : ''}</div>
                          {e.raw && <pre className="whitespace-pre-wrap overflow-auto max-h-40 mt-1">{e.raw}</pre>}
                        </div>
                      ))}
                      <div className="font-medium mt-2">2.2) Concrete Plan</div>
                      {initialIO.length === 0 ? <div className="opacity-70">(none)</div> : initialIO.map((e,idx)=>(
                        <div key={idx} className="mt-1 p-2 bg-black/10 rounded">
                          <div>phase={e.phase} usage={e.usage ? JSON.stringify(e.usage) : ''}</div>
                          {e.raw && <pre className="whitespace-pre-wrap overflow-auto max-h-40 mt-1">{e.raw}</pre>}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="mb-2">
                    <div className="font-semibold">3) Unity Execution</div>
                    {relatedPlans.length === 0 && relatedBatches.length === 0 ? <div className="opacity-70">(no plan_result)</div> : null}
                    {relatedPlans.map((p,idx)=> (
                      <div key={idx} className="mt-1 p-2 bg-black/10 rounded">
                        <div>atomic={String(p.atomic)} {p.note ? `note=${p.note}`:''}</div>
                        <div className="pl-2 mt-1">
                          {(() => {
                            // compress consecutive duplicates in steps
                            const cmp: typeof p.steps = []
                            for (const s of p.steps) {
                              const last = cmp.length ? cmp[cmp.length-1] : null
                              if (last && last.id === s.id && (!!last.ok) === (!!s.ok) && (last.reason||'') === (s.reason||'')) continue
                              cmp.push(s)
                            }
                            return cmp.map((s,ix)=> {
                              const d = s.desc || (typeof s.id === 'number' ? idDesc[s.id] : '') || ''
                              return (
                                <div key={ix}>#{ix+1} id={s.id} {s.ok ? 'OK' : `FAIL(${s.reason||''})`} {d ? `— ${d}` : ''}</div>
                              )
                            })
                          })()}
                        </div>
                      </div>
                    ))}
                    {relatedBatches.map((b,idx)=> (
                      <div key={`b${idx}`} className="mt-1 p-2 bg-black/10 rounded">
                        <div>batch atomic={String(b.atomic)} {b.note?`note=${b.note}`:''}</div>
                        <div className="pl-2 mt-1">
                          <div>applied: {b.applied.length? b.applied.map(id=> `${id}${idDesc[id]?` — ${idDesc[id]}`:''}`).join(', '): '(none)'}</div>
                          <div>failed: {b.failed.length? b.failed.map(id=> `${id}${idDesc[id]?` — ${idDesc[id]}`:''}`).join(', '): '(none)'}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </details>
            )
          })}
        </div>
      )}
      {/* 移除回合外的 LLM Responses / Plan Results / Live，仅保留回合卡片 */}
    </Flex>
  )
}

function toCSV(rows: Array<{ts:number; gen?:number; turn?:string; actionId?:number; why?:string; summary?:string}>) {
  if (!rows?.length) return ''
  const header = ['ts','gen','turn','actionId','why','summary']
  const esc = (s?: string) => s == null ? '' : JSON.stringify(String(s))
  const data = [header.join(','), ...rows.map(r => [r.ts, r.gen ?? '', r.turn ?? '', r.actionId ?? '', esc(r.why), esc(r.summary)].join(','))].join('\n')
  return data
}

function download(name: string, content: string) {
  const blob = new Blob([content], {type: 'text/plain;charset=utf-8'})
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 500)
}

