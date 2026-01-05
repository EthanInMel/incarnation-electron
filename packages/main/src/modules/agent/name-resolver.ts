/**
 * Enhanced Name Resolver - 增强版名称解析
 * 
 * 解决问题：
 * 1. 硬编码别名映射难以维护
 * 2. 模糊匹配可能错误识别
 * 3. #N 后缀解析不够鲁棒
 */

// ==================== 类型定义 ====================

export interface NameMatch {
  matched: boolean;
  confidence: number; // 0-1
  matchedItem: any | null;
  matchType: 'exact' | 'label' | 'alias' | 'fuzzy' | 'none';
  alternatives?: any[];
}

export interface UnitInfo {
  unit_id: number;
  name: string;
  label?: string;
  hp?: number;
  atk?: number;
  can_attack?: boolean;
  cell_index?: number;
}

export interface CardInfo {
  card_id: number;
  name: string;
  label?: string;
  mana_cost?: number;
}

// ==================== 别名注册表 ====================

/**
 * 可扩展的别名注册表
 * 支持多语言和常见变体
 */
class AliasRegistry {
  private aliases: Map<string, string[]> = new Map();
  
  constructor() {
    this.registerDefaults();
  }
  
  private registerDefaults(): void {
    // 格式：标准名 -> [别名列表]
    this.register('tryx', ['崔克丝', '崔克斯', '特里克斯', 'trix']);
    this.register('skeleton', ['骷髅', '亡灵', '骨骼', 'skele']);
    this.register('fairy', ['小仙子', '精灵', '仙女', 'fae']);
    this.register('minotaur', ['牛头人', '牛头', '米诺陶', 'mino']);
    this.register('lycan', ['狼人', '莱坎', '狼', 'wolf']);
    this.register('ash', ['艾许', '阿什', '灰烬']);
    this.register('cinda', ['辛达', '辛达尔', '辛达火焰', 'cynda']);
    this.register('manavault', ['mana vault', '法力井', '法力水晶', '水晶']);
    this.register('secondwind', ['second wind', 'second_wind', '二次呼吸', '续力']);
    this.register('archer', ['弓箭手', '射手']);
    this.register('crossbowman', ['弩手', '弩兵', '十字弓手']);
    this.register('hero', ['英雄', '主角']);
  }
  
  /**
   * 注册新别名
   */
  register(canonicalName: string, aliases: string[]): void {
    const existing = this.aliases.get(canonicalName.toLowerCase()) || [];
    this.aliases.set(canonicalName.toLowerCase(), [...existing, ...aliases.map(a => a.toLowerCase())]);
  }
  
  /**
   * 获取标准名称
   */
  getCanonical(name: string): string {
    const normalized = name.toLowerCase().trim();
    
    // 直接匹配标准名
    if (this.aliases.has(normalized)) {
      return normalized;
    }
    
    // 搜索别名
    for (const [canonical, aliasList] of this.aliases) {
      if (aliasList.includes(normalized)) {
        return canonical;
      }
      // 部分匹配
      for (const alias of aliasList) {
        if (normalized.includes(alias) || alias.includes(normalized)) {
          return canonical;
        }
      }
    }
    
    return normalized;
  }
  
  /**
   * 检查两个名称是否等价
   */
  isEquivalent(name1: string, name2: string): boolean {
    return this.getCanonical(name1) === this.getCanonical(name2);
  }
}

// 全局别名注册表
const aliasRegistry = new AliasRegistry();

// ==================== 核心解析函数 ====================

/**
 * 规范化名称
 * - 转小写
 * - 去除空白
 * - 统一分隔符
 */
export function normalizeName(name: any): string {
  if (name === null || name === undefined) return '';
  const str = String(name).trim().toLowerCase();
  // 统一空格和下划线
  return str.replace(/[\s_]+/g, ' ').trim();
}

/**
 * 解析带 #N 后缀的名称
 * 例如: "Tryx#1" -> { baseName: "tryx", index: 1 }
 */
export function parseNameWithIndex(name: string): { baseName: string; index: number | null } {
  const normalized = normalizeName(name);
  const match = normalized.match(/^(.+?)#(\d+)$/);
  
  if (match) {
    return {
      baseName: match[1].trim(),
      index: parseInt(match[2], 10)
    };
  }
  
  return {
    baseName: normalized,
    index: null
  };
}

/**
 * 计算编辑距离（Levenshtein Distance）
 * 用于模糊匹配
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  const matrix: number[][] = [];
  
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // 替换
          matrix[i][j - 1] + 1,     // 插入
          matrix[i - 1][j] + 1      // 删除
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

/**
 * 计算名称相似度（0-1）
 */
function nameSimilarity(name1: string, name2: string): number {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);
  
  if (n1 === n2) return 1.0;
  if (n1.length === 0 || n2.length === 0) return 0;
  
  // 检查别名等价
  if (aliasRegistry.isEquivalent(n1, n2)) {
    return 0.95;
  }
  
  // 检查包含关系
  if (n1.includes(n2) || n2.includes(n1)) {
    const shorter = n1.length < n2.length ? n1 : n2;
    const longer = n1.length >= n2.length ? n1 : n2;
    return shorter.length / longer.length * 0.9;
  }
  
  // 编辑距离
  const distance = levenshteinDistance(n1, n2);
  const maxLen = Math.max(n1.length, n2.length);
  return Math.max(0, 1 - distance / maxLen) * 0.7;
}

// ==================== 高级解析器 ====================

/**
 * 在单位列表中查找匹配的单位
 */
export function resolveUnit(
  units: UnitInfo[],
  queryName: string,
  options: {
    requireCanAttack?: boolean;
    minConfidence?: number;
  } = {}
): NameMatch {
  if (!units || units.length === 0 || !queryName) {
    return { matched: false, confidence: 0, matchedItem: null, matchType: 'none' };
  }
  
  const { baseName, index } = parseNameWithIndex(queryName);
  const minConfidence = options.minConfidence ?? 0.6;
  
  // 过滤 can_attack（如果需要）
  const candidates = options.requireCanAttack 
    ? units.filter(u => u.can_attack === true)
    : units;
  
  if (candidates.length === 0) {
    return { matched: false, confidence: 0, matchedItem: null, matchType: 'none' };
  }
  
  // 1. 精确匹配 label
  const exactLabelMatch = candidates.find(u => {
    const { baseName: unitBase, index: unitIndex } = parseNameWithIndex(u.label || '');
    return normalizeName(unitBase) === normalizeName(baseName) && 
           (index === null || unitIndex === index);
  });
  
  if (exactLabelMatch) {
    return { matched: true, confidence: 1.0, matchedItem: exactLabelMatch, matchType: 'exact' };
  }
  
  // 2. 精确匹配 name（不带 #N）
  const exactNameMatch = candidates.find(u => 
    normalizeName(u.name) === normalizeName(baseName)
  );
  
  if (exactNameMatch && index === null) {
    return { matched: true, confidence: 0.95, matchedItem: exactNameMatch, matchType: 'label' };
  }
  
  // 3. 如果有索引，按同名单位排序后取第 N 个
  if (index !== null) {
    const sameNameUnits = candidates
      .filter(u => aliasRegistry.isEquivalent(u.name || '', baseName))
      .sort((a, b) => (a.unit_id || 0) - (b.unit_id || 0));
    
    if (sameNameUnits.length >= index) {
      return { 
        matched: true, 
        confidence: 0.9, 
        matchedItem: sameNameUnits[index - 1], 
        matchType: 'label',
        alternatives: sameNameUnits
      };
    }
  }
  
  // 4. 别名匹配
  const aliasMatch = candidates.find(u => 
    aliasRegistry.isEquivalent(u.name || '', baseName) ||
    aliasRegistry.isEquivalent(u.label || '', baseName)
  );
  
  if (aliasMatch) {
    return { matched: true, confidence: 0.85, matchedItem: aliasMatch, matchType: 'alias' };
  }
  
  // 5. 模糊匹配
  let bestMatch: UnitInfo | null = null;
  let bestSimilarity = 0;
  
  for (const unit of candidates) {
    const nameSim = nameSimilarity(unit.name || '', baseName);
    const labelSim = nameSimilarity(unit.label || '', queryName);
    const maxSim = Math.max(nameSim, labelSim);
    
    if (maxSim > bestSimilarity) {
      bestSimilarity = maxSim;
      bestMatch = unit;
    }
  }
  
  if (bestMatch && bestSimilarity >= minConfidence) {
    return { 
      matched: true, 
      confidence: bestSimilarity, 
      matchedItem: bestMatch, 
      matchType: 'fuzzy' 
    };
  }
  
  // 未找到
  return { 
    matched: false, 
    confidence: bestSimilarity, 
    matchedItem: null, 
    matchType: 'none',
    alternatives: candidates.slice(0, 5) // 返回一些候选项供调试
  };
}

/**
 * 在手牌中查找匹配的卡牌
 */
export function resolveCard(
  hand: CardInfo[],
  queryName: string,
  options: {
    maxManaCost?: number;
    minConfidence?: number;
  } = {}
): NameMatch {
  if (!hand || hand.length === 0 || !queryName) {
    return { matched: false, confidence: 0, matchedItem: null, matchType: 'none' };
  }
  
  const { baseName } = parseNameWithIndex(queryName);
  const minConfidence = options.minConfidence ?? 0.6;
  
  // 过滤费用
  const candidates = options.maxManaCost !== undefined
    ? hand.filter(c => (c.mana_cost || 0) <= options.maxManaCost!)
    : hand;
  
  if (candidates.length === 0) {
    return { matched: false, confidence: 0, matchedItem: null, matchType: 'none' };
  }
  
  // 1. 精确匹配
  const exactMatch = candidates.find(c => 
    normalizeName(c.name) === normalizeName(baseName) ||
    normalizeName(c.label || '') === normalizeName(baseName)
  );
  
  if (exactMatch) {
    return { matched: true, confidence: 1.0, matchedItem: exactMatch, matchType: 'exact' };
  }
  
  // 2. 别名匹配
  const aliasMatch = candidates.find(c => 
    aliasRegistry.isEquivalent(c.name || '', baseName)
  );
  
  if (aliasMatch) {
    return { matched: true, confidence: 0.9, matchedItem: aliasMatch, matchType: 'alias' };
  }
  
  // 3. 模糊匹配
  let bestMatch: CardInfo | null = null;
  let bestSimilarity = 0;
  
  for (const card of candidates) {
    const sim = nameSimilarity(card.name || '', baseName);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestMatch = card;
    }
  }
  
  if (bestMatch && bestSimilarity >= minConfidence) {
    return { matched: true, confidence: bestSimilarity, matchedItem: bestMatch, matchType: 'fuzzy' };
  }
  
  return { 
    matched: false, 
    confidence: bestSimilarity, 
    matchedItem: null, 
    matchType: 'none',
    alternatives: candidates.slice(0, 5)
  };
}

// ==================== 便捷函数 ====================

/**
 * 解析单位 ID（兼容旧接口）
 */
export function resolveUnitId(
  units: UnitInfo[],
  queryName: string,
  isEnemy: boolean = false
): number | null {
  const result = resolveUnit(units, queryName);
  
  if (result.matched && result.matchedItem) {
    return result.matchedItem.unit_id;
  }
  
  // 兼容：尝试直接解析为数字
  const numId = parseInt(queryName, 10);
  if (!isNaN(numId) && units.some(u => u.unit_id === numId)) {
    return numId;
  }
  
  return null;
}

/**
 * 解析卡牌 ID（兼容旧接口）
 */
export function resolveCardId(
  hand: CardInfo[],
  queryName: string
): number | null {
  const result = resolveCard(hand, queryName);
  
  if (result.matched && result.matchedItem) {
    return result.matchedItem.card_id;
  }
  
  // 兼容：尝试直接解析为数字
  const numId = parseInt(queryName, 10);
  if (!isNaN(numId) && hand.some(c => c.card_id === numId)) {
    return numId;
  }
  
  return null;
}

/**
 * 判断名称是否指向英雄
 */
export function isHeroTarget(targetName: string): boolean {
  const normalized = normalizeName(targetName);
  return normalized === 'hero' || 
         normalized === '英雄' || 
         normalized === 'enemy hero' ||
         normalized === '敌方英雄';
}

/**
 * 生成单位标签（Name#N 格式）
 */
export function generateUnitLabels(units: UnitInfo[]): UnitInfo[] {
  const nameCount: Record<string, number> = {};
  
  return units.map(unit => {
    const name = unit.name || 'Unknown';
    const normalizedName = normalizeName(name);
    
    nameCount[normalizedName] = (nameCount[normalizedName] || 0) + 1;
    const index = nameCount[normalizedName];
    
    return {
      ...unit,
      label: `${name}#${index}`
    };
  });
}

// ==================== 导出别名注册表访问 ====================

export function registerAlias(canonicalName: string, aliases: string[]): void {
  aliasRegistry.register(canonicalName, aliases);
}

export function getCanonicalName(name: string): string {
  return aliasRegistry.getCanonical(name);
}

// ==================== 兼容旧接口 ====================

// 保持与原 name-utils.ts 的兼容性
export const normName = normalizeName;
export const aliasName = getCanonicalName;

export function findCardInHandByName(observation: any, name: string): CardInfo | null {
  const hand = observation?.you?.hand || observation?.self?.hand || [];
  const result = resolveCard(hand, name);
  return result.matched ? result.matchedItem : null;
}

export function findUnitByAlias(units: any[], name: string): UnitInfo | null {
  const result = resolveUnit(units, name);
  return result.matched ? result.matchedItem : null;
}

export function parseRC(s: string): { row: number; col: number } | null {
  try {
    const m = /^r(\d+)c(\d+)$/i.exec(String(s || ''));
    if (!m) return null;
    return { row: Number(m[1]), col: Number(m[2]) };
  } catch {
    return null;
  }
}

export function matchCardInHandByAlias(observation: any, alias: string): CardInfo | null {
  return findCardInHandByName(observation, alias);
}











