import express, { NextFunction, Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { RowDataPacket } from 'mysql2';
import pokemonRouter from './routes/pokemon';
import { createSoulLinkRouter } from './routes/soullink';
import { createAuthRouter } from './routes/auth';
import { createFriendsRouter } from './routes/friends';
import { createNotificationsRouter } from './routes/notifications';
import { registerSoulLinkSocket } from './ws/soullink';
import { registerUserSocket } from './ws/notifications';
import pool from './db/connection';
import { seed } from './seed';
import { ensureSoulLinkSchema } from './db/migrate';

dotenv.config();

const app  = express();
const port = parseInt(process.env.PORT ?? '4000');

// In development Next.js occupies 3000, the API runs on 4000 by default.
// Override with CORS_ORIGINS (comma-separated) in production.
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000', 'http://localhost:3001'];
app.use(cors({ origin: corsOrigins }));
app.use(express.json());

// HTTP server + Socket.io
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: corsOrigins, methods: ['GET', 'POST'] },
});
// Expose io to route handlers (e.g. room settings broadcast) via req.app.get('io')
app.set('io', io);

// Routes
app.use('/pokemon', pokemonRouter);
app.use('/auth', createAuthRouter());
app.use('/friends', createFriendsRouter(io));
app.use('/notifications', createNotificationsRouter());
app.use('/soullink', createSoulLinkRouter(io));

// WebSocket handlers
registerSoulLinkSocket(io);
registerUserSocket(io);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
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

  // Ensure SoulLink tables exist (safe to run on every start)
  await ensureSoulLinkSchema();
  console.log('SoulLink schema ready.');

  httpServer.listen(port, () => {
    console.log(`Pokétype API listening on port ${port}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
