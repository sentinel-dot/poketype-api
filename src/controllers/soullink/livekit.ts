import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import { AccessToken } from 'livekit-server-sdk';
import pool from '../../db/connection';

interface SeatRow extends RowDataPacket { id: string; }

export async function getLiveKitToken(req: Request, res: Response): Promise<void> {
  const apiKey    = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !livekitUrl) {
    res.status(503).json({ error: 'LiveKit is not configured on this server' });
    return;
  }

  const { roomCode } = req.params as { roomCode: string };
  const { seatId, participantToken } = req.body as { seatId?: unknown; participantToken?: unknown };

  if (typeof seatId !== 'string' || seatId.trim().length === 0) {
    res.status(400).json({ error: 'seatId is required' });
    return;
  }

  if (typeof participantToken !== 'string' || participantToken.trim().length === 0) {
    res.status(401).json({ error: 'participantToken is required' });
    return;
  }

  // Validate seat belongs to this room AND the caller holds the correct token
  const [rows] = await pool.query<SeatRow[]>(
    `SELECT s.id FROM soullink_seats s
     JOIN soullink_rooms r ON r.id = s.room_id
     WHERE r.code = ? AND s.id = ? AND s.participant_token = ?`,
    [roomCode, seatId, participantToken],
  );

  if (rows.length === 0) {
    res.status(404).json({ error: 'Room or seat not found' });
    return;
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: seatId,
    ttl:      '2h',
  });

  at.addGrant({
    roomJoin:     true,
    room:         `soullink_${roomCode}`,
    canPublish:   true,
    canSubscribe: true,
  });

  const token = await at.toJwt();

  res.json({ url: livekitUrl, token });
}
