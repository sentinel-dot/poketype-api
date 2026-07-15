import { Request, Response } from 'express';
import { Server } from 'socket.io';
import { SlotStatus } from '../../types';
import { AuthedRequest } from '../../middleware/auth';
import { resolveSeatWriteAccess } from './access';
import {
  applySlotUpdate,
  clearOneSlot,
  clearAllSlots as clearAllSlotsService,
  adjustDeathCount,
  VALID_SLOT_STATUSES,
} from './slotService';

/**
 * Validates write access to a seat: the caller must hold the seat's
 * participantToken OR be the authenticated room owner. Returns the room_id on
 * success, null otherwise.
 */
function validateSeatOwnership(
  req: Request,
  roomCode: string,
  seatId: string,
  participantToken: string | null,
): Promise<string | null> {
  const authUserId = (req as AuthedRequest).auth?.userId ?? null;
  return resolveSeatWriteAccess(roomCode, seatId, participantToken, authUserId);
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

  const token = typeof participantToken === 'string' && participantToken.trim().length > 0 ? participantToken : null;
  if (!token && !(req as AuthedRequest).auth) {
    res.status(401).json({ error: 'participantToken or admin authentication is required' });
    return;
  }

  const roomId = await validateSeatOwnership(req, roomCode, seatId, token);
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

  const ptokRaw =
    (req.body as { participantToken?: unknown }).participantToken ??
    req.query['participantToken'];
  const token = typeof ptokRaw === 'string' && ptokRaw.trim().length > 0 ? ptokRaw : null;

  if (!token && !(req as AuthedRequest).auth) {
    res.status(401).json({ error: 'participantToken or admin authentication is required' });
    return;
  }

  const roomId = await validateSeatOwnership(req, roomCode, seatId, token);
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
  const ptokRaw =
    (req.body as { participantToken?: unknown }).participantToken ??
    req.query['participantToken'];
  const token = typeof ptokRaw === 'string' && ptokRaw.trim().length > 0 ? ptokRaw : null;

  if (!token && !(req as AuthedRequest).auth) {
    res.status(401).json({ error: 'participantToken or admin authentication is required' });
    return;
  }

  const roomId = await validateSeatOwnership(req, roomCode, seatId, token);
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

  const token = typeof participantToken === 'string' && participantToken.trim().length > 0 ? participantToken : null;
  if (!token && !(req as AuthedRequest).auth) {
    res.status(401).json({ error: 'participantToken or admin authentication is required' });
    return;
  }
  const d = Number(delta);
  if (isNaN(d) || (d !== 1 && d !== -1)) {
    res.status(400).json({ error: 'delta must be +1 or -1' });
    return;
  }

  const roomId = await validateSeatOwnership(req, roomCode, seatId, token);
  if (!roomId) {
    res.status(403).json({ error: 'Forbidden: invalid token or seat not found in this room' });
    return;
  }

  const deathCount = await adjustDeathCount(io, roomCode, seatId, d);
  res.json({ ok: true, seatId, deathCount });
}
