import { Box, Button, Flex, Heading, Separator, Text } from '@radix-ui/themes'
import { useEffect, useMemo, useState } from 'react'

function prettyMode(mode?: string): string {
  const m = String(mode || '').trim()
  switch (m) {
    case 'mastra_smart': return 'Mastra Smart'
    case 'mastra_deep': return 'Mastra Deep'
    case 'fast_only': return 'Fast Only'
    case 'llm_only': return 'LLM Only'
    case 'smart': return 'Smart'
    case 'intent_driven': return 'Mastra (legacy cfg)'
    default: return m || '—'
  }
}

export default function Agent() {
  const [logs, setLogs] = useState<string[]>([])
  const [paused, setPaused] = useState<boolean>(false)
  const [rt, setRt] = useState<{turn?: string; steps?: string; temp?: string; mode?: string}>({})
  const [decisions, setDecisions] = useState<Array<{ts:number; actionId:number; text?:string; why?: string; turn?: string; gen?: number}>>([])

  useEffect(() => {
    // @ts-expect-error preload
    const ipc = window.electron?.ipcRenderer
    if (!ipc) return

    const onLog = (_: any, entry: any) => {
      const ln = `[LLM] action=${entry?.actionId ?? ''} ${String(entry?.text ?? '').slice(0, 120)}`
      setLogs(prev => [...prev.slice(-200), ln])
    }
    const onExplain = (_: any, data: any) => {
      const why = data?.why ? ` why=${String(data.why).slice(0,120)}` : ''
      const ln = `[Explain] mode=${prettyMode(data?.mode)} temp=${data?.temp ?? ''}${why}`
      setLogs(prev => [...prev.slice(-200), ln])
      setRt(prev => ({...prev, mode: prettyMode(data?.mode), temp: data?.temp != null ? String(data.temp) : prev.temp, steps: data?.steps != null ? String(data.steps) : prev.steps, turn: data?.turn != null ? String(data.turn) : prev.turn}))
      if (data?.actionId) {
        setDecisions(prev => [...prev, { ts: Date.now(), actionId: data.actionId, text: undefined, why: data?.why, turn: String(data?.turn ?? ''), gen: data?.gen }].slice(-500))
      }
    }
    const onCfgLoaded = (_: any, data: any) => {
      setLogs(prev => [...prev.slice(-200), `[CFG] loaded provider=${data?.provider ?? ''} model=${data?.model ?? ''}`])
    }
    ipc.on('decision_log', (e: any, entry: any) => {
      onLog(e, entry)
      const rec = { ts: Date.now(), actionId: entry?.actionId, text: entry?.text }
      setDecisions(prev => [...prev, rec].slice(-500))
    })
    ipc.on('decision_explain', onExplain)
    ipc.on('cfg_loaded', onCfgLoaded)
    ipc.on('state', (_: any, data: any) => {
      const t = data?.snapshot?.turn
      if (t != null) setRt(prev => ({...prev, turn: String(t)}))
    })
    return () => {
      ipc.removeListener('decision_log', onLog)
      ipc.removeListener('decision_explain', onExplain)
      ipc.removeListener('cfg_loaded', onCfgLoaded)
    }
  }, [])

  return (
    <Box p="4">
      <Heading mb="3">Agent</Heading>
      <Flex direction="column" className="gap-3">
        <Flex gap="3" align="center">
          <Text>Status: {paused ? 'Paused' : 'Running'}</Text>
          <Button onClick={() => {
            // @ts-expect-error preload
            const inv = window.electron?.ipcRenderer?.invoke
            setPaused(p => {
              const np = !p
              if (inv) inv('cfg', { paused: np }).catch(()=>{})
              else {
                // @ts-expect-error preload
                window.electron?.ipcRenderer?.send('cfg', { paused: np })
              }
              return np
            })
          }}>{paused ? 'Resume' : 'Pause'}</Button>
        </Flex>

        <Flex gap="12" wrap="wrap">
          <Box>
            <Heading size="3">Runtime</Heading>
            <div className="text-sm text-gray-400 mt-1">Turn: {rt.turn ?? '—'}</div>
            <div className="text-sm text-gray-400">Steps: {rt.steps ?? '—'}</div>
            <div className="text-sm text-gray-400">Temp: {rt.temp ?? '—'}</div>
            <div className="text-sm text-gray-400">Mode: {rt.mode ?? '—'}</div>
          </Box>

          <Box>
            <Heading size="3">Export</Heading>
            <Flex gap="2" mt="2">
              <Button onClick={() => exportCSV(decisions)}>Export CSV</Button>
              <Button onClick={() => exportJSON(decisions)}>Export JSON</Button>
            </Flex>
          </Box>
        </Flex>

        <Separator size="4" my="2" />
        <Text color="gray">Live decisions</Text>
        <Box className="bg-black/40 rounded p-3 h-[360px] overflow-auto text-xs font-mono">
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </Box>
      </Flex>
    </Box>
  )
}

function exportCSV(rows: Array<{ts:number; actionId:number; text?:string}>) {
  if (!rows?.length) return;
  const header = ['ts','actionId','text']
  const data = [header.join(','), ...rows.map(r => [r.ts, r.actionId, JSON.stringify(r.text||'')].join(','))].join('\n')
  download('decisions.csv', data)
}

function exportJSON(rows: Array<{ts:number; actionId:number; text?:string}>) {
  if (!rows?.length) return;
  download('decisions.json', JSON.stringify(rows, null, 2))
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

