import { RowDataPacket } from 'mysql2';
import pool from '../../db/connection';
import { PokemonPool, SeatStatus, SlotStatus } from '../../types';

interface RoomRow extends RowDataPacket {
  id: string;
  code: string;
  name: string;
  max_players: number;
  pokemon_pool: string;
  game: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SeatSlotRow extends RowDataPacket {
  seatId: string;
  position: number;
  displayName: string | null;
  seatStatus: string;
  joinedAt: Date | null;
  slot: number | null;
  pokemonId: number | null;
  nickname: string | null;
  level: number | null;
  slotStatus: string | null;
  pokemonName: string | null;
}

export interface TeamSlotState {
  slot: number;
  status: SlotStatus;
  pokemonId: number | null;
  pokemonName: string | null;
  nickname: string | null;
  level: number | null;
}

export interface SeatState {
  id: string;
  position: number;
  displayName: string | null;
  status: SeatStatus;
  joinedAt: string | null;
  teamSlots: TeamSlotState[];
}

export interface RoomState {
  room: {
    id: string;
    roomCode: string;
    name: string;
    maxPlayers: number;
    pokemonPool: PokemonPool;
    gameName: string | null;
    createdAt: string;
  };
  seats: SeatState[];
}

export async function fetchRoomState(roomCode: string): Promise<RoomState | null> {
  const [roomRows] = await pool.query<RoomRow[]>(
    `SELECT id, code, name, max_players, pokemon_pool, game, created_at, updated_at
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
       ts.slot,
       ts.pokemon_id   AS pokemonId,
       ts.nickname,
       ts.level,
       ts.status       AS slotStatus,
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

  const seatsMap = new Map<string, SeatState>();

  for (const row of rows) {
    if (!seatsMap.has(row.seatId)) {
      seatsMap.set(row.seatId, {
        id: row.seatId,
        position: row.position,
        displayName: row.displayName,
        status: row.seatStatus as SeatStatus,
        joinedAt: row.joinedAt instanceof Date ? row.joinedAt.toISOString() : (row.joinedAt ?? null),
        teamSlots: [],
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
      });
    }
  }

  const seats = Array.from(seatsMap.values()).sort((a, b) => a.position - b.position);

  return {
    room: {
      id: room.id,
      roomCode: room.code,
      name: room.name,
      maxPlayers: room.max_players,
      pokemonPool: room.pokemon_pool as PokemonPool,
      gameName: room.game,
      createdAt: room.created_at instanceof Date ? room.created_at.toISOString() : String(room.created_at),
    },
    seats,
  };
}
