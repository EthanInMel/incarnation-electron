import { Box, Button, Flex, Heading, Separator, Text } from '@radix-ui/themes'
import { useEffect, useMemo, useState } from 'react'

export default function Logs() {
  const [rows, setRows] = useState<Array<{ts:number; gen?:number; turn?:string; actionId?:number; why?:string; summary?:string}>>([])
  const [live, setLive] = useState<string[]>([])

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
    const onAvail = (d: any) => {
      const head = (d?.preview && Array.isArray(d.preview) && d.preview.length > 0) ? (JSON.stringify(d.preview[0]) ?? '') : ''
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
    }

    on('decision_explain', onExplain)
    on('available_actions', onAvail)
    on('decision_log', onLog)
    return () => {
      off('decision_explain', onExplain)
      off('available_actions', onAvail)
      off('decision_log', onLog)
    }
  }, [])

  const csv = useMemo(() => toCSV(rows), [rows])

  return (
    <Flex direction="column" className="h-full min-h-screen p-4">
      <Heading mb="3">Logs</Heading>
      <Flex gap="3" align="center" mb="2">
        <Button onClick={() => download('logs.csv', csv)}>Export CSV</Button>
        <Button onClick={() => download('logs.json', JSON.stringify(rows, null, 2))}>Export JSON</Button>
        <Button color="red" onClick={() => { setRows([]); setLive([]); }}>Clear</Button>
      </Flex>
      <Separator size="4" my="2" />
      <Text color="gray">Live</Text>
      <Box className="bg-black/40 rounded p-3 flex-1 min-h-[300px] overflow-auto text-xs font-mono">
        {live.map((l, i) => <div key={i}>{l}</div>)}
      </Box>
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

