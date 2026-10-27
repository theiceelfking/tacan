import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { RoomError } from './rooms.js';

// Player accounts: name + password, kept in one JSON file under dataDir (a Docker volume in production).
//
//  - Passwords are stored as scrypt hashes with a per-user salt, never in clear.
//  - A login hands out a random session token; the file keeps only its SHA-256, so a leaked file cannot be used
//    to log in. Sessions last sessionDays and are dropped on logout.
//  - Logins are rate limited per client address (see LoginLimiter) so passwords cannot be guessed quickly.
//
// The account name is also the name shown at the table, so nobody can sit down under someone else's name.

const NAME_RE = /^[\p{L}\p{N}_.\- ]{3,20}$/u;
const PASS_MIN = 6;
const PASS_MAX = 72;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_SESSIONS_PER_USER = 10;

export class Accounts {
  constructor({ dataDir, sessionDays = 30, now = () => Date.now() } = {}) {
    this.file = dataDir ? path.join(dataDir, 'accounts.json') : null;
    this.sessionMs = sessionDays * 86_400_000;
    this.now = now;
    this.users = {};    // key (lowercase name) -> { name, salt, hash, created }
    this.sessions = {}; // sha256(token) -> { user: key, exp }
    if (this.file) {
      mkdirSync(dataDir, { recursive: true });
      try {
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        this.users = data.users ?? {};
        this.sessions = data.sessions ?? {};
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }

  async register(name, password) {
    const display = cleanName(name);
    checkPassword(password);
    const key = keyOf(display);
    if (this.users[key]) throw new RoomError('name_taken', 'Tên đăng nhập đã có người dùng');
    const salt = randomBytes(16).toString('hex');
    const hash = (await hashPassword(password, salt)).toString('hex');
    if (this.users[key]) throw new RoomError('name_taken', 'Tên đăng nhập đã có người dùng'); // raced another register
    this.users[key] = { name: display, salt, hash, created: this.now() };
    return this.#newSession(key);
  }

  async login(name, password) {
    const key = typeof name === 'string' ? keyOf(name.trim().replace(/\s+/g, ' ')) : '';
    const u = this.users[key];
    // Hash even for an unknown name so the answer takes as long either way.
    const salt = u?.salt ?? '00000000000000000000000000000000';
    const got = await hashPassword(typeof password === 'string' ? password.slice(0, PASS_MAX) : '', salt);
    if (!u || !timingSafeEqual(got, Buffer.from(u.hash, 'hex'))) {
      throw new RoomError('bad_login', 'Sai tên đăng nhập hoặc mật khẩu');
    }
    return this.#newSession(key);
  }

  // The display name for a session token, or null when it is unknown or expired.
  verify(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const id = sha256(token);
    const s = this.sessions[id];
    if (!s) return null;
    if (s.exp < this.now() || !this.users[s.user]) {
      delete this.sessions[id];
      this.#write();
      return null;
    }
    return this.users[s.user].name;
  }

  logout(token) {
    if (typeof token !== 'string') return;
    const id = sha256(token);
    if (this.sessions[id]) {
      delete this.sessions[id];
      this.#write();
    }
  }

  stats() {
    return { accounts: Object.keys(this.users).length };
  }

  #newSession(key) {
    const t = this.now();
    // Expired sessions go; a user keeps at most MAX_SESSIONS_PER_USER (oldest dropped).
    const mine = [];
    for (const [id, s] of Object.entries(this.sessions)) {
      if (s.exp < t) delete this.sessions[id];
      else if (s.user === key) mine.push([id, s.exp]);
    }
    mine.sort((a, b) => a[1] - b[1]);
    while (mine.length >= MAX_SESSIONS_PER_USER) delete this.sessions[mine.shift()[0]];
    const token = randomBytes(32).toString('hex');
    this.sessions[sha256(token)] = { user: key, exp: t + this.sessionMs };
    this.#write();
    return { name: this.users[key].name, session: token };
  }

  // Whole file each time, written next to it and renamed over it, so a crash never leaves half a file.
  #write() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ users: this.users, sessions: this.sessions }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

// Failed-login budget per client address: `max` failures per `windowMs`, then refused until the window ends.
export class LoginLimiter {
  constructor({ max = 10, windowMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map(); // address -> { n, until }
  }

  check(addr) {
    const h = this.hits.get(addr);
    if (h && h.until > this.now() && h.n >= this.max) {
      throw new RoomError('too_many_logins', 'Thử sai quá nhiều lần, đợi vài phút rồi thử lại');
    }
  }

  failed(addr) {
    const t = this.now();
    let h = this.hits.get(addr);
    if (!h || h.until <= t) this.hits.set(addr, (h = { n: 0, until: t + this.windowMs }));
    h.n++;
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.until <= t) this.hits.delete(k);
    }
  }
}

function cleanName(name) {
  const n = typeof name === 'string' ? name.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  if (!NAME_RE.test(n)) {
    throw new RoomError('bad_name', 'Tên đăng nhập 3–20 ký tự: chữ, số, dấu cách, _ . -');
  }
  return n;
}

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < PASS_MIN || p.length > PASS_MAX) {
    throw new RoomError('bad_password', `Mật khẩu ${PASS_MIN}–${PASS_MAX} ký tự`);
  }
}

const keyOf = (name) => name.normalize('NFC').toLowerCase();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) =>
      err ? reject(err) : resolve(key));
  });
}
