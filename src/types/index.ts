export interface EvoNode {
  id:        number;
  name:      string;   // display name (DE if available)
  nameEN:    string;   // for API lookups
  evolvesTo: { method: string; node: EvoNode }[];
}

export interface EvolutionResponse {
  chain: EvoNode;
}

export interface MatchupResponse {
  pokemon:     string;
  pokemonId:   number;  // For frontend image URL: official-artwork/{pokemonId}.png
  generation:  number;
  types:       string[];
  matchup: {
    '0':    string[];   // immune
    '0.25': string[];
    '0.5':  string[];
    '1':    string[];
    '2':    string[];
    '4':    string[];
  };
}

// ─── SoulLink Types ──────────────────────────────────────────────────────────

export type PokemonPool =
  | 'gen1' | 'gen1-2' | 'gen1-3' | 'gen1-4' | 'gen1-5'
  | 'gen1-6' | 'gen1-7' | 'gen1-8' | 'gen1-9' | 'all';

export const POOL_TO_MAX_DEX: Record<PokemonPool, number | null> = {
  'gen1':   151,
  'gen1-2': 251,
  'gen1-3': 386,
  'gen1-4': 493,
  'gen1-5': 649,
  'gen1-6': 721,
  'gen1-7': 809,
  'gen1-8': 905,
  'gen1-9': 1025,
  'all':    null,
};

export type SeatStatus = 'empty' | 'joining' | 'online' | 'disconnected';
export type SlotStatus  = 'empty' | 'alive' | 'dead';
export type EncounterOutcome = 'caught' | 'dead' | 'fled';

/** SoulLink ruleset flags, persisted as JSON on the room. */
export interface Ruleset {
  typeClause:   boolean;
  autoDeadSync: boolean;
  dupesWarn:    boolean;
}

/** A species used on a seat, tracked for the dupes-/species-clause. */
export interface UsedSpecies {
  familyKey:   number;
  pokemonId:   number;
  pokemonName: string | null;
  outcome:     EncounterOutcome;
  routeLabel:  string | null;
}

/**
 * API wire-format shape of a SoulLink room (as returned by GET /soullink/rooms/:code).
 * Note: field names differ from the DB columns (code→roomCode, game→gameName).
 */
export interface SoulLinkRoom {
  id:          string;
  roomCode:    string;        // DB column: code
  name:        string;
  maxPlayers:  number;
  pokemonPool: PokemonPool;
  gameName:    string | null; // DB column: game
  ownerUserId: string | null; // DB column: owner_user_id
  badges:      number;
  levelCap:    number | null; // DB column: level_cap
  ruleset:     Ruleset;
  status:      string;        // 'active' | 'archived'
  createdAt:   string;        // ISO 8601 — DATETIME serialised by JSON
}

/** API wire-format shape of a team slot. */
export interface SoulLinkTeamSlot {
  slot:           number;
  status:         SlotStatus;
  pokemonId:      number | null;
  pokemonName:    string | null;
  nickname:       string | null;
  level:          number | null;
  isShiny:        boolean;
  encounterLabel: string | null;
  route:          string | null;
}

/** API wire-format shape of a SoulLink seat. */
export interface SoulLinkSeat {
  id:          string;
  position:    number;
  displayName: string | null;
  status:      SeatStatus;
  joinedAt:    string | null; // ISO 8601 or null
  userId:      string | null; // DB column: user_id
  deathCount:  number;
  teamSlots:   SoulLinkTeamSlot[];
  usedSpecies: UsedSpecies[];
}

/** A dead encounter shown in the room memorial/graveyard. */
export interface GraveyardEntry {
  seatId:      string | null;
  position:    number | null;
  displayName: string | null;
  pokemonId:   number;
  pokemonName: string | null;
  routeLabel:  string | null;
  diedAt:      string | null;
}

/** Full room state as returned by GET /soullink/rooms/:code and the `room:state` WS event. */
export interface RoomStateResponse {
  room:      SoulLinkRoom;
  seats:     SoulLinkSeat[];
  graveyard: GraveyardEntry[];
}
