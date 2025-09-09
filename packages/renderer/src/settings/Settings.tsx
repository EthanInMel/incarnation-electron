import { useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Heading, Select, Switch, Text, TextArea, TextField } from '@radix-ui/themes'


type AgentConfig = {
  provider: string
  model: string
  apiKey?: string
  baseUrl: string
  bridgeToken?: string
  temperature: number
  maxTokens: number
  maxSteps: number
  maxTurnMs: number
  endpoint?: string
  systemPrompt?: string
  decisionMode?: 'json_strict'|'tool_call'|'rank_then_choose'|'policy_only'
  strategyProfile?: 'balanced'|'aggressive'|'defensive'
  adaptiveTemp?: boolean
  minTemp?: number
  maxTemp?: number
  fewshot?: string
  nBest?: number
  nBestParallel?: boolean
  maxActions?: number
  knowledge?: {
    weight?: number
    global?: string
    phase?: string
    cards?: string
  }
}

export default function Settings() {
  const [cfg, setCfg] = useState<AgentConfig>({
    provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'http://localhost:3000', bridgeToken: 'dev',
    temperature: 0.2, maxTokens: 512, maxSteps: 6, maxTurnMs: 12000,
    decisionMode: 'json_strict', strategyProfile: 'balanced', adaptiveTemp: true, minTemp: 0.1, maxTemp: 0.7,
    knowledge: { weight: 0.6 }, nBest: 1, nBestParallel: false, maxActions: 24,
  })

  useEffect(() => {
    const b64Invoke = typeof btoa === 'function' ? btoa('ipcInvoke') : 'aXBjSW52b2tl'
    const b64On = typeof btoa === 'function' ? btoa('ipcOn') : 'aXBjT24='
    const info = {
      // @ts-expect-error runtime probe
      hasPreloadInvoke: typeof (window as any)[b64Invoke] === 'function',
      // @ts-expect-error runtime probe
      hasPreloadOn: typeof (window as any)[b64On] === 'function',
    }
    console.log('[Settings] init:', info)

    try {
      // @ts-expect-error preload bridge
      ;(window as any)[b64Invoke]('get_cfg').then((c: AgentConfig) => { if (c) setCfg(prev => ({...prev, ...c})) }).catch((e: any) => {
        console.warn('[Settings] get_cfg via preload ipcInvoke failed:', e)
      })
    } catch (e) {
      console.warn('[Settings] preload ipcInvoke not available:', e)
    }
  }, [])

  useEffect(() => {
    // React to main broadcasts so fields populate on startup as soon as main loads config
    const b64On = typeof btoa === 'function' ? btoa('ipcOn') : 'aXBjT24='
    const b64Off = typeof btoa === 'function' ? btoa('ipcOff') : 'aXBjT2Zm'
    // @ts-expect-error preload bridge
    const on = (window as any)[b64On]
    // @ts-expect-error preload bridge
    const off = (window as any)[b64Off]
    if (typeof on !== 'function' || typeof off !== 'function') return
    const onLoaded = (c: AgentConfig) => { if (c) setCfg(prev => ({...prev, ...c})) }
    const onSaved = (p: any) => { console.log('[Settings] cfg_saved received', p) }
    on('cfg_loaded', onLoaded)
    on('cfg_saved', onSaved)
    return () => {
      off('cfg_loaded', onLoaded)
      off('cfg_saved', onSaved)
    }
  }, [])

  function update<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) {
    setCfg(prev => ({...prev, [key]: value}))
  }

  function updateK<K extends keyof NonNullable<AgentConfig['knowledge']>>(key: K, value: NonNullable<AgentConfig['knowledge']>[K]) {
    setCfg(prev => ({...prev, knowledge: {...(prev.knowledge||{}), [key]: value}}))
  }

  async function save() {
    // Allow both send and invoke
    // @ts-expect-error preload global
    const inv = window.electron?.ipcRenderer?.invoke
    // Diagnostics for why save might not work
    const b64send = typeof btoa === 'function' ? btoa('send') : 'c2VuZA=='
    const b64Invoke = typeof btoa === 'function' ? btoa('ipcInvoke') : 'aXBjSW52b2tl'
    // @ts-expect-error runtime probe
    const hasElectron = !!(window as any).electron
    // @ts-expect-error runtime probe
    const hasInvoke = !!((window as any).electron?.ipcRenderer?.invoke)
    // @ts-expect-error runtime probe
    const hasPreloadSend = typeof (window as any)[b64send] === 'function'
    console.log('[Settings] save clicked', {cfg, hasElectron, hasInvoke, hasPreloadSend})
    if (inv) {
      // @ts-expect-error preload global
      await window.electron?.ipcRenderer?.invoke('cfg', cfg)
      console.log('[Settings] cfg sent via invoke')
    } else {
      console.warn('[Settings] ipcRenderer.invoke not available; attempting send path (may be undefined)')
      // @ts-expect-error preload global
      window.electron?.ipcRenderer?.send('cfg', cfg)
      try {
        // Attempt via preload-exposed send() or ipcInvoke()
        // @ts-expect-error runtime probe
        const fn = (window as any)[b64send]
        if (typeof fn === 'function') {
          await fn('cfg', cfg)
          console.log('[Settings] cfg sent via preload send()')
        } else if (typeof (window as any)[b64Invoke] === 'function') {
          // @ts-expect-error preload bridge
          await (window as any)[b64Invoke]('cfg', cfg)
          console.log('[Settings] cfg sent via preload ipcInvoke()')
        } else {
          console.warn('[Settings] preload send() not available under key', b64send)
        }
      } catch (e) {
        console.warn('[Settings] preload send() failed', e)
      }
    }
  }

  return (
    <Box p="4" className="space-y-4">
      <Flex justify="between" align="center">
        <Heading>Settings</Heading>
        <Button onClick={save}>Save</Button>
      </Flex>

      <Flex gap="3" wrap="wrap">
        <TextField.Root placeholder="Provider" value={cfg.provider} onChange={(e) => update('provider', e.target.value)} />
        <TextField.Root placeholder="Model" value={cfg.model} onChange={(e) => update('model', e.target.value)} />
        <TextField.Root placeholder="API Key" type="password" value={cfg.apiKey||''} onChange={(e) => update('apiKey', e.target.value)} />
        <TextField.Root placeholder="Dispatcher Base URL" value={cfg.baseUrl} onChange={(e) => update('baseUrl', e.target.value)} />
        <TextField.Root placeholder="Bridge Token" value={cfg.bridgeToken||''} onChange={(e) => update('bridgeToken', e.target.value)} />
      </Flex>

      <Flex gap="3" wrap="wrap">
        <TextField.Root placeholder="Temperature" value={String(cfg.temperature)} onChange={(e) => update('temperature', Number(e.target.value))} />
        <TextField.Root placeholder="Max Tokens" value={String(cfg.maxTokens)} onChange={(e) => update('maxTokens', Number(e.target.value))} />
        <TextField.Root placeholder="Max Steps" value={String(cfg.maxSteps)} onChange={(e) => update('maxSteps', Number(e.target.value))} />
        <TextField.Root placeholder="Max Turn Ms" value={String(cfg.maxTurnMs)} onChange={(e) => update('maxTurnMs', Number(e.target.value))} />
      </Flex>

      <Flex gap="3" wrap="wrap" align="center">
        <Select.Root value={cfg.decisionMode||'json_strict'} onValueChange={(v) => update('decisionMode', v as any)}>
          <Select.Trigger />
          <Select.Content>
            <Select.Item value="json_strict">JSON Strict</Select.Item>
            <Select.Item value="tool_call">Tool Call</Select.Item>
            <Select.Item value="rank_then_choose">Rank then Choose</Select.Item>
            <Select.Item value="policy_only">Policy Only</Select.Item>
          </Select.Content>
        </Select.Root>

        <Select.Root value={cfg.strategyProfile||'balanced'} onValueChange={(v) => update('strategyProfile', v as any)}>
          <Select.Trigger />
          <Select.Content>
            <Select.Item value="balanced">Balanced</Select.Item>
            <Select.Item value="aggressive">Aggressive</Select.Item>
            <Select.Item value="defensive">Defensive</Select.Item>
          </Select.Content>
        </Select.Root>

        <Flex align="center" gap="2">
          <Switch checked={!!cfg.adaptiveTemp} onCheckedChange={(v) => update('adaptiveTemp', !!v)} />
          <Text>Adaptive Temp</Text>
        </Flex>
      </Flex>

      <Flex gap="3" wrap="wrap">
        <TextField.Root placeholder="Min Temp" value={String(cfg.minTemp||0)} onChange={(e) => update('minTemp', Number(e.target.value))} />
        <TextField.Root placeholder="Max Temp" value={String(cfg.maxTemp||0)} onChange={(e) => update('maxTemp', Number(e.target.value))} />
        <TextField.Root placeholder="N-Best" value={String(cfg.nBest||1)} onChange={(e) => update('nBest', Number(e.target.value))} />
        <Flex align="center" gap="2">
          <Switch checked={!!cfg.nBestParallel} onCheckedChange={(v) => update('nBestParallel', !!v)} />
          <Text>N-Best Parallel</Text>
        </Flex>
        <TextField.Root placeholder="Max Actions" value={String(cfg.maxActions||24)} onChange={(e) => update('maxActions', Number(e.target.value))} />
      </Flex>

      <Flex direction="column" gap="2">
        <Text>System Prompt</Text>
        <TextArea value={cfg.systemPrompt||''} onChange={(e) => update('systemPrompt', e.target.value)} />
      </Flex>

      <Flex direction="column" gap="2">
        <Text>Few-shot (one per line: id:desc)</Text>
        <TextArea value={cfg.fewshot||''} onChange={(e) => update('fewshot', e.target.value)} />
      </Flex>

      <Flex direction="column" gap="2">
        <Text>Knowledge Global</Text>
        <TextArea value={cfg.knowledge?.global||''} onChange={(e) => updateK('global', e.target.value)} />
      </Flex>

      <Flex direction="column" gap="2">
        <Text>Knowledge Phase (phase:note per line)</Text>
        <TextArea value={cfg.knowledge?.phase||''} onChange={(e) => updateK('phase', e.target.value)} />
      </Flex>

      <Flex direction="column" gap="2">
        <Text>Knowledge Cards (card_id:note per line)</Text>
        <TextArea value={cfg.knowledge?.cards||''} onChange={(e) => updateK('cards', e.target.value)} />
      </Flex>

      <Flex gap="3" wrap="wrap" align="center">
        <TextField.Root placeholder="Knowledge Weight" value={String(cfg.knowledge?.weight||0.6)} onChange={(e) => updateK('weight', Number(e.target.value))} />
        <Button onClick={() => exportKnowledge(cfg)}>Export Knowledge (JSON)</Button>
        <label className="text-sm">
          <input type="file" accept="application/json" onChange={(e) => importKnowledge(e, setCfg)} />
        </label>
      </Flex>
    </Box>
  )
}

function exportKnowledge(cfg: any) {
  const data = {
    global: cfg?.knowledge?.global || '',
    phase: cfg?.knowledge?.phase || '',
    cards: cfg?.knowledge?.cards || '',
    weight: Number.isFinite(cfg?.knowledge?.weight) ? cfg.knowledge.weight : 0.6,
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'})
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'knowledge.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 500)
}

function importKnowledge(ev: React.ChangeEvent<HTMLInputElement>, setCfg: any) {
  const f = ev.target.files && ev.target.files[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result||'{}'))
      setCfg((prev: any) => ({...prev, knowledge: {
        weight: (data?.weight != null ? Number(data.weight) : (prev?.knowledge?.weight ?? 0.6)),
        global: data?.global || '',
        phase: data?.phase || '',
        cards: data?.cards || '',
      }}))
    } catch (e) {
      console.warn('Import knowledge failed', e)
    }
  }
  reader.readAsText(f)
}

