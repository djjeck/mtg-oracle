import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  getDatabase, insertCard, insertCardFace, insertLegality,
  type CardRow,
} from '../../src/data/db.js';
import { handler, GetCardsInput } from '../../src/tools/get-cards.js';
import { formatGetCards } from '../../src/format.js';

// --- Test fixtures ---

function makeCard(overrides: Partial<CardRow> & Pick<CardRow, 'id' | 'name'>): CardRow {
  return {
    mana_cost: null, cmc: null, type_line: null, oracle_text: null,
    power: null, toughness: null, loyalty: null, colors: null,
    color_identity: null, keywords: null, rarity: null,
    set_code: null, set_name: null, released_at: null,
    image_uri: null, scryfall_uri: null, edhrec_rank: null, artist: null,
    price_usd: null, price_usd_foil: null, price_eur: null, price_eur_foil: null, price_tix: null,
    ...overrides,
  };
}

function seedTestData(db: Database.Database): void {
  insertCard(db, makeCard({
    id: 'bolt-001', name: 'Lightning Bolt', mana_cost: '{R}', type_line: 'Instant',
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
  }));
  insertCard(db, makeCard({
    id: 'goyf-001', name: 'Tarmogoyf', mana_cost: '{1}{G}', type_line: 'Creature — Lhurgoyf',
    oracle_text: "Tarmogoyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.",
    power: '*', toughness: '1+*',
  }));
  insertCard(db, makeCard({
    id: 'jace-001', name: 'Jace, the Mind Sculptor', mana_cost: '{2}{U}{U}',
    type_line: 'Legendary Planeswalker — Jace', oracle_text: '+2: Look at the top card of target player\'s library.',
    loyalty: '3',
  }));
  insertCard(db, makeCard({
    id: 'giant-001', name: 'Bonecrusher Giant // Stomp', mana_cost: '{2}{R} // {1}{R}',
    type_line: 'Creature — Giant // Instant — Adventure',
  }));
  insertCardFace(db, {
    card_id: 'giant-001', face_index: 0, name: 'Bonecrusher Giant', mana_cost: '{2}{R}',
    type_line: 'Creature — Giant', power: '4', toughness: '3', colors: '["R"]',
    oracle_text: 'Whenever Bonecrusher Giant becomes the target of a spell, Bonecrusher Giant deals 2 damage to that spell\'s controller.',
  });
  insertCardFace(db, {
    card_id: 'giant-001', face_index: 1, name: 'Stomp', mana_cost: '{1}{R}',
    type_line: 'Instant — Adventure', power: null, toughness: null, colors: '["R"]',
    oracle_text: 'Damage can\'t be prevented this turn. Stomp deals 2 damage to any target.',
  });

  insertLegality(db, { card_id: 'bolt-001', format: 'modern', status: 'legal' });
  insertLegality(db, { card_id: 'bolt-001', format: 'commander', status: 'legal' });
  insertLegality(db, { card_id: 'jace-001', format: 'modern', status: 'legal' });
  insertLegality(db, { card_id: 'giant-001', format: 'modern', status: 'legal' });
}

// --- Tests ---

describe('get_cards tool', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = getDatabase(':memory:');
    seedTestData(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('input schema', () => {
    it('accepts up to 100 names', () => {
      expect(GetCardsInput.safeParse({ names: Array(100).fill('Lightning Bolt') }).success).toBe(true);
    });

    it('rejects more than 100 names', () => {
      expect(GetCardsInput.safeParse({ names: Array(101).fill('Lightning Bolt') }).success).toBe(false);
    });

    it('rejects an empty list', () => {
      expect(GetCardsInput.safeParse({ names: [] }).success).toBe(false);
    });
  });

  describe('handler', () => {
    it('returns cards in the order requested, with their oracle text', () => {
      const result = handler(db, { names: ['Tarmogoyf', 'Lightning Bolt'] });
      expect(result.cards.map(c => c.name)).toEqual(['Tarmogoyf', 'Lightning Bolt']);
      expect(result.cards[1].oracle_text).toBe('Lightning Bolt deals 3 damage to any target.');
      expect(result.not_found).toEqual([]);
    });

    it('matches names case-insensitively', () => {
      const result = handler(db, { names: ['lightning bolt'] });
      expect(result.cards[0].name).toBe('Lightning Bolt');
    });

    it('matches a card by the name of one of its faces, and returns the faces', () => {
      const result = handler(db, { names: ['Bonecrusher Giant'] });
      expect(result.cards[0].name).toBe('Bonecrusher Giant // Stomp');
      expect(result.cards[0].faces.map(f => f.name)).toEqual(['Bonecrusher Giant', 'Stomp']);
      expect(result.cards[0].faces[1].oracle_text).toContain('Stomp deals 2 damage');
    });

    it('falls back to a partial name match', () => {
      const result = handler(db, { names: ['Mind Sculptor'] });
      expect(result.cards[0].name).toBe('Jace, the Mind Sculptor');
    });

    it('returns each card once, however often it is requested', () => {
      const result = handler(db, { names: ['Lightning Bolt', 'Tarmogoyf', 'lightning bolt'] });
      expect(result.cards.map(c => c.name)).toEqual(['Lightning Bolt', 'Tarmogoyf']);
    });

    it('lists names it cannot find, with suggestions', () => {
      const result = handler(db, { names: ['Lightning Bolt', 'Lightning Helix', 'Nonexistent Card'] });
      expect(result.cards.map(c => c.name)).toEqual(['Lightning Bolt']);
      expect(result.not_found).toEqual([
        { name: 'Lightning Helix', suggestions: ['Lightning Bolt'] },
        { name: 'Nonexistent Card', suggestions: [] },
      ]);
    });

    it('includes legality in the requested format', () => {
      const result = handler(db, { names: ['Lightning Bolt', 'Tarmogoyf'], format: 'modern' });
      expect(result.format).toBe('modern');
      expect(result.cards[0].legality).toBe('legal');
      expect(result.cards[1].legality).toBeNull();
    });

    it('resolves format aliases', () => {
      const result = handler(db, { names: ['Lightning Bolt'], format: 'EDH' });
      expect(result.format).toBe('commander');
      expect(result.cards[0].legality).toBe('legal');
    });

    it('omits legality when no format is given', () => {
      const result = handler(db, { names: ['Lightning Bolt'] });
      expect(result.format).toBeNull();
      expect(result.cards[0].legality).toBeNull();
    });
  });

  describe('formatGetCards', () => {
    it('prints each card compactly: name and cost, type and stats, text', () => {
      const text = formatGetCards(handler(db, { names: ['Lightning Bolt', 'Tarmogoyf', 'Jace, the Mind Sculptor'] }));
      expect(text).toContain('## Lightning Bolt {R}\nInstant\nLightning Bolt deals 3 damage to any target.');
      expect(text).toContain('## Tarmogoyf {1}{G}\nCreature — Lhurgoyf — */1+*\n');
      expect(text).toContain('## Jace, the Mind Sculptor {2}{U}{U}\nLegendary Planeswalker — Jace — Loyalty 3\n');
    });

    it('prints the faces of multi-face cards', () => {
      const text = formatGetCards(handler(db, { names: ['Bonecrusher Giant'] }));
      // The faces carry the type lines, so the combined one is not repeated.
      expect(text).toContain('## Bonecrusher Giant // Stomp {2}{R} // {1}{R}\n### Bonecrusher Giant {2}{R}\nCreature — Giant — 4/3\nWhenever');
      expect(text).toContain('### Stomp {1}{R}\nInstant — Adventure\nDamage can\'t be prevented');
    });

    it('marks legality in the header when a format is given', () => {
      const text = formatGetCards(handler(db, { names: ['Lightning Bolt', 'Tarmogoyf'], format: 'modern' }));
      expect(text).toContain('# 2 cards (Modern legality)');
      expect(text).toContain('## Lightning Bolt {R} · Modern: Legal\n');
      expect(text).toContain('## Tarmogoyf {1}{G} · Modern: Unknown\n');
    });

    it('lists names that were not found', () => {
      const text = formatGetCards(handler(db, { names: ['Lightning Helix', 'Nonexistent Card'] }));
      expect(text).toContain('# 0 cards');
      expect(text).toContain('Not found:\n- "Lightning Helix" (did you mean: Lightning Bolt?)\n- "Nonexistent Card"');
    });
  });
});
