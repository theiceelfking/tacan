import { randomBytes, randomInt } from 'node:crypto';

// Rooms for host + relay play. One seated player is the host: their Unity client runs the rules and pushes state
// to everyone else. The server seats people, passes messages along, and keeps the game alive when people drop:
//
//  - The host keeps the server's copy of the full game up to date ("save"). When the host goes offline, the lowest
//    online seat becomes host and receives that copy ("promote"), so play carries on; the game's new host lets a
//    bot play the seats that are offline.
//  - Once a game has started, seats are never given away: whoever leaves or drops can come back with their token
//    (rejoin), as a guest. The room closes only after nobody at all has been online for idleMs.
//  - Before the start, a seat whose player left (or stayed away for graceMs) is freed for someone else.
//
// Relay rule: guests can only talk to the host; the host can talk to one seat or to everybody. A guest
// therefore can never forge "state" for another guest.

export const MAX_SEATS = 4;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const CODE_LENGTH = 5;
const NAME_MAX = 20;

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Lobby {
  constructor({ graceMs = 60_000, idleMs = 10 * 60_000, maxRooms = 1000, log = () => {} } = {}) {
    this.graceMs = graceMs;
    this.idleMs = idleMs;
    this.maxRooms = maxRooms;
    this.log = log;
    this.rooms = new Map(); // code -> room
  }

  // ------------------------------------------------------------------ entry points (one per client message)

  create(conn, name) {
    if (conn.room) throw new RoomError('already_in_room', 'Đã ở trong một phòng');
    if (this.rooms.size >= this.maxRooms) throw new RoomError('server_full', 'Máy chủ đã đầy, thử lại sau');
    const room = {
      code: this.#newCode(), seats: new Array(MAX_SEATS).fill(null), started: false, host: 0, save: null, idleTimer: null,
    };
    this.rooms.set(room.code, room);
    this.#seat(room, 0, conn, name);
    this.log(`room ${room.code} created`);
    return room;
  }

  join(conn, code, name) {
    if (conn.room) throw new RoomError('already_in_room', 'Đã ở trong một phòng');
    const room = this.#find(code);
    if (room.started) throw new RoomError('room_started', 'Ván đã bắt đầu');
    const seat = room.seats.indexOf(null);
    if (seat < 0) throw new RoomError('room_full', 'Phòng đã đủ người');
    this.#seat(room, seat, conn, name);
    return room;
  }

  // Take a seat back after a drop or a leave, using the token handed out in "welcome".
  rejoin(conn, code, token) {
    if (conn.room) throw new RoomError('already_in_room', 'Đã ở trong một phòng');
    const room = this.#find(code);
    const seat = typeof token === 'string' ? room.seats.findIndex((s) => s && s.token === token) : -1;
    // the seat token only works for the account that sat there
    if (seat < 0 || (room.seats[seat].user && room.seats[seat].user !== conn.user)) {
      throw new RoomError('bad_token', 'Không thể vào lại chỗ cũ');
    }
    const s = room.seats[seat];
    if (s.conn) this.#detach(s.conn, 'replaced'); // the same player on a fresh socket wins
    clearTimeout(s.graceTimer);
    s.graceTimer = null;
    s.conn = conn;
    conn.room = room;
    conn.seat = seat;
    this.#online(room);
    this.#welcome(room, seat);
    this.#ensureHost(room);
    this.#broadcastRoom(room);
    return room;
  }

  start(conn) {
    const room = this.#hostRoom(conn);
    room.started = true;
    this.#broadcastRoom(room);
  }

  // Host only: the full game, handed to the next host if this one goes away.
  save(conn, data) {
    const room = this.#hostRoom(conn);
    if (typeof data !== 'string') throw new RoomError('bad_message', 'Dữ liệu lưu không hợp lệ');
    room.save = data;
  }

  // Host only, before the game: free a seat so someone else can take it.
  kick(conn, seat) {
    const room = this.#hostRoom(conn);
    if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_SEATS || seat === room.host || !room.seats[seat]) {
      throw new RoomError('bad_seat', 'Chỗ ngồi không hợp lệ');
    }
    if (room.started) throw new RoomError('room_started', 'Ván đã bắt đầu');
    const s = room.seats[seat];
    if (s.conn) {
      send(s.conn, { t: 'closed', reason: 'kicked' });
      this.#detach(s.conn);
    }
    this.#free(room, seat);
  }

  relay(conn, to, data) {
    const room = conn.room;
    if (!room) throw new RoomError('not_in_room', 'Chưa vào phòng');
    const from = conn.seat;
    const msg = { t: 'msg', from, data };
    if (from !== room.host) {
      // guests only ever speak to the host
      const host = room.seats[room.host];
      if (host?.conn) send(host.conn, msg);
      return;
    }
    if (to === undefined || to === null) {
      room.seats.forEach((s, i) => { if (i !== from && s?.conn) send(s.conn, msg); });
    } else {
      if (!Number.isInteger(to) || to < 0 || to >= MAX_SEATS || to === from) throw new RoomError('bad_seat', 'Chỗ ngồi không hợp lệ');
      if (room.seats[to]?.conn) send(room.seats[to].conn, msg);
    }
  }

  // Player chose to leave. Before the start the seat is freed; in a started game it stays theirs (offline).
  leave(conn) {
    const room = conn.room;
    if (!room) return;
    const seat = conn.seat;
    this.#detach(conn);
    if (room.started) this.#offline(room);
    else this.#free(room, seat);
  }

  // Socket died. Before the start the seat is held for graceMs; in a started game it stays theirs (offline).
  disconnected(conn) {
    const room = conn.room;
    if (!room) return;
    const seat = conn.seat;
    this.#detach(conn);
    const s = room.seats[seat];
    if (!room.started && s) {
      clearTimeout(s.graceTimer);
      s.graceTimer = setTimeout(() => {
        s.graceTimer = null;
        if (!s.conn && room.seats[seat] === s && !room.started) this.#free(room, seat);
      }, this.graceMs);
      s.graceTimer.unref?.();
    }
    this.#offline(room);
  }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) players += r.seats.filter((s) => s?.conn).length;
    return { rooms: this.rooms.size, players };
  }

  // ------------------------------------------------------------------ internals

  #seat(room, seat, conn, name) {
    room.seats[seat] = { name: cleanName(name, seat), user: conn.user ?? null, token: randomBytes(16).toString('hex'), conn, graceTimer: null };
    conn.room = room;
    conn.seat = seat;
    this.#online(room);
    this.#welcome(room, seat);
    this.#ensureHost(room);
    this.#broadcastRoom(room);
  }

  #welcome(room, seat) {
    const s = room.seats[seat];
    send(s.conn, {
      t: 'welcome', room: room.code, seat, host: seat === room.host, hostSeat: room.host, token: s.token, started: room.started,
    });
  }

  // Someone went offline: hand the host role on if needed, and close the room once it has stood empty for a while.
  #offline(room) {
    this.#ensureHost(room);
    this.#broadcastRoom(room);
    if (room.seats.some((s) => s?.conn)) return;
    if (!room.seats.some(Boolean)) return this.#close(room, 'empty');
    clearTimeout(room.idleTimer);
    room.idleTimer = setTimeout(() => {
      if (!room.seats.some((s) => s?.conn)) this.#close(room, 'idle');
    }, room.started ? this.idleMs : this.graceMs);
    room.idleTimer.unref?.();
  }

  #online(room) {
    clearTimeout(room.idleTimer);
    room.idleTimer = null;
  }

  // The host seat must be someone online whenever anyone is.
  #ensureHost(room) {
    if (room.seats[room.host]?.conn) return;
    const next = room.seats.findIndex((s) => s?.conn);
    if (next < 0) return;
    room.host = next;
    send(room.seats[next].conn, { t: 'promote', data: room.save });
    this.log(`room ${room.code}: seat ${next} is now host`);
  }

  #free(room, seat) {
    clearTimeout(room.seats[seat]?.graceTimer);
    room.seats[seat] = null;
    if (!room.seats.some(Boolean)) return this.#close(room, 'empty');
    this.#offline(room);
  }

  #close(room, reason) {
    if (!this.rooms.has(room.code)) return;
    this.rooms.delete(room.code);
    clearTimeout(room.idleTimer);
    for (const s of room.seats) {
      if (!s) continue;
      clearTimeout(s.graceTimer);
      if (s.conn) {
        send(s.conn, { t: 'closed', reason });
        this.#detach(s.conn);
      }
    }
    this.log(`room ${room.code} closed (${reason})`);
  }

  #detach(conn, reason) {
    const room = conn.room;
    if (room && room.seats[conn.seat]?.conn === conn) room.seats[conn.seat].conn = null;
    if (reason) send(conn, { t: 'closed', reason });
    conn.room = null;
    conn.seat = -1;
  }

  #broadcastRoom(room) {
    if (!this.rooms.has(room.code)) return;
    const players = room.seats.map((s, seat) => (s ? { seat, name: s.name, online: !!s.conn } : null)).filter(Boolean);
    const msg = { t: 'room', room: room.code, started: room.started, hostSeat: room.host, players };
    for (const s of room.seats) if (s?.conn) send(s.conn, msg);
  }

  #hostRoom(conn) {
    if (!conn.room) throw new RoomError('not_in_room', 'Chưa vào phòng');
    if (conn.seat !== conn.room.host) throw new RoomError('not_host', 'Chỉ chủ phòng mới làm được');
    return conn.room;
  }

  #find(code) {
    const room = typeof code === 'string' ? this.rooms.get(code.trim().toUpperCase()) : undefined;
    if (!room) throw new RoomError('no_room', 'Không tìm thấy phòng');
    return room;
  }

  #newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }
}

function cleanName(name, seat) {
  const n = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX) : '';
  return n || `Người ${seat + 1}`;
}

// conn is anything with a ws-like send(); closed sockets are skipped quietly.
export function send(conn, obj) {
  if (conn.readyState === undefined || conn.readyState === 1) conn.send(JSON.stringify(obj));
}
