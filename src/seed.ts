/**
 * Seed script – fetches all required data from PokéAPI and populates MariaDB.
 * Run once: npm run seed
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------------------
// PokéAPI types (minimal shape – only fields we use)
// ---------------------------------------------------------------------------

interface NamedResource { name: string; url: string; }

interface DamageRelations {
  no_damage_to:       NamedResource[];
  half_damage_to:     NamedResource[];
  double_damage_to:   NamedResource[];
  no_damage_from:     NamedResource[];
  half_damage_from:   NamedResource[];
  double_damage_from: NamedResource[];
}

interface PastDamageRelation {
  generation: NamedResource;
  damage_relations: DamageRelations;
}

interface TypeData {
  id:   number;
  name: string;
  damage_relations:      DamageRelations;
  past_damage_relations: PastDamageRelation[];
}

interface PokemonType { slot: number; type: NamedResource; }

interface PastType {
  generation: NamedResource;
  types: PokemonType[];
}

interface PokemonData {
  id:         number;
  name:       string;
  types:      PokemonType[];
  past_types: PastType[];
  species:    NamedResource;
}

interface SpeciesName { language: NamedResource; name: string; }

interface SpeciesData {
  generation: NamedResource;
  names: SpeciesName[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = 'https://pokeapi.co/api/v2';
const TOTAL_GENERATIONS = 9;

/** Generation name -> id mapping (PokéAPI uses roman numeral names) */
const GEN_NAME_TO_ID: Record<string, number> = {
  'generation-i':    1,
  'generation-ii':   2,
  'generation-iii':  3,
  'generation-iv':   4,
  'generation-v':    5,
  'generation-vi':   6,
  'generation-vii':  7,
  'generation-viii': 8,
  'generation-ix':   9,
};

async function get<T>(url: string): Promise<T> {
  const res = await axios.get<T>(url, { timeout: 15000 });
  return res.data;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Fetch with simple retry on transient failures */
async function fetchWithRetry<T>(url: string, retries = 3): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await get<T>(url);
    } catch (err: unknown) {
      if (attempt === retries) throw err;
      const wait = attempt * 1000;
      console.warn(`  Retry ${attempt}/${retries - 1} for ${url} – waiting ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} retries`);
}

// ---------------------------------------------------------------------------
// Build the full type effectiveness table for every generation
// ---------------------------------------------------------------------------

/**
 * Given all type data from the API, produce a nested map:
 *   genId -> attackingTypeName -> defendingTypeName -> multiplier
 *
 * Strategy:
 * 1. Start with the *current* damage_relations as the "latest" state.
 * 2. Walk past_damage_relations (which describe how it was in older gens)
 *    and fill in earlier generations.
 * 3. For generations where no change is recorded, carry the previous value forward.
 */
function buildEffectivenessTable(
  types: TypeData[],
): Map<number, Map<string, Map<string, number>>> {

  // genId -> atkType -> defType -> multiplier
  const table = new Map<number, Map<string, Map<string, number>>>();
  for (let g = 1; g <= TOTAL_GENERATIONS; g++) {
    table.set(g, new Map());
  }

  // Helper: apply a DamageRelations block as the "from gen X onwards" state
  // for the given attacking type against all defending types it lists.
  // Returns a map defType -> multiplier (only the non-1× entries).
  function relationsToMap(dr: DamageRelations): Map<string, number> {
    const m = new Map<string, number>();
    for (const t of dr.no_damage_to)     m.set(t.name, 0);
    for (const t of dr.half_damage_to)   m.set(t.name, 0.5);
    for (const t of dr.double_damage_to) m.set(t.name, 2);
    // _from entries describe what can hit THIS type – we ignore them here
    // because we build from the attacker's perspective
    return m;
  }

  for (const typeData of types) {
    const atkName = typeData.name;

    // Sort past relations from oldest generation to newest so we can
    // walk forward and fill gaps correctly.
    const pastRels = [...typeData.past_damage_relations].sort((a, b) => {
      return (GEN_NAME_TO_ID[a.generation.name] ?? 99)
           - (GEN_NAME_TO_ID[b.generation.name] ?? 99);
    });

    // Build a timeline:
    // pastRels describe the state UNTIL (and including) that generation.
    // The current damage_relations are the state from the generation after
    // the last past entry onwards.

    // Collect break-points: [upToGen, effectivenessMap]
    const breakpoints: Array<{ upTo: number; map: Map<string, number> }> = [];

    for (const pr of pastRels) {
      const genId = GEN_NAME_TO_ID[pr.generation.name];
      if (genId === undefined) continue;
      breakpoints.push({ upTo: genId, map: relationsToMap(pr.damage_relations) });
    }

    // Current state applies from (lastBreakpoint + 1) to TOTAL_GENERATIONS
    const currentMap = relationsToMap(typeData.damage_relations);

    // For each generation, determine which map applies
    for (let g = 1; g <= TOTAL_GENERATIONS; g++) {
      // Find the applicable breakpoint: the one with the lowest upTo >= g
      // (i.e. the oldest "past" state that still covers gen g)
      const applicable = breakpoints
        .filter(bp => bp.upTo >= g)
        .sort((a, b) => a.upTo - b.upTo)[0];

      const effMap = applicable ? applicable.map : currentMap;

      const genMap = table.get(g)!;
      if (!genMap.has(atkName)) genMap.set(atkName, new Map());
      const atkMap = genMap.get(atkName)!;

      for (const [defName, mult] of effMap) {
        atkMap.set(defName, mult);
      }
    }
  }

  return table;
}

// ---------------------------------------------------------------------------
// Determine a Pokémon's types for each generation
// ---------------------------------------------------------------------------

/**
 * Returns a map genId -> [type names] for the given Pokémon.
 * Only includes generations >= introducedGen (the generation the Pokémon debuted in).
 * Rules:
 * - Current types apply from the generation AFTER the last past_types entry.
 * - past_types entries describe types valid up to and including that generation.
 */
function pokemonTypesPerGen(pokemon: PokemonData, introducedGen: number): Map<number, string[]> {
  const result = new Map<number, string[]>();

  const currentTypes = pokemon.types.map(t => t.type.name);

  // Sort past_types from oldest generation to newest
  const pastTypes = [...pokemon.past_types].sort((a, b) => {
    return (GEN_NAME_TO_ID[a.generation.name] ?? 99)
         - (GEN_NAME_TO_ID[b.generation.name] ?? 99);
  });

  // Same logic as effectiveness: breakpoints describe state UNTIL gen X
  const breakpoints: Array<{ upTo: number; types: string[] }> = [];
  for (const pt of pastTypes) {
    const genId = GEN_NAME_TO_ID[pt.generation.name];
    if (genId === undefined) continue;
    breakpoints.push({ upTo: genId, types: pt.types.map(t => t.type.name) });
  }

  for (let g = introducedGen; g <= TOTAL_GENERATIONS; g++) {
    const applicable = breakpoints
      .filter(bp => bp.upTo >= g)
      .sort((a, b) => a.upTo - b.upTo)[0];

    result.set(g, applicable ? applicable.types : currentTypes);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main seeding logic
// ---------------------------------------------------------------------------

async function seed() {
  const db = await mysql.createConnection({
    host:     process.env.DB_HOST     ?? 'localhost',
    port:     parseInt(process.env.DB_PORT ?? '3306'),
    user:     process.env.DB_USER     ?? 'dev',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME     ?? 'poketype',
    charset:  'utf8mb4',
    multipleStatements: true,
  });

  console.log('Connected to database.');

  // ── Apply schema ──────────────────────────────────────────────────────────
  console.log('Applying schema...');
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await db.query(schemaSql);
  console.log('Schema applied.');

  // ── Seed generations ──────────────────────────────────────────────────────
  console.log('Seeding generations...');
  for (const [name, id] of Object.entries(GEN_NAME_TO_ID)) {
    await db.query(
      'INSERT IGNORE INTO generations (id, name) VALUES (?, ?)',
      [id, name],
    );
  }

  // ── Fetch all types ───────────────────────────────────────────────────────
  console.log('Fetching type list...');
  const typeList = await fetchWithRetry<{ results: NamedResource[] }>(`${BASE}/type?limit=100`);
  const typeNames = typeList.results.map(t => t.name);

  // Filter out the two pseudo-types ('unknown' and 'shadow') that have no
  // real battle mechanics
  const BATTLE_TYPES = typeNames.filter(n => n !== 'unknown' && n !== 'shadow');

  console.log(`Fetching ${BATTLE_TYPES.length} type details...`);
  const typeDataList: TypeData[] = [];
  for (const typeName of BATTLE_TYPES) {
    process.stdout.write(`  ${typeName}...`);
    const data = await fetchWithRetry<TypeData>(`${BASE}/type/${typeName}`);
    typeDataList.push(data);
    process.stdout.write(' ok\n');
    await sleep(100);
  }

  // ── Insert types ──────────────────────────────────────────────────────────
  console.log('Inserting types...');
  for (const td of typeDataList) {
    await db.query(
      'INSERT IGNORE INTO types (id, name) VALUES (?, ?)',
      [td.id, td.name],
    );
  }

  // ── Build and insert type_effectiveness ───────────────────────────────────
  console.log('Building type effectiveness table...');
  const effTable = buildEffectivenessTable(typeDataList);

  // Build a name -> id map for types
  const typeIdByName = new Map(typeDataList.map(td => [td.name, td.id]));

  // Types that exist in each generation (some didn't exist in early gens)
  // We use presence in the effectiveness table to determine this.
  // Additionally, Steel and Dark don't exist in Gen 1, Fairy from Gen 6.
  const TYPE_INTRODUCED_GEN: Record<string, number> = {
    steel: 2,
    dark:  2,
    fairy: 6,
  };

  console.log('Inserting type effectiveness rows...');
  let effRows = 0;
  for (let g = 1; g <= TOTAL_GENERATIONS; g++) {
    const genEffMap = effTable.get(g)!;

    // Determine which types exist in this generation
    const activeTypes = typeDataList
      .map(td => td.name)
      .filter(name => (TYPE_INTRODUCED_GEN[name] ?? 1) <= g);

    for (const atkName of activeTypes) {
      for (const defName of activeTypes) {
        const atkId = typeIdByName.get(atkName)!;
        const defId = typeIdByName.get(defName)!;

        // Look up multiplier; default is 1 (neutral)
        const mult = genEffMap.get(atkName)?.get(defName) ?? 1;

        if (mult !== 1) {
          // Only store non-neutral entries to save space; the API will default to 1
          await db.query(
            `INSERT INTO type_effectiveness
               (generation_id, attacking_type_id, defending_type_id, multiplier)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE multiplier = VALUES(multiplier)`,
            [g, atkId, defId, mult],
          );
          effRows++;
        }
      }
    }
  }
  console.log(`Inserted ${effRows} type effectiveness rows.`);

  // ── Fetch all Pokémon ─────────────────────────────────────────────────────
  console.log('Fetching Pokémon list...');
  // PokéAPI has 1025 Pokémon up to Gen 9; we fetch only the "main" entries
  // (no alternate forms that have their own pokedex entries as separate Pokémon)
  const pokeList = await fetchWithRetry<{ count: number; results: NamedResource[] }>(
    `${BASE}/pokemon?limit=10000`,
  );

  // Filter to only numbered (non-form) Pokémon: IDs 1–1025
  const mainPokemon = pokeList.results.filter(p => {
    const id = parseInt(p.url.split('/').filter(Boolean).pop()!);
    return id >= 1 && id <= 1025;
  });

  console.log(`Fetching data for ${mainPokemon.length} Pokémon...`);

  for (let i = 0; i < mainPokemon.length; i++) {
    const p = mainPokemon[i];
    const pokemonId = parseInt(p.url.split('/').filter(Boolean).pop()!);

    if ((i + 1) % 50 === 0 || i === 0) {
      console.log(`  [${i + 1}/${mainPokemon.length}] ${p.name}`);
    }

    let pokemonData: PokemonData;
    try {
      pokemonData = await fetchWithRetry<PokemonData>(`${BASE}/pokemon/${pokemonId}`);
    } catch {
      console.warn(`  Skipping ${p.name} – fetch failed`);
      continue;
    }

    // Insert Pokémon
    await db.query(
      'INSERT IGNORE INTO pokemon (id, identifier) VALUES (?, ?)',
      [pokemonData.id, pokemonData.name],
    );

    // Fetch species for multilingual names
    let speciesData: SpeciesData | null = null;
    try {
      speciesData = await fetchWithRetry<SpeciesData>(pokemonData.species.url);
    } catch {
      // Non-fatal – we'll just miss the names for this Pokémon
    }

    if (speciesData) {
      for (const nameEntry of speciesData.names) {
        const lang = nameEntry.language.name;
        if (lang === 'en' || lang === 'de') {
          await db.query(
            `INSERT INTO pokemon_names (pokemon_id, language, name)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name)`,
            [pokemonData.id, lang, nameEntry.name],
          );
        }
      }
    }

    // Determine introduction generation; default to 1 if species fetch failed
    const introducedGen = speciesData
      ? (GEN_NAME_TO_ID[speciesData.generation.name] ?? 1)
      : 1;

    // Insert types per generation (only from introducedGen onwards)
    const typesPerGen = pokemonTypesPerGen(pokemonData, introducedGen);
    for (const [genId, typeNames] of typesPerGen) {
      for (let slot = 0; slot < typeNames.length; slot++) {
        const typeId = typeIdByName.get(typeNames[slot]);
        if (typeId === undefined) continue;
        await db.query(
          `INSERT INTO pokemon_types (pokemon_id, generation_id, slot, type_id)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE type_id = VALUES(type_id)`,
          [pokemonData.id, genId, slot + 1, typeId],
        );
      }
    }

    // Small delay to be polite to the API
    await sleep(80);
  }

  await db.end();
  console.log('\nSeeding complete!');
}

export { seed };

if (require.main === module) {
  seed().catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
