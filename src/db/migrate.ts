import pool from './connection';

/**
 * Ensures the SoulLink tables exist without re-running the full seed.
 * Safe to call on every server start (all statements use IF NOT EXISTS).
 */
export async function ensureSoulLinkSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS soullink_rooms (
      id           VARCHAR(36)   NOT NULL,
      code         VARCHAR(10)   NOT NULL,
      name         VARCHAR(200)  NOT NULL,
      max_players  INT           NOT NULL DEFAULT 3,
      pokemon_pool VARCHAR(20)   NOT NULL DEFAULT 'all',
      game         VARCHAR(100)  NULL,
      created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_room_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS soullink_seats (
      id                VARCHAR(36)   NOT NULL,
      room_id           VARCHAR(36)   NOT NULL,
      position          INT           NOT NULL,
      display_name      VARCHAR(100)  NULL,
      status            ENUM('empty','joining','online','disconnected') NOT NULL DEFAULT 'empty',
      participant_token VARCHAR(100)  NULL,
      joined_at         DATETIME      NULL,
      last_seen_at      DATETIME      NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_seat_room_pos (room_id, position),
      CONSTRAINT fk_seat_room FOREIGN KEY (room_id) REFERENCES soullink_rooms(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS soullink_team_slots (
      id          VARCHAR(36)  NOT NULL,
      room_id     VARCHAR(36)  NOT NULL,
      seat_id     VARCHAR(36)  NOT NULL,
      slot        INT          NOT NULL,
      pokemon_id  INT          NULL,
      nickname    VARCHAR(50)  NULL,
      level       INT          NULL,
      status      ENUM('empty','alive','dead') NOT NULL DEFAULT 'empty',
      updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_team_slot (seat_id, slot),
      CONSTRAINT fk_ts_room    FOREIGN KEY (room_id)    REFERENCES soullink_rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_ts_seat    FOREIGN KEY (seat_id)    REFERENCES soullink_seats(id) ON DELETE CASCADE,
      CONSTRAINT fk_ts_pokemon FOREIGN KEY (pokemon_id) REFERENCES pokemon(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}
