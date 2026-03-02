import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = mysql.createPool({
  host:     process.env.DB_HOST     ?? 'localhost',
  port:     parseInt(process.env.DB_PORT ?? '3306'),
  user:     process.env.DB_USER     ?? 'dev',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME     ?? 'poketype',
  waitForConnections: true,
  connectionLimit:    10,
  charset: 'utf8mb4',
});

export default pool;
