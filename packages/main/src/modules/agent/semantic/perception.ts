/**
 * Semantic v2 perception layer:
 * raw snapshot/actions -> semantic battle report (LLM-friendly) + helper mappings.
 *
 * Important: this module MUST NOT leak raw ids/cell_index as "geometry" to the LLM.
 * 对 LLM 只暴露：
 * - 符号化的位置（cell_id 作为节点编号，position_zone 等抽象标签）
 * - 图上的大致步数（dist_to_*_hero）
 * 原始 id 和完整拓扑仅通过 `internals` 暴露给 solver。
 */

export type SemanticUnitRole = 'hero' | 'tank' | 'sniper' | 'support' | 'unit';

export type SemanticBattleReport = {
  turn: number;
  context: {
    mana: number;
    tempo: 'ahead' | 'even' | 'behind';
    opponent_posture_guess: 'aggressive' | 'defensive' | 'develop';
    hex_board?: {
      cells: Array<{
        q: number;
        r: number;
        cell_id: number;
        units: string[];
        owner: 'me' | 'enemy' | 'contested' | 'none';
      }>;
      neighbors: Array<{
        q: number;
        r: number;
        neighbors: Array<{ q: number; r: number }>;
      }>;
    };
  };
  my: {
    hero: { name: string; hp?: number | null };
    units: Array<{
      name: string;
      // 位置：仅通过 cell_id（节点 id），配合 position_zone / dist_*_hero 做抽象空间理解
      cell_id?: number | null;
      position_zone?: string | null; // 如 front_left / mid_center / back_right / unknown
      dist_to_my_hero?: number | null;
      dist_to_enemy_hero?: number | null;
      role: SemanticUnitRole;
      hp?: number | null;
      atk?: number | null;
      move_range?: number | null;
      attack_range?: number | null;
      attack_type?: string | null;
      can_attack?: boolean | null;
      targets_now?: string[];
      targets_after_move?: string[];
      // 可选：逐格移动信息（用于 1 阶段 LLM 精确理解位置关系）——只暴露 to_cell_id
      moves?: Array<{
        to_cell_id: number;
        targets?: string[];
      }>;
    }>;
  };
  enemy: {
    hero: { name: string; hp?: number | null };
    units: Array<{
      name: string;
      cell_id?: number | null;
      position_zone?: string | null;
      dist_to_my_hero?: number | null;
      dist_to_enemy_hero?: number | null;
      role: SemanticUnitRole;
      hp?: number | null;
      atk?: number | null;
      move_range?: number | null;
      attack_range?: number | null;
      attack_type?: string | null;
    }>;
  };
  hand: Array<{
    name: string;
    cost?: number | null;
    type?: string | null;
    desc?: string | null;
    count?: number | null;
    playable_cells?: number[];
  }>;
};

export type SemanticInternals = {
  myNameToUnitId: Map<string, number>;
  enemyNameToUnitId: Map<string, number>;
  cellToZone: (cellIndex: number) => string;
  width: number;
  height: number;
  forwardDirY: number; // +1 means increasing row is forward, -1 decreasing, 0 unknown
};

function norm(s: any): string {
  return String(s ?? '').trim().toLowerCase();
}

function fuzzyIncludes(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function cellToZoneFactory(snapshot: any): { cellToZone: (cellIndex: number) => string; width: number; height: number; forwardDirY: number } {
  const width = Number(snapshot?.board?.width ?? 0);
  let height = Number(snapshot?.board?.height ?? 0);

  // 某些版本 Unity 只发送 width，不发送 height，这里根据最大 cell_index 进行推断，避免全部变成 unknown
  if ((!Number.isFinite(height) || height <= 0) && Number.isFinite(width) && width > 0) {
    const allUnits = [
      ...(Array.isArray(snapshot?.self_units) ? snapshot.self_units : []),
      ...(Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units : []),
    ];
    let maxIndex = -1;
    for (const u of allUnits) {
      const idx = Number(u?.cell_index ?? u?.pos?.cell_index);
      if (Number.isFinite(idx) && idx > maxIndex) maxIndex = idx;
    }
    if (maxIndex >= 0) {
      height = Math.floor(maxIndex / width) + 1;
    }
  }
  const selfHero = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index ?? -1);
  const enemyHero = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index ?? -1);
  const heroY = (width > 0 && selfHero >= 0) ? Math.floor(selfHero / width) : null;
  const enemyY = (width > 0 && enemyHero >= 0) ? Math.floor(enemyHero / width) : null;
  const dirY = (heroY != null && enemyY != null) ? Math.sign(enemyY - heroY) : 0;

  const cellToZone = (cellIndex: number): string => {
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return 'unknown';
    if (!Number.isFinite(cellIndex) || cellIndex < 0) return 'unknown';
    const x = cellIndex % width;
    const y = Math.floor(cellIndex / width);

    let lane: 'left' | 'center' | 'right' = 'center';
    if (x < width / 3) lane = 'left';
    else if (x >= (2 * width) / 3) lane = 'right';

    // 以前后方向：以“我方英雄 -> 敌方英雄”为正方向
    // 注意：Unity 棋盘的 Y 轴方向与语义前后感知相反，这里按你的定义进行调整：
    // - 我方英雄朝向敌方英雄的一侧标记为 front
    // - 反向一侧标记为 back
    let depth: 'back' | 'mid' | 'front' = 'mid';
    if (heroY != null && dirY !== 0) {
      const forward = (y - heroY) * dirY;
      // 这里有意将 forward>0 视为 back、forward<0 视为 front，以匹配当前棋盘坐标系的朝向
      if (forward >= 2) depth = 'back';
      else if (forward <= -2) depth = 'front';
      else depth = 'mid';
    } else {
      // 若无法确定朝向则退回到绝对高度划分
      const relY = y;
      if (relY < height / 3) depth = 'back';
      else if (relY >= (2 * height) / 3) depth = 'front';
      else depth = 'mid';
    }

    return `${depth}_${lane}`;
  };

  return { cellToZone, width, height, forwardDirY: dirY };
}

function roleHeuristic(u: any): SemanticUnitRole {
  if (u?.is_hero === true || String(u?.role || '').toLowerCase() === 'hero') return 'hero';
  const range = Number(u?.attack_range ?? 1);
  const tp = norm(u?.attack_type);
  if (tp.includes('ranged') || range >= 3) return 'sniper';
  const name = norm(u?.label ?? u?.name);
  if (name.includes('healer') || name.includes('fairy') || name.includes('generator')) return 'support';
  const hp = Number(u?.hp ?? 0);
  const maxHp = Number(u?.max_hp ?? u?.maxHp ?? hp);
  if (Number.isFinite(maxHp) && maxHp >= 10 && range <= 1) return 'tank';
  return 'unit';
}

function computeTempo(snapshot: any): 'ahead' | 'even' | 'behind' {
  try {
    const selfObj = snapshot?.self || snapshot?.you || {};
    const enemyObj = snapshot?.enemy || snapshot?.opponent || {};
    const myHP = Number(selfObj?.health ?? selfObj?.hero_hp ?? snapshot?.you?.hero_hp);
    const enemyHP = Number(enemyObj?.health ?? enemyObj?.hero_hp ?? snapshot?.opponent?.hero_hp);
    const myCount = Array.isArray(snapshot?.self_units) ? snapshot.self_units.length : 0;
    const enemyCount = Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units.length : 0;
    let score = 0;
    if (Number.isFinite(myHP) && Number.isFinite(enemyHP)) score += (enemyHP - myHP);
    score += (enemyCount - myCount) * 2;
    if (score >= 3) return 'behind';
    if (score <= -3) return 'ahead';
    return 'even';
  } catch {
    return 'even';
  }
}

function guessOpponentPosture(snapshot: any): 'aggressive' | 'defensive' | 'develop' {
  try {
    const myUnits = Array.isArray(snapshot?.self_units) ? snapshot.self_units : [];
    const enemyUnits = Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units : [];
    const selfObj = snapshot?.self || snapshot?.you || {};
    const enemyObj = snapshot?.enemy || snapshot?.opponent || {};
    const myHP = Number(selfObj?.health ?? snapshot?.you?.hero_hp);
    const enemyHP = Number(enemyObj?.health ?? snapshot?.opponent?.hero_hp);
    const enemyRanged = enemyUnits.filter((u: any) => {
      const tp = norm(u?.attack_type);
      const rng = Number(u?.attack_range);
      return tp.includes('ranged') || (Number.isFinite(rng) && rng > 1);
    }).length;
    if (enemyRanged >= 2 || (enemyUnits.length > myUnits.length + 1 && enemyHP >= myHP)) return 'aggressive';
    if (enemyUnits.length < myUnits.length - 1 || enemyHP < myHP - 4) return 'defensive';
    return 'develop';
  } catch {
    return 'develop';
  }
}

export function buildSemanticReport(params: {
  snapshot: any;
  actions: any[];
  tacticalPreview?: any[];
  enableHexBoard?: boolean;
}): { report: SemanticBattleReport; internals: SemanticInternals } {
  const { snapshot, actions, tacticalPreview = [], enableHexBoard = true } = params;
  const turn = Number(snapshot?.turn ?? 0);
  const selfObj = snapshot?.self || snapshot?.you || {};
  const enemyObj = snapshot?.enemy || snapshot?.opponent || {};
  const mana = Number(selfObj?.mana ?? snapshot?.you?.mana ?? 0);

  const { cellToZone, width, height, forwardDirY } = cellToZoneFactory(snapshot);

  const myUnitsRaw = Array.isArray(snapshot?.self_units) ? snapshot.self_units : [];
  const enemyUnitsRaw = Array.isArray(snapshot?.enemy_units) ? snapshot.enemy_units : [];

  const myNameToUnitId = new Map<string, number>();
  const enemyNameToUnitId = new Map<string, number>();

  // --- Build unique, human-friendly names for units (区分同名单位) ---
  const nameCounters = new Map<string, number>(); // key: norm(baseName)|side
  const myDecoratedNameById = new Map<number, string>();
  const enemyDecoratedNameById = new Map<number, string>();

  const decorateUnitName = (u: any, side: 'me' | 'enemy') => {
    const id = Number(u?.unit_id ?? u?.id);
    if (!Number.isFinite(id)) return;
    const baseRaw = String(u?.label ?? u?.name ?? '').trim()
      || (side === 'enemy' ? `Enemy${id}` : `Unit${id}`);
    const key = `${norm(baseRaw)}|${side}`;
    const count = (nameCounters.get(key) ?? 0) + 1;
    nameCounters.set(key, count);
    const decorated = count === 1 ? baseRaw : `${baseRaw}#${count}`;
    if (side === 'enemy') enemyDecoratedNameById.set(id, decorated);
    else myDecoratedNameById.set(id, decorated);
  };

  for (const u of myUnitsRaw) decorateUnitName(u, 'me');
  for (const u of enemyUnitsRaw) decorateUnitName(u, 'enemy');

  // Build name maps using decorated names（供 solver 通过 SemanticInternals 精确反查 unit_id）
  for (const [id, nm] of myDecoratedNameById.entries()) {
    myNameToUnitId.set(norm(nm), id);
  }
  for (const [id, nm] of enemyDecoratedNameById.entries()) {
    enemyNameToUnitId.set(norm(nm), id);
  }

  // --- Build global topology graph from movement information (neighbors on abstract board) ---
  const neighbors = new Map<number, Set<number>>();
  const ensureNode = (cell: number) => {
    if (!Number.isFinite(cell) || cell < 0) return;
    if (!neighbors.has(cell)) neighbors.set(cell, new Set<number>());
  };
  const addEdge = (a: number, b: number) => {
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return;
    ensureNode(a);
    ensureNode(b);
    neighbors.get(a)!.add(b);
    neighbors.get(b)!.add(a);
  };

  // seed nodes from all units' current positions
  for (const u of [...myUnitsRaw, ...enemyUnitsRaw]) {
    const cell = Number(u?.cell_index ?? u?.pos?.cell_index ?? -1);
    if (Number.isFinite(cell) && cell >= 0) ensureNode(cell);
  }

  const acts = Array.isArray(actions) ? actions : [];

  // add edges from move_unit actions (approximate from current unit cell -> target cell)
  for (const a of acts) {
    const mu = a?.move_unit;
    if (!mu) continue;
    const uid = Number(mu.unit_id);
    const toCell = Number(mu.to_cell_index ?? mu.cell_index);
    if (!Number.isFinite(uid) || !Number.isFinite(toCell)) continue;
    const unit = myUnitsRaw.find((u: any) => Number(u?.unit_id ?? u?.id) === uid)
      || enemyUnitsRaw.find((u: any) => Number(u?.unit_id ?? u?.id) === uid);
    const fromCell = Number(unit?.cell_index ?? unit?.pos?.cell_index ?? -1);
    if (Number.isFinite(fromCell) && Number.isFinite(toCell) && fromCell >= 0 && toCell >= 0) {
      addEdge(fromCell, toCell);
    }
  }

  // add edges from tactical preview move-then-attack rows
  const pv = Array.isArray(tacticalPreview) ? tacticalPreview : [];
  for (const row of pv) {
    const uid = Number(row?.unit_id ?? row?.move_then_attack?.unit_id);
    const toCell = Number(row?.to_cell_index ?? row?.move_then_attack?.to_cell_index);
    if (!Number.isFinite(uid) || !Number.isFinite(toCell)) continue;
    const unit = myUnitsRaw.find((u: any) => Number(u?.unit_id ?? u?.id) === uid)
      || enemyUnitsRaw.find((u: any) => Number(u?.unit_id ?? u?.id) === uid);
    const fromCell = Number(unit?.cell_index ?? unit?.pos?.cell_index ?? -1);
    if (Number.isFinite(fromCell) && Number.isFinite(toCell) && fromCell >= 0 && toCell >= 0) {
      addEdge(fromCell, toCell);
    }
  }

  // Build attack hints for my units
  const nowTargetsByAttacker = new Map<number, Set<string>>();
  for (const a of acts) {
    const ua = a?.unit_attack;
    if (!ua) continue;
    const att = Number(ua.attacker_unit_id);
    const tgt = Number(ua.target_unit_id);
    if (!Number.isFinite(att) || !Number.isFinite(tgt)) continue;
    const tgtUnit = enemyUnitsRaw.find((e: any) => Number(e?.unit_id ?? e?.id) === tgt) || myUnitsRaw.find((e: any) => Number(e?.unit_id ?? e?.id) === tgt);
    const tgtName = String(tgtUnit?.label ?? tgtUnit?.name ?? '').trim();
    if (!tgtName) continue;
    if (!nowTargetsByAttacker.has(att)) nowTargetsByAttacker.set(att, new Set<string>());
    nowTargetsByAttacker.get(att)!.add(tgtName);
  }

  const afterMoveTargetsByUnit = new Map<number, Set<string>>();
  const moveTargetsByUnitAndCell = new Map<number, Map<number, Set<string>>>();
  for (const row of pv) {
    const uid = Number(row?.unit_id ?? row?.move_then_attack?.unit_id);
    if (!Number.isFinite(uid)) continue;
    const toCell = Number(row?.to_cell_index ?? row?.move_then_attack?.to_cell_index);
    const atks = Array.isArray(row?.attacks) ? row.attacks : null;
    const addTarget = (tgtId: number) => {
      const tgtUnit = enemyUnitsRaw.find((e: any) => Number(e?.unit_id ?? e?.id) === Number(tgtId)) || null;
      const tgtName = String(tgtUnit?.label ?? tgtUnit?.name ?? '').trim();
      if (!tgtName) return;
      if (!afterMoveTargetsByUnit.has(uid)) afterMoveTargetsByUnit.set(uid, new Set<string>());
      afterMoveTargetsByUnit.get(uid)!.add(tgtName);
      if (!moveTargetsByUnitAndCell.has(uid)) moveTargetsByUnitAndCell.set(uid, new Map<number, Set<string>>());
      if (!moveTargetsByUnitAndCell.get(uid)!.has(toCell)) moveTargetsByUnitAndCell.get(uid)!.set(toCell, new Set<string>());
      moveTargetsByUnitAndCell.get(uid)!.get(toCell)!.add(tgtName);
    };
    if (atks && atks.length) {
      for (const a of atks) {
        const tgt = Number(a?.target_unit_id);
        if (Number.isFinite(tgt)) addTarget(tgt);
      }
    } else {
      const tgt = Number(row?.move_then_attack?.target_unit_id);
      if (Number.isFinite(tgt)) addTarget(tgt);
    }
  }

  const myHeroName = String(selfObj?.hero_name ?? snapshot?.you?.hero_name ?? myUnitsRaw.find((u: any) => u?.is_hero)?.name ?? 'MyHero');
  const enemyHeroName = String(enemyObj?.hero_name ?? snapshot?.opponent?.hero_name ?? enemyUnitsRaw.find((u: any) => u?.is_hero)?.name ?? 'EnemyHero');

  // --- Pre-compute BFS distance from my hero / enemy hero for high-level distances ---
  const selfHeroCell = Number(selfObj?.hero_cell_index ?? snapshot?.you?.hero_cell_index ?? (() => {
    const hu = myUnitsRaw.find((u: any) => u?.is_hero);
    return Number(hu?.cell_index ?? hu?.pos?.cell_index ?? -1);
  })());
  const enemyHeroCell = Number(enemyObj?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index ?? (() => {
    const hu = enemyUnitsRaw.find((u: any) => u?.is_hero);
    return Number(hu?.cell_index ?? hu?.pos?.cell_index ?? -1);
  })());

  const bfs = (start: number): Map<number, number> => {
    const dist = new Map<number, number>();
    if (!Number.isFinite(start) || start < 0 || !neighbors.has(start)) return dist;
    const q: number[] = [];
    dist.set(start, 0);
    q.push(start);
    while (q.length) {
      const cur = q.shift()!;
      const d = dist.get(cur)!;
      for (const nb of neighbors.get(cur) ?? []) {
        if (!dist.has(nb)) {
          dist.set(nb, d + 1);
          q.push(nb);
        }
      }
    }
    return dist;
  };

  const distFromMyHero = bfs(selfHeroCell);
  const distFromEnemyHero = bfs(enemyHeroCell);

  // --- Build hex_board view: axial-like coordinates (q,r) + neighbors ---
  type HexCellInfo = {
    q: number;
    r: number;
    units: Set<string>;
    owner: 'me' | 'enemy' | 'contested' | 'none';
  };
  const hexCellsMap = new Map<number, HexCellInfo>(); // key: cell_index

  const getOrCreateHexCell = (cellIndex: number, hintUnit?: any, side?: 'me' | 'enemy'): HexCellInfo | null => {
    if (!Number.isFinite(cellIndex) || cellIndex < 0) return null;
    let info = hexCellsMap.get(cellIndex);
    if (!info) {
      let q: number;
      let r: number;
      const gx = Number(hintUnit?.grid_x);
      const gy = Number(hintUnit?.grid_y);
      if (Number.isFinite(gx) && Number.isFinite(gy)) {
        q = gx;
        r = gy;
      } else if (Number.isFinite(width) && width > 0) {
        q = cellIndex % width;
        r = Math.floor(cellIndex / width);
      } else {
        q = cellIndex;
        r = 0;
      }
      info = { q, r, units: new Set<string>(), owner: 'none' };
      hexCellsMap.set(cellIndex, info);
    }
    if (hintUnit && side) {
      const name = String(hintUnit?.label ?? hintUnit?.name ?? '').trim();
      if (name) info.units.add(name);
      if (info.owner === 'none') info.owner = side;
      else if (info.owner !== side) info.owner = 'contested';
    }
    return info;
  };

  // seed from units
  for (const u of myUnitsRaw) {
    const cell = Number(u?.cell_index ?? u?.pos?.cell_index ?? -1);
    getOrCreateHexCell(cell, u, 'me');
  }
  for (const u of enemyUnitsRaw) {
    const cell = Number(u?.cell_index ?? u?.pos?.cell_index ?? -1);
    getOrCreateHexCell(cell, u, 'enemy');
  }

  // seed from playable cells (from actions)
  for (const a of acts) {
    const pc = a?.play_card;
    if (!pc) continue;
    const cell = Number(pc.cell_index);
    if (!Number.isFinite(cell) || cell < 0) continue;
    getOrCreateHexCell(cell);
  }

  // ensure neighbor cells also have coordinates (owner stays 'none' unless we saw a unit)
  for (const [cell, neighSet] of neighbors.entries()) {
    getOrCreateHexCell(cell);
    for (const nb of neighSet.values()) {
      getOrCreateHexCell(nb);
    }
  }

  const hex_board = enableHexBoard
    ? {
        cells: Array.from(hexCellsMap.entries()).map(([cell, info]) => ({
          q: info.q,
          r: info.r,
          cell_id: cell,
          units: Array.from(info.units.values()),
          owner: info.owner,
        })),
        neighbors: Array.from(neighbors.entries()).map(([cell, neighSet]) => {
          const info = hexCellsMap.get(cell);
          if (!info) {
            return {
              q: 0,
              r: 0,
              neighbors: [] as Array<{ q: number; r: number }>,
            };
          }
          const neighArr: Array<{ q: number; r: number }> = [];
          for (const nb of neighSet.values()) {
            const nInfo = hexCellsMap.get(nb);
            if (!nInfo) continue;
            neighArr.push({ q: nInfo.q, r: nInfo.r });
          }
          return {
            q: info.q,
            r: info.r,
            neighbors: neighArr,
          };
        }),
      }
    : undefined;

  const report: SemanticBattleReport = {
    turn,
    context: {
      mana,
      tempo: computeTempo(snapshot),
      opponent_posture_guess: guessOpponentPosture(snapshot),
      hex_board,
    },
    my: {
      hero: { name: myHeroName, hp: Number.isFinite(Number(selfObj?.health)) ? Number(selfObj?.health) : (Number.isFinite(Number(snapshot?.you?.hero_hp)) ? Number(snapshot?.you?.hero_hp) : null) },
      units: myUnitsRaw.map((u: any) => {
        const id = Number(u?.unit_id ?? u?.id);
        const nm = myDecoratedNameById.get(id)
          || String(u?.label ?? u?.name ?? '').trim()
          || `Unit${id}`;
        const cell = Number(u?.cell_index ?? u?.pos?.cell_index ?? -1);
        const distSelfApprox = Number.isFinite(Number((u as any)?.distance_to_self_hero))
          ? Number((u as any).distance_to_self_hero)
          : null;
        const distEnemyApprox = Number.isFinite(Number((u as any)?.distance_to_enemy_hero))
          ? Number((u as any).distance_to_enemy_hero)
          : null;
        const now = Array.from(nowTargetsByAttacker.get(id) ?? []);
        const aft = Array.from(afterMoveTargetsByUnit.get(id) ?? []);
        const mvByCell = moveTargetsByUnitAndCell.get(id) || new Map<number, Set<string>>();
        const base: any = {
          name: nm,
          cell_id: Number.isFinite(cell) && cell >= 0 ? cell : null,
          position_zone: Number.isFinite(cell) && cell >= 0 ? cellToZone(cell) : 'unknown',
          dist_to_my_hero: distFromMyHero.has(cell) ? distFromMyHero.get(cell)! : distSelfApprox,
          dist_to_enemy_hero: distFromEnemyHero.has(cell) ? distFromEnemyHero.get(cell)! : distEnemyApprox,
          role: roleHeuristic(u),
          hp: Number.isFinite(Number(u?.hp)) ? Number(u.hp) : null,
          atk: Number.isFinite(Number(u?.atk)) ? Number(u.atk) : null,
          move_range: Number.isFinite(Number(u?.move_range)) ? Number(u.move_range) : null,
          attack_range: Number.isFinite(Number(u?.attack_range)) ? Number(u.attack_range) : null,
          attack_type: (u?.attack_type != null) ? String(u.attack_type) : null,
          can_attack: (u?.can_attack != null) ? Boolean(u.can_attack) : null,
        };
        if (now.length > 0) base.targets_now = now;
        if (aft.length > 0) base.targets_after_move = aft;
        const movesArr = Array.from(mvByCell.entries()).map(([to, tgts]) => {
          const targets = Array.from(tgts.values());
          const m: any = { to_cell_id: Number.isFinite(to) && to >= 0 ? to : -1 };
          if (targets.length > 0) m.targets = targets;
          return m;
        }).filter(m => Object.keys(m).length > 0);
        if (movesArr.length > 0) base.moves = movesArr;
        return base;
      }),
    },
    enemy: {
      hero: { name: enemyHeroName, hp: Number.isFinite(Number(enemyObj?.health)) ? Number(enemyObj?.health) : (Number.isFinite(Number(snapshot?.opponent?.hero_hp)) ? Number(snapshot?.opponent?.hero_hp) : null) },
      units: enemyUnitsRaw.map((u: any) => {
        const id = Number(u?.unit_id ?? u?.id);
        const nm = enemyDecoratedNameById.get(id)
          || String(u?.label ?? u?.name ?? '').trim()
          || `Enemy${id}`;
        const cell = Number(u?.cell_index ?? u?.pos?.cell_index ?? -1);
        const distSelfApprox = Number.isFinite(Number((u as any)?.distance_to_self_hero))
          ? Number((u as any).distance_to_self_hero)
          : null;
        const distEnemyApprox = Number.isFinite(Number((u as any)?.distance_to_enemy_hero))
          ? Number((u as any).distance_to_enemy_hero)
          : null;
        return {
          name: nm,
          cell_id: Number.isFinite(cell) && cell >= 0 ? cell : null,
          position_zone: Number.isFinite(cell) && cell >= 0 ? cellToZone(cell) : 'unknown',
          dist_to_my_hero: distFromMyHero.has(cell) ? distFromMyHero.get(cell)! : distSelfApprox,
          dist_to_enemy_hero: distFromEnemyHero.has(cell) ? distFromEnemyHero.get(cell)! : distEnemyApprox,
          role: roleHeuristic(u),
          hp: Number.isFinite(Number(u?.hp)) ? Number(u.hp) : null,
          atk: Number.isFinite(Number(u?.atk)) ? Number(u.atk) : null,
          move_range: Number.isFinite(Number(u?.move_range)) ? Number(u.move_range) : null,
          attack_range: Number.isFinite(Number(u?.attack_range)) ? Number(u.attack_range) : null,
          attack_type: (u?.attack_type != null) ? String(u.attack_type) : null,
        };
      }),
    },
    hand: (() => {
      const rawHand = Array.isArray(selfObj?.hand) ? selfObj.hand : (Array.isArray(snapshot?.you?.hand) ? snapshot.you.hand : []);
      // dedupe by card_id
      const byId = new Map<number, any>();
      for (const c of rawHand) {
        const id = Number(c?.card_id ?? c?.id);
        const name = String(c?.label ?? c?.name ?? '').trim();
        if (!Number.isFinite(id) || !name) continue;
        const ex = byId.get(id) || { name, cost: c?.mana_cost ?? c?.cost, type: c?.type, desc: c?.desc, count: 0, playable_cells: new Set<number>() };
        ex.name = ex.name || name;
        if (ex.cost == null) ex.cost = c?.mana_cost ?? c?.cost;
        if (ex.type == null) ex.type = c?.type;
        if (ex.desc == null) ex.desc = c?.desc;
        ex.count++;
        byId.set(id, ex);
      }
      // derive playable cells from play_card actions
      for (const a of acts) {
        const pc = a?.play_card;
        if (!pc) continue;
        const cid = Number(pc.card_id);
        const cell = Number(pc.cell_index);
        if (!Number.isFinite(cid) || !Number.isFinite(cell)) continue;
        const entry = byId.get(cid);
        if (!entry) continue;
        // 只对 Unit 卡牌保留具体落点；Spell 类卡牌通常是全局的，这里不聚合以免棋盘视图被全图铺满
        const t = String(entry.type || '').toLowerCase();
        if (t === 'unit') {
          entry.playable_cells.add(cell);
        }
      }
      return Array.from(byId.values()).map((x: any) => {
        const base: any = {
          name: x.name,
          cost: Number.isFinite(Number(x.cost)) ? Number(x.cost) : null,
          type: x.type != null ? String(x.type) : null,
          desc: x.desc != null ? String(x.desc) : null,
          count: Number.isFinite(Number(x.count)) ? Number(x.count) : null,
        };
        const cells = Array.from(x.playable_cells.values());
        if (cells.length > 0) base.playable_cells = cells;
        return base;
      });
    })(),
  };

  const internals: SemanticInternals = {
    myNameToUnitId,
    enemyNameToUnitId,
    cellToZone,
    width,
    height,
    forwardDirY,
  };

  return { report, internals };
}


