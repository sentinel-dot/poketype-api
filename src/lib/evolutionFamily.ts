import axios from 'axios';
import { RowDataPacket } from 'mysql2';
import pool from '../db/connection';

interface FamilyRow extends RowDataPacket {
  pokemon_id: number;
  family_key: number;
}

const POKEAPI = 'https://pokeapi.co/api/v2';

// In-process memo on top of the DB cache to avoid repeat lookups within a request burst.
const memo = new Map<number, number>();

function speciesIdFromUrl(url: string): number {
  const parts = url.split('/').filter(Boolean);
  return parseInt(parts[parts.length - 1], 10);
}

/** Collect every species id in an evolution chain node (recursively). */
function collectChainIds(node: any, acc: number[]): void {
  if (!node) return;
  const id = speciesIdFromUrl(node.species?.url ?? '');
  if (!isNaN(id)) acc.push(id);
  for (const next of node.evolves_to ?? []) collectChainIds(next, acc);
}

/**
 * Resolves the evolution-family key (the lowest species id in the chain) for a
 * pokémon. Uses the `evolution_family` cache table; on a miss it fetches the
 * chain from PokeAPI, caches every member, and returns the key. Falls back to
 * the pokémon's own id if the network lookup fails.
 */
export async function resolveFamilyKey(pokemonId: number): Promise<number> {
  if (memo.has(pokemonId)) return memo.get(pokemonId)!;

  const [cached] = await pool.query<FamilyRow[]>(
    'SELECT family_key FROM evolution_family WHERE pokemon_id = ? LIMIT 1',
    [pokemonId],
  );
  if (cached.length > 0) {
    memo.set(pokemonId, cached[0].family_key);
    return cached[0].family_key;
  }

  try {
    const species = await axios.get(`${POKEAPI}/pokemon-species/${pokemonId}`, { timeout: 8000 });
    const chainUrl: string = species.data?.evolution_chain?.url;
    if (!chainUrl) throw new Error('no chain url');

    const chain = await axios.get(chainUrl, { timeout: 8000 });
    const ids: number[] = [];
    collectChainIds(chain.data?.chain, ids);
    if (ids.length === 0) ids.push(pokemonId);

    const familyKey = Math.min(...ids);

    // Cache every chain member (ignore duplicates / out-of-range ids).
    const values = ids.filter(id => id > 0).map(id => [id, familyKey]);
    if (values.length > 0) {
      await pool.query(
        'INSERT IGNORE INTO evolution_family (pokemon_id, family_key) VALUES ?',
        [values],
      );
    }
    for (const id of ids) memo.set(id, familyKey);
    return familyKey;
  } catch {
    // Network/cache failure: treat the pokémon as its own family so the app
    // still works (dupes across evolutions just won't be linked this time).
    memo.set(pokemonId, pokemonId);
    return pokemonId;
  }
}
