import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import pool from '../db/connection';
import { POOL_TO_MAX_DEX, PokemonPool } from '../types';

interface SearchRow extends RowDataPacket {
  id: number;
  nameDE: string | null;
  nameEN: string | null;
}

export async function searchPokemon(req: Request, res: Response): Promise<void> {
  const q = String(req.query['q'] ?? '').trim();

  if (q.length < 1) {
    res.json({ results: [] });
    return;
  }

  // Optional pool or maxNationalDex filter
  let maxDex: number | null = null;
  const poolParam = req.query['pool'] as string | undefined;
  const maxDexParam = req.query['maxNationalDex'] as string | undefined;

  if (poolParam && poolParam in POOL_TO_MAX_DEX) {
    maxDex = POOL_TO_MAX_DEX[poolParam as PokemonPool];
  } else if (maxDexParam) {
    const parsed = parseInt(maxDexParam, 10);
    if (!isNaN(parsed) && parsed > 0) maxDex = parsed;
  }

  const params: (string | number)[] = [`${q}%`];
  const dexFilter = maxDex !== null ? 'AND p.id <= ?' : '';
  if (maxDex !== null) params.push(maxDex);

  const [rows] = await pool.query<SearchRow[]>(
    `SELECT p.id,
       MAX(CASE WHEN pn.language = 'de' THEN pn.name END) AS nameDE,
       MAX(CASE WHEN pn.language = 'en' THEN pn.name END) AS nameEN
     FROM pokemon p
     JOIN pokemon_names pn ON pn.pokemon_id = p.id
     WHERE pn.name LIKE ? ${dexFilter}
     GROUP BY p.id
     ORDER BY p.id
     LIMIT 10`,
    params,
  );

  res.json({
    results: rows.map(r => ({
      id: r.id,
      nameDE: r.nameDE,
      nameEN: r.nameEN,
    })),
  });
}
