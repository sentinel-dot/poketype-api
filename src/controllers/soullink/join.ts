import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection';
import { AuthedRequest } from '../../middleware/auth';

interface SeatRow extends RowDataPacket {
  id: string;
  position: number;
  status: string;
}

interface RoomRow extends RowDataPacket {
  id: string;
  code: string;
  name: string;
  max_players: number;
  pokemon_pool: string;
  game: string | null;
}

// A 'disconnected' seat (tab closed, network drop, ...) is never told apart
// from an intentional leave by the client, so we reclaim it for new joiners
// once it's been stale this long. Real 'empty' seats are always preferred.
const SEAT_RECLAIM_GRACE_MINUTES = 15;

export async function joinRoom(req: Request, res: Response): Promise<void> {
  const { roomCode } = req.params as { roomCode: string };
  const auth = (req as AuthedRequest).auth ?? null;
  const { displayName } = req.body as { displayName?: unknown };

  // Logged-in users may omit displayName (their username is used instead).
  const resolvedDisplayName =
    typeof displayName === 'string' && displayName.trim().length > 0
      ? displayName.trim().slice(0, 100)
      : (auth?.username ?? null);
  if (!resolvedDisplayName) {
    res.status(400).json({ error: 'displayName is required' });
    return;
  }

  const [roomRows] = await pool.query<RoomRow[]>(
    `SELECT id, code, name, max_players, pokemon_pool, game
     FROM soullink_rooms WHERE code = ?`,
    [roomCode],
  );

  if (roomRows.length === 0) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  const room = roomRows[0];

  // Cross-day resume: a logged-in user who already holds a seat re-enters it
  // (and keeps yesterday's team) instead of claiming a new one.
  if (auth) {
    const [existing] = await pool.query<(SeatRow & { participant_token: string | null })[]>(
      `SELECT id, position, status, participant_token
         FROM soullink_seats
        WHERE room_id = ? AND user_id = ? AND status <> 'empty' LIMIT 1`,
      [room.id, auth.userId],
    );
    if (existing.length > 0) {
      const seat = existing[0];
      const token = seat.participant_token ?? uuidv4();
      await pool.query(
        `UPDATE soullink_seats
            SET display_name = ?, status = 'joining', participant_token = ?, joined_at = NOW()
          WHERE id = ?`,
        [resolvedDisplayName, token, seat.id],
      );
      res.status(200).json({ seatId: seat.id, participantToken: token, resumed: true });
      return;
    }
  }

  // Use a transaction with SELECT ... FOR UPDATE to prevent two simultaneous
  // join requests from claiming the same seat (race condition).
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [seatRows] = await conn.query<SeatRow[]>(
      `SELECT id, position, status
       FROM soullink_seats
       WHERE room_id = ?
         AND (
           (status = 'empty' AND display_name IS NULL)
           OR (status = 'disconnected' AND last_seen_at < NOW() - INTERVAL ? MINUTE)
         )
       ORDER BY CASE WHEN status = 'empty' THEN 0 ELSE 1 END, position
       LIMIT 1
       FOR UPDATE`,
      [room.id, SEAT_RECLAIM_GRACE_MINUTES],
    );

    if (seatRows.length === 0) {
      await conn.rollback();
      res.status(409).json({ error: 'Room is full' });
      return;
    }

    const seat = seatRows[0];
    const participantToken = uuidv4();

    if (seat.status === 'disconnected') {
      // Reclaiming an abandoned seat — wipe the previous occupant's team,
      // encounters and death counter so the new joiner starts clean.
      await conn.query(`DELETE FROM soullink_team_slots WHERE seat_id = ?`, [seat.id]);
      await conn.query(`DELETE FROM soullink_encounters WHERE seat_id = ?`, [seat.id]);
      await conn.query(`UPDATE soullink_seats SET death_count = 0 WHERE id = ?`, [seat.id]);
    }

    await conn.query(
      `UPDATE soullink_seats
       SET display_name = ?, status = 'joining', participant_token = ?, user_id = ?, joined_at = NOW()
       WHERE id = ?`,
      [resolvedDisplayName, participantToken, auth?.userId ?? null, seat.id],
    );

    await conn.commit();

    res.status(200).json({
      seatId: seat.id,
      participantToken,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function leaveRoom(req: Request, res: Response, io: Server): Promise<void> {
  const { roomCode } = req.params as { roomCode: string };
  const { participantToken } = req.body as { participantToken?: unknown };

  if (typeof participantToken !== 'string') {
    res.status(400).json({ error: 'participantToken is required' });
    return;
  }

  // Find seat by token inside this room
  const [rows] = await pool.query<(SeatRow & { room_code: string })[]>(
    `SELECT s.id, s.position, s.status
     FROM soullink_seats s
     JOIN soullink_rooms r ON r.id = s.room_id
     WHERE r.code = ? AND s.participant_token = ?`,
    [roomCode, participantToken],
  );

  if (rows.length === 0) {
    res.status(404).json({ error: 'Seat not found for this token' });
    return;
  }

  const seat = rows[0];

  await resetSeat(seat.id);
  io.to(roomCode).emit('seat:left', { seatId: seat.id });

  res.json({ ok: true });
}

/**
 * Full reset of a seat: identity, team, encounters and death counter. Used by
 * an intentional leave and by an admin kick. Everything the previous occupant
 * left behind must go, otherwise the next joiner (or the same user rejoining)
 * inherits stale graveyard / used-species / death data tied to this seat id.
 */
export async function resetSeat(seatId: string): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE soullink_seats
       SET display_name = NULL, status = 'empty', participant_token = NULL,
           user_id = NULL, joined_at = NULL, last_seen_at = NULL, death_count = 0
       WHERE id = ?`,
      [seatId],
    );
    await conn.query(`DELETE FROM soullink_team_slots WHERE seat_id = ?`, [seatId]);
    await conn.query(`DELETE FROM soullink_encounters WHERE seat_id = ?`, [seatId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
