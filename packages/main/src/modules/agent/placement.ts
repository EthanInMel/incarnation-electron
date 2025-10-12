import {aliasName} from './name-utils.js'

export function computeForward(snapshot:any, W:number) {
  try {
    const selfIdx = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index)
    const oppIdx = Number(snapshot?.enemy?.hero_cell_index ?? snapshot?.opponent?.hero_cell_index)
    if (Number.isFinite(selfIdx) && Number.isFinite(oppIdx)) {
      const r1 = Math.floor(selfIdx/W), c1 = selfIdx%W
      const r2 = Math.floor(oppIdx/W), c2 = oppIdx%W
      const dr = Math.sign(r2-r1)||1; const dc = Math.sign(c2-c1)||0
      return {dr,dc}
    }
  } catch {}
  return {dr:1, dc:0}
}

export function scorePlayActionByHint(a:any, hint:any, snapshot:any, W:number) {
  try {
    const ci = Number(a?.play_card?.cell_index); if (!Number.isFinite(ci)) return -1
    const row = Math.floor(ci / W), col = ci % W
    const txt = aliasName(hint?.hint || hint?.pos || hint?.position || hint || '')
    const lanePref = txt.includes('center') ? 'center' : (txt.includes('left') ? 'left' : (txt.includes('right') ? 'right' : null))
    // 新增：支持 defensive/offensive 语义
    const regionPref = txt.includes('offensive')||txt.includes('front')||txt.includes('forward')||txt.includes('attack') ? 'frontline' 
      : (txt.includes('defensive')||txt.includes('back')||txt.includes('protect')||txt.includes('shield') ? 'backline' 
      : (txt.includes('mid') ? 'mid' : null))
    const fwd = computeForward(snapshot, W)
    let u_n = 0
    try { const sIdx = Number(snapshot?.self?.hero_cell_index ?? snapshot?.you?.hero_cell_index); const sr = Math.floor(sIdx/W), sc = sIdx%W; const drs = row - sr, dcs = col - sc; const len = Math.max(1, Math.hypot(W,W)); const u_f = drs*fwd.dr + dcs*fwd.dc; u_n = u_f/len } catch {}
    let s = 0
    if (lanePref==='left' && col < Math.floor(W/2)) s += 2; if (lanePref==='right' && col > Math.floor(W/2)) s += 2; if (lanePref==='center' && Math.abs(col - Math.floor(W/2))<=1) s += 2
    if (regionPref==='frontline') s += Math.max(0, u_n)
    if (regionPref==='backline') s += Math.max(0, 1 - Math.max(0, u_n))
    if (!lanePref) s += 0.5; if (!regionPref) s += 0.5
    if (txt.includes('behind')) {
      try {
        const parts = txt.split(/\s+/); const idx = parts.indexOf('behind'); if (idx>=0 && parts[idx+1]) {
          const targetAlias = aliasName(parts.slice(idx+1).join(' '))
          const units = Array.isArray(snapshot?.self_units)? snapshot.self_units : []
          const u = units.find((x:any)=> aliasName(x?.label||x?.name)===targetAlias || aliasName(x?.name)===targetAlias)
          if (u && Number.isFinite(u?.row) && Number.isFinite(u?.col)) {
            const br = Number(u.row) - fwd.dr; const bc = Number(u.col) - fwd.dc
            const d = Math.hypot(row-br, col-bc)
            s += Math.max(0, 2 - d)
          }
        }
      } catch {}
    }
    return s
  } catch { return -1 }
}



