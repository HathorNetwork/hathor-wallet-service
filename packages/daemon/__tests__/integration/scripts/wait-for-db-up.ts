import mysql from 'mysql2/promise';
import {
  DB_USER,
  DB_PASS,
  DB_PORT,
  DB_ENDPOINT,
} from '../config';

const attemptConnection = async (maxAttempts: number, interval: number): Promise<void> => {
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const conn = await mysql.createConnection({
        host: DB_ENDPOINT,
        user: DB_USER,
        password: DB_PASS,
        port: DB_PORT,
      });
      await conn.query('SELECT 1');

      console.log('Successfully connected to the database!');
      await conn.end();
      return;
    } catch (err: any) {
      console.error('Failed to connect to the database:', err.message);
      attempts++;
      if (attempts < maxAttempts) {
        console.log(`Retrying connection... Attempt ${attempts} of ${maxAttempts}`);
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
  }

  throw new Error('Maximum connection attempts reached. Exiting.');
};

// Attempt to connect
attemptConnection(10, 5000) // 10 attempts, 5 seconds interval
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
