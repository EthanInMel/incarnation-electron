/**
 * Intent Translator: Convert high-level LLM intents to concrete action IDs
 */

export interface Intent {
  type: 'advance_and_attack' | 'direct_attack' | 'defensive_play' | 'aggressive_play' | 'reposition' | 'end_turn';
  unit?: string;
  target?: string;
  card?: string;
  zone?: string;
  direction?: string;
  intent?: string;
}

export interface TurnPlanStep {
  type: 'move_then_attack' | 'unit_attack' | 'play_card' | 'move' | 'end_turn';
  unit_id?: number;
  target_unit_id?: number;
  card_id?: number;
  to?: { cell_index: number };
  [key: string]: any;
}

/**
 * Translate LLM intent to executable turn_plan steps
 */
export function translateIntent(
  intent: Intent,
  snapshot: any,
  actions: any[]
): TurnPlanStep[] {
  switch (intent.type) {
    case 'advance_and_attack':
      return translateAdvanceAndAttack(intent, snapshot, actions);
    
    case 'direct_attack':
      return translateDirectAttack(intent, snapshot, actions);
    
    case 'defensive_play':
      return translateDefensivePlay(intent, snapshot, actions);
    
    case 'aggressive_play':
      return translateAggressivePlay(intent, snapshot, actions);
    
    case 'reposition':
      return translateReposition(intent, snapshot, actions);
    
    case 'end_turn':
      return [{ type: 'end_turn' }];
    
    default:
      return [];
  }
}

/**
 * advance_and_attack: Find unit, find target, create move_then_attack step
 * The Unity bridge will intelligently handle execution and fallback
 */
function translateAdvanceAndAttack(
  intent: Intent,
  snapshot: any,
  actions: any[]
): TurnPlanStep[] {
  try {
    // 1. Find unit by name (fuzzy match)
    const unitName = (intent.unit || '').toLowerCase().trim();
    if (!unitName) {
      console.warn('[IntentTranslator] No unit specified');
      return [];
    }

    const selfUnits = snapshot?.self_units || [];
    let unit = selfUnits.find((u: any) => {
      const label = (u.label || u.name || '').toLowerCase();
      return label === unitName || label.includes(unitName) || unitName.includes(label);
    });

    // Try extracting base name (e.g., "Tryx#1" -> "Tryx")
    if (!unit && unitName.includes('#')) {
      const baseName = unitName.split('#')[0];
      unit = selfUnits.find((u: any) => {
        const label = (u.label || u.name || '').toLowerCase();
        return label.includes(baseName);
      });
    }

    if (!unit) {
      console.warn(`[IntentTranslator] Unit not found: ${unitName}. Available: ${selfUnits.map((u:any) => u.label || u.name).join(', ')}`);
      return [];
    }

    // 2. Find target by name (prefer exact match, fallback to fuzzy + smart selection)
    const targetName = (intent.target || '').toLowerCase().trim();
    const enemyUnits = snapshot?.enemy_units || [];
    
    let target = enemyUnits.find((e: any) => {
      const label = (e.label || e.name || '').toLowerCase();
      return label === targetName || label.includes(targetName) || targetName.includes(label);
    });

    // Fallback: smart target selection based on intent
    if (!target && targetName) {
      // Try hero if target includes "hero"
      if (targetName.includes('hero')) {
        target = enemyUnits.find((e: any) => {
          const label = (e.label || e.name || '').toLowerCase();
          return label.includes('hero') || e.is_hero || e.role === 'hero';
        });
      }
    }

    if (!target) {
      const intentType = intent.intent || 'pressure';
      target = selectTargetByIntent(unit, enemyUnits, intentType);
      if (target) {
        console.log(`[IntentTranslator] Auto-selected target: ${target.label || target.name} (intent: ${intentType})`);
      }
    }

    if (!target) {
      console.warn(`[IntentTranslator] No valid target found for ${unitName}. Available: ${enemyUnits.map((e:any) => e.label || e.name).join(', ')}`);
      return [];
    }

    const unitId = unit.unit_id;
    const targetId = target.unit_id;

    // 3. Check tactical preview for move→attack opportunities
    const preview = snapshot?.tactical_preview || snapshot?.move_attack_opportunities || [];
    
    // Try to find exact unit+target match
    let opportunity = null;
    if (Array.isArray(preview)) {
      opportunity = preview.find((p: any) =>
        p.unit_id === unitId &&
        Array.isArray(p.attacks) &&
        p.attacks.some((a: any) => a.target_unit_id === targetId)
      );

      // Fallback: find any move for this unit that enables attacks
      if (!opportunity) {
        opportunity = preview.find((p: any) =>
          p.unit_id === unitId &&
          Array.isArray(p.attacks) &&
          p.attacks.length > 0
        );
      }
    }

    if (opportunity && opportunity.to_cell_index != null) {
      console.log(`[IntentTranslator] ✅ move_then_attack: ${unit.label || unit.name} -> ${target.label || target.name}`);
      // Try to locate an explicit id_attack for this (unit, move, target)
      let attackId: number | null = null;
      try {
        const atks = (opportunity.attacks || []) as any[];
        if (Array.isArray(atks) && atks.length) {
          const hit = atks.find((a:any)=> Number(a?.target_unit_id) === Number(targetId));
          if (hit && Number.isFinite(Number(hit.id_attack))) attackId = Number(hit.id_attack);
        }
        if (attackId == null && Number.isFinite(Number(opportunity.id_attack))) {
          attackId = Number(opportunity.id_attack);
        }
      } catch {}

      const step:any = {
        type: 'move_then_attack',
        unit_id: unitId,
        to: { cell_index: opportunity.to_cell_index },
        target_unit_id: targetId
      };
      if (attackId != null) (step as any).attack_id = attackId;
      return [step];
    }

    // 4. Fallback: try direct attack (no move)
    const canAttackNow = unit.can_attack === true;
    if (canAttackNow) {
      console.log(`[IntentTranslator] ✅ direct attack: ${unit.label || unit.name} -> ${target.label || target.name}`);
      return [{
        type: 'unit_attack',
        attacker_unit_id: unitId,
        target_unit_id: targetId
      }];
    }

    console.warn(`[IntentTranslator] ❌ No attack path: ${unitName} -> ${targetName} (can_attack=${unit.can_attack})`);
    return [];
  } catch (e) {
    console.error('[IntentTranslator] advance_and_attack error:', e);
    return [];
  }
}

/**
 * direct_attack: Find unit and target, create attack step
 */
function translateDirectAttack(
  intent: Intent,
  snapshot: any,
  actions: any[]
): TurnPlanStep[] {
  try {
    const unitName = intent.unit || '';
    const targetName = intent.target || '';

    const selfUnits = snapshot?.self_units || [];
    const unit = selfUnits.find((u: any) =>
      (u.label || u.name || '').toLowerCase().includes(unitName.toLowerCase())
    );

    const enemyUnits = snapshot?.enemy_units || [];
    const target = enemyUnits.find((e: any) =>
      (e.label || e.name || '').toLowerCase().includes(targetName.toLowerCase())
    ) || enemyUnits[0]; // fallback to first enemy

    if (!unit || !target) {
      console.warn(`[IntentTranslator] direct_attack: missing unit or target`);
      return [];
    }

    return [{
      type: 'unit_attack',
      attacker_unit_id: unit.unit_id,
      target_unit_id: target.unit_id
    }];
  } catch (e) {
    console.error('[IntentTranslator] direct_attack error:', e);
    return [];
  }
}

/**
 * defensive_play: Find card in hand, determine best defensive position
 */
function translateDefensivePlay(
  intent: Intent,
  snapshot: any,
  actions: any[]
): TurnPlanStep[] {
  try {
    const cardName = (intent.card || '').toLowerCase().trim();
    const hand = snapshot?.you?.hand || [];
    
    let card = hand.find((c: any) => {
      const label = (c.label || c.name || '').toLowerCase();
      return label === cardName || label.includes(cardName) || cardName.includes(label);
    });

    if (!card) {
      console.warn(`[IntentTranslator] Card not found: ${cardName}. Hand: ${hand.map((c:any) => c.label || c.name).join(', ')}`);
      return [];
    }

    const cardId = card.card_id;
    const places = snapshot?.places_by_card?.[cardId] || [];
    
    if (places.length === 0) {
      console.warn(`[IntentTranslator] No valid placements for ${cardName}`);
      return [];
    }

    let bestCell: any = null;
    const zone = intent.zone || 'protect_hero';

    if (zone === 'protect_hero') {
      // Prefer backline, not ahead
      bestCell = places.find((p: any) => p.region === 'backline' && !p.ahead);
      if (!bestCell) {
        bestCell = places.find((p: any) => !p.ahead);
      }
      if (!bestCell) {
        bestCell = places[0];
      }
    } else if (zone === 'frontline') {
      bestCell = places.find((p: any) => p.region === 'frontline');
      if (!bestCell) {
        bestCell = places.find((p: any) => p.ahead);
      }
      if (!bestCell) {
        bestCell = places[0];
      }
    } else {
      // Default: mid/backline
      bestCell = places.find((p: any) => p.region !== 'frontline') || places[0];
    }

    console.log(`[IntentTranslator] ✅ defensive_play: ${card.label || card.name} @ ${bestCell.pos || bestCell.cell_index}`);
    return [{
      type: 'play_card',
      card_id: cardId,
      to: { cell_index: bestCell.cell_index }
    }];
  } catch (e) {
    console.error('[IntentTranslator] defensive_play error:', e);
    return [];
  }
}

/**
 * aggressive_play: Find card, determine best offensive position
 */
function translateAggressivePlay(
  intent: Intent,
  snapshot: any,
  actions: any[]
): TurnPlanStep[] {
  try {
    const cardName = (intent.card || '').toLowerCase().trim();
    const hand = snapshot?.you?.hand || [];
    
    const card = hand.find((c: any) => {
      const label = (c.label || c.name || '').toLowerCase();
      return label === cardName || label.includes(cardName) || cardName.includes(label);
    });

    if (!card) {
      console.warn(`[IntentTranslator] Card not found: ${cardName}`);
      return [];
    }

    const cardId = card.card_id;
    const places = snapshot?.places_by_card?.[cardId] || [];
    
    if (places.length === 0) {
      console.warn(`[IntentTranslator] No placements for ${cardName}`);
      return [];
    }

    let bestCell: any = null;
    const zone = intent.zone || 'enemy_frontline';

    if (zone.includes('enemy') || zone === 'frontline') {
      // Prefer forward/ahead positions
      bestCell = places.find((p: any) => p.ahead === true && p.region === 'frontline');
      if (!bestCell) {
        bestCell = places.find((p: any) => p.ahead === true);
      }
      if (!bestCell) {
        bestCell = places[0];
      }
    } else {
      bestCell = places[0];
    }

    console.log(`[IntentTranslator] ✅ aggressive_play: ${card.label || card.name} @ ${bestCell.pos || bestCell.cell_index}`);
    return [{
      type: 'play_card',
      card_id: cardId,
      to: { cell_index: bestCell.cell_index }
    }];
  } catch (e) {
    console.error('[IntentTranslator] aggressive_play error:', e);
    return [];
  }
}

/**
 * reposition: Find unit, move in specified direction (no attack)
 */
function translateReposition(
  intent: Intent,
  snapshot: any,
  actions: any[]
): TurnPlanStep[] {
  try {
    const unitName = intent.unit || '';
    const selfUnits = snapshot?.self_units || [];
    const unit = selfUnits.find((u: any) =>
      (u.label || u.name || '').toLowerCase().includes(unitName.toLowerCase())
    );

    if (!unit) return [];

    // For now, just return empty (Unity will need more logic here)
    // Could be enhanced with direction-based cell selection
    console.warn(`[IntentTranslator] reposition not fully implemented yet`);
    return [];
  } catch (e) {
    console.error('[IntentTranslator] reposition error:', e);
    return [];
  }
}

/**
 * Smart target selection based on intent type
 */
function selectTargetByIntent(
  attacker: any,
  enemies: any[],
  intentType: string
): any | null {
  if (!enemies || enemies.length === 0) return null;

  const scoreTarget = (enemy: any): number => {
    let score = 0;
    const name = (enemy.name || '').toLowerCase();
    const hp = enemy.hp || 99;
    const atk = attacker.atk || 0;

    // Base priority
    if (name.includes('cinda')) score += 80;
    if (name.includes('ash')) score += 70;
    if (name.includes('hero')) score += 90;
    if (name.includes('archer') || name.includes('crossbow')) score += 40;

    // Intent-specific scoring
    if (intentType === 'kill') {
      if (atk >= hp) score += 150; // Lethal
      score -= hp * 5; // Prefer low HP
    } else if (intentType === 'pressure') {
      score += atk * 2; // Prefer high-value targets
    } else if (intentType === 'trade') {
      const hpDiff = Math.abs(hp - (attacker.hp || 0));
      score -= hpDiff * 3; // Prefer similar HP
    }

    return score;
  };

  return enemies.reduce((best, current) => {
    const currentScore = scoreTarget(current);
    const bestScore = best ? scoreTarget(best) : -Infinity;
    return currentScore > bestScore ? current : best;
  }, null);
}

/**
 * Main translation function: convert entire intent plan to turn_plan
 */
export function translateIntentPlan(
  intentPlan: { analysis?: string; steps: Intent[] },
  snapshot: any,
  actions: any[]
): { atomic: boolean; auto_end: boolean; steps: TurnPlanStep[] } {
  const steps: TurnPlanStep[] = [];

  for (const intent of intentPlan.steps || []) {
    const translated = translateIntent(intent, snapshot, actions);
    steps.push(...translated);
  }

  return {
    atomic: false,
    auto_end: false,
    steps
  };
}

