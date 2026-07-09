import { Request, Response } from 'express';
import { Server } from 'socket.io';
import { RowDataPacket } from 'mysql2';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection';
import { resolveFamilyKey } from '../../lib/evolutionFamily';

export type EncounterOutcome = 'caught' | 'dead' | 'fled';

export interface UsedSpecies {
  familyKey: number;
  pokemonId: number;
  pokemonName: string | null;
  outcome: EncounterOutcome;
  routeLabel: string | null;
}

interface EncounterRow extends RowDataPacket {
  id: string;
  seat_id: string | null;
  family_key: number;
  pokemon_id: number;
  pokemon_name: string | null;
  outcome: EncounterOutcome;
  route_label: string | null;
}

async function pokemonName(pokemonId: number): Promise<string | null> {
  const [rows] = await pool.query<(RowDataPacket & { name: string | null })[]>(
    `SELECT COALESCE(pn_de.name, pn_en.name) AS name
       FROM pokemon p
       LEFT JOIN pokemon_names pn_de ON pn_de.pokemon_id = p.id AND pn_de.language = 'de'
       LEFT JOIN pokemon_names pn_en ON pn_en.pokemon_id = p.id AND pn_en.language = 'en'
      WHERE p.id = ?`,
    [pokemonId],
  );
  return rows[0]?.name ?? null;
}

/**
 * Upserts an encounter for the dupes registry. Death is permanent: a 'dead'
 * outcome is never downgraded back to 'caught'.
 */
export async function recordEncounter(
  roomId: string,
  seatId: string,
  pokemonId: number,
  outcome: EncounterOutcome,
  routeLabel: string | null,
  name?: string | null,
): Promise<UsedSpecies> {
  const familyKey = await resolveFamilyKey(pokemonId);
  const resolvedName = name ?? (await pokemonName(pokemonId));

  const keepDead = outcome === 'caught' ? "IF(outcome = 'dead', 'dead', VALUES(outcome))" : 'VALUES(outcome)';

  await pool.query(
    `INSERT INTO soullink_encounters (id, room_id, seat_id, family_key, pokemon_id, pokemon_name, outcome, route_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       pokemon_id   = VALUES(pokemon_id),
       pokemon_name = VALUES(pokemon_name),
       outcome      = ${keepDead},
       route_label  = COALESCE(VALUES(route_label), route_label),
       updated_at   = NOW()`,
    [uuidv4(), roomId, seatId, familyKey, pokemonId, resolvedName, outcome, routeLabel],
  );

  return { familyKey, pokemonId, pokemonName: resolvedName, outcome, routeLabel };
}

/** All used species grouped by seat — folded into room state for instant client checks. */
export async function fetchUsedSpeciesBySeat(roomId: string): Promise<Map<string, UsedSpecies[]>> {
  const [rows] = await pool.query<EncounterRow[]>(
    `SELECT id, seat_id, family_key, pokemon_id, pokemon_name, outcome, route_label
       FROM soullink_encounters
      WHERE room_id = ?`,
    [roomId],
  );
  const map = new Map<string, UsedSpecies[]>();
  for (const r of rows) {
    if (!r.seat_id) continue;
    if (!map.has(r.seat_id)) map.set(r.seat_id, []);
    map.get(r.seat_id)!.push({
      familyKey: r.family_key,
      pokemonId: r.pokemon_id,
      pokemonName: r.pokemon_name,
      outcome: r.outcome,
      routeLabel: r.route_label,
    });
  }
  return map;
}

async function seatRoomId(roomCode: string, seatId: string, participantToken: string): Promise<string | null> {
  const [rows] = await pool.query<(RowDataPacket & { room_id: string })[]>(
    `SELECT s.room_id FROM soullink_seats s
       JOIN soullink_rooms r ON r.id = s.room_id
      WHERE r.code = ? AND s.id = ? AND s.participant_token = ?`,
    [roomCode, seatId, participantToken],
  );
  return rows.length > 0 ? rows[0].room_id : null;
}

// ─── HTTP handlers ───────────────────────────────────────────────────────────

/** POST /rooms/:roomCode/encounters — log a fled/lost (or manual) encounter. */
export async function addEncounter(req: Request, res: Response, io: Server): Promise<void> {
  const { roomCode } = req.params as { roomCode: string };
  const { seatId, pokemonId, outcome, routeLabel, participantToken } = req.body as {
    seatId?: unknown;
    pokemonId?: unknown;
    outcome?: unknown;
    routeLabel?: unknown;
    participantToken?: unknown;
  };

  if (typeof seatId !== 'string' || typeof participantToken !== 'string') {
    res.status(401).json({ error: 'seatId und participantToken erforderlich.' });
    return;
  }
  const pid = Number(pokemonId);
  if (isNaN(pid) || pid < 1) {
    res.status(400).json({ error: 'pokemonId ungültig.' });
    return;
  }
  const out: EncounterOutcome = outcome === 'dead' || outcome === 'caught' ? outcome : 'fled';
  const route = typeof routeLabel === 'string' && routeLabel.trim() ? routeLabel.trim().slice(0, 100) : null;

  const roomId = await seatRoomId(roomCode, seatId, participantToken);
  if (!roomId) {
    res.status(403).json({ error: 'Ungültiger Token oder Sitzplatz.' });
    return;
  }

  const used = await recordEncounter(roomId, seatId, pid, out, route);
  io.to(roomCode).emit('encounter:added', { seatId, used });
  res.status(201).json({ seatId, used });
}

/** DELETE /rooms/:roomCode/encounters/:familyKey — undo a mislogged encounter. */
export async function removeEncounter(req: Request, res: Response, io: Server): Promise<void> {
  const { roomCode, familyKey } = req.params as { roomCode: string; familyKey: string };
  const seatId = String((req.body as { seatId?: unknown }).seatId ?? req.query.seatId ?? '');
  const participantToken = String(
    (req.body as { participantToken?: unknown }).participantToken ?? req.query.participantToken ?? '',
  );
  const fk = Number(familyKey);

  if (!seatId || !participantToken || isNaN(fk)) {
    res.status(400).json({ error: 'seatId, participantToken und familyKey erforderlich.' });
    return;
  }

  const roomId = await seatRoomId(roomCode, seatId, participantToken);
  if (!roomId) {
    res.status(403).json({ error: 'Ungültiger Token oder Sitzplatz.' });
    return;
  }

  await pool.query(
    'DELETE FROM soullink_encounters WHERE room_id = ? AND seat_id = ? AND family_key = ?',
    [roomId, seatId, fk],
  );
  io.to(roomCode).emit('encounter:removed', { seatId, familyKey: fk });
  res.json({ ok: true });
}

/** GET /pokemon/:id/family — resolve a candidate's family key for client-side checks. */
export async function getFamilyKey(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (isNaN(id) || id < 1) {
    res.status(400).json({ error: 'Ungültige Pokémon-ID.' });
    return;
  }
  const familyKey = await resolveFamilyKey(id);
  res.json({ pokemonId: id, familyKey });
}
