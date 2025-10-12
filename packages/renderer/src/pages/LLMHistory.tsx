import { useEffect, useState } from 'react'
import { Box, Button, Flex, Table, Text, TextArea, TextField } from '@radix-ui/themes'

type LLMRow = {
  turn?: number
  phase?: string
  provider?: string
  model?: string
  request?: any
  response?: any
  error?: any
  elapsed_ms?: number
  created_at?: number
}

export default function LLMHistory() {
  const [sessionId, setSessionId] = useState<string>('default')
  const [rows, setRows] = useState<LLMRow[]>([])
  const [raw, setRaw] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)

  async function load() {
    try {
      setLoading(true)
      const b64Invoke = typeof btoa === 'function' ? btoa('ipcInvoke') : 'aXBjSW52b2tl'
      // @ts-ignore preload bridge
      const inv = (window as any)[b64Invoke] || window.electron?.ipcRenderer?.invoke
      const res = await inv('db_get_replay', {sessionId})
      if (res?.ok) {
        const llm = Array.isArray(res.data?.llm) ? res.data.llm : []
        setRows(llm)
        setRaw(JSON.stringify({session: res.data?.session, llm}, null, 2))
      } else {
        setRows([])
        setRaw(String(res?.error||'failed'))
      }
    } catch (e:any) {
      setRows([])
      setRaw(String(e?.message||e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(()=>{ load() }, [])

  return (
    <Box p="4" className="space-y-3">
      <Flex gap="2" align="center">
        <Text>Session ID</Text>
        <TextField.Root value={sessionId} onChange={(e)=>setSessionId(e.target.value)} />
        <Button disabled={loading} onClick={load}>{loading?'Loading...':'Reload'}</Button>
      </Flex>

      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Time</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Turn</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Phase</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Model</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Elapsed</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r, i)=> (
            <Table.Row key={i} onClick={()=> setRaw(JSON.stringify(r, null, 2))} className="cursor-pointer">
              <Table.Cell>{r.created_at ? new Date(r.created_at).toLocaleString() : ''}</Table.Cell>
              <Table.Cell>{r.turn ?? ''}</Table.Cell>
              <Table.Cell>{r.phase ?? ''}</Table.Cell>
              <Table.Cell>{[r.provider, r.model].filter(Boolean).join('/')}</Table.Cell>
              <Table.Cell>{r.elapsed_ms ?? ''} ms</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>

      <Text>Detail</Text>
      <TextArea value={raw} onChange={()=>{}} rows={18} />
    </Box>
  )
}


