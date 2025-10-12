export function normName(x: any): string { try { return String(x||'').trim().toLowerCase(); } catch { return ''; } }

export function aliasName(x: any): string {
  try {
    const n = normName(x)
    const map: Record<string,string> = {
      'tryx':'tryx','崔克丝':'tryx','崔克斯':'tryx','特里克斯':'tryx',
      'skeleton':'skeleton','骷髅':'skeleton','亡灵':'skeleton','骨骼':'skeleton',
      'fairy':'fairy','小仙子':'fairy','精灵':'fairy',
      'minotaur':'minotaur','牛头人':'minotaur','牛头':'minotaur',
      'lycan':'lycan','狼人':'lycan','莱坎':'lycan',
      'ash':'ash','艾许':'ash','阿什':'ash',
      'cinda':'cinda','辛达':'cinda','辛达尔':'cinda','辛达火焰':'cinda',
      'mana vault':'manavault','manavault':'manavault','法力井':'manavault','法力水晶':'manavault',
      'second wind':'secondwind','second_wind':'secondwind','二次呼吸':'secondwind','续力':'secondwind',
    }
    for (const k of Object.keys(map)) { if (n.includes(k)) return map[k] }
    return n
  } catch { return normName(x) }
}

export function parseRC(s: string): {row:number; col:number} | null {
  try { const m = /^r(\d+)c(\d+)$/i.exec(String(s||'')); if (!m) return null; return {row:Number(m[1]), col:Number(m[2])}; } catch { return null; }
}

export function matchCardInHandByAlias(observation:any, alias:string) {
  try {
    const hand = Array.isArray(observation?.you?.hand) ? observation.you.hand : []
    const a = aliasName(alias)
    let best: any = null
    for (const c of hand) {
      const cn = aliasName(c?.name)
      if (cn && a && (cn===a || cn.includes(a) || a.includes(cn))) {
        if (!best) best = c
        if (typeof c?.label === 'string' && String(c.label).endsWith('#1')) { best = c; break }
      }
    }
    if (best) return best
  } catch {}
  return null
}

export function findCardInHandByName(observation:any, name:string) {
  try { return matchCardInHandByAlias(observation, name) } catch {} return null
}

export function findUnitByAlias(units:any[], name:string) {
  const nm = aliasName(name)
  const byLabel = units.find((u:any)=> aliasName(u?.label)===nm)
  if (byLabel) return byLabel
  const byName = units.find((u:any)=> aliasName(u?.name).includes(nm))
  return byName || null
}


