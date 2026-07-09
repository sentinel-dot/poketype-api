import { Server } from 'socket.io';
import { RowDataPacket } from 'mysql2';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection';
import { SlotStatus } from '../../types';
import { recordEncounter } from './encounters';
import { Ruleset, DEFAULT_RULESET } from './roomState';

export const VALID_SLOT_STATUSES: SlotStatus[] = ['empty', 'alive', 'dead'];

export interface SlotPatch {
  pokemonId?: number | null;
  nickname?: string | null;
  level?: number | null;
  status?: SlotStatus;
  isShiny?: boolean;
  encounterLabel?: string | null;
  route?: string | null;
}

export interface SlotData {
  pokemonId: number | null;
  nickname: string | null;
  level: number | null;
  status: SlotStatus;
  pokemonName: string | null;
  isShiny: boolean;
  encounterLabel: string | null;
  route: string | null;
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

export async function fetchRuleset(roomId: string): Promise<Ruleset> {
  const [rows] = await pool.query<(RowDataPacket & { ruleset: unknown })[]>(
    'SELECT ruleset FROM soullink_rooms WHERE id = ? LIMIT 1',
    [roomId],
  );
  const raw = rows[0]?.ruleset;
  let obj: Record<string, unknown> = {};
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { obj = {}; } }
  else if (raw && typeof raw === 'object') obj = raw as Record<string, unknown>;
  return {
    typeClause: obj.typeClause !== undefined ? Boolean(obj.typeClause) : DEFAULT_RULESET.typeClause,
    autoDeadSync: obj.autoDeadSync !== undefined ? Boolean(obj.autoDeadSync) : DEFAULT_RULESET.autoDeadSync,
    dupesWarn: obj.dupesWarn !== undefined ? Boolean(obj.dupesWarn) : DEFAULT_RULESET.dupesWarn,
  };
}

/**
 * Reads the current slot row so partial patches can merge onto existing values.
 */
async function readSlot(seatId: string, slot: number) {
  const [rows] = await pool.query<(RowDataPacket & {
    pokemon_id: number | null;
    nickname: string | null;
    level: number | null;
    status: SlotStatus;
    is_shiny: number;
    encounter_label: string | null;
    route: string | null;
  })[]>(
    `SELECT pokemon_id, nickname, level, status, is_shiny, encounter_label, route
       FROM soullink_team_slots WHERE seat_id = ? AND slot = ? LIMIT 1`,
    [seatId, slot],
  );
  return rows[0] ?? null;
}

/**
 * Applies a slot update, records the dupes-encounter, and (when the pokémon
 * dies) triggers auto-dead-sync on the linked slots of the other seats.
 * Emits all resulting socket events. Returns the caller's final slot data.
 */
export async function applySlotUpdate(
  io: Server,
  roomCode: string,
  roomId: string,
  seatId: string,
  slot: number,
  patch: SlotPatch,
): Promise<SlotData> {
  const current = await readSlot(seatId, slot);

  const pid = patch.pokemonId !== undefined ? patch.pokemonId : (current?.pokemon_id ?? null);
  const nick = patch.nickname !== undefined
    ? (patch.nickname ? String(patch.nickname).trim().slice(0, 50) : null)
    : (current?.nickname ?? null);
  const lvl = patch.level !== undefined ? patch.level : (current?.level ?? null);
  const status: SlotStatus = patch.status && VALID_SLOT_STATUSES.includes(patch.status)
    ? patch.status
    : (current?.status ?? (pid ? 'alive' : 'empty'));
  const isShiny = patch.isShiny !== undefined ? patch.isShiny : Boolean(current?.is_shiny);
  const encounterLabel = patch.encounterLabel !== undefined
    ? (patch.encounterLabel ? String(patch.encounterLabel).trim().slice(0, 100) : null)
    : (current?.encounter_label ?? null);
  const route = patch.route !== undefined
    ? (patch.route ? String(patch.route).trim().slice(0, 100) : null)
    : (current?.route ?? null);

  const justDied = status === 'dead' && current?.status !== 'dead';

  await pool.query(
    `INSERT INTO soullink_team_slots
       (id, room_id, seat_id, slot, pokemon_id, nickname, level, status, is_shiny, encounter_label, route, died_at, died_route)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${justDied ? 'NOW()' : 'NULL'}, ${justDied ? '?' : 'NULL'})
     ON DUPLICATE KEY UPDATE
       pokemon_id = VALUES(pokemon_id),
       nickname   = VALUES(nickname),
       level      = VALUES(level),
       status     = VALUES(status),
       is_shiny   = VALUES(is_shiny),
       encounter_label = VALUES(encounter_label),
       route      = VALUES(route),
       ${justDied ? 'died_at = NOW(), died_route = VALUES(died_route),' : ''}
       updated_at = NOW()`,
    justDied
      ? [uuidv4(), roomId, seatId, slot, pid, nick, lvl, status, isShiny ? 1 : 0, encounterLabel, route, route]
      : [uuidv4(), roomId, seatId, slot, pid, nick, lvl, status, isShiny ? 1 : 0, encounterLabel, route],
  );

  const name = pid !== null ? await pokemonName(pid) : null;

  // Dupes registry: record the caught species, or mark it dead.
  if (pid !== null) {
    if (status === 'dead') {
      const used = await recordEncounter(roomId, seatId, pid, 'dead', route, name);
      io.to(roomCode).emit('encounter:added', { seatId, used });
    } else {
      const used = await recordEncounter(roomId, seatId, pid, 'caught', route, name);
      io.to(roomCode).emit('encounter:added', { seatId, used });
    }
  }

  const slotData: SlotData = { pokemonId: pid, nickname: nick, level: lvl, status, pokemonName: name, isShiny, encounterLabel, route };
  io.to(roomCode).emit('team-slot:updated', { seatId, slot, slotData });

  // Auto-dead-sync: a linked death drags the same slot of the other seats down.
  if (justDied) {
    const ruleset = await fetchRuleset(roomId);
    if (ruleset.autoDeadSync) {
      await syncLinkedDeaths(io, roomCode, roomId, seatId, slot, route);
    }
  }

  return slotData;
}

/**
 * Marks the same slot index in every OTHER seat of the room as dead (if it
 * holds a living pokémon), records the deaths, and emits the updates.
 */
async function syncLinkedDeaths(
  io: Server,
  roomCode: string,
  roomId: string,
  sourceSeatId: string,
  slot: number,
  route: string | null,
): Promise<void> {
  const [rows] = await pool.query<(RowDataPacket & {
    seat_id: string; pokemon_id: number | null; status: SlotStatus;
  })[]>(
    `SELECT seat_id, pokemon_id, status
       FROM soullink_team_slots
      WHERE room_id = ? AND slot = ? AND seat_id <> ? AND pokemon_id IS NOT NULL AND status <> 'dead'`,
    [roomId, slot, sourceSeatId],
  );

  for (const r of rows) {
    await pool.query(
      `UPDATE soullink_team_slots
          SET status = 'dead', died_at = NOW(), died_route = COALESCE(?, died_route), updated_at = NOW()
        WHERE seat_id = ? AND slot = ?`,
      [route, r.seat_id, slot],
    );
    const name = r.pokemon_id !== null ? await pokemonName(r.pokemon_id) : null;
    if (r.pokemon_id !== null) {
      const used = await recordEncounter(roomId, r.seat_id, r.pokemon_id, 'dead', route, name);
      io.to(roomCode).emit('encounter:added', { seatId: r.seat_id, used });
    }
    io.to(roomCode).emit('team-slot:updated', {
      seatId: r.seat_id,
      slot,
      slotData: { pokemonId: r.pokemon_id, status: 'dead', pokemonName: name } as Partial<SlotData>,
      linkedDeath: true,
    });
  }

  if (rows.length > 0) {
    io.to(roomCode).emit('slot:link-dead', { slot });
  }
}

/** Clears one slot (keeps the dead encounter in the registry). */
export async function clearOneSlot(
  io: Server,
  roomCode: string,
  seatId: string,
  slot: number,
): Promise<void> {
  await pool.query(
    `UPDATE soullink_team_slots
        SET pokemon_id = NULL, nickname = NULL, level = NULL, status = 'empty',
            is_shiny = 0, encounter_label = NULL, route = NULL, updated_at = NOW()
      WHERE seat_id = ? AND slot = ?`,
    [seatId, slot],
  );
  io.to(roomCode).emit('team-slot:cleared', { seatId, slot });
}

/** Clears the entire team bar of a seat at once (for a fresh restart). */
export async function clearAllSlots(
  io: Server,
  roomCode: string,
  seatId: string,
): Promise<void> {
  await pool.query(
    `UPDATE soullink_team_slots
        SET pokemon_id = NULL, nickname = NULL, level = NULL, status = 'empty',
            is_shiny = 0, encounter_label = NULL, route = NULL, updated_at = NOW()
      WHERE seat_id = ?`,
    [seatId],
  );
  io.to(roomCode).emit('team:cleared-all', { seatId });
}

/** Adjusts a seat's death counter by a delta (clamped at 0). Returns the new value. */
export async function adjustDeathCount(
  io: Server,
  roomCode: string,
  seatId: string,
  delta: number,
): Promise<number> {
  await pool.query(
    'UPDATE soullink_seats SET death_count = GREATEST(0, death_count + ?) WHERE id = ?',
    [delta, seatId],
  );
  const [rows] = await pool.query<(RowDataPacket & { death_count: number })[]>(
    'SELECT death_count FROM soullink_seats WHERE id = ? LIMIT 1',
    [seatId],
  );
  const deathCount = rows[0]?.death_count ?? 0;
  io.to(roomCode).emit('death:updated', { seatId, deathCount });
  return deathCount;
}
