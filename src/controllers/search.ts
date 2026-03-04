import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import pool from '../db/connection';

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

  const [rows] = await pool.query<SearchRow[]>(
    `SELECT p.id,
       MAX(CASE WHEN pn.language = 'de' THEN pn.name END) AS nameDE,
       MAX(CASE WHEN pn.language = 'en' THEN pn.name END) AS nameEN
     FROM pokemon p
     JOIN pokemon_names pn ON pn.pokemon_id = p.id
     WHERE pn.name LIKE ?
     GROUP BY p.id
     ORDER BY p.id
     LIMIT 10`,
    [`${q}%`],
  );

  res.json({
    results: rows.map(r => ({
      id: r.id,
      nameDE: r.nameDE,
      nameEN: r.nameEN,
    })),
  });
}
