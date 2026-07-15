import { Request, Response } from 'express';
import { Server } from 'socket.io';
import { RowDataPacket } from 'mysql2';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection';
import { resolveFamilyKey } from '../../lib/evolutionFamily';
import { fetchRuleset } from './slotService';

export type EncounterOutcome = 'caught' | 'dead' | 'fled';

/** A route (row) of the central encounter matrix. */
export interface RouteEntry {
  id: string;
  label: string;
  position: number;
}

/** One filled cell of the matrix: a player's encounter on a route. */
export interface EncounterState {
  seatId: string;
  routeId: string;
  familyKey: number;
  pokemonId: number;
  pokemonName: string | null;
  outcome: EncounterOutcome;
  nickname: string | null;
  level: number | null;
  isShiny: boolean;
}

/** Legacy per-seat dupes registry shape (derived from encounters). */
export interface UsedSpecies {
  familyKey: number;
  pokemonId: number;
  pokemonName: string | null;
  outcome: EncounterOutcome;
  routeLabel: string | null;
}

interface RouteRow extends RowDataPacket {
  id: string;
  label: string;
  position: number;
}

interface EncounterRow extends RowDataPacket {
  seat_id: string;
  route_id: string;
  family_key: number;
  pokemon_id: number;
  pokemon_name: string | null;
  outcome: EncounterOutcome;
  nickname: string | null;
  level: number | null;
  is_shiny: number;
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

function toEncounterState(r: EncounterRow): EncounterState {
  return {
    seatId: r.seat_id,
    routeId: r.route_id,
    familyKey: r.family_key,
    pokemonId: r.pokemon_id,
    pokemonName: r.pokemon_name,
    outcome: r.outcome,
    nickname: r.nickname,
    level: r.level,
    isShiny: Boolean(r.is_shiny),
  };
}

// ─── Room-state readers (folded into the full room snapshot) ──────────────────

/** Ordered routes of a room. */
export async function fetchRoutes(roomId: string): Promise<RouteEntry[]> {
  const [rows] = await pool.query<RouteRow[]>(
    `SELECT id, label, position FROM soullink_routes WHERE room_id = ? ORDER BY position, created_at`,
    [roomId],
  );
  return rows.map((r) => ({ id: r.id, label: r.label, position: r.position }));
}

/** All filled matrix cells of a room (only rows with a route + pokémon). */
export async function fetchRoomEncounters(roomId: string): Promise<EncounterState[]> {
  const [rows] = await pool.query<EncounterRow[]>(
    `SELECT seat_id, route_id, family_key, pokemon_id, pokemon_name, outcome, nickname, level, is_shiny
       FROM soullink_encounters
      WHERE room_id = ? AND route_id IS NOT NULL AND pokemon_id IS NOT NULL`,
    [roomId],
  );
  return rows.map(toEncounterState);
}

/** Legacy per-seat dupes registry — grouped used species for client checks. */
export async function fetchUsedSpeciesBySeat(roomId: string): Promise<Map<string, UsedSpecies[]>> {
  const [rows] = await pool.query<EncounterRow[]>(
    `SELECT e.seat_id, e.family_key, e.pokemon_id, e.pokemon_name, e.outcome, r.label AS route_label
       FROM soullink_encounters e
       LEFT JOIN soullink_routes r ON r.id = e.route_id
      WHERE e.room_id = ? AND e.pokemon_id IS NOT NULL`,
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

// ─── Route CRUD (broadcast the full ordered list on any change) ───────────────

async function broadcastRoutes(io: Server, roomCode: string, roomId: string): Promise<void> {
  io.to(roomCode).emit('routes:updated', { routes: await fetchRoutes(roomId) });
}

/** Adds a route at the end of the list (any participant). Returns the new list. */
export async function addRoute(io: Server, roomCode: string, roomId: string, label: string): Promise<void> {
  const clean = label.trim().slice(0, 100);
  if (!clean) return;
  const [posRows] = await pool.query<(RowDataPacket & { next: number })[]>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM soullink_routes WHERE room_id = ?`,
    [roomId],
  );
  const position = posRows[0]?.next ?? 0;
  // Ignore duplicate labels (unique per room) — keep the operation idempotent.
  await pool.query(
    `INSERT IGNORE INTO soullink_routes (id, room_id, label, position) VALUES (?, ?, ?, ?)`,
    [uuidv4(), roomId, clean, position],
  );
  await broadcastRoutes(io, roomCode, roomId);
}

/** Renames a route (owner). */
export async function renameRoute(io: Server, roomCode: string, roomId: string, routeId: string, label: string): Promise<void> {
  const clean = label.trim().slice(0, 100);
  if (!clean) return;
  await pool.query(
    `UPDATE soullink_routes SET label = ? WHERE id = ? AND room_id = ?`,
    [clean, routeId, roomId],
  );
  await broadcastRoutes(io, roomCode, roomId);
}

/** Deletes a route and every encounter on it (owner). */
export async function deleteRoute(io: Server, roomCode: string, roomId: string, routeId: string): Promise<void> {
  await pool.query(`DELETE FROM soullink_encounters WHERE room_id = ? AND route_id = ?`, [roomId, routeId]);
  await pool.query(`DELETE FROM soullink_routes WHERE id = ? AND room_id = ?`, [routeId, roomId]);
  io.to(roomCode).emit('route:deleted', { routeId });
  await broadcastRoutes(io, roomCode, roomId);
}

/** Applies a new ordering to the room's routes (owner). */
export async function reorderRoutes(io: Server, roomCode: string, roomId: string, orderedIds: string[]): Promise<void> {
  let position = 0;
  for (const id of orderedIds) {
    await pool.query(
      `UPDATE soullink_routes SET position = ? WHERE id = ? AND room_id = ?`,
      [position++, id, roomId],
    );
  }
  await broadcastRoutes(io, roomCode, roomId);
}

// ─── Encounter cells ──────────────────────────────────────────────────────────

export interface EncounterPatch {
  pokemonId: number;
  outcome?: EncounterOutcome;
  nickname?: string | null;
  level?: number | null;
  isShiny?: boolean;
}

/**
 * Upserts one matrix cell (a player's encounter on a route). When the outcome
 * is 'dead' and the room's autoDeadSync rule is on, every other player's
 * encounter on the SAME route is dragged dead too (souls are linked by route).
 */
export async function setEncounter(
  io: Server,
  roomCode: string,
  roomId: string,
  seatId: string,
  routeId: string,
  patch: EncounterPatch,
): Promise<EncounterState> {
  const familyKey = await resolveFamilyKey(patch.pokemonId);
  const name = await pokemonName(patch.pokemonId);
  const outcome: EncounterOutcome =
    patch.outcome === 'dead' || patch.outcome === 'fled' ? patch.outcome : 'caught';
  const nickname = patch.nickname != null ? String(patch.nickname).trim().slice(0, 50) || null : null;
  const level = patch.level != null && !isNaN(Number(patch.level)) ? Math.max(1, Math.min(100, Number(patch.level))) : null;
  const isShiny = patch.isShiny ? 1 : 0;

  await pool.query(
    `INSERT INTO soullink_encounters
       (id, room_id, seat_id, route_id, route_label, family_key, pokemon_id, pokemon_name, outcome, nickname, level, is_shiny)
     VALUES (?, ?, ?, ?, (SELECT label FROM soullink_routes WHERE id = ?), ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       family_key   = VALUES(family_key),
       pokemon_id   = VALUES(pokemon_id),
       pokemon_name = VALUES(pokemon_name),
       route_label  = VALUES(route_label),
       outcome      = VALUES(outcome),
       nickname     = VALUES(nickname),
       level        = VALUES(level),
       is_shiny     = VALUES(is_shiny),
       updated_at   = NOW()`,
    [uuidv4(), roomId, seatId, routeId, routeId, familyKey, patch.pokemonId, name, outcome, nickname, level, isShiny],
  );

  const result: EncounterState = {
    seatId, routeId, familyKey, pokemonId: patch.pokemonId, pokemonName: name,
    outcome, nickname, level, isShiny: Boolean(isShiny),
  };
  io.to(roomCode).emit('encounter:updated', { encounter: result });

  if (outcome === 'dead') {
    const ruleset = await fetchRuleset(roomId);
    if (ruleset.autoDeadSync) {
      await syncRouteDeaths(io, roomCode, roomId, routeId, seatId);
    }
  }

  return result;
}

/** Marks every OTHER seat's encounter on the same route as dead. */
async function syncRouteDeaths(
  io: Server,
  roomCode: string,
  roomId: string,
  routeId: string,
  sourceSeatId: string,
): Promise<void> {
  const [rows] = await pool.query<EncounterRow[]>(
    `SELECT seat_id, route_id, family_key, pokemon_id, pokemon_name, outcome, nickname, level, is_shiny
       FROM soullink_encounters
      WHERE room_id = ? AND route_id = ? AND seat_id <> ? AND pokemon_id IS NOT NULL AND outcome <> 'dead'`,
    [roomId, routeId, sourceSeatId],
  );
  if (rows.length === 0) return;

  await pool.query(
    `UPDATE soullink_encounters
        SET outcome = 'dead', updated_at = NOW()
      WHERE room_id = ? AND route_id = ? AND seat_id <> ? AND pokemon_id IS NOT NULL AND outcome <> 'dead'`,
    [roomId, routeId, sourceSeatId],
  );

  for (const r of rows) {
    const enc = toEncounterState({ ...r, outcome: 'dead' } as EncounterRow);
    io.to(roomCode).emit('encounter:updated', { encounter: enc, linkedDeath: true });
  }
  io.to(roomCode).emit('route:link-dead', { routeId });
}

/** Removes a matrix cell. */
export async function clearEncounter(
  io: Server,
  roomCode: string,
  roomId: string,
  seatId: string,
  routeId: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM soullink_encounters WHERE room_id = ? AND seat_id = ? AND route_id = ?`,
    [roomId, seatId, routeId],
  );
  io.to(roomCode).emit('encounter:removed', { seatId, routeId });
}

// ─── HTTP: family-key resolver (client-side dupes checks) ─────────────────────

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
