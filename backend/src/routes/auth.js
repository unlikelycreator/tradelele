import crypto from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const attempts = new Map(); // ip → { count, until }

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts — try again in a minute' });
  if (!safeEqual(req.body?.password ?? '', config.dashboardPassword)) {
    const count = (a?.count || 0) + 1;
    attempts.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    return res.status(401).json({ error: 'Wrong password' });
  }
  attempts.delete(ip);
  const token = jwt.sign({ sub: 'owner' }, config.jwtSecret, { expiresIn: '12h' });
  res.json({ token });
});

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  try {
    jwt.verify(String(token || ''), config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Not signed in' });
  }
}
