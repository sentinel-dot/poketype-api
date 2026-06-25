import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection';
import { POOL_TO_MAX_DEX, PokemonPool } from '../../types';
import { fetchRoomState } from './roomState';

function generateRoomCode(): string {
  // Exclude visually ambiguous characters (0, O, I, 1)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function uniqueRoomCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateRoomCode();
    const [rows] = await pool.query<(RowDataPacket & { count: number })[]>(
      'SELECT COUNT(*) AS count FROM soullink_rooms WHERE code = ?',
      [code],
    );
    if (rows[0].count === 0) return code;
  }
  throw new Error('Could not generate unique room code');
}

export async function createRoom(req: Request, res: Response): Promise<void> {
  const { name, pokemonPool, gameName, displayName } = req.body as {
    name?: unknown;
    pokemonPool?: unknown;
    gameName?: unknown;
    displayName?: unknown;
  };

  if (typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    res.status(400).json({ error: 'displayName is required' });
    return;
  }

  const pool_val: PokemonPool =
    typeof pokemonPool === 'string' && pokemonPool in POOL_TO_MAX_DEX
      ? (pokemonPool as PokemonPool)
      : 'all';

  const game_val = typeof gameName === 'string' && gameName.trim().length > 0
    ? gameName.trim().slice(0, 100)
    : null;

  const roomId = uuidv4();
  const code   = await uniqueRoomCode();

  await pool.query(
    `INSERT INTO soullink_rooms (id, code, name, max_players, pokemon_pool, game)
     VALUES (?, ?, ?, 3, ?, ?)`,
    [roomId, code, name.trim().slice(0, 200), pool_val, game_val],
  );

  // Create the 3 fixed seats
  const seatIds = [uuidv4(), uuidv4(), uuidv4()];
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO soullink_seats (id, room_id, position) VALUES (?, ?, ?)`,
      [seatIds[i], roomId, i + 1],
    );
  }

  // Assign host to seat 1
  const participantToken = uuidv4();
  await pool.query(
    `UPDATE soullink_seats
     SET display_name = ?, status = 'joining', participant_token = ?, joined_at = NOW()
     WHERE id = ?`,
    [displayName.trim().slice(0, 100), participantToken, seatIds[0]],
  );

  res.status(201).json({
    roomCode: code,
    seatId: seatIds[0],
    participantToken,
  });
}

export async function getRoom(req: Request, res: Response): Promise<void> {
  const { roomCode } = req.params as { roomCode: string };

  const state = await fetchRoomState(roomCode);
  if (!state) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  res.json(state);
}
