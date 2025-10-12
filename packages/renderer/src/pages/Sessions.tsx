import { useEffect, useState } from 'react'
import { Box, Button, Flex, Table, Text, TextArea, TextField } from '@radix-ui/themes'

type SessionRow = { id: string; created_at: number; meta?: any }
type EventRow = { ts: number; kind: string; payload: any }

export default function Sessions() {
  const [list, setList] = useState<SessionRow[]>([])
  const [selected, setSelected] = useState<string>('default')
  const [replay, setReplay] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)

  const inv = (()=>{
    const b64Invoke = typeof btoa === 'function' ? btoa('ipcInvoke') : 'aXBjSW52b2tl'
    // @ts-ignore preload bridge
    return (window as any)[b64Invoke] || window.electron?.ipcRenderer?.invoke
  })()

  async function loadList() {
    try {
      setLoading(true)
      const res = await inv('db_list_sessions', {limit: 200, offset: 0})
      if (res?.ok) setList(res.data || [])
    } catch {}
    finally { setLoading(false) }
  }

  async function loadReplay(id: string) {
    try {
      setLoading(true)
      const res = await inv('db_get_replay', {sessionId: id})
      if (res?.ok) setReplay(JSON.stringify(res.data, null, 2))
      else setReplay(String(res?.error || 'failed'))
    } catch (e:any) { setReplay(String(e?.message||e)) }
    finally { setLoading(false) }
  }

  useEffect(()=>{ loadList() }, [])
  useEffect(()=>{ if (selected) loadReplay(selected) }, [selected])

  return (
    <Box p="4" className="space-y-3">
      <Flex gap="2" align="center">
        <Text>Sessions</Text>
        <Button onClick={loadList} disabled={loading}>{loading?'Loading...':'Refresh'}</Button>
      </Flex>

      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Session ID</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Created</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Meta</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {list.map((s)=> (
            <Table.Row key={s.id} onClick={()=> setSelected(s.id)} className="cursor-pointer" data-selected={selected===s.id}>
              <Table.Cell>{s.id}</Table.Cell>
              <Table.Cell>{new Date(s.created_at).toLocaleString()}</Table.Cell>
              <Table.Cell>{s.meta ? JSON.stringify(s.meta) : ''}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>

      <Text>Replay</Text>
      <TextArea value={replay} onChange={()=>{}} rows={20} />
    </Box>
  )
}


