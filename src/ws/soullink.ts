import { Server, Socket } from 'socket.io';
import { RowDataPacket } from 'mysql2';
import pool from '../db/connection';
import { fetchRoomState } from '../controllers/soullink/roomState';
import { SlotStatus } from '../types';
import {
  applySlotUpdate,
  clearOneSlot,
  clearAllSlots,
  adjustDeathCount,
  VALID_SLOT_STATUSES,
} from '../controllers/soullink/slotService';

interface SeatRow extends RowDataPacket {
  id: string;
  room_id: string;
  position: number;
  display_name: string | null;
  status: string;
}

// In-memory maps: socketId → { roomCode, seatId } and seatId → Set<socketId>
const socketToSeat  = new Map<string, { roomCode: string; seatId: string }>();
const seatToSockets = new Map<string, Set<string>>();

export function registerSoulLinkSocket(io: Server): void {
  io.on('connection', (socket: Socket) => {

    // ── room:join ─────────────────────────────────────────────────────────
    socket.on('room:join', async (data: unknown) => {
      try {
        const { roomCode, participantToken } = (data ?? {}) as {
          roomCode?: string;
          participantToken?: string;
        };

        if (!roomCode || !participantToken) {
          socket.emit('error', { message: 'roomCode and participantToken are required' });
          return;
        }

        const [rows] = await pool.query<SeatRow[]>(
          `SELECT s.id, s.room_id, s.position, s.display_name, s.status
           FROM soullink_seats s
           JOIN soullink_rooms r ON r.id = s.room_id
           WHERE r.code = ? AND s.participant_token = ?`,
          [roomCode, participantToken],
        );

        if (rows.length === 0) {
          socket.emit('error', { message: 'Invalid token or room code' });
          return;
        }

        const seat = rows[0];
        // 'joining' = first WS connect after HTTP create/join (no slots yet)
        // anything else = reconnect after disconnect or server restart → preserve slots
        const wasDisconnected = seat.status !== 'joining';

        // Update seat to online
        await pool.query(
          `UPDATE soullink_seats SET status = 'online', last_seen_at = NOW() WHERE id = ?`,
          [seat.id],
        );

        // Join the Socket.io room and track socket→seat + seat→sockets
        socket.join(roomCode);
        socketToSeat.set(socket.id, { roomCode, seatId: seat.id });
        if (!seatToSockets.has(seat.id)) seatToSockets.set(seat.id, new Set());
        seatToSockets.get(seat.id)!.add(socket.id);

        // Send full room state to the joining client
        const state = await fetchRoomState(roomCode);
        socket.emit('room:state', state);

        // Notify others
        const seatPayload = {
          seatId:      seat.id,
          position:    seat.position,
          displayName: seat.display_name,
          status:      'online',
        };

        if (wasDisconnected) {
          socket.to(roomCode).emit('seat:reconnected', seatPayload);
        } else {
          socket.to(roomCode).emit('seat:joined', seatPayload);
        }
      } catch (err) {
        console.error('[ws] room:join error:', err);
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    // ── team-slot:update ──────────────────────────────────────────────────
    socket.on('team-slot:update', async (data: unknown) => {
      try {
        const { roomCode, seatId, slot, patch } = (data ?? {}) as {
          roomCode?: string;
          seatId?: string;
          slot?: number;
          patch?: {
            pokemonId?: number | null;
            nickname?: string | null;
            level?: number | null;
            status?: string;
            isShiny?: boolean;
            encounterLabel?: string | null;
            route?: string | null;
          };
        };

        if (!roomCode || !seatId || slot == null || !patch) {
          socket.emit('error', { message: 'roomCode, seatId, slot and patch are required' });
          return;
        }
        if (slot < 1 || slot > 6) {
          socket.emit('error', { message: 'slot must be 1–6' });
          return;
        }

        // Verify the socket owns this seat
        const ownership = socketToSeat.get(socket.id);
        if (!ownership || ownership.seatId !== seatId) {
          socket.emit('error', { message: 'You can only update your own slots' });
          return;
        }

        // Verify seat is in this room
        const [rows] = await pool.query<(RowDataPacket & { room_id: string })[]>(
          `SELECT s.room_id FROM soullink_seats s
           JOIN soullink_rooms r ON r.id = s.room_id
           WHERE r.code = ? AND s.id = ?`,
          [roomCode, seatId],
        );
        if (rows.length === 0) {
          socket.emit('error', { message: 'Seat not found in this room' });
          return;
        }

        const roomId = rows[0].room_id;

        const pid = patch.pokemonId != null ? Number(patch.pokemonId) : (patch.pokemonId === null ? null : undefined);
        if (pid != null && (isNaN(pid) || pid < 1)) {
          socket.emit('error', { message: 'pokemonId must be a positive integer' });
          return;
        }

        const lvl = patch.level != null ? Number(patch.level) : (patch.level === null ? null : undefined);
        if (lvl != null && (isNaN(lvl) || lvl < 1 || lvl > 100)) {
          socket.emit('error', { message: 'level must be 1–100' });
          return;
        }

        const status = VALID_SLOT_STATUSES.includes(patch.status as SlotStatus)
          ? (patch.status as SlotStatus)
          : undefined;

        await applySlotUpdate(io, ownership.roomCode, roomId, seatId, slot, {
          pokemonId: pid,
          nickname: patch.nickname === undefined ? undefined : patch.nickname,
          level: lvl,
          status,
          isShiny: patch.isShiny === undefined ? undefined : Boolean(patch.isShiny),
          encounterLabel: patch.encounterLabel === undefined ? undefined : patch.encounterLabel,
          route: patch.route === undefined ? undefined : patch.route,
        });
      } catch (err) {
        console.error('[ws] team-slot:update error:', err);
        socket.emit('error', { message: 'Failed to update slot' });
      }
    });

    // ── team-slot:clear ───────────────────────────────────────────────────
    socket.on('team-slot:clear', async (data: unknown) => {
      try {
        const { roomCode, seatId, slot } = (data ?? {}) as {
          roomCode?: string;
          seatId?: string;
          slot?: number;
        };

        if (!roomCode || !seatId || slot == null) {
          socket.emit('error', { message: 'roomCode, seatId and slot are required' });
          return;
        }
        if (slot < 1 || slot > 6) {
          socket.emit('error', { message: 'slot must be 1–6' });
          return;
        }

        // Verify the socket owns this seat
        const clearOwnership = socketToSeat.get(socket.id);
        if (!clearOwnership || clearOwnership.seatId !== seatId) {
          socket.emit('error', { message: 'You can only clear your own slots' });
          return;
        }

        // Use the server-tracked roomCode to prevent the client from
        // redirecting the broadcast to a different room.
        await clearOneSlot(io, clearOwnership.roomCode, seatId, slot);
      } catch (err) {
        console.error('[ws] team-slot:clear error:', err);
        socket.emit('error', { message: 'Failed to clear slot' });
      }
    });

    // ── team-slot:clear-all ───────────────────────────────────────────────
    socket.on('team-slot:clear-all', async (data: unknown) => {
      try {
        const { seatId } = (data ?? {}) as { seatId?: string };
        const ownership = socketToSeat.get(socket.id);
        if (!ownership || !seatId || ownership.seatId !== seatId) {
          socket.emit('error', { message: 'You can only clear your own team' });
          return;
        }
        await clearAllSlots(io, ownership.roomCode, seatId);
      } catch (err) {
        console.error('[ws] team-slot:clear-all error:', err);
        socket.emit('error', { message: 'Failed to clear team' });
      }
    });

    // ── death:adjust ──────────────────────────────────────────────────────
    // { seatId, delta: +1 | -1 } — bump a seat's death counter.
    socket.on('death:adjust', async (data: unknown) => {
      try {
        const { seatId, delta } = (data ?? {}) as { seatId?: string; delta?: number };
        const ownership = socketToSeat.get(socket.id);
        if (!ownership || !seatId || ownership.seatId !== seatId) {
          socket.emit('error', { message: 'You can only change your own death counter' });
          return;
        }
        const d = Number(delta);
        if (d !== 1 && d !== -1) {
          socket.emit('error', { message: 'delta must be +1 or -1' });
          return;
        }
        await adjustDeathCount(io, ownership.roomCode, seatId, d);
      } catch (err) {
        console.error('[ws] death:adjust error:', err);
        socket.emit('error', { message: 'Failed to update death counter' });
      }
    });

    // ── disconnect ────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      try {
        const entry = socketToSeat.get(socket.id);
        if (!entry) return;

        const { roomCode, seatId } = entry;
        socketToSeat.delete(socket.id);

        // Only mark disconnected when the last socket for this seat closes
        // (handles multiple browser tabs with the same participantToken)
        const seatSockets = seatToSockets.get(seatId);
        if (seatSockets) {
          seatSockets.delete(socket.id);
          if (seatSockets.size > 0) return; // other tabs still connected
          seatToSockets.delete(seatId);
        }

        await pool.query(
          `UPDATE soullink_seats
           SET status = 'disconnected', last_seen_at = NOW()
           WHERE id = ?`,
          [seatId],
        );

        io.to(roomCode).emit('seat:disconnected', { seatId });
      } catch (err) {
        console.error('[ws] disconnect error:', err);
      }
    });
  });
}
