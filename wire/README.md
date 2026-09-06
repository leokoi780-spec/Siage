# Wire — fast, private chat & file transfer

A small, self-hosted chat app. Create a room, share the 5-character code,
and talk — text or files — in real time. There's no database and nothing
is written to disk: messages and files are relayed directly between the
people in a room and exist only in server memory for the moment they're
sent. When the last person leaves a room, that room (and everything said
in it) is deleted.

**Zero dependencies.** This runs on nothing but Node.js itself — no
`npm install` required, no third-party packages to trust or keep patched.
The WebSocket protocol is implemented directly on top of Node's built-in
`http` module (see `lib/ws-server.js`).

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. That's the only
requirement.

```bash
node server.js
```

Then open **http://localhost:3000**. Open it again in a second tab (or on
another device on the same network, using your computer's local IP
instead of `localhost`) to test chatting between two people.

## Tested

`test.js` boots the real server and drives it with real WebSocket
connections (no mocks) to check the things that actually matter:

- static files (`/`, `.css`, `.js`) serve with correct content types, and
  unknown/`..`-traversal paths are rejected — including raw, unnormalized
  requests sent the way `curl --path-as-is` would, which a browser or a
  plain HTTP client library would otherwise silently sanitize for you
- creating a room, joining with a valid code, and joining with a bad code
- two people in a room see each other join and leave, with a live roster
- chat messages and typing indicators relay to others but never echo back
  to the sender
- a file sent in chunks reassembles **byte-for-byte** on the other end,
  for both a small (40KB) and larger (200KB) multi-chunk file
- **two separate rooms never leak messages into each other**
- a full room (12 people) rejects a 13th joiner
- malformed JSON and oversized frames are dropped without crashing the
  server or the connection
- a connection's `close` event fires exactly once even if the underlying
  socket reports both an error and a close for the same disconnect
- the `/healthz` endpoint responds for uptime checks, every response
  carries the baseline security headers, and a file over the 300MB cap is
  rejected with a reason instead of being relayed to the room

Run it yourself any time with:

```bash
node test.js
```

Last run: **23/23 passing.**

## What changed in the latest pass

This pass focused on turning a working prototype into something you'd
feel comfortable putting a real link in front of real people:

- **Auto-reconnect.** A dropped connection no longer means "reload the
  page." The client retries with backoff, shows a status dot and banner
  while it does, and silently rejoins the same room under the same name
  once the socket is back — with a heads-up in the chat once it succeeds.
- **Per-person color coding.** Names in the message list, the file
  cards, and the member roster get a consistent color per person, so a
  room with several people in it stays easy to scan.
- **Message timestamps.** Every message carries its send time (visible
  on hover) without cluttering the layout.
- **A sane file-size ceiling.** Files over 300MB are rejected up front
  (client-side, before wasting a transfer) and again on the server (in
  case a different client skips that check), with a clear reason shown
  on the file card instead of a silent failure.
- **Deploy-ready hardening in `server.js`:** a `/healthz` endpoint for
  platform health checks, baseline security headers (CSP,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`) on every response, and a graceful shutdown
  handler for `SIGTERM`/`SIGINT` so deploy platforms and `docker stop`
  don't cut connections mid-write.
- **Small accessibility and polish passes:** visible keyboard focus
  states, `aria-label`s on icon-only buttons, `prefers-reduced-motion`
  support, a proper favicon, and Open Graph/description meta tags.

## Bugs found and fixed in an earlier audit

A pass over this code turned up two real issues that the original test
suite didn't catch:

1. **Path-traversal check used a bare string prefix.** The original guard
   was `filePath.startsWith(PUBLIC_DIR)`, which a directory like
   `public-backup` sitting next to `public/` would have satisfied even
   though it's a different folder. Worse, the original test for this used
   Node's `http.get`, which silently normalizes `..` out of URLs before
   sending — so the test passed without ever exercising the vulnerable
   code path. Fixed by requiring an exact match or a path separator after
   the prefix, and rewrote the test to send a raw, unnormalized request
   over a TCP socket (the way `curl --path-as-is` does) so it actually
   proves the fix works.
2. **A connection's `close` event could fire twice.** The internal guard
   compared ping/pong liveness state instead of just checking "have I
   already closed", so a socket that emitted both `error` and `close` for
   the same disconnect (which real sockets do) could double-fire cleanup
   logic. Fixed to a simple idempotent guard, verified with a unit test
   using a fake socket that fires both events.

## How it works

- **Rooms**: the server hands out a random 5-character code when you
  click "Create room." Anyone with the code can join, up to 12 people. A
  room is deleted the instant it's empty.
- **Chat**: messages relay live over a WebSocket — nothing is queued or
  logged server-side.
- **Files**: a file is sliced into 16KB chunks in the browser and streamed
  chunk-by-chunk to everyone else in the room, who reassemble it and get a
  Download link the moment the last chunk arrives. The server only ever
  holds one chunk at a time in transit — it never buffers or saves the
  full file. Files over 300MB are rejected rather than accepted and
  dropped partway through.
- **Dead connections**: the server pings each connection every 30 seconds
  and drops anyone who doesn't answer, so a closed laptop lid or lost wifi
  doesn't leave a phantom member sitting in the room. The browser client
  detects the drop and automatically tries to reconnect and rejoin.

## About "private"

This app is *private* in the sense that matters most day to day: no
accounts, no message history, no file storage, no analytics — the moment
people leave, the conversation is gone from the server. It is **not**
end-to-end encrypted the way something like Signal is — the server
process technically sees the plaintext of what passes through it (that's
what lets it relay to the right people). For real day-to-day use:

- **Always deploy behind HTTPS/WSS** (see below) so traffic between
  browsers and your server is encrypted in transit.
- Only share room codes with people you trust, over a channel you trust —
  the code is the only thing standing between a stranger and the room.
- If you need true end-to-end encryption (where even the server operator
  can't read messages), that requires generating keys in each browser and
  encrypting before sending — not included here, but it can be layered on
  top of this same relay.

## Deploying it

To let people elsewhere use it, deploy `server.js` to any Node host:

- **Render / Railway / Fly.io** — connect this folder as a repo, set the
  start command to `node server.js`, and they'll give you an `https://`
  URL (with WSS automatically) for free on the smallest tier. Point the
  platform's health check at `/healthz`.
- **A VPS** (DigitalOcean, Linode, etc.) — install Node, copy this folder
  over, run `node server.js` behind Nginx or Caddy with a free Let's
  Encrypt certificate for HTTPS, and keep it alive with `pm2` or a
  systemd service.

No code changes are needed — the app reads the port from
`process.env.PORT`, which every host above sets automatically, and the
client automatically switches to `wss://` when the page is loaded over
HTTPS.

If you're putting this in front of the general public rather than a
private group, consider adding a reverse-proxy-level rate limit (Nginx,
Caddy, or your host's built-in option) on room creation — this app
intentionally keeps the server itself dependency-free and doesn't ship
its own rate limiter.

## Project structure

```
server.js           HTTP server + room/relay logic (no dependencies)
lib/ws-server.js     Minimal hand-rolled WebSocket server (RFC 6455)
public/index.html    App shell (landing screen + chat room)
public/style.css     Styling
public/app.js        Client logic: joining rooms, chat, reconnect, chunked file transfer
public/favicon.svg   Browser tab icon
test.js              End-to-end test suite (run with `node test.js`)
package.json         Project metadata — no runtime dependencies
```

## Customizing

- **Bigger rooms / different limits**: change `MAX_ROOM_SIZE` in
  `server.js`.
- **File size cap**: change `MAX_FILE_SIZE` in **both** `server.js` and
  `public/app.js` — they're checked in two places on purpose (client for
  a fast, friendly rejection; server as the source of truth).
- **File chunk size**: change `CHUNK_SIZE` in `public/app.js` — smaller
  chunks mean smoother progress bars but more messages sent.
- **Look and feel**: colors and type are defined as CSS variables at the
  top of `public/style.css`.

## A note on the hand-rolled WebSocket server

`lib/ws-server.js` implements just enough of RFC 6455 for this app: the
opening handshake, text-frame messages (including fragmented ones),
close, and ping/pong. It doesn't implement WebSocket extensions like
permessage-deflate. It's covered by the test suite above, but if you're
adapting this code for a much higher-traffic production system, swapping
in the battle-tested `ws` npm package is a reasonable next step — the
JSON message protocol in `server.js` would stay the same either way.
