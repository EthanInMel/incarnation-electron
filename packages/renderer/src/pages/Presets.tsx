import { Box, Button, Flex, Heading, Select, Text, TextArea, TextField } from '@radix-ui/themes'
import { useEffect, useMemo, useState } from 'react'

export default function Presets() {
  const [list, setList] = useState<Array<{name:string; versions:Array<{version:string; systemPrompt:string; updatedAt?:number}>}>>([])
  const [name, setName] = useState('')
  const [version, setVersion] = useState('v1')
  const [sys, setSys] = useState('')

  useEffect(() => {
    load()
  }, [])

  const names = useMemo(() => list.map(p => p.name), [list])
  const versions = useMemo(() => (list.find(p => p.name === name)?.versions ?? []).map(v => v.version), [list, name])

  function normalizePresets(arr: any[]) {
    for (const p of arr) {
      if (!p.versions) {
        p.versions = [{version:'v1', systemPrompt: p.systemPrompt||''}]
        delete p.systemPrompt
      }
    }
    return arr
  }

  function load() {
    try {
      const raw = localStorage.getItem('ai_presets')
      let arr: any[] = []
      try { arr = raw ? JSON.parse(raw) : [] } catch { arr = [] }
      arr = normalizePresets(arr)
      localStorage.setItem('ai_presets', JSON.stringify(arr))
      setList(arr)
      if (!arr.find(p => p.name === name) && arr[0]) setName(arr[0].name)
      const pv = arr.find(p => p.name === name)?.versions?.[0]?.version
      if (pv) setVersion(pv)
    } catch {}
  }

  function saveVersion() {
    if (!name.trim()) return
    let arr: any[]
    try { arr = JSON.parse(localStorage.getItem('ai_presets')||'[]') } catch { arr = [] }
    arr = normalizePresets(arr)
    let p = arr.find((x:any) => x.name === name)
    if (!p) { p = {name, versions: []}; arr.push(p) }
    const ex = p.versions.find((x:any) => x.version === (version||'v1'))
    const data = {version: version||'v1', systemPrompt: sys, updatedAt: Date.now()}
    if (ex) Object.assign(ex, data); else p.versions.push(data)
    localStorage.setItem('ai_presets', JSON.stringify(arr))
    setList(arr)
  }

  function applyVersion() {
    if (!name || !version) return
    const p = list.find(x => x.name === name)
    if (!p || !p.versions) return
    const v = p.versions.find(x => x.version === version) || p.versions[0]
    if (!v) return
    setSys(v.systemPrompt || '')
  }

  function deletePresetOrVersion() {
    if (!name) return
    let arr: any[]
    try { arr = JSON.parse(localStorage.getItem('ai_presets')||'[]') } catch { arr = [] }
    arr = normalizePresets(arr)
    if (version) {
      const p = arr.find((x:any) => x.name === name)
      if (p) {
        p.versions = p.versions.filter((x:any) => x.version !== version)
        if (!p.versions.length) arr = arr.filter((x:any) => x.name !== name)
      }
    } else {
      arr = arr.filter((x:any) => x.name !== name)
    }
    localStorage.setItem('ai_presets', JSON.stringify(arr))
    setList(arr)
    if (!arr.find(p => p.name === name)) setName(arr[0]?.name || '')
  }

  function exportPresets() {
    const raw = localStorage.getItem('ai_presets') || '[]'
    download('presets.json', raw)
  }

  function importPresets(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files && ev.target.files[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const incoming = JSON.parse(String(reader.result||'[]'))
        if (!Array.isArray(incoming)) throw new Error('Invalid format')
        let arr: any[]
        try { arr = JSON.parse(localStorage.getItem('ai_presets')||'[]') } catch { arr = [] }
        arr = normalizePresets(arr)
        const inc = normalizePresets(incoming)
        for (const p of inc) {
          let target = arr.find((x:any) => x.name === p.name)
          if (!target) { arr.push(p); continue }
          if (p.versions) {
            for (const v of p.versions) {
              const ex = target.versions.find((x:any) => x.version === v.version)
              if (ex) Object.assign(ex, v); else target.versions.push(v)
            }
          }
        }
        localStorage.setItem('ai_presets', JSON.stringify(arr))
        setList(arr)
      } catch (e) {
        console.warn('Import failed', e)
      }
    }
    reader.readAsText(f)
  }

  return (
    <Box p="4">
      <Heading>Presets</Heading>
      <Flex gap="3" mt="3" wrap="wrap" align="center">
        <TextField.Root placeholder="Preset name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField.Root placeholder="Version" value={version} onChange={(e) => setVersion(e.target.value)} />
        <Select.Root value={name} onValueChange={setName}>
          <Select.Trigger />
          <Select.Content>
            {names.map(n => <Select.Item key={n} value={n}>{n}</Select.Item>)}
          </Select.Content>
        </Select.Root>
        <Select.Root value={version} onValueChange={setVersion}>
          <Select.Trigger />
          <Select.Content>
            {versions.map(v => <Select.Item key={v} value={v}>{v}</Select.Item>)}
          </Select.Content>
        </Select.Root>
        <Button onClick={saveVersion}>Save/Update</Button>
        <Button onClick={applyVersion}>Apply</Button>
        <Button color="red" onClick={deletePresetOrVersion}>Delete</Button>
      </Flex>

      <Box mt="3">
        <Text>System Prompt</Text>
        <TextArea value={sys} onChange={(e) => setSys(e.target.value)} style={{width:'100%', height: 160}} />
      </Box>

      <Flex gap="2" mt="3" align="center">
        <Button onClick={exportPresets}>Export Presets (JSON)</Button>
        <input type="file" accept="application/json" onChange={importPresets} />
      </Flex>
    </Box>
  )
}

function download(name: string, content: string) {
  const blob = new Blob([content], {type: 'application/json'})
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 500)
}

