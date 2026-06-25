import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection';

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

export async function joinRoom(req: Request, res: Response): Promise<void> {
  const { roomCode } = req.params as { roomCode: string };
  const { displayName } = req.body as { displayName?: unknown };

  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
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

  // Use a transaction with SELECT ... FOR UPDATE to prevent two simultaneous
  // join requests from claiming the same seat (race condition).
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [seatRows] = await conn.query<SeatRow[]>(
      `SELECT id, position, status
       FROM soullink_seats
       WHERE room_id = ? AND status = 'empty' AND display_name IS NULL
       ORDER BY position
       LIMIT 1
       FOR UPDATE`,
      [room.id],
    );

    if (seatRows.length === 0) {
      await conn.rollback();
      res.status(409).json({ error: 'Room is full' });
      return;
    }

    const seat = seatRows[0];
    const participantToken = uuidv4();

    await conn.query(
      `UPDATE soullink_seats
       SET display_name = ?, status = 'joining', participant_token = ?, joined_at = NOW()
       WHERE id = ?`,
      [displayName.trim().slice(0, 100), participantToken, seat.id],
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

  // Clear the seat and its team slots (intentional leave)
  await pool.query(
    `UPDATE soullink_seats
     SET display_name = NULL, status = 'empty', participant_token = NULL,
         joined_at = NULL, last_seen_at = NULL
     WHERE id = ?`,
    [seat.id],
  );

  await pool.query(
    `DELETE FROM soullink_team_slots WHERE seat_id = ?`,
    [seat.id],
  );

  io.to(roomCode).emit('seat:left', { seatId: seat.id });

  res.json({ ok: true });
}
