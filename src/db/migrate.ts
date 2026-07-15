import { RowDataPacket } from 'mysql2';
import pool from './connection';

/**
 * Idempotently adds a column to a table only if it does not already exist.
 * MySQL lacks `ADD COLUMN IF NOT EXISTS` on older versions, so we probe
 * information_schema first.
 */
async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [table, column],
  );
  if ((rows[0]?.c as number) > 0) return;
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Idempotently adds an index to a table only if it does not already exist.
 */
async function addIndexIfMissing(table: string, indexName: string, definition: string): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?`,
    [table, indexName],
  );
  if ((rows[0]?.c as number) > 0) return;
  await pool.query(`ALTER TABLE ${table} ADD ${definition}`);
}

/**
 * Idempotently drops an index only if it exists.
 */
async function dropIndexIfExists(table: string, indexName: string): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?`,
    [table, indexName],
  );
  if ((rows[0]?.c as number) === 0) return;
  await pool.query(`ALTER TABLE ${table} DROP INDEX ${indexName}`);
}

/**
 * Ensures all SoulLink + account tables exist and are up to date.
 * Safe to call on every server start (CREATE ... IF NOT EXISTS + guarded ALTERs).
 */
export async function ensureSoulLinkSchema(): Promise<void> {
  // ─── Accounts ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            VARCHAR(36)   NOT NULL,
      username      VARCHAR(30)   NOT NULL,
      display_name  VARCHAR(50)   NOT NULL,
      password_hash VARCHAR(100)  NOT NULL,
      avatar        VARCHAR(255)  NULL,
      created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id         VARCHAR(36)  NOT NULL,
      user_id    VARCHAR(36)  NOT NULL,
      friend_id  VARCHAR(36)  NOT NULL,
      status     ENUM('pending','accepted') NOT NULL DEFAULT 'pending',
      created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_friend_pair (user_id, friend_id),
      INDEX idx_friend_user   (user_id),
      INDEX idx_friend_friend (friend_id),
      CONSTRAINT fk_friend_user   FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_friend_friend FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         VARCHAR(36)  NOT NULL,
      user_id    VARCHAR(36)  NOT NULL,
      type       VARCHAR(40)  NOT NULL,
      payload    JSON         NULL,
      read_at    DATETIME     NULL,
      created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_notif_user (user_id, created_at),
      CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ─── SoulLink core ─────────────────────────────────────────────────────────
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

  // ─── Dupes-/Species-Clause tracking ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS soullink_encounters (
      id           VARCHAR(36)  NOT NULL,
      room_id      VARCHAR(36)  NOT NULL,
      seat_id      VARCHAR(36)  NULL,
      family_key   INT          NOT NULL,
      pokemon_id   INT          NOT NULL,
      pokemon_name VARCHAR(100) NULL,
      outcome      ENUM('caught','dead','fled') NOT NULL DEFAULT 'caught',
      route_label  VARCHAR(100) NULL,
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_enc_seat_family (room_id, seat_id, family_key),
      INDEX idx_enc_room (room_id),
      CONSTRAINT fk_enc_room FOREIGN KEY (room_id) REFERENCES soullink_rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_enc_seat FOREIGN KEY (seat_id) REFERENCES soullink_seats(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Lazily-populated cache mapping a pokémon to its evolution-family key
  // (the lowest species id in its evolution chain). Resolved via PokeAPI.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS evolution_family (
      pokemon_id INT NOT NULL,
      family_key INT NOT NULL,
      PRIMARY KEY (pokemon_id),
      INDEX idx_family_key (family_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ─── Additive column migrations (guarded / idempotent) ───────────────────────
  await addColumnIfMissing('soullink_rooms', 'owner_user_id', 'VARCHAR(36) NULL');
  await addColumnIfMissing('soullink_rooms', 'badges',        'INT NOT NULL DEFAULT 0');
  await addColumnIfMissing('soullink_rooms', 'level_cap',     'INT NULL');
  await addColumnIfMissing('soullink_rooms', 'ruleset',       'JSON NULL');
  await addColumnIfMissing('soullink_rooms', 'status',        "ENUM('active','archived') NOT NULL DEFAULT 'active'");

  await addColumnIfMissing('soullink_seats', 'user_id',     'VARCHAR(36) NULL');
  await addColumnIfMissing('soullink_seats', 'death_count', 'INT NOT NULL DEFAULT 0');

  await addColumnIfMissing('soullink_team_slots', 'is_shiny',        'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('soullink_team_slots', 'encounter_label', 'VARCHAR(100) NULL');
  await addColumnIfMissing('soullink_team_slots', 'route',           'VARCHAR(100) NULL');
  await addColumnIfMissing('soullink_team_slots', 'died_at',         'DATETIME NULL');
  await addColumnIfMissing('soullink_team_slots', 'died_route',      'VARCHAR(100) NULL');

  await addIndexIfMissing('soullink_rooms', 'idx_room_owner', 'INDEX idx_room_owner (owner_user_id)');
  await addIndexIfMissing('soullink_seats', 'idx_seat_user',  'INDEX idx_seat_user (user_id)');

  // ─── Central encounter matrix (Route × Player, the nuzlocke tracker) ──────────
  // Ordered list of routes/locations per room; the rows of the matrix.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS soullink_routes (
      id         VARCHAR(36)  NOT NULL,
      room_id    VARCHAR(36)  NOT NULL,
      label      VARCHAR(100) NOT NULL,
      position   INT          NOT NULL DEFAULT 0,
      created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_route_room_label (room_id, label),
      INDEX idx_route_room (room_id, position),
      CONSTRAINT fk_route_room FOREIGN KEY (room_id) REFERENCES soullink_rooms(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Encounters become route-centric: one row per (room, seat, route). The
  // dupes clause is derived from family_key; full nuzlocke data lives here.
  await addColumnIfMissing('soullink_encounters', 'route_id', 'VARCHAR(36) NULL');
  await addColumnIfMissing('soullink_encounters', 'nickname', 'VARCHAR(50) NULL');
  await addColumnIfMissing('soullink_encounters', 'level',    'INT NULL');
  await addColumnIfMissing('soullink_encounters', 'is_shiny', 'TINYINT(1) NOT NULL DEFAULT 0');

  // Backfill routes from existing distinct route_labels, then link encounters.
  await pool.query(`
    INSERT IGNORE INTO soullink_routes (id, room_id, label, position)
    SELECT UUID(), room_id, route_label, 0
      FROM soullink_encounters
     WHERE route_label IS NOT NULL AND route_label <> '' AND route_id IS NULL
     GROUP BY room_id, route_label
  `);
  await pool.query(`
    UPDATE soullink_encounters e
      JOIN soullink_routes r ON r.room_id = e.room_id AND r.label = e.route_label
       SET e.route_id = r.id
     WHERE e.route_id IS NULL AND e.route_label IS NOT NULL AND e.route_label <> ''
  `);

  // Old data allowed several families per (seat, route); the new model is one
  // encounter per (seat, route). Dedupe before the unique index or it errors.
  await pool.query(`
    DELETE e1 FROM soullink_encounters e1
      JOIN soullink_encounters e2
        ON e1.room_id = e2.room_id AND e1.seat_id = e2.seat_id
       AND e1.route_id = e2.route_id AND e1.route_id IS NOT NULL
       AND e1.id > e2.id
  `);

  // Swap the unique constraint from (room, seat, family) to (room, seat, route).
  await dropIndexIfExists('soullink_encounters', 'uq_enc_seat_family');
  await addIndexIfMissing(
    'soullink_encounters',
    'uq_enc_seat_route',
    'UNIQUE KEY uq_enc_seat_route (room_id, seat_id, route_id)',
  );
  await addIndexIfMissing(
    'soullink_encounters',
    'idx_enc_family',
    'INDEX idx_enc_family (room_id, seat_id, family_key)',
  );
}
