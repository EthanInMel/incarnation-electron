/**
 * Card Hints Client
 * 用于管理从 Unity 传输过来的玩家卡牌 AI 提示词数据
 * 
 * 数据流：Server → Unity → Electron (through Socket)
 */

export interface CardHint {
    cardId: number;
    cardName?: string;
    playHint?: string;
    actionHint?: string;
    threatLevel: number;
    protectLevel: number;
    tags?: string;
    conditionalHints?: string;
}

// 内存缓存 - 从 Unity state 更新
let hintsCache: Map<number, CardHint> = new Map();
let lastUpdateTime = 0;

/**
 * 从 Unity 推送的 state 消息中更新卡牌提示词缓存
 * Unity 应该在 state.player_card_hints 或 state.card_hints 字段中包含数据
 */
export function updateHintsFromState(snapshot: any): void {
    try {
        // 尝试多种可能的字段名
        const hints = snapshot?.player_card_hints
            || snapshot?.card_hints
            || snapshot?.you?.card_hints
            || snapshot?.cardHints;

        if (!hints) return;

        // 如果是数组格式
        if (Array.isArray(hints)) {
            for (const hint of hints) {
                if (hint?.cardId != null) {
                    hintsCache.set(hint.cardId, {
                        cardId: hint.cardId,
                        cardName: hint.cardName || hint.card_name,
                        playHint: hint.playHint || hint.play_hint,
                        actionHint: hint.actionHint || hint.action_hint,
                        threatLevel: hint.threatLevel ?? hint.threat_level ?? 5,
                        protectLevel: hint.protectLevel ?? hint.protect_level ?? 5,
                        tags: hint.tags,
                        conditionalHints: hint.conditionalHints || hint.conditional_hints,
                    });
                }
            }
            lastUpdateTime = Date.now();
            console.log(`[CardHints] Updated ${hints.length} hints from state`);
        }
        // 如果是对象格式 { cardId: hint }
        else if (typeof hints === 'object') {
            for (const [key, hint] of Object.entries(hints)) {
                const cardId = parseInt(key) || (hint as any)?.cardId;
                if (cardId && hint) {
                    const h = hint as any;
                    hintsCache.set(cardId, {
                        cardId,
                        cardName: h.cardName || h.card_name,
                        playHint: h.playHint || h.play_hint,
                        actionHint: h.actionHint || h.action_hint,
                        threatLevel: h.threatLevel ?? h.threat_level ?? 5,
                        protectLevel: h.protectLevel ?? h.protect_level ?? 5,
                        tags: h.tags,
                        conditionalHints: h.conditionalHints || h.conditional_hints,
                    });
                }
            }
            lastUpdateTime = Date.now();
            console.log(`[CardHints] Updated ${Object.keys(hints).length} hints from state`);
        }
    } catch (e) {
        console.error('[CardHints] Failed to update from state:', e);
    }
}

/**
 * 获取指定卡牌的提示词
 */
export function getCardHint(cardId: number): CardHint | null {
    return hintsCache.get(cardId) || null;
}

/**
 * 获取所有缓存的提示词
 */
export function getAllCardHints(): CardHint[] {
    return Array.from(hintsCache.values());
}

/**
 * 清空缓存
 */
export function clearHintsCache(): void {
    hintsCache.clear();
    lastUpdateTime = 0;
}

/**
 * 检查缓存是否有效
 */
export function hasHints(): boolean {
    return hintsCache.size > 0;
}

/**
 * 获取最后更新时间
 */
export function getLastUpdateTime(): number {
    return lastUpdateTime;
}

/**
 * 为 prompt 构建准备提示词数据
 * 根据手牌/场上单位 ID 获取相关的 AI 提示词
 */
export function getHintsForPrompt(cardIds: number[]): Record<number, CardHint> {
    const result: Record<number, CardHint> = {};
    for (const id of cardIds) {
        const hint = hintsCache.get(id);
        if (hint) {
            result[id] = hint;
        }
    }
    return result;
}

/**
 * 构建 prompt 用的提示词文本块
 */
export function buildHintsPromptBlock(snapshot: any): string {
    if (hintsCache.size === 0) {
        return '';
    }

    const lines: string[] = [];

    // 1. 手牌提示词
    const hand = snapshot?.you?.hand || [];
    const handHints = hand
        .map((c: any) => {
            const cardId = c.card_id || c.cardId || c.id;
            const hint = hintsCache.get(cardId);
            if (hint?.playHint) {
                return `- ${c.label || c.name}(${c.mana_cost}费): ${hint.playHint}`;
            }
            return null;
        })
        .filter(Boolean);

    if (handHints.length > 0) {
        lines.push('📋 手牌 AI 策略：');
        lines.push(...handHints);
    }

    // 2. 友军行动提示
    const selfUnits = snapshot?.self_units || [];
    const selfHints = selfUnits
        .map((u: any) => {
            const cardId = u.card_id || u.cardId;
            const hint = cardId ? hintsCache.get(cardId) : null;
            if (hint?.actionHint) {
                return `- ${u.label || u.name}: ${hint.actionHint}`;
            }
            return null;
        })
        .filter(Boolean);

    if (selfHints.length > 0) {
        lines.push('🛡️ 友军行动策略：');
        lines.push(...selfHints);
    }

    // 3. 敌方威胁等级
    const enemyUnits = snapshot?.enemy_units || [];
    const threats = enemyUnits
        .map((u: any) => {
            const cardId = u.card_id || u.cardId;
            const hint = cardId ? hintsCache.get(cardId) : null;
            const threat = hint?.threatLevel || 5;
            if (threat >= 7) {
                return { name: u.label || u.name, hp: u.hp, threat };
            }
            return null;
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.threat - a.threat)
        .slice(0, 5);

    if (threats.length > 0) {
        lines.push('⚠️ 高威胁敌人（优先击杀）：');
        for (const t of threats) {
            lines.push(`- ${t.name}(HP:${t.hp}, 威胁:${t.threat})`);
        }
    }

    return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * 从快照中提取所有相关的 cardId
 */
export function extractCardIdsFromSnapshot(snapshot: any): number[] {
    const ids = new Set<number>();

    // 手牌
    const hand = snapshot?.you?.hand || [];
    for (const c of hand) {
        const id = c.card_id || c.cardId || c.id;
        if (typeof id === 'number') ids.add(id);
    }

    // 友军
    const selfUnits = snapshot?.self_units || [];
    for (const u of selfUnits) {
        const id = u.card_id || u.cardId;
        if (typeof id === 'number') ids.add(id);
    }

    // 敌军
    const enemyUnits = snapshot?.enemy_units || [];
    for (const u of enemyUnits) {
        const id = u.card_id || u.cardId;
        if (typeof id === 'number') ids.add(id);
    }

    return Array.from(ids);
}
