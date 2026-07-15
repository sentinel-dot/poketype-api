import { Server, Socket } from 'socket.io';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import pool from '../db/connection';
import { fetchRoomState } from '../controllers/soullink/roomState';
import { resetSeat } from '../controllers/soullink/join';
import {
  addRoute,
  renameRoute,
  deleteRoute,
  reorderRoutes,
  setEncounter,
  clearEncounter,
} from '../controllers/soullink/encounters';
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
  user_id: string | null;
  owner_user_id: string | null;
}

// In-memory maps: socketId → seat context and seatId → Set<socketId>.
// `isOwner` lets the room creator write to every seat (admin control).
interface SocketSeat { roomCode: string; roomId: string; seatId: string; isOwner: boolean; }
const socketToSeat  = new Map<string, SocketSeat>();
const seatToSockets = new Map<string, Set<string>>();

/** True when the socket owns the target seat OR is the room admin (owner). */
function canWriteSeat(ownership: SocketSeat | undefined, seatId: string): boolean {
  return !!ownership && (ownership.seatId === seatId || ownership.isOwner);
}

/** Confirms a seat belongs to the given room (guards admin cross-seat writes). */
async function seatInRoom(seatId: string, roomId: string): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 1 FROM soullink_seats WHERE id = ? AND room_id = ? LIMIT 1`,
    [seatId, roomId],
  );
  return rows.length > 0;
}

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
          `SELECT s.id, s.room_id, s.position, s.display_name, s.status,
                  s.user_id, r.owner_user_id
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
        const isOwner = !!seat.owner_user_id && seat.owner_user_id === seat.user_id;

        // Update seat to online
        await pool.query(
          `UPDATE soullink_seats SET status = 'online', last_seen_at = NOW() WHERE id = ?`,
          [seat.id],
        );

        // Join the Socket.io room and track socket→seat + seat→sockets
        socket.join(roomCode);
        socketToSeat.set(socket.id, { roomCode, roomId: seat.room_id, seatId: seat.id, isOwner });
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

        // Own seat, or the room admin editing any seat.
        const ownership = socketToSeat.get(socket.id);
        if (!canWriteSeat(ownership, seatId)) {
          socket.emit('error', { message: 'You can only update your own slots' });
          return;
        }

        // Verify the target seat lives in the socket's tracked room (prevents
        // an admin from redirecting a write to a seat in a different room).
        if (!(await seatInRoom(seatId, ownership!.roomId))) {
          socket.emit('error', { message: 'Seat not found in this room' });
          return;
        }
        const roomId = ownership!.roomId;

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

        await applySlotUpdate(io, ownership!.roomCode, roomId, seatId, slot, {
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

        // Own seat, or the room admin editing any seat.
        const clearOwnership = socketToSeat.get(socket.id);
        if (!canWriteSeat(clearOwnership, seatId)) {
          socket.emit('error', { message: 'You can only clear your own slots' });
          return;
        }
        if (!(await seatInRoom(seatId, clearOwnership!.roomId))) {
          socket.emit('error', { message: 'Seat not found in this room' });
          return;
        }

        // Use the server-tracked roomCode to prevent the client from
        // redirecting the broadcast to a different room.
        await clearOneSlot(io, clearOwnership!.roomCode, seatId, slot);
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
        if (!seatId || !canWriteSeat(ownership, seatId)) {
          socket.emit('error', { message: 'You can only clear your own team' });
          return;
        }
        if (!(await seatInRoom(seatId, ownership!.roomId))) {
          socket.emit('error', { message: 'Seat not found in this room' });
          return;
        }
        await clearAllSlots(io, ownership!.roomCode, seatId);
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
        if (!seatId || !canWriteSeat(ownership, seatId)) {
          socket.emit('error', { message: 'You can only change your own death counter' });
          return;
        }
        const d = Number(delta);
        if (d !== 1 && d !== -1) {
          socket.emit('error', { message: 'delta must be +1 or -1' });
          return;
        }
        if (!(await seatInRoom(seatId, ownership!.roomId))) {
          socket.emit('error', { message: 'Seat not found in this room' });
          return;
        }
        await adjustDeathCount(io, ownership!.roomCode, seatId, d);
      } catch (err) {
        console.error('[ws] death:adjust error:', err);
        socket.emit('error', { message: 'Failed to update death counter' });
      }
    });

    // ── room:kick ─────────────────────────────────────────────────────────
    // { seatId } — admin-only: fully reset another player's seat and evict
    // their live sockets.
    socket.on('room:kick', async (data: unknown) => {
      try {
        const { seatId } = (data ?? {}) as { seatId?: string };
        const ownership = socketToSeat.get(socket.id);
        if (!ownership || !ownership.isOwner) {
          socket.emit('error', { message: 'Only the room admin can remove players' });
          return;
        }
        if (!seatId || seatId === ownership.seatId) {
          socket.emit('error', { message: 'Invalid seat to remove' });
          return;
        }
        if (!(await seatInRoom(seatId, ownership.roomId))) {
          socket.emit('error', { message: 'Seat not found in this room' });
          return;
        }

        await resetSeat(seatId);

        // Evict the kicked player's live sockets so their client clears its
        // stale credentials and leaves the room.
        const targetSockets = seatToSockets.get(seatId);
        if (targetSockets) {
          for (const sid of targetSockets) {
            io.to(sid).emit('seat:kicked', { seatId });
            socketToSeat.delete(sid);
          }
          seatToSockets.delete(seatId);
        }

        io.to(ownership.roomCode).emit('seat:left', { seatId });
      } catch (err) {
        console.error('[ws] room:kick error:', err);
        socket.emit('error', { message: 'Failed to remove player' });
      }
    });

    // ── route:add ─────────────────────────────────────────────────────────
    // { label } — any participant can add a route to the encounter matrix.
    socket.on('route:add', async (data: unknown) => {
      try {
        const { label } = (data ?? {}) as { label?: string };
        const ownership = socketToSeat.get(socket.id);
        if (!ownership) {
          socket.emit('error', { message: 'Join the room first' });
          return;
        }
        if (typeof label !== 'string' || !label.trim()) {
          socket.emit('error', { message: 'Route label is required' });
          return;
        }
        await addRoute(io, ownership.roomCode, ownership.roomId, label);
      } catch (err) {
        console.error('[ws] route:add error:', err);
        socket.emit('error', { message: 'Failed to add route' });
      }
    });

    // ── route:rename / route:delete / route:reorder (admin only) ────────────
    socket.on('route:rename', async (data: unknown) => {
      try {
        const { routeId, label } = (data ?? {}) as { routeId?: string; label?: string };
        const ownership = socketToSeat.get(socket.id);
        if (!ownership || !ownership.isOwner) {
          socket.emit('error', { message: 'Only the room admin can edit routes' });
          return;
        }
        if (!routeId || typeof label !== 'string' || !label.trim()) {
          socket.emit('error', { message: 'routeId and label are required' });
          return;
        }
        await renameRoute(io, ownership.roomCode, ownership.roomId, routeId, label);
      } catch (err) {
        console.error('[ws] route:rename error:', err);
        socket.emit('error', { message: 'Failed to rename route' });
      }
    });

    socket.on('route:delete', async (data: unknown) => {
      try {
        const { routeId } = (data ?? {}) as { routeId?: string };
        const ownership = socketToSeat.get(socket.id);
        if (!ownership || !ownership.isOwner) {
          socket.emit('error', { message: 'Only the room admin can delete routes' });
          return;
        }
        if (!routeId) {
          socket.emit('error', { message: 'routeId is required' });
          return;
        }
        await deleteRoute(io, ownership.roomCode, ownership.roomId, routeId);
      } catch (err) {
        console.error('[ws] route:delete error:', err);
        socket.emit('error', { message: 'Failed to delete route' });
      }
    });

    socket.on('route:reorder', async (data: unknown) => {
      try {
        const { orderedIds } = (data ?? {}) as { orderedIds?: unknown };
        const ownership = socketToSeat.get(socket.id);
        if (!ownership || !ownership.isOwner) {
          socket.emit('error', { message: 'Only the room admin can reorder routes' });
          return;
        }
        if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
          socket.emit('error', { message: 'orderedIds must be a string array' });
          return;
        }
        await reorderRoutes(io, ownership.roomCode, ownership.roomId, orderedIds as string[]);
      } catch (err) {
        console.error('[ws] route:reorder error:', err);
        socket.emit('error', { message: 'Failed to reorder routes' });
      }
    });

    // ── encounter:set ───────────────────────────────────────────────────────
    // { seatId, routeId, patch } — upsert a matrix cell (own seat or admin).
    socket.on('encounter:set', async (data: unknown) => {
      try {
        const { seatId, routeId, patch } = (data ?? {}) as {
          seatId?: string;
          routeId?: string;
          patch?: {
            pokemonId?: number;
            outcome?: string;
            nickname?: string | null;
            level?: number | null;
            isShiny?: boolean;
          };
        };
        const ownership = socketToSeat.get(socket.id);
        if (!seatId || !canWriteSeat(ownership, seatId)) {
          socket.emit('error', { message: 'You can only edit your own encounters' });
          return;
        }
        if (!routeId || !patch || patch.pokemonId == null) {
          socket.emit('error', { message: 'routeId and patch.pokemonId are required' });
          return;
        }
        const pid = Number(patch.pokemonId);
        if (isNaN(pid) || pid < 1) {
          socket.emit('error', { message: 'pokemonId must be a positive integer' });
          return;
        }
        if (!(await seatInRoom(seatId, ownership!.roomId))) {
          socket.emit('error', { message: 'Seat not found in this room' });
          return;
        }
        const outcome =
          patch.outcome === 'dead' || patch.outcome === 'fled' || patch.outcome === 'caught'
            ? (patch.outcome as 'dead' | 'fled' | 'caught')
            : undefined;
        await setEncounter(io, ownership!.roomCode, ownership!.roomId, seatId, routeId, {
          pokemonId: pid,
          outcome,
          nickname: patch.nickname === undefined ? undefined : patch.nickname,
          level: patch.level === undefined ? undefined : patch.level,
          isShiny: patch.isShiny === undefined ? undefined : Boolean(patch.isShiny),
        });
      } catch (err) {
        console.error('[ws] encounter:set error:', err);
        socket.emit('error', { message: 'Failed to save encounter' });
      }
    });

    // ── encounter:clear ─────────────────────────────────────────────────────
    socket.on('encounter:clear', async (data: unknown) => {
      try {
        const { seatId, routeId } = (data ?? {}) as { seatId?: string; routeId?: string };
        const ownership = socketToSeat.get(socket.id);
        if (!seatId || !canWriteSeat(ownership, seatId)) {
          socket.emit('error', { message: 'You can only edit your own encounters' });
          return;
        }
        if (!routeId) {
          socket.emit('error', { message: 'routeId is required' });
          return;
        }
        if (!(await seatInRoom(seatId, ownership!.roomId))) {
          socket.emit('error', { message: 'Seat not found in this room' });
          return;
        }
        await clearEncounter(io, ownership!.roomCode, ownership!.roomId, seatId, routeId);
      } catch (err) {
        console.error('[ws] encounter:clear error:', err);
        socket.emit('error', { message: 'Failed to clear encounter' });
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

        // Guard: never resurrect a seat that was intentionally left. A leave
        // (or kick) nulls the participant_token and sets status='empty'; the
        // socket then unmounts and fires this handler on the SAME seat id.
        // Without this guard the just-emptied seat flips back to 'disconnected'
        // with a NULL token — unreconnectable and blocking the room until the
        // reclaim grace expires.
        const [updated] = await pool.query<ResultSetHeader>(
          `UPDATE soullink_seats
           SET status = 'disconnected', last_seen_at = NOW()
           WHERE id = ? AND participant_token IS NOT NULL AND status <> 'empty'`,
          [seatId],
        );

        if (updated.affectedRows > 0) {
          io.to(roomCode).emit('seat:disconnected', { seatId });
        }
      } catch (err) {
        console.error('[ws] disconnect error:', err);
      }
    });
  });
}
