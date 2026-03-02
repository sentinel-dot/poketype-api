import express from 'express';
import dotenv from 'dotenv';
import pokemonRouter from './routes/pokemon';

dotenv.config();

const app  = express();
const port = parseInt(process.env.PORT ?? '3000');

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

app.listen(port, () => {
  console.log(`Pokétype API listening on port ${port}`);
});

export default app;
