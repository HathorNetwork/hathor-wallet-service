import mysql from 'mysql2/promise';
import {
  DB_USER,
  DB_PASS,
  DB_PORT,
  DB_NAME,
  DB_ENDPOINT,
} from '../config';

const main = async () => {
  const conn = await mysql.createConnection({
    host: DB_ENDPOINT,
    user: DB_USER,
    password: DB_PASS,
    port: DB_PORT,
  })

  await conn.query(`CREATE DATABASE IF NOT EXISTS ${DB_NAME};`);
  console.log('Database created successfully');
  process.exit(0);
};

main();
