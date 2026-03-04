import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import pool from '../db/connection';
import { MatchupResponse } from '../types';

// Types introduced in a given generation; they don't appear as attackers before that.
const TYPE_INTRODUCED_GEN: Record<string, number> = {
  steel: 2,
  dark:  2,
  fairy: 6,
};

interface TypeRow extends RowDataPacket { id: number; name: string; }
interface EffRow   extends RowDataPacket {
  attacking_type_id: number;
  defending_type_id: number;
  multiplier:        string;
}
interface NameRow  extends RowDataPacket { name: string; }
interface PokemonRow extends RowDataPacket { id: number; identifier: string; }

export async function getMatchup(req: Request, res: Response): Promise<void> {
  const { name }  = req.params;
  const genParam  = req.query['gen'];

  // ── Validate generation ──────────────────────────────────────────────────
  const gen = parseInt(String(genParam ?? ''));
  if (isNaN(gen) || gen < 1 || gen > 9) {
    res.status(400).json({ error: 'Query param "gen" must be an integer between 1 and 9.' });
    return;
  }

  // ── Resolve Pokémon by name (EN or DE, case-insensitive) ─────────────────
  const [pokemonRows] = await pool.query<PokemonRow[]>(
    `SELECT p.id, p.identifier
     FROM pokemon p
     JOIN pokemon_names pn ON pn.pokemon_id = p.id
     WHERE LOWER(pn.name) = LOWER(?)
     LIMIT 1`,
    [name],
  );

  if (pokemonRows.length === 0) {
    res.status(404).json({ error: `Pokémon "${name}" not found.` });
    return;
  }

  const pokemon = pokemonRows[0];

  // ── Get Pokémon's types for the requested generation ─────────────────────
  const [typeRows] = await pool.query<TypeRow[]>(
    `SELECT t.name AS name
     FROM pokemon_types pt
     JOIN types t ON t.id = pt.type_id
     WHERE pt.pokemon_id = ?
       AND pt.generation_id = ?
     ORDER BY pt.slot`,
    [pokemon.id, gen],
  );

  if (typeRows.length === 0) {
    interface MinGenRow extends RowDataPacket { id: number | null; }
    const [minGenRows] = await pool.query<MinGenRow[]>(
      `SELECT MIN(generation_id) AS id FROM pokemon_types WHERE pokemon_id = ?`,
      [pokemon.id],
    );
    const introducedGen = minGenRows[0]?.id ?? null;
    const msg = introducedGen
      ? `"${name}" was not introduced until Generation ${introducedGen}.`
      : `No type data for "${name}" in Generation ${gen}.`;
    res.status(422).json({ error: msg });
    return;
  }

  const pokeTypes: string[] = typeRows.map(r => r.name);

  // ── Fetch the English name for display ───────────────────────────────────
  const [nameRows] = await pool.query<NameRow[]>(
    `SELECT name FROM pokemon_names WHERE pokemon_id = ? AND language = 'en' LIMIT 1`,
    [pokemon.id],
  );
  const displayName = nameRows[0]?.name ?? pokemon.identifier;

  // ── Get all types active in this generation ───────────────────────────────
  const [allTypeRows] = await pool.query<TypeRow[]>(
    'SELECT id, name FROM types ORDER BY id',
  );
  const activeTypes = allTypeRows.filter(t => (TYPE_INTRODUCED_GEN[t.name] ?? 1) <= gen);

  const activeTypeIds   = activeTypes.map(t => t.id);
  const activeTypeNames = activeTypes.map(t => t.name);

  // ── Resolve defending type IDs ────────────────────────────────────────────
  const [defTypeRows] = await pool.query<TypeRow[]>(
    `SELECT id, name FROM types WHERE name IN (${pokeTypes.map(() => '?').join(',')})`,
    pokeTypes,
  );
  const defTypeIds       = defTypeRows.map(r => r.id);
  const defTypeIdByName  = new Map(defTypeRows.map(r => [r.name, r.id]));

  // ── Fetch all relevant effectiveness rows ────────────────────────────────
  const [effRows] = await pool.query<EffRow[]>(
    `SELECT attacking_type_id, defending_type_id, multiplier
     FROM type_effectiveness
     WHERE generation_id = ?
       AND attacking_type_id IN (${activeTypeIds.map(() => '?').join(',')})
       AND defending_type_id IN (${defTypeIds.map(() => '?').join(',')})`,
    [gen, ...activeTypeIds, ...defTypeIds],
  );

  // Build lookup: atkTypeId -> defTypeId -> multiplier
  const effLookup = new Map<number, Map<number, number>>();
  for (const row of effRows) {
    if (!effLookup.has(row.attacking_type_id)) {
      effLookup.set(row.attacking_type_id, new Map());
    }
    effLookup.get(row.attacking_type_id)!.set(
      row.defending_type_id,
      parseFloat(row.multiplier),
    );
  }

  // ── Calculate final multiplier for each attacking type ───────────────────
  const result: MatchupResponse = {
    pokemon:    displayName,
    pokemonId:  pokemon.id,
    generation: gen,
    types:      pokeTypes,
    matchup: { '0': [], '0.25': [], '0.5': [], '1': [], '2': [], '4': [] },
  };

  for (let i = 0; i < activeTypes.length; i++) {
    const atkId   = activeTypeIds[i];
    const atkName = activeTypeNames[i];

    let combined = 1;
    for (const defTypeName of pokeTypes) {
      const defId = defTypeIdByName.get(defTypeName)!;
      const mult  = effLookup.get(atkId)?.get(defId) ?? 1;
      if (mult === 0) { combined = 0; break; }   // immunity short-circuit
      combined *= mult;
    }

    // Round away floating point noise
    const rounded = Math.round(combined * 10000) / 10000;

    const key = String(rounded) as keyof MatchupResponse['matchup'];
    if (key in result.matchup) {
      result.matchup[key].push(atkName);
    } else {
      result.matchup['1'].push(atkName);
    }
  }

  res.json(result);
}
