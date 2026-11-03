import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { CardRow, CardFaceRow, LegalityRow } from '../data/db.js';
import { resolveFormat } from './check-legality.js';

// --- Input schema ---

export const GetCardsInput = z.object({
  names: z.array(z.string().min(1)).min(1).max(100).describe('Card names to look up (max 100), e.g. every card in a decklist'),
  format: z.string().optional().describe('Format to report legality in (e.g., "modern", "commander"). Omit to skip legality.'),
});

export type GetCardsParams = z.infer<typeof GetCardsInput>;

// --- Output types ---

export interface CompactCardFace {
  name: string;
  mana_cost: string | null;
  type_line: string | null;
  oracle_text: string | null;
  power: string | null;
  toughness: string | null;
}

export interface CompactCard {
  name: string;
  mana_cost: string | null;
  type_line: string | null;
  oracle_text: string | null;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  faces: CompactCardFace[];
  /** Status in the requested format; null when no format was given or the format is unknown for this card. */
  legality: string | null;
}

export interface CardNotFound {
  name: string;
  suggestions: string[];
}

export interface GetCardsResult {
  format: string | null;
  cards: CompactCard[];
  not_found: CardNotFound[];
}

// --- Handler ---

// Art Series cards ("Sol Ring // Sol Ring", type "Card // Card") have faces named
// after real cards; rank them last so a name resolves to the playable card.
const ART_SERIES_LAST = "c.type_line = 'Card // Card'";

// Exact lookups compare with COLLATE NOCASE, which uses the name indexes.
function findCard(db: Database.Database, name: string): CardRow | undefined {
  return (db.prepare(
    'SELECT * FROM cards WHERE name = ? COLLATE NOCASE'
  ).get(name) as CardRow | undefined)
    // A face name, e.g. "Bonecrusher Giant" for "Bonecrusher Giant // Stomp"
    ?? (db.prepare(
      `SELECT c.* FROM cards c JOIN card_faces f ON f.card_id = c.id
       WHERE f.name = ? COLLATE NOCASE ORDER BY ${ART_SERIES_LAST} LIMIT 1`
    ).get(name) as CardRow | undefined)
    ?? (db.prepare(
      `SELECT * FROM cards c WHERE LOWER(c.name) LIKE LOWER(?)
       ORDER BY ${ART_SERIES_LAST}, LENGTH(c.name) LIMIT 1`
    ).get(`%${name}%`) as CardRow | undefined);
}

export function handler(db: Database.Database, params: GetCardsParams): GetCardsResult {
  const format = params.format ? resolveFormat(params.format) : null;
  const getFaces = db.prepare('SELECT * FROM card_faces WHERE card_id = ? ORDER BY face_index');
  const getLegality = db.prepare('SELECT * FROM legalities WHERE card_id = ? AND format = ?');
  const getSuggestions = db.prepare('SELECT name FROM cards WHERE LOWER(name) LIKE LOWER(?) LIMIT 5');

  const seen = new Set<string>();
  const cards: CompactCard[] = [];
  const not_found: CardNotFound[] = [];

  for (const name of params.names) {
    const card = findCard(db, name);
    if (!card) {
      const suggestions = getSuggestions.all(`%${name.split(' ')[0]}%`) as Array<{ name: string }>;
      not_found.push({ name, suggestions: suggestions.map(s => s.name) });
      continue;
    }
    if (seen.has(card.id)) continue;
    seen.add(card.id);

    const faces = getFaces.all(card.id) as CardFaceRow[];
    const legality = format
      ? (getLegality.get(card.id, format) as LegalityRow | undefined)?.status ?? null
      : null;

    cards.push({
      name: card.name,
      mana_cost: card.mana_cost,
      type_line: card.type_line,
      oracle_text: card.oracle_text,
      power: card.power,
      toughness: card.toughness,
      loyalty: card.loyalty,
      faces: faces.map(f => ({
        name: f.name,
        mana_cost: f.mana_cost,
        type_line: f.type_line,
        oracle_text: f.oracle_text,
        power: f.power,
        toughness: f.toughness,
      })),
      legality,
    });
  }

  return { format, cards, not_found };
}
