# Catan server

Node server for online play. One port serves:

- `GET /` — the Unity WebGL build (`public/`)
- `GET /healthz` — `{ ok, rooms, players }`
- `WS /ws` — rooms + message relay

The server knows nothing about Catan rules. One player is the **host** (at first the room creator): their game
client runs the rules and sends state to the others. Guests send their actions to the host. The host also keeps a
full save of the game on the server, so when the host goes offline the next online player becomes host with it and
the game goes on.

## Run

```sh
npm install
npm test
npm start                 # http://localhost:8080
```

Environment: `PORT` (8080), `PUBLIC_DIR` (`./public`), `DATA_DIR` (`./data`, accounts), `TRUST_PROXY` (`1` behind a reverse proxy), `RECONNECT_GRACE_MS` (60000, lobby seats),
`ROOM_IDLE_MS` (600000, a started room with nobody online), `MAX_ROOMS` (1000).

## Docker image

```sh
npm run sync-web          # copy ../Builds/Web (Unity: Catan > Build Web) into public/
docker build -t catan-server .
docker run -d --name catan --restart unless-stopped -p 8080:8080 -v catan-data:/data catan-server
```

Accounts are kept in `/data/accounts.json`: keep the `-v catan-data:/data` volume, or every rebuild forgets them.

If it sits behind a reverse proxy (nginx, Caddy, a cloud load balancer), the proxy must pass WebSocket
upgrades on `/ws`. Pages served over https need `wss://`.

## Accounts

Online play needs an account (name + password); the name at the table is the account name.

- Passwords: scrypt with a salt per user. Sessions: a random 256-bit token; the file stores only its SHA-256.
  Sessions last 30 days, at most 10 per account, and end on logout.
- Failed logins: 10 per client address per 10 minutes, then refused. Behind a reverse proxy set `TRUST_PROXY=1`,
  otherwise every player looks like the proxy's address (and only then: the header is easy to fake).
- A seat in a room belongs to the account that took it: someone else holding the seat token cannot take it.
- Use https (`wss://`) on the internet: over plain http the password crosses the network readable.

Keeping Node itself patched is separate from logins: rebuild now and then with `docker build --pull` (newer
`node:22-alpine`) and check `npm audit`. The image runs as the `node` user, not root.

## Game side (Unity)

- `Assets/Scripts/Net/NetSocket.cs` — WebSocket: browser via `Assets/Plugins/WebGL/CatanSocket.jslib`, `ClientWebSocket` elsewhere.
- `Assets/Scripts/Net/NetClient.cs` — create / join / rejoin, relay.
- `Assets/Scripts/CatanNet.cs` — every player action is a `Cmd` sent to the host, which checks it against the rules
  for that seat; the host sends each guest a `Snap` of the table with other players' cards hidden.
- Anyone offline (the old host too) is played by a bot on the host after 10 s, and gets the seat back on rejoin.
  "Rời phòng" in a started game keeps the seat; "Chơi online > Vào lại" brings the player back, even after an
  app restart.
- Log lines about a steal name the card only for the thief and the victim.
- Checks: `-executeMethod CatanNetTest.Run` (host + 2 guests in memory, whole games, half of them with a host change),
  `-executeMethod CatanNetTest.Live` (two clients through a running server on `ws://localhost:8080/ws`).

The web build connects to the server it was loaded from. The Android app asks for the server address in
"Chơi online" (e.g. `ws://192.168.1.10:8080/ws` on a LAN, `wss://your-domain/ws` behind https).

## Protocol (JSON text frames on `/ws`)

Client → server

| message | who | meaning |
|---|---|---|
| `{t:"register", name, password}` | anyone | new account → `authed` |
| `{t:"login", name, password}` | anyone | → `{t:"authed", name, session}` |
| `{t:"logout", session}` | anyone | end that session → `loggedout` |
| `{t:"create", session}` | logged in | open a room, become host (seat 0) |
| `{t:"join", room, session}` | logged in | take the first free seat (1–3); refused once the game started |
| `{t:"rejoin", room, token, session}` | same account | take your seat back (after a drop, or after leaving a started game) |
| `{t:"start"}` | host | lock the room (no new joins) |
| `{t:"save", data}` | host | the full game, handed to the next host |
| `{t:"kick", seat}` | host | free a seat (before the start) |
| `{t:"send", to?, data}` | all | relay `data`. Host: `to` = seat, or omit for everyone else. Guests: always goes to the host |
| `{t:"leave"}` | all | leave: before the start the seat is freed; in a started game it stays yours (offline) |
| `{t:"ping"}` | all | answered with `{t:"pong"}` |

Server → client

| message | meaning |
|---|---|
| `{t:"welcome", room, seat, host, hostSeat, token, started}` | you are seated; keep `token` for `rejoin` |
| `{t:"room", room, started, hostSeat, players:[{seat, name, online}]}` | seats or host changed |
| `{t:"promote", data}` | you are now the host; `data` is the last save (null before the start) |
| `{t:"msg", from, data}` | relayed message from seat `from` |
| `{t:"closed", reason}` | `kicked`, `replaced` (same seat opened on another socket), `idle` |
| `{t:"error", code, message}` | `no_room`, `room_full`, `room_started`, `bad_token`, `not_host`, `rate_limited`, … |

Drops: before the start, a seat is kept for `RECONNECT_GRACE_MS` after its socket dies. In a started game seats
are never given away: they show `online:false` and the host lets a bot play them. Whenever the host is offline,
the lowest online seat is promoted. A started room closes after `ROOM_IDLE_MS` with nobody online. Messages are
capped at 256 KB and 100 per second per socket.
