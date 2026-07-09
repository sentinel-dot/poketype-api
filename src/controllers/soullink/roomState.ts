import { RowDataPacket } from 'mysql2';
import pool from '../../db/connection';
import { PokemonPool, SeatStatus, SlotStatus } from '../../types';
import { fetchUsedSpeciesBySeat, UsedSpecies } from './encounters';

interface RoomRow extends RowDataPacket {
  id: string;
  code: string;
  name: string;
  max_players: number;
  pokemon_pool: string;
  game: string | null;
  owner_user_id: string | null;
  badges: number;
  level_cap: number | null;
  ruleset: unknown;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface SeatSlotRow extends RowDataPacket {
  seatId: string;
  position: number;
  displayName: string | null;
  seatStatus: string;
  joinedAt: Date | null;
  userId: string | null;
  deathCount: number;
  slot: number | null;
  pokemonId: number | null;
  nickname: string | null;
  level: number | null;
  slotStatus: string | null;
  isShiny: number | null;
  encounterLabel: string | null;
  route: string | null;
  pokemonName: string | null;
}

interface GraveyardRow extends RowDataPacket {
  seatId: string | null;
  position: number | null;
  displayName: string | null;
  pokemonId: number;
  pokemonName: string | null;
  routeLabel: string | null;
  diedAt: Date | null;
}

export interface TeamSlotState {
  slot: number;
  status: SlotStatus;
  pokemonId: number | null;
  pokemonName: string | null;
  nickname: string | null;
  level: number | null;
  isShiny: boolean;
  encounterLabel: string | null;
  route: string | null;
}

export interface SeatState {
  id: string;
  position: number;
  displayName: string | null;
  status: SeatStatus;
  joinedAt: string | null;
  userId: string | null;
  deathCount: number;
  teamSlots: TeamSlotState[];
  usedSpecies: UsedSpecies[];
}

export interface Ruleset {
  typeClause: boolean;
  autoDeadSync: boolean;
  dupesWarn: boolean;
}

export const DEFAULT_RULESET: Ruleset = {
  typeClause: true,
  autoDeadSync: true,
  dupesWarn: true,
};

export interface GraveyardEntry {
  seatId: string | null;
  position: number | null;
  displayName: string | null;
  pokemonId: number;
  pokemonName: string | null;
  routeLabel: string | null;
  diedAt: string | null;
}

export interface RoomState {
  room: {
    id: string;
    roomCode: string;
    name: string;
    maxPlayers: number;
    pokemonPool: PokemonPool;
    gameName: string | null;
    ownerUserId: string | null;
    badges: number;
    levelCap: number | null;
    ruleset: Ruleset;
    status: string;
    createdAt: string;
  };
  seats: SeatState[];
  graveyard: GraveyardEntry[];
}

function parseRuleset(raw: unknown): Ruleset {
  let obj: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = {}; }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  return {
    typeClause: obj.typeClause !== undefined ? Boolean(obj.typeClause) : DEFAULT_RULESET.typeClause,
    autoDeadSync: obj.autoDeadSync !== undefined ? Boolean(obj.autoDeadSync) : DEFAULT_RULESET.autoDeadSync,
    dupesWarn: obj.dupesWarn !== undefined ? Boolean(obj.dupesWarn) : DEFAULT_RULESET.dupesWarn,
  };
}

export async function fetchRoomState(roomCode: string): Promise<RoomState | null> {
  const [roomRows] = await pool.query<RoomRow[]>(
    `SELECT id, code, name, max_players, pokemon_pool, game,
            owner_user_id, badges, level_cap, ruleset, status, created_at, updated_at
       FROM soullink_rooms WHERE code = ?`,
    [roomCode],
  );

  if (roomRows.length === 0) return null;
  const room = roomRows[0];

  const [rows] = await pool.query<SeatSlotRow[]>(
    `SELECT
       s.id            AS seatId,
       s.position,
       s.display_name  AS displayName,
       s.status        AS seatStatus,
       s.joined_at     AS joinedAt,
       s.user_id       AS userId,
       s.death_count   AS deathCount,
       ts.slot,
       ts.pokemon_id   AS pokemonId,
       ts.nickname,
       ts.level,
       ts.status       AS slotStatus,
       ts.is_shiny     AS isShiny,
       ts.encounter_label AS encounterLabel,
       ts.route,
       COALESCE(pn_de.name, pn_en.name) AS pokemonName
     FROM soullink_seats s
     LEFT JOIN soullink_team_slots ts
       ON ts.seat_id = s.id
     LEFT JOIN pokemon_names pn_de
       ON pn_de.pokemon_id = ts.pokemon_id AND pn_de.language = 'de'
     LEFT JOIN pokemon_names pn_en
       ON pn_en.pokemon_id = ts.pokemon_id AND pn_en.language = 'en'
     WHERE s.room_id = ?
     ORDER BY s.position, ts.slot`,
    [room.id],
  );

  const usedBySeat = await fetchUsedSpeciesBySeat(room.id);

  const seatsMap = new Map<string, SeatState>();

  for (const row of rows) {
    if (!seatsMap.has(row.seatId)) {
      seatsMap.set(row.seatId, {
        id: row.seatId,
        position: row.position,
        displayName: row.displayName,
        status: row.seatStatus as SeatStatus,
        joinedAt: row.joinedAt instanceof Date ? row.joinedAt.toISOString() : (row.joinedAt ?? null),
        userId: row.userId,
        deathCount: row.deathCount ?? 0,
        teamSlots: [],
        usedSpecies: usedBySeat.get(row.seatId) ?? [],
      });
    }

    if (row.slot !== null) {
      seatsMap.get(row.seatId)!.teamSlots.push({
        slot: row.slot,
        status: (row.slotStatus ?? 'empty') as SlotStatus,
        pokemonId: row.pokemonId,
        pokemonName: row.pokemonName,
        nickname: row.nickname,
        level: row.level,
        isShiny: Boolean(row.isShiny),
        encounterLabel: row.encounterLabel,
        route: row.route,
      });
    }
  }

  const seats = Array.from(seatsMap.values()).sort((a, b) => a.position - b.position);

  // Memorial: every dead encounter, persists even after slots are cleared.
  const [graveRows] = await pool.query<GraveyardRow[]>(
    `SELECT e.seat_id AS seatId, s.position, s.display_name AS displayName,
            e.pokemon_id AS pokemonId, e.pokemon_name AS pokemonName,
            e.route_label AS routeLabel, e.updated_at AS diedAt
       FROM soullink_encounters e
       LEFT JOIN soullink_seats s ON s.id = e.seat_id
      WHERE e.room_id = ? AND e.outcome = 'dead'
      ORDER BY e.updated_at DESC`,
    [room.id],
  );
  const graveyard: GraveyardEntry[] = graveRows.map(g => ({
    seatId: g.seatId,
    position: g.position,
    displayName: g.displayName,
    pokemonId: g.pokemonId,
    pokemonName: g.pokemonName,
    routeLabel: g.routeLabel,
    diedAt: g.diedAt instanceof Date ? g.diedAt.toISOString() : (g.diedAt ?? null),
  }));

  return {
    room: {
      id: room.id,
      roomCode: room.code,
      name: room.name,
      maxPlayers: room.max_players,
      pokemonPool: room.pokemon_pool as PokemonPool,
      gameName: room.game,
      ownerUserId: room.owner_user_id,
      badges: room.badges ?? 0,
      levelCap: room.level_cap,
      ruleset: parseRuleset(room.ruleset),
      status: room.status ?? 'active',
      createdAt: room.created_at instanceof Date ? room.created_at.toISOString() : String(room.created_at),
    },
    seats,
    graveyard,
  };
}
