import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, publicUser, randomColor } from './db.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,20}$/;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Usuário deve ter 3 a 20 caracteres (letras, números, _ . -).';
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return 'A senha deve ter pelo menos 6 caracteres.';
  }
  return null;
}

export function createUser(username, password) {
  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const result = db
    .prepare('INSERT INTO users (username, display_name, password_hash, color, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, username, hashPassword(password), randomColor(), isFirst ? 1 : 0, Date.now());
  return getUser(Number(result.lastInsertRowid));
}

export function getUser(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? publicUser(row) : null;
}

export function findUserRow(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)').run(hashToken(token), userId, now, now);
  return token;
}

export function userFromToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const tokenHash = hashToken(token);
  const session = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(tokenHash);
  if (!session) return null;
  db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(Date.now(), tokenHash);
  return getUser(session.user_id);
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function deleteOtherSessions(userId, keepToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, hashToken(keepToken));
}

export function setPassword(userId, password) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
}

// Limite simples de tentativas de login por IP para dificultar força bruta.
const attempts = new Map();
export function rateLimited(key) {
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, reset: now + 15 * 60_000 };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + 15 * 60_000;
  }
  entry.count += 1;
  attempts.set(key, entry);
  return entry.count > 20;
}
