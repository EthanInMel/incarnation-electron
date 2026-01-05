import { useEffect, useState, useMemo } from 'react'
import { Box, Button, Flex, Heading, Text, TextArea, TextField, Badge, Tabs, Card, ScrollArea } from '@radix-ui/themes'

/**
 * 单张卡牌的 AI Hints 配置
 */
interface CardHint {
    cardId: number
    cardName: string
    // 出牌策略
    playHint?: string
    // 行动策略（上场后）
    actionHint?: string
    // 威胁等级 (0-10)，作为敌人时被优先攻击的程度
    threatLevel?: number
    // 保护等级 (0-10)，作为友军时被保护的程度
    protectLevel?: number
    // 战术标签
    tags?: string[]
    // 特殊条件触发的提示
    conditionalHints?: ConditionalHint[]
}

interface ConditionalHint {
    condition: 'low_hp' | 'high_mana' | 'enemy_has' | 'ally_has' | 'early_game' | 'late_game'
    threshold?: number
    targetCard?: string
    hint: string
}

/**
 * 预设的卡牌信息（从游戏数据加载）
 * TODO: 后续可以从 Server API 或本地 JSON 加载
 */
const KNOWN_CARDS: Array<{ id: number; name: string; type: string; cost: number }> = [
    { id: 1, name: 'Halberdier', type: 'Unit', cost: 2 },
    { id: 2, name: 'Knight', type: 'Unit', cost: 3 },
    { id: 3, name: 'Paladin', type: 'Unit', cost: 4 },
    { id: 4, name: 'Archer', type: 'Unit', cost: 2 },
    { id: 6, name: 'Cleric', type: 'Unit', cost: 3 },
    { id: 9, name: 'Goblin', type: 'Unit', cost: 1 },
    { id: 11, name: 'Buuuh', type: 'Unit', cost: 2 },
    { id: 12, name: 'Lycan', type: 'Unit', cost: 3 },
    { id: 13, name: 'Behemoth', type: 'Unit', cost: 5 },
    { id: 14, name: 'Dark Elf', type: 'Unit', cost: 3 },
    { id: 15, name: 'Devil', type: 'Unit', cost: 4 },
    { id: 16, name: 'Golem', type: 'Unit', cost: 4 },
    { id: 17, name: 'Griffin', type: 'Unit', cost: 3 },
    { id: 19, name: 'Fairy', type: 'Unit', cost: 2 },
    { id: 21, name: 'Disco Reaper', type: 'Unit', cost: 4 },
    { id: 23, name: 'Lightning', type: 'Spell', cost: 3 },
    { id: 25, name: 'Catapult', type: 'Unit', cost: 4 },
    { id: 27, name: 'Champion', type: 'Unit', cost: 5 },
    { id: 29, name: 'Marksman', type: 'Unit', cost: 3 },
    { id: 31, name: 'Crossbowman', type: 'Unit', cost: 2 },
    { id: 33, name: 'Cinda', type: 'Unit', cost: 5 },
    { id: 35, name: 'Morale Boost', type: 'Spell', cost: 2 },
    { id: 36, name: 'Mana Surge', type: 'Spell', cost: 1 },
    { id: 38, name: 'Masquerade', type: 'Spell', cost: 2 },
    { id: 39, name: 'Fog of War', type: 'Spell', cost: 2 },
    { id: 41, name: 'Masonry', type: 'Spell', cost: 2 },
    { id: 43, name: 'Phase Shift', type: 'Spell', cost: 3 },
    { id: 44, name: 'Barricade', type: 'Unit', cost: 1 },
    { id: 46, name: 'Mana Vault', type: 'Spell', cost: 0 },
    { id: 47, name: 'Block', type: 'Spell', cost: 1 },
    { id: 51, name: 'Mass Purify', type: 'Spell', cost: 3 },
    { id: 54, name: 'Giant Slug', type: 'Unit', cost: 4 },
    { id: 56, name: 'Dancer', type: 'Unit', cost: 3 },
    { id: 57, name: 'Medusa', type: 'Unit', cost: 4 },
    { id: 58, name: 'Barbarian', type: 'Unit', cost: 3 },
    { id: 59, name: 'Frost Mage', type: 'Unit', cost: 4 },
    { id: 60, name: 'Death Queen', type: 'Unit', cost: 6 },
    { id: 61, name: 'Ash', type: 'Unit', cost: 4 },
    { id: 62, name: 'Emerald Dragon', type: 'Unit', cost: 6 },
    { id: 63, name: 'Dropbears', type: 'Unit', cost: 2 },
    { id: 65, name: 'Chain Lightning', type: 'Spell', cost: 4 },
]

/**
 * 预设的战术标签
 */
const PRESET_TAGS = [
    'melee', 'ranged', 'assassin', 'tank', 'healer', 'buffer', 'debuffer',
    'burst', 'aoe', 'single_target', 'priority_target', 'protect_me',
    'early_game', 'late_game', 'combo_piece', 'finisher'
]

/**
 * 默认 hints 模板
 */
const DEFAULT_HINTS: Record<string, Partial<CardHint>> = {
    'Ash': {
        playHint: '刺客型单位，优先在敌方有脆皮单位时出场',
        actionHint: '优先击杀低HP敌人，尤其是远程和治疗单位',
        threatLevel: 9,
        protectLevel: 4,
        tags: ['assassin', 'burst', 'priority_target']
    },
    'Cinda': {
        playHint: '高伤害近战，费用足够时优先出场',
        actionHint: '优先攻击脆皮敌人，特别是Ash、Archer',
        threatLevel: 8,
        protectLevel: 7,
        tags: ['melee', 'burst', 'priority_target']
    },
    'Archer': {
        playHint: '远程单位，放在后排提供持续输出',
        actionHint: '优先攻击前排敌人，保持安全距离',
        threatLevel: 7,
        protectLevel: 5,
        tags: ['ranged', 'single_target']
    },
    'Cleric': {
        playHint: '治疗单位，当友军受伤时优先出场',
        actionHint: '优先治疗低HP友军，自身需要保护',
        threatLevel: 8,
        protectLevel: 8,
        tags: ['healer', 'protect_me', 'priority_target']
    },
}

export default function CardHints() {
    const [hints, setHints] = useState<Record<number, CardHint>>({})
    const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
    const [filter, setFilter] = useState<string>('')
    const [dirty, setDirty] = useState(false)

    // 加载已保存的 hints
    useEffect(() => {
        const load = async () => {
            try {
                // @ts-expect-error preload bridge
                const inv = window.electron?.ipcRenderer?.invoke || (window as any)[btoa('ipcInvoke')]
                if (typeof inv === 'function') {
                    const cfg = await inv('get_cfg')
                    if (cfg?.cardHints) {
                        setHints(cfg.cardHints)
                    }
                }
            } catch (e) {
                console.warn('[CardHints] Failed to load:', e)
            }
        }
        load()
    }, [])

    // 过滤后的卡牌列表
    const filteredCards = useMemo(() => {
        if (!filter) return KNOWN_CARDS
        const lf = filter.toLowerCase()
        return KNOWN_CARDS.filter(c =>
            c.name.toLowerCase().includes(lf) ||
            c.type.toLowerCase().includes(lf) ||
            String(c.id).includes(lf)
        )
    }, [filter])

    // 当前选中的卡牌 hint
    const currentHint = useMemo(() => {
        if (!selectedCardId) return null
        const card = KNOWN_CARDS.find(c => c.id === selectedCardId)
        if (!card) return null

        // 合并默认 hints 和用户自定义
        const defaultHint = DEFAULT_HINTS[card.name] || {}
        const userHint = hints[selectedCardId] || {}

        return {
            cardId: selectedCardId,
            cardName: card.name,
            playHint: userHint.playHint ?? defaultHint.playHint ?? '',
            actionHint: userHint.actionHint ?? defaultHint.actionHint ?? '',
            threatLevel: userHint.threatLevel ?? defaultHint.threatLevel ?? 5,
            protectLevel: userHint.protectLevel ?? defaultHint.protectLevel ?? 5,
            tags: userHint.tags ?? defaultHint.tags ?? [],
        } as CardHint
    }, [selectedCardId, hints])

    // 更新单个字段
    const updateField = <K extends keyof CardHint>(field: K, value: CardHint[K]) => {
        if (!selectedCardId) return
        setHints(prev => ({
            ...prev,
            [selectedCardId]: {
                ...prev[selectedCardId],
                cardId: selectedCardId,
                cardName: KNOWN_CARDS.find(c => c.id === selectedCardId)?.name || '',
                [field]: value
            }
        }))
        setDirty(true)
    }

    // 保存到配置
    const save = async () => {
        try {
            // @ts-expect-error preload bridge
            const inv = window.electron?.ipcRenderer?.invoke || (window as any)[btoa('ipcInvoke')]
            if (typeof inv === 'function') {
                // Convert Map to Array for server
                const list = Object.values(hints);
                const res = await inv('update_card_hints', { hints: list })

                if (res && res.ok) {
                    setDirty(false)
                    console.log('[CardHints] Saved successfully')
                } else {
                    console.error('[CardHints] Save failed:', res?.error)
                    // If socket is not connected, we might want to tell the user
                    if (res?.error === 'socket_not_connected') {
                        alert('保存失败：请确保游戏客户端正在运行并已连接')
                    } else {
                        alert('保存失败: ' + (res?.error || '未知错误'))
                    }
                }
            }
        } catch (e) {
            console.error('[CardHints] Failed to save:', e)
            alert('保存异常: ' + String(e))
        }
    }

    // 导出 JSON
    const exportHints = () => {
        const data = JSON.stringify(hints, null, 2)
        const blob = new Blob([data], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'card_hints.json'
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 500)
    }

    // 导入 JSON
    const importHints = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
            try {
                const data = JSON.parse(String(reader.result || '{}'))
                setHints(data)
                setDirty(true)
            } catch (err) {
                console.error('[CardHints] Import failed:', err)
            }
        }
        reader.readAsText(file)
    }

    // 应用默认模板
    const applyDefaults = () => {
        const newHints: Record<number, CardHint> = { ...hints }
        for (const card of KNOWN_CARDS) {
            const defaultHint = DEFAULT_HINTS[card.name]
            if (defaultHint && !newHints[card.id]) {
                newHints[card.id] = {
                    cardId: card.id,
                    cardName: card.name,
                    ...defaultHint
                } as CardHint
            }
        }
        setHints(newHints)
        setDirty(true)
    }

    return (
        <Box p="4">
            <Flex justify="between" align="center" mb="4">
                <Heading>卡牌 AI 提示词配置</Heading>
                <Flex gap="2">
                    <Button variant="soft" onClick={applyDefaults}>应用默认模板</Button>
                    <Button variant="soft" onClick={exportHints}>导出</Button>
                    <label>
                        <Button variant="soft" asChild>
                            <span>导入</span>
                        </Button>
                        <input type="file" accept="application/json" onChange={importHints} className="hidden" />
                    </label>
                    <Button color={dirty ? 'green' : 'gray'} onClick={save}>
                        {dirty ? '保存 *' : '已保存'}
                    </Button>
                </Flex>
            </Flex>

            <Flex gap="4" style={{ height: 'calc(100vh - 150px)' }}>
                {/* 左侧：卡牌列表 */}
                <Box style={{ width: '280px', flexShrink: 0 }}>
                    <TextField.Root
                        placeholder="搜索卡牌..."
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        mb="2"
                    />
                    <ScrollArea style={{ height: 'calc(100% - 40px)' }}>
                        <Flex direction="column" gap="1">
                            {filteredCards.map(card => {
                                const hasHint = !!hints[card.id]
                                const isSelected = selectedCardId === card.id
                                return (
                                    <Card
                                        key={card.id}
                                        className={`cursor-pointer transition-colors ${isSelected ? 'bg-blue-900/50' : 'hover:bg-gray-800/50'}`}
                                        onClick={() => setSelectedCardId(card.id)}
                                    >
                                        <Flex justify="between" align="center">
                                            <Flex direction="column">
                                                <Text weight="bold">{card.name}</Text>
                                                <Text size="1" color="gray">{card.type} · {card.cost}费</Text>
                                            </Flex>
                                            {hasHint && <Badge color="green" size="1">已配置</Badge>}
                                        </Flex>
                                    </Card>
                                )
                            })}
                        </Flex>
                    </ScrollArea>
                </Box>

                {/* 右侧：编辑面板 */}
                <Box style={{ flex: 1 }}>
                    {currentHint ? (
                        <Card>
                            <Heading size="4" mb="3">{currentHint.cardName} 的 AI 提示词</Heading>

                            <Tabs.Root defaultValue="basic">
                                <Tabs.List>
                                    <Tabs.Trigger value="basic">基础设置</Tabs.Trigger>
                                    <Tabs.Trigger value="advanced">高级设置</Tabs.Trigger>
                                </Tabs.List>

                                <Tabs.Content value="basic">
                                    <Flex direction="column" gap="3" mt="3">
                                        <Box>
                                            <Text as="label" size="2" weight="bold">出牌策略提示</Text>
                                            <Text size="1" color="gray" mb="1">告诉 AI 什么时候应该打出这张牌</Text>
                                            <TextArea
                                                placeholder="例如：当敌方有脆皮单位时优先出场；费用足够时尽早出场"
                                                value={currentHint.playHint || ''}
                                                onChange={(e) => updateField('playHint', e.target.value)}
                                                rows={3}
                                            />
                                        </Box>

                                        <Box>
                                            <Text as="label" size="2" weight="bold">行动策略提示</Text>
                                            <Text size="1" color="gray" mb="1">告诉 AI 这个单位上场后应该怎么行动</Text>
                                            <TextArea
                                                placeholder="例如：优先攻击低HP敌人；保护己方治疗单位"
                                                value={currentHint.actionHint || ''}
                                                onChange={(e) => updateField('actionHint', e.target.value)}
                                                rows={3}
                                            />
                                        </Box>

                                        <Flex gap="4">
                                            <Box style={{ flex: 1 }}>
                                                <Text as="label" size="2" weight="bold">威胁等级 (0-10)</Text>
                                                <Text size="1" color="gray" mb="1">作为敌人时被优先击杀的程度</Text>
                                                <TextField.Root
                                                    type="number"
                                                    min={0}
                                                    max={10}
                                                    value={String(currentHint.threatLevel || 5)}
                                                    onChange={(e) => updateField('threatLevel', Number(e.target.value))}
                                                />
                                            </Box>
                                            <Box style={{ flex: 1 }}>
                                                <Text as="label" size="2" weight="bold">保护等级 (0-10)</Text>
                                                <Text size="1" color="gray" mb="1">作为友军时被保护的程度</Text>
                                                <TextField.Root
                                                    type="number"
                                                    min={0}
                                                    max={10}
                                                    value={String(currentHint.protectLevel || 5)}
                                                    onChange={(e) => updateField('protectLevel', Number(e.target.value))}
                                                />
                                            </Box>
                                        </Flex>

                                        <Box>
                                            <Text as="label" size="2" weight="bold">战术标签</Text>
                                            <Flex gap="1" wrap="wrap" mt="1">
                                                {PRESET_TAGS.map(tag => {
                                                    const isActive = currentHint.tags?.includes(tag)
                                                    return (
                                                        <Badge
                                                            key={tag}
                                                            color={isActive ? 'blue' : 'gray'}
                                                            className="cursor-pointer"
                                                            onClick={() => {
                                                                const currentTags = currentHint.tags || []
                                                                const newTags = isActive
                                                                    ? currentTags.filter(t => t !== tag)
                                                                    : [...currentTags, tag]
                                                                updateField('tags', newTags)
                                                            }}
                                                        >
                                                            {tag}
                                                        </Badge>
                                                    )
                                                })}
                                            </Flex>
                                        </Box>
                                    </Flex>
                                </Tabs.Content>

                                <Tabs.Content value="advanced">
                                    <Flex direction="column" gap="3" mt="3">
                                        <Text color="gray">高级条件触发功能开发中...</Text>
                                        <Text size="1" color="gray">
                                            计划支持：当自己HP低于X时、当敌方有特定卡牌时、早期/晚期游戏等条件触发不同的提示词
                                        </Text>
                                    </Flex>
                                </Tabs.Content>
                            </Tabs.Root>
                        </Card>
                    ) : (
                        <Card>
                            <Flex direction="column" align="center" justify="center" style={{ height: '300px' }}>
                                <Text color="gray" size="4">← 请从左侧选择一张卡牌</Text>
                                <Text color="gray" size="2" mt="2">为每张卡牌配置 AI 决策提示词</Text>
                            </Flex>
                        </Card>
                    )}
                </Box>
            </Flex>
        </Box>
    )
}
