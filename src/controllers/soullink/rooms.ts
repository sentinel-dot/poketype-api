import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection';
import { POOL_TO_MAX_DEX, PokemonPool } from '../../types';
import { fetchRoomState, DEFAULT_RULESET, Ruleset } from './roomState';
import { AuthedRequest } from '../../middleware/auth';
import { createNotification } from '../notifications/service';
import { Server } from 'socket.io';

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
  const auth = (req as AuthedRequest).auth ?? null;
  const { name, pokemonPool, gameName, displayName, maxPlayers } = req.body as {
    name?: unknown;
    pokemonPool?: unknown;
    gameName?: unknown;
    displayName?: unknown;
    maxPlayers?: unknown;
  };

  if (typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  // Room size: 2 or 3 players (default 3). One fixed seat is created per slot.
  const seatCount = Number(maxPlayers) === 2 ? 2 : 3;
  // A logged-in host may skip displayName (their username is used instead).
  const resolvedDisplayName =
    typeof displayName === 'string' && displayName.trim().length > 0
      ? displayName.trim().slice(0, 100)
      : (auth?.username ?? null);
  if (!resolvedDisplayName) {
    res.status(400).json({ error: 'displayName is required' });
    return;
  }

  // Pool selection was removed from the UI; default to the full dex.
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
    `INSERT INTO soullink_rooms (id, code, name, max_players, pokemon_pool, game, owner_user_id, ruleset)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [roomId, code, name.trim().slice(0, 200), seatCount, pool_val, game_val, auth?.userId ?? null, JSON.stringify(DEFAULT_RULESET)],
  );

  // Create the fixed seats (one per player slot)
  const seatIds = Array.from({ length: seatCount }, () => uuidv4());
  for (let i = 0; i < seatCount; i++) {
    await pool.query(
      `INSERT INTO soullink_seats (id, room_id, position) VALUES (?, ?, ?)`,
      [seatIds[i], roomId, i + 1],
    );
  }

  // Assign host to seat 1 (linking their account when logged in)
  const participantToken = uuidv4();
  await pool.query(
    `UPDATE soullink_seats
     SET display_name = ?, status = 'joining', participant_token = ?, user_id = ?, joined_at = NOW()
     WHERE id = ?`,
    [resolvedDisplayName, participantToken, auth?.userId ?? null, seatIds[0]],
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

interface RoomOwnerRow extends RowDataPacket { id: string; owner_user_id: string | null; ruleset: unknown; }

/**
 * PATCH /rooms/:roomCode/settings — rename, adjust badges/level cap, toggle
 * ruleset flags, or archive.  Owner-only when the room has an owner; open to
 * any participant (guest rooms) otherwise.
 */
export async function updateRoomSettings(req: Request, res: Response): Promise<void> {
  const auth = (req as AuthedRequest).auth ?? null;
  const { roomCode } = req.params as { roomCode: string };
  const { name, badges, levelCap, ruleset, status } = req.body as {
    name?: unknown;
    badges?: unknown;
    levelCap?: unknown;
    ruleset?: unknown;
    status?: unknown;
  };

  const [rows] = await pool.query<RoomOwnerRow[]>(
    'SELECT id, owner_user_id, ruleset FROM soullink_rooms WHERE code = ? LIMIT 1',
    [roomCode],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  const room = rows[0];

  if (room.owner_user_id && room.owner_user_id !== auth?.userId) {
    res.status(403).json({ error: 'Only the room owner can change settings' });
    return;
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (typeof name === 'string' && name.trim().length > 0) {
    sets.push('name = ?');
    params.push(name.trim().slice(0, 200));
  }
  if (badges !== undefined) {
    const b = Number(badges);
    if (!isNaN(b) && b >= 0 && b <= 20) { sets.push('badges = ?'); params.push(b); }
  }
  if (levelCap !== undefined) {
    if (levelCap === null) { sets.push('level_cap = NULL'); }
    else {
      const l = Number(levelCap);
      if (!isNaN(l) && l >= 1 && l <= 100) { sets.push('level_cap = ?'); params.push(l); }
    }
  }
  if (ruleset && typeof ruleset === 'object') {
    let existing: Record<string, unknown> = {};
    const raw = room.ruleset;
    if (typeof raw === 'string') { try { existing = JSON.parse(raw); } catch { existing = {}; } }
    else if (raw && typeof raw === 'object') existing = raw as Record<string, unknown>;
    const merged: Ruleset = {
      typeClause: 'typeClause' in ruleset ? Boolean((ruleset as Record<string, unknown>).typeClause) : Boolean(existing.typeClause ?? DEFAULT_RULESET.typeClause),
      autoDeadSync: 'autoDeadSync' in ruleset ? Boolean((ruleset as Record<string, unknown>).autoDeadSync) : Boolean(existing.autoDeadSync ?? DEFAULT_RULESET.autoDeadSync),
      dupesWarn: 'dupesWarn' in ruleset ? Boolean((ruleset as Record<string, unknown>).dupesWarn) : Boolean(existing.dupesWarn ?? DEFAULT_RULESET.dupesWarn),
    };
    sets.push('ruleset = ?');
    params.push(JSON.stringify(merged));
  }
  if (status === 'active' || status === 'archived') {
    sets.push('status = ?');
    params.push(status);
  }

  if (sets.length === 0) {
    res.status(400).json({ error: 'No valid fields to update' });
    return;
  }

  params.push(room.id);
  await pool.query(`UPDATE soullink_rooms SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, params);

  const state = await fetchRoomState(roomCode);
  const io = req.app.get('io');
  if (io && state) io.to(roomCode).emit('room:settings-updated', { room: state.room });
  res.json({ ok: true, room: state?.room });
}

interface InviteRoomRow extends RowDataPacket {
  id: string;
  name: string;
}

/** POST /rooms/:roomCode/invite { userId } — notify a friend they've been invited (auth required). */
export async function inviteToRoom(req: AuthedRequest, res: Response, io: Server): Promise<void> {
  const me = req.auth?.userId;
  if (!me) {
    res.status(401).json({ error: 'Anmeldung erforderlich.' });
    return;
  }
  const { roomCode } = req.params;
  const targetId = String((req.body as { userId?: unknown })?.userId ?? '').trim();
  if (!targetId) {
    res.status(400).json({ error: 'userId ist erforderlich.' });
    return;
  }

  const [rooms] = await pool.query<InviteRoomRow[]>(
    'SELECT id, name FROM soullink_rooms WHERE code = ? LIMIT 1',
    [roomCode],
  );
  if (rooms.length === 0) {
    res.status(404).json({ error: 'Room nicht gefunden.' });
    return;
  }

  // Only allow inviting accepted friends.
  const [friends] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM friendships
      WHERE status = 'accepted'
        AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))
      LIMIT 1`,
    [me, targetId, targetId, me],
  );
  if (friends.length === 0) {
    res.status(403).json({ error: 'Nur Freunde können eingeladen werden.' });
    return;
  }

  const [meRow] = await pool.query<(RowDataPacket & { username: string; display_name: string })[]>(
    'SELECT username, display_name FROM users WHERE id = ? LIMIT 1',
    [me],
  );

  await createNotification(io, targetId, 'room_invite', {
    roomCode,
    roomName: rooms[0].name,
    userId: me,
    username: meRow[0]?.username,
    displayName: meRow[0]?.display_name,
  });

  res.json({ ok: true });
}