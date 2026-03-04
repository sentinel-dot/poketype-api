# Pokétype API

A REST API that returns Pokémon type weaknesses and resistances with exact damage multipliers (0×, 0.25×, 0.5×, 1×, 2×, 4×), fully generation-aware.

Built with **Node.js**, **TypeScript**, **Express**, and **MariaDB**. After a one-time seed, the app is completely independent from any external API.

---

## Features

- Generation-accurate type matchups (Gen 1–9)
- Handles Pokémon whose types changed across generations (e.g. Magnemite: Electric in Gen 1 → Electric/Steel from Gen 2)
- Handles type chart changes across generations (e.g. Steel/Dark introduced in Gen 2, Fairy in Gen 6)
- Dual-type combined multiplier calculation with correct immunity handling
- Pokémon name lookup in **English** and **German**, case-insensitive

---

## Stack

| Layer    | Technology          |
|----------|---------------------|
| Runtime  | Node.js 20+         |
| Language | TypeScript 5        |
| Framework| Express 4           |
| Database | MariaDB 10.11+      |
| ORM      | mysql2 (raw queries)|

---

## Prerequisites

- Node.js 20+
- MariaDB running locally
- A database named `poketype` with credentials for your user

```sql
CREATE DATABASE poketype CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON poketype.* TO 'youruser'@'localhost';
FLUSH PRIVILEGES;
```

---

## Setup

**1. Install dependencies**

```bash
npm install
```

**2. Configure environment**

Copy `.env` and edit as needed:

```bash
cp .env .env.local
```

```ini
DB_HOST=localhost
DB_PORT=3306
DB_USER=dev
DB_PASSWORD=devpw
DB_NAME=poketype
PORT=3000
```

**3. Seed the database**

This fetches all data from [PokéAPI](https://pokeapi.co/) and populates MariaDB. Run it once — it covers all 1025 Pokémon across Gen 1–9 and takes roughly 15–20 minutes (rate-limited to be polite to the public API).

```bash
npm run seed
```

The seed script will:
- Create all tables automatically
- Fetch and store all 18 battle types with their effectiveness tables per generation
- Fetch all 1025 Pokémon with their types per generation
- Store Pokémon names in English and German

**4. Start the server**

```bash
# Development (ts-node, no compile step)
npm run dev

# Production
npm run build
npm start
```

---

## API

### `GET /pokemon/:name/matchup?gen=<1-9>`

Returns the Pokémon's types for the given generation and all attacking type matchups grouped by damage multiplier.

| Parameter | Type   | Required | Description                        |
|-----------|--------|----------|------------------------------------|
| `name`    | string | Yes      | Pokémon name in English or German  |
| `gen`     | int    | Yes      | Generation number (1–9)            |

Name lookup is case-insensitive.

#### Example requests

```
GET /pokemon/gengar/matchup?gen=1
GET /pokemon/Glurak/matchup?gen=2
GET /pokemon/PIKACHU/matchup?gen=9
GET /pokemon/Koraidon/matchup?gen=9
```

#### Example response

```json
{
  "pokemon": "Gengar",
  "pokemonId": 94,
  "generation": 1,
  "types": ["ghost", "poison"],
  "matchup": {
    "0":    ["normal", "fighting"],
    "0.25": ["bug", "grass", "fairy"],
    "0.5":  ["poison", "fire", "grass"],
    "1":    ["water", "electric", "ice", "ground", "rock", "dragon"],
    "2":    ["ghost", "dark"],
    "4":    []
  }
}
```

#### Error responses

| Status | Condition                                              |
|--------|--------------------------------------------------------|
| 400    | `gen` is missing, non-numeric, or outside 1–9         |
| 404    | Pokémon name not found                                 |
| 404    | Pokémon has no type data for the requested generation  |

### `GET /health`

Returns `{ "status": "ok" }`. Useful for uptime checks.

---

## Database schema

```
generations       — Gen 1–9 IDs and names
types             — All 18 battle types
type_effectiveness— Attacking vs defending multiplier per generation (non-neutral rows only)
pokemon           — Pokémon ID and internal identifier
pokemon_names     — English and German names per Pokémon
pokemon_types     — Type(s) per Pokémon per generation (slot 1 and 2)
```

Only non-neutral (≠ 1×) effectiveness rows are stored; absent rows are treated as 1× by the API.

---

## Generation accuracy notes

| Change                          | From gen |
|---------------------------------|----------|
| Steel and Dark types introduced | 2        |
| Fairy type introduced           | 6        |
| Ghost vs Psychic fixed (0× → 1×)| 2        |
| Poison vs Bug changed           | 2        |
| Ice vs Fire changed             | 2        |
| Steel lost Ghost/Dark resistance| 6        |

Type chart changes are sourced directly from PokéAPI's `past_damage_relations` field. Pokémon type changes are sourced from `past_types`.

---

## Frontend

An implementation brief for a React + TypeScript mobile-first frontend (with type icons, Pokémon-themed design, and optional artwork) is in **[docs/FRONTEND_AGENT_BRIEF.md](docs/FRONTEND_AGENT_BRIEF.md)**. Use it to implement the web app or to brief an agent.

---

## Project structure

```
poketype-api/
├── .env
├── docs/
│   └── FRONTEND_AGENT_BRIEF.md   # Brief for React frontend implementation
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                  # Express app entry point
    ├── seed.ts                   # One-time seeding script
    ├── db/
    │   ├── connection.ts         # mysql2 connection pool
    │   └── schema.sql            # Table definitions
    ├── routes/
    │   └── pokemon.ts            # Route definitions
    ├── controllers/
    │   └── matchup.ts            # Matchup calculation logic
    └── types/
        └── index.ts              # Shared TypeScript types
```
