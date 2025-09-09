import { Card, Flex, Heading, Text } from '@radix-ui/themes'
import { useEffect, useState } from 'react'

export default function Dashboard() {
  const [status, setStatus] = useState<'unknown'|'loaded'>('unknown')
  const [lastDecision, setLastDecision] = useState<string>('—')
  const [turn, setTurn] = useState<string>('—')

  useEffect(() => {
    // @ts-expect-error preload
    const ipc = window.electron?.ipcRenderer
    if (!ipc) return
    const onCfgLoaded = (_: any) => setStatus('loaded')
    const onLog = (_: any, entry: any) => setLastDecision(String(entry?.actionId ?? '—'))
    const onState = (_: any, data: any) => {
      const t = data?.snapshot?.turn
      if (t != null) setTurn(String(t))
    }
    ipc.on('cfg_loaded', onCfgLoaded)
    ipc.on('decision_log', onLog)
    ipc.on('state', onState)
    return () => {
      ipc.removeListener('cfg_loaded', onCfgLoaded)
      ipc.removeListener('decision_log', onLog)
      ipc.removeListener('state', onState)
    }
  }, [])

  return (
    <Flex direction="column" p="4" className="gap-4">
      <Heading>Dashboard</Heading>
      <Flex className="gap-3" wrap="wrap">
        <Card>
          <Text weight="bold">Agent Status</Text>
          <Text as="p" color="gray">{status === 'loaded' ? 'Loaded' : 'Unknown'}</Text>
        </Card>
        <Card>
          <Text weight="bold">Last Decision</Text>
          <Text as="p" color="gray">{lastDecision}</Text>
        </Card>
        <Card>
          <Text weight="bold">Turn / Steps</Text>
          <Text as="p" color="gray">{turn}</Text>
        </Card>
      </Flex>
    </Flex>
  )
}

