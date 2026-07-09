import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import { Server } from 'socket.io';
import pool from '../../db/connection';
import { SlotStatus } from '../../types';
import {
  applySlotUpdate,
  clearOneSlot,
  clearAllSlots as clearAllSlotsService,
  adjustDeathCount,
  VALID_SLOT_STATUSES,
} from './slotService';

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

  const { pokemonId, nickname, level, status, isShiny, encounterLabel, route, participantToken } = req.body as {
    pokemonId?: unknown;
    nickname?: unknown;
    level?: unknown;
    status?: unknown;
    isShiny?: unknown;
    encounterLabel?: unknown;
    route?: unknown;
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

  const lvl = level === null || level === undefined ? null : Number(level);
  if (lvl !== null && (isNaN(lvl) || lvl < 1 || lvl > 100)) {
    res.status(400).json({ error: 'level must be 1–100 or null' });
    return;
  }

  const statusVal: SlotStatus | undefined = VALID_SLOT_STATUSES.includes(status as SlotStatus)
    ? (status as SlotStatus)
    : undefined;

  const slotData = await applySlotUpdate(io, roomCode, roomId, seatId, slotNum, {
    pokemonId: pid,
    nickname: nickname === undefined ? undefined : (nickname === null ? null : String(nickname)),
    level: lvl,
    status: statusVal,
    isShiny: isShiny === undefined ? undefined : Boolean(isShiny),
    encounterLabel: encounterLabel === undefined ? undefined : (encounterLabel === null ? null : String(encounterLabel)),
    route: route === undefined ? undefined : (route === null ? null : String(route)),
  });

  res.json({ seatId, slot: slotNum, ...slotData });
}

export async function clearSlot(req: Request, res: Response, io: Server): Promise<void> {
  const { roomCode, seatId, slot } = req.params as { roomCode: string; seatId: string; slot: string };
  const slotNum = parseInt(slot, 10);

  if (isNaN(slotNum) || slotNum < 1 || slotNum > 6) {
    res.status(400).json({ error: 'slot must be 1–6' });
    return;
  }

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

  await clearOneSlot(io, roomCode, seatId, slotNum);
  res.json({ ok: true, seatId, slot: slotNum });
}

/** DELETE /rooms/:roomCode/seats/:seatId/team — wipe the whole team bar. */
export async function clearAllSlots(req: Request, res: Response, io: Server): Promise<void> {
  const { roomCode, seatId } = req.params as { roomCode: string; seatId: string };
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

  await clearAllSlotsService(io, roomCode, seatId);
  res.json({ ok: true, seatId });
}

/** PATCH /rooms/:roomCode/seats/:seatId/deaths { delta } — bump the death counter. */
export async function updateDeathCount(req: Request, res: Response, io: Server): Promise<void> {
  const { roomCode, seatId } = req.params as { roomCode: string; seatId: string };
  const { delta, participantToken } = req.body as { delta?: unknown; participantToken?: unknown };

  if (typeof participantToken !== 'string' || participantToken.trim().length === 0) {
    res.status(401).json({ error: 'participantToken is required' });
    return;
  }
  const d = Number(delta);
  if (isNaN(d) || (d !== 1 && d !== -1)) {
    res.status(400).json({ error: 'delta must be +1 or -1' });
    return;
  }

  const roomId = await validateSeatOwnership(roomCode, seatId, participantToken);
  if (!roomId) {
    res.status(403).json({ error: 'Forbidden: invalid token or seat not found in this room' });
    return;
  }

  const deathCount = await adjustDeathCount(io, roomCode, seatId, d);
  res.json({ ok: true, seatId, deathCount });
}
