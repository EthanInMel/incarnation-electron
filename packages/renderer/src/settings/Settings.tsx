import { useEffect, useState } from 'react'
import { Box, Button, Flex, Heading, Select, Switch, Text, TextArea, TextField, Tabs } from '@radix-ui/themes'


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
  decisionMode?: 'intent'|'hierarchical'|'policy_only'
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
    provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', bridgeToken: 'dev',
    temperature: 0.2, maxTokens: 512, maxSteps: 6, maxTurnMs: 12000,
    decisionMode: 'intent', strategyProfile: 'balanced', adaptiveTemp: true, minTemp: 0.1, maxTemp: 0.7,
    knowledge: { weight: 0.6 }, nBest: 1, nBestParallel: false, maxActions: 24,
  })

  const [showApi, setShowApi] = useState<boolean>(false)
  const [testInput, setTestInput] = useState<string>('Reply with OK')
  const [testOutput, setTestOutput] = useState<string>('')
  const [testing, setTesting] = useState<boolean>(false)

  useEffect(() => {
    const b64Invoke = typeof btoa === 'function' ? btoa('ipcInvoke') : 'aXBjSW52b2tl'
    const b64On = typeof btoa === 'function' ? btoa('ipcOn') : 'aXBjT24='
    const info = {
      // @ts-ignore runtime probe
      hasPreloadInvoke: typeof (window as any)[b64Invoke] === 'function',
      // @ts-ignore runtime probe
      hasPreloadOn: typeof (window as any)[b64On] === 'function',
    }
    console.log('[Settings] init:', info)

    try {
      // @ts-ignore preload bridge
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
    // @ts-ignore preload bridge
    const on = (window as any)[b64On]
    // @ts-ignore preload bridge
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

  function defaultBaseUrl(provider: string) {
    const p = String(provider||'').toLowerCase()
    if (p === 'siliconflow') return 'https://api.siliconflow.cn/v1'
    return 'https://api.openai.com/v1'
  }

  function handleProviderChange(p: string) {
    setCfg(prev => {
      const next: AgentConfig = {...prev, provider: p}
      // If baseUrl is empty or matches old defaults, switch to new default automatically
      const known = new Set(['https://api.openai.com/v1','https://api.siliconflow.cn/v1','http://localhost:3000'])
      if (!prev.baseUrl || known.has(String(prev.baseUrl))) next.baseUrl = defaultBaseUrl(p)
      if (!prev.endpoint) next.endpoint = 'chat/completions'
      return next
    })
  }

  async function save() {
    // Allow both send and invoke
    // @ts-ignore preload global
    const inv = window.electron?.ipcRenderer?.invoke
    // Diagnostics for why save might not work
    const b64send = typeof btoa === 'function' ? btoa('send') : 'c2VuZA=='
    const b64Invoke = typeof btoa === 'function' ? btoa('ipcInvoke') : 'aXBjSW52b2tl'
    // @ts-ignore runtime probe
    const hasElectron = !!(window as any).electron
    // @ts-ignore runtime probe
    const hasInvoke = !!((window as any).electron?.ipcRenderer?.invoke)
    // @ts-ignore runtime probe
    const hasPreloadSend = typeof (window as any)[b64send] === 'function'
    console.log('[Settings] save clicked', {cfg, hasElectron, hasInvoke, hasPreloadSend})
    if (inv) {
      // @ts-ignore preload global
      await window.electron?.ipcRenderer?.invoke('cfg', cfg)
      console.log('[Settings] cfg sent via invoke')
    } else {
      console.warn('[Settings] ipcRenderer.invoke not available; attempting send path (may be undefined)')
      // @ts-ignore preload global
      window.electron?.ipcRenderer?.send('cfg', cfg)
      try {
        // Attempt via preload-exposed send() or ipcInvoke()
        // @ts-ignore runtime probe
        const fn = (window as any)[b64send]
        if (typeof fn === 'function') {
          await fn('cfg', cfg)
          console.log('[Settings] cfg sent via preload send()')
        } else if (typeof (window as any)[b64Invoke] === 'function') {
          // @ts-ignore preload bridge
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

  async function testLLM() {
    try {
      setTesting(true)
      setTestOutput('')
      const b64Invoke = typeof btoa === 'function' ? btoa('ipcInvoke') : 'aXBjSW52b2tl'
      // @ts-ignore preload bridge
      const inv = (window as any)[b64Invoke] || window.electron?.ipcRenderer?.invoke
      if (typeof inv !== 'function') {
        console.warn('[Settings] test_llm: no ipc invoke bridge')
        setTestOutput('IPC bridge unavailable. Please try running via Electron.')
        return
      }
      const payload = { override: cfg, content: testInput }
      const res = await inv('test_llm', payload)
      if (res?.ok) {
        const usage = res?.usage ? `\nusage: ${JSON.stringify(res.usage)}` : ''
        setTestOutput(`OK (${res.provider}/${res.model}) in ${res.elapsedMs}ms${usage}\n${String(res.snippet||'')}`)
      } else {
        const headers = res?.headers ? `\nheaders: ${JSON.stringify(res.headers, null, 2)}` : ''
        const detail = res?.detail ? `\nbody: ${JSON.stringify(res.detail, null, 2)}` : ''
        const status = res?.status ? ` [${res.status}]` : ''
        setTestOutput(`FAILED${status} in ${res?.elapsedMs||0}ms: ${res?.error||'unknown'}${headers}${detail}`)
      }
    } catch (e:any) {
      setTestOutput(`error: ${String(e?.message||e)}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <Box p="4" className="space-y-4">
      <Flex justify="between" align="center">
        <Heading>Settings</Heading>
        <Button onClick={save}>Save</Button>
      </Flex>

      <Tabs.Root defaultValue="llm">
        <Tabs.List>
          <Tabs.Trigger value="llm">LLM</Tabs.Trigger>
          <Tabs.Trigger value="decision">Decision</Tabs.Trigger>
          <Tabs.Trigger value="prompts">Prompts</Tabs.Trigger>
          <Tabs.Trigger value="knowledge">Knowledge</Tabs.Trigger>
          <Tabs.Trigger value="advanced">Advanced</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="llm">
          <Flex direction="column" gap="3">
            <Flex gap="3" wrap="wrap">
              <Flex direction="column">
                <Text>Provider</Text>
                <Select.Root value={cfg.provider} onValueChange={handleProviderChange}>
                  <Select.Trigger />
                  <Select.Content>
                    <Select.Item value="openai">OpenAI</Select.Item>
                    <Select.Item value="siliconflow">SiliconFlow</Select.Item>
                  </Select.Content>
                </Select.Root>
              </Flex>
              <Flex direction="column">
                <Text>Model</Text>
                <TextField.Root value={cfg.model} onChange={(e) => update('model', e.target.value)} />
              </Flex>
              <Flex direction="column">
                <Text>API Key</Text>
                <Flex gap="2" align="center">
                  <TextField.Root type={showApi ? 'text' : 'password'} value={cfg.apiKey||''} onChange={(e) => update('apiKey', e.target.value)} />
                  <Button variant="surface" onClick={() => setShowApi(v => !v)}>{showApi ? 'Hide' : 'Show'}</Button>
                </Flex>
              </Flex>
              <Flex direction="column">
                <Text>Base URL</Text>
                <TextField.Root value={cfg.baseUrl} onChange={(e) => update('baseUrl', e.target.value)} />
              </Flex>
              <Flex direction="column">
                <Text>Endpoint</Text>
                <TextField.Root value={cfg.endpoint||'chat/completions'} onChange={(e) => update('endpoint', e.target.value)} />
              </Flex>
            </Flex>
            <Text size="1">SiliconFlow 文档见 <a href="https://docs.siliconflow.cn/cn/api-reference/" target="_blank" rel="noreferrer">docs.siliconflow.cn</a>；请选择 Chat Completions 接口。</Text>

            <Flex gap="3" wrap="wrap">
              <Flex direction="column">
                <Text>Temperature</Text>
                <TextField.Root value={String(cfg.temperature)} onChange={(e) => update('temperature', Number(e.target.value))} />
              </Flex>
              <Flex direction="column">
                <Text>Max Tokens</Text>
                <TextField.Root value={String(cfg.maxTokens)} onChange={(e) => update('maxTokens', Number(e.target.value))} />
              </Flex>
              <Flex direction="column">
                <Text>Max Steps</Text>
                <TextField.Root value={String(cfg.maxSteps)} onChange={(e) => update('maxSteps', Number(e.target.value))} />
              </Flex>
              <Flex direction="column">
                <Text>Decision Timeout (ms)</Text>
                <TextField.Root value={String(cfg.maxTurnMs)} onChange={(e) => update('maxTurnMs', Number(e.target.value))} />
              </Flex>
            </Flex>

            <Box className="space-y-2" pt="3">
              <Text>Test Prompt</Text>
              <TextArea value={testInput} onChange={(e) => setTestInput(e.target.value)} rows={3} />
              <Flex gap="2">
                <Button color="green" disabled={testing} onClick={testLLM}>{testing ? 'Testing...' : 'Test LLM'}</Button>
                <Button variant="soft" onClick={()=>setTestOutput('')}>Clear</Button>
              </Flex>
              <Text>Result</Text>
              <TextArea value={testOutput} readOnly rows={6} />
            </Box>
          </Flex>
        </Tabs.Content>

        <Tabs.Content value="decision">
          <Flex gap="3" wrap="wrap" align="center">
            <Select.Root value={cfg.decisionMode||'intent'} onValueChange={(v) => update('decisionMode', v as any)}>
              <Select.Trigger />
              <Select.Content>
                <Select.Item value="intent">Intent</Select.Item>
                <Select.Item value="hierarchical">Hierarchical</Select.Item>
                <Select.Item value="policy_only">Policy Only</Select.Item>
                <Select.Item value="mixed">Mixed</Select.Item>
                <Select.Item value="intent_driven">Intent Driven</Select.Item>
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
            <Flex direction="column">
              <Text>Min Temp</Text>
              <TextField.Root value={String(cfg.minTemp||0)} onChange={(e) => update('minTemp', Number(e.target.value))} />
            </Flex>
            <Flex direction="column">
              <Text>Max Temp</Text>
              <TextField.Root value={String(cfg.maxTemp||0)} onChange={(e) => update('maxTemp', Number(e.target.value))} />
            </Flex>
            <Flex direction="column">
              <Text>N-Best</Text>
              <TextField.Root value={String(cfg.nBest||1)} onChange={(e) => update('nBest', Number(e.target.value))} />
            </Flex>
            <Flex align="center" gap="2">
              <Switch checked={!!cfg.nBestParallel} onCheckedChange={(v) => update('nBestParallel', !!v)} />
              <Text>N-Best Parallel</Text>
            </Flex>
            <Flex direction="column">
              <Text>Max Actions</Text>
              <TextField.Root value={String(cfg.maxActions||24)} onChange={(e) => update('maxActions', Number(e.target.value))} />
            </Flex>
          </Flex>
        </Tabs.Content>

        <Tabs.Content value="prompts">
          <Flex direction="column" gap="2">
            <Text>System Prompt</Text>
            <TextArea value={cfg.systemPrompt||''} onChange={(e) => update('systemPrompt', e.target.value)} />
          </Flex>
          <Flex direction="column" gap="2">
            <Text>Few-shot (one per line: id:desc)</Text>
            <TextArea value={cfg.fewshot||''} onChange={(e) => update('fewshot', e.target.value)} />
          </Flex>
        </Tabs.Content>

        <Tabs.Content value="knowledge">
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
        </Tabs.Content>

        <Tabs.Content value="advanced">
          <Flex gap="3" wrap="wrap">
            <Flex direction="column">
              <Text>Bridge Token</Text>
              <TextField.Root value={cfg.bridgeToken||''} onChange={(e) => update('bridgeToken', e.target.value)} />
            </Flex>
          </Flex>
        </Tabs.Content>
      </Tabs.Root>
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

