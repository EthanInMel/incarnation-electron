import { Box, Button, Flex, Heading, Separator, Text } from '@radix-ui/themes'
import { useEffect, useMemo, useState } from 'react'

export default function Logs() {
  const [rows, setRows] = useState<Array<{ts:number; gen?:number; turn?:string; actionId?:number; why?:string; summary?:string}>>([])
  const [live, setLive] = useState<string[]>([])

  useEffect(() => {
    // @ts-expect-error preload
    const ipc = window.electron?.ipcRenderer
    if (!ipc) return

    const onExplain = (_: any, d: any) => {
      const r = { ts: Date.now(), gen: d?.gen, turn: d?.turn != null ? String(d.turn) : undefined, actionId: d?.actionId, why: d?.why, summary: `mode=${d?.mode ?? ''} temp=${d?.temp ?? ''}` }
      setRows(prev => [...prev, r].slice(-2000))
      setLive(prev => [...prev.slice(-500), `[Explain] ${r.summary}${r.why ? ` why=${r.why}` : ''}`])
    }
    const onAvail = (_: any, d: any) => {
      const s = d?.preview ? JSON.stringify(d.preview[0]) : ''
      setLive(prev => [...prev.slice(-500), `[Actions] gen=${d?.gen ?? ''} count=${d?.count ?? ''} ${s.slice(0, 120)}`])
    }
    const onLog = (_: any, e: any) => {
      setLive(prev => [...prev.slice(-500), `[Decision] id=${e?.actionId ?? ''} ${String(e?.text ?? '').slice(0,120)}`])
    }

    ipc.on('decision_explain', onExplain)
    ipc.on('available_actions', onAvail)
    ipc.on('decision_log', onLog)
    return () => {
      ipc.removeListener('decision_explain', onExplain)
      ipc.removeListener('available_actions', onAvail)
      ipc.removeListener('decision_log', onLog)
    }
  }, [])

  const csv = useMemo(() => toCSV(rows), [rows])

  return (
    <Box p="4">
      <Heading mb="3">Logs</Heading>
      <Flex gap="3" align="center" mb="2">
        <Button onClick={() => download('logs.csv', csv)}>Export CSV</Button>
        <Button onClick={() => download('logs.json', JSON.stringify(rows, null, 2))}>Export JSON</Button>
      </Flex>
      <Separator size="4" my="2" />
      <Text color="gray">Live</Text>
      <Box className="bg-black/40 rounded p-3 h-[280px] overflow-auto text-xs font-mono">
        {live.map((l, i) => <div key={i}>{l}</div>)}
      </Box>
    </Box>
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

