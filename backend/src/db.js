import { MongoClient } from 'mongodb';
import { config } from './config.js';
import { MemoryDb } from './lib/memoryDb.js';

let client;
let db;

/** MONGO_URI=memory → in-process store (nothing survives a restart; for trying the bot and tests). */
export const isMemoryDb = () => config.mongoUri === 'memory' || process.env.MONGO_URI === 'memory';

export async function connectDb() {
  if (isMemoryDb()) {
    db = new MemoryDb();
    return db;
  }
  client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  db = client.db(config.mongoDb);
  await Promise.all([
    db.collection('trades').createIndex({ mode: 1, status: 1 }),
    db.collection('trades').createIndex({ date: 1, mode: 1 }),
    db.collection('trades').createIndex({ openedAt: -1 }),
    db.collection('orders').createIndex({ createdAt: -1 }),
    // keep the event log to 30 days
    db.collection('events').createIndex({ tsDate: 1 }, { expireAfterSeconds: 30 * 86400 }),
    db.collection('daily').createIndex({ date: 1, mode: 1 }, { unique: true }),
  ]);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not connected');
  return db;
}

export const col = (name) => getDb().collection(name);

export async function closeDb() {
  await client?.close();
  client = null;
  db = null;
}
