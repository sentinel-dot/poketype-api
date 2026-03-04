import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { RowDataPacket } from 'mysql2';
import pokemonRouter from './routes/pokemon';
import pool from './db/connection';
import { seed } from './seed';

dotenv.config();

const app  = express();
const port = parseInt(process.env.PORT ?? '3000');

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000'];
app.use(cors({ origin: corsOrigins }));
app.use(express.json());

// Routes
app.use('/pokemon', pokemonRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

async function startServer() {
  // Auto-seed if the database is empty
  try {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM pokemon');
    const count = rows[0]['count'] as number;
    if (count === 0) {
      console.log('Database is empty – running seed...');
      await seed();
    } else {
      console.log(`Database already seeded (${count} Pokémon found).`);
    }
  } catch (err: unknown) {
    // Only seed if the table doesn't exist yet; re-throw other errors
    const code = (err as { code?: string }).code;
    if (code !== 'ER_NO_SUCH_TABLE') throw err;
    console.log('Database not initialized – running seed...');
    await seed();
  }

  app.listen(port, () => {
    console.log(`Pokétype API listening on port ${port}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
