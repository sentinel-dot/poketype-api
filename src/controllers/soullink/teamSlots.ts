import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection';
import { SlotStatus } from '../../types';

const VALID_STATUSES: SlotStatus[] = ['empty', 'alive', 'dead'];

interface SeatRow extends RowDataPacket { id: string; room_id: string; }

/**
 * Validates that the seat belongs to the given room AND that the caller
 * holds the correct participantToken.  Returns the room_id on success, null
 * when the seat is not found or the token does not match.
 */
async function validateSeatOwnership(
  roomCode: string,
  seatId: string,
  participantToken: string,
): Promise<string | null> {
  const [rows] = await pool.query<SeatRow[]>(
    `SELECT s.id, s.room_id
     FROM soullink_seats s
     JOIN soullink_rooms r ON r.id = s.room_id
     WHERE r.code = ? AND s.id = ? AND s.participant_token = ?`,
    [roomCode, seatId, participantToken],
  );
  return rows.length > 0 ? rows[0].room_id : null;
}

export async function updateSlot(req: Request, res: Response, io: Server): Promise<void> {
  const { roomCode, seatId, slot } = req.params as { roomCode: string; seatId: string; slot: string };
  const slotNum = parseInt(slot, 10);

  if (isNaN(slotNum) || slotNum < 1 || slotNum > 6) {
    res.status(400).json({ error: 'slot must be 1–6' });
    return;
  }

  const { pokemonId, nickname, level, status, participantToken } = req.body as {
    pokemonId?: unknown;
    nickname?: unknown;
    level?: unknown;
    status?: unknown;
    participantToken?: unknown;
  };

  if (typeof participantToken !== 'string' || participantToken.trim().length === 0) {
    res.status(401).json({ error: 'participantToken is required' });
    return;
  }

  const roomId = await validateSeatOwnership(roomCode, seatId, participantToken);
  if (!roomId) {
    res.status(403).json({ error: 'Forbidden: invalid token or seat not found in this room' });
    return;
  }

  // Validate fields
  const pid = pokemonId === null || pokemonId === undefined ? null : Number(pokemonId);
  if (pid !== null && (isNaN(pid) || pid < 1)) {
    res.status(400).json({ error: 'pokemonId must be a positive integer or null' });
    return;
  }

  const nick = nickname === null || nickname === undefined
    ? null
    : String(nickname).trim().slice(0, 50) || null;

  const lvl = level === null || level === undefined ? null : Number(level);
  if (lvl !== null && (isNaN(lvl) || lvl < 1 || lvl > 100)) {
    res.status(400).json({ error: 'level must be 1–100 or null' });
    return;
  }

  const statusVal: SlotStatus = VALID_STATUSES.includes(status as SlotStatus)
    ? (status as SlotStatus)
    : 'alive';

  // Upsert the slot
  const slotId = uuidv4();
  await pool.query(
    `INSERT INTO soullink_team_slots (id, room_id, seat_id, slot, pokemon_id, nickname, level, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       pokemon_id = VALUES(pokemon_id),
       nickname   = VALUES(nickname),
       level      = VALUES(level),
       status     = VALUES(status),
       updated_at = NOW()`,
    [slotId, roomId, seatId, slotNum, pid, nick, lvl, statusVal],
  );

  let pokemonName: string | null = null;
  if (pid !== null) {
    const [nameRows] = await pool.query<(RowDataPacket & { pokemonName: string | null })[]>(
      `SELECT COALESCE(pn_de.name, pn_en.name) AS pokemonName
       FROM pokemon p
       LEFT JOIN pokemon_names pn_de ON pn_de.pokemon_id = p.id AND pn_de.language = 'de'
       LEFT JOIN pokemon_names pn_en ON pn_en.pokemon_id = p.id AND pn_en.language = 'en'
       WHERE p.id = ?`,
      [pid],
    );
    pokemonName = nameRows[0]?.pokemonName ?? null;
  }

  const slotData = { pokemonId: pid, nickname: nick, level: lvl, status: statusVal, pokemonName };

  io.to(roomCode).emit('team-slot:updated', { seatId, slot: slotNum, slotData });

  res.json({ seatId, slot: slotNum, ...slotData });
}

export async function clearSlot(req: Request, res: Response, io: Server): Promise<void> {
  const { roomCode, seatId, slot } = req.params as { roomCode: string; seatId: string; slot: string };
  const slotNum = parseInt(slot, 10);

  if (isNaN(slotNum) || slotNum < 1 || slotNum > 6) {
    res.status(400).json({ error: 'slot must be 1–6' });
    return;
  }

  // participantToken may be passed in the request body (non-standard for DELETE
  // but supported by most HTTP clients) or as a query param for strict clients.
  const ptok =
    (req.body as { participantToken?: unknown }).participantToken ??
    req.query['participantToken'];

  if (typeof ptok !== 'string' || ptok.trim().length === 0) {
    res.status(401).json({ error: 'participantToken is required' });
    return;
  }

  const roomId = await validateSeatOwnership(roomCode, seatId, ptok);
  if (!roomId) {
    res.status(403).json({ error: 'Forbidden: invalid token or seat not found in this room' });
    return;
  }

  await pool.query(
    `UPDATE soullink_team_slots
     SET pokemon_id = NULL, nickname = NULL, level = NULL, status = 'empty', updated_at = NOW()
     WHERE seat_id = ? AND slot = ?`,
    [seatId, slotNum],
  );

  io.to(roomCode).emit('team-slot:cleared', { seatId, slot: slotNum });

  res.json({ ok: true, seatId, slot: slotNum });
}
