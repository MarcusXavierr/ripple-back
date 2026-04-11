# Backend PRD — P2P Video Call Signaling Server

**Date:** 2026-04-11
**Scope:** Backend signaling server only (V1). Frontend is tracked separately.
**Source:** Derived from the full-stack architecture doc, constrained to backend.

---

## 1. Overview

A Bun + Elysia WebSocket signaling server for a 2-peer WebRTC video call. The server does **not** route media — it only manages room membership and relays WebRTC signaling messages (offer, answer, ICE candidates) between the two peers in a room.

```
[Peer A] ──── WebSocket ────► [Signaling Server]
[Peer B] ──── WebSocket ────► [Signaling Server]

[Peer A] ◄──────────────────────────────────────► [Peer B]
              WebRTC P2P (handled by frontend)
```

### Responsibilities

- Manage rooms (max 2 peers per room)
- Authenticate reconnection via `peerId`
- Blind-relay WebRTC messages between peers
- Heartbeat to detect ghost peers
- Emit semantic close codes
- Garbage-collect abandoned rooms

---

## 2. Current state vs. target (delta)

The project already has a minimal Elysia WebSocket server. This PRD is a migration from the current shape to the target contract.

### Already implemented ✓

- Elysia + Bun + TLS bootstrap (`src/index.ts`)
- WebSocket route with query params (`src/app.ts`)
- In-memory room `Map` (`src/rooms.ts`)
- Room capacity check — max 2 (`src/ws-handlers.ts`)
- Duplicate id rejection (buggy — returns 200 text body)
- Role assignment via `order: 1/2`
- Blind message relay
- `enter` / `onclose` publish
- Test scaffolding — `test/http.test.ts`, `test/rooms.test.ts`, `test/ws.test.ts`

### Needs to change 🔧

1. Route path `/` → `/ws`
2. Query param rename `userId` → `peerId`, `roomId` → `room`
3. Rooms data shape: `Map<string, string[]>` → `Map<roomId, Room>` with `peers: Map<peerId, PeerEntry>`, `caller`, `createdAt`
4. Rejection mechanism: HTTP `Response` → WebSocket close codes (4001, etc.)
5. `onopen` payload: `{ order: 1|2 }` → `{ role: 'caller'|'callee', reconnect: boolean }`
6. Duplicate-id bug fix: currently returns 200 text body; target is reconnection (see §4)
7. `beforeHandle` currently has side effects (adds user); target is query-shape validation only — all state mutation moves into `open`
8. `close` currently removes the peer from the room; target is soft-evict (keep entry, set `ws=null`, `disconnectedAt=now`)

### Missing entirely ➕

- `src/types.ts` with `CLOSE_CODES` and SYNC'd protocol types
- `src/heartbeat.ts` with ping/pong cycle (60s)
- `src/gc.ts` with room garbage collection
- `pong` interception in `message()` (consume, don't relay)
- Reconnection branch in `open()`
- `peer-reconnected` event
- Heartbeat and GC tests

---

## 3. Target file layout

```
src/
├── index.ts          (unchanged — bootstrap + TLS, plus start heartbeat/GC)
├── app.ts            (change route path / → /ws, rename query params)
├── ws-handlers.ts    (major rewrite)
├── rooms.ts          (rewrite — new data shape)
├── heartbeat.ts      (NEW)
├── gc.ts             (NEW)
└── types.ts          (NEW — SYNC contract with frontend)
test/
├── rooms.test.ts     (rewrite against new shape)
├── ws.test.ts        (rewrite against new shape)
├── heartbeat.test.ts (NEW)
├── gc.test.ts        (NEW)
└── http.test.ts      (audit, keep if relevant, otherwise drop)
```

---

## 4. Data model

```typescript
// src/rooms.ts
import type { ElysiaWS } from 'elysia/ws'

export type PeerEntry = {
  ws: ElysiaWS | null            // null while disconnected, set on connect/reconnect
  role: 'caller' | 'callee'
  disconnectedAt: number | null  // set on close, cleared on reconnect
  waitingPong: boolean
}

export type Room = {
  peers: Map<string, PeerEntry>  // peerId → entry
  caller: string | null          // immutable once set; survives caller disconnects
  createdAt: number
}

export const rooms = new Map<string, Room>()
```

### Notes
- `caller` is `string | null`. Once a peer is assigned `caller`, it remains set until the room itself is GC'd, so a returning caller within the reconnection window keeps their role.
- `PeerEntry.ws` is nullable to express the "soft-disconnected" state — the slot is reserved but no live socket is attached.

---

## 5. Connection lifecycle

### Query contract

```
wss://<host>/ws?room=<roomId>&peerId=<uuid>
```

### `beforeHandle(ctx)`

Validates query shape only. Returns an HTTP `Response` (400) on malformed input (missing/empty `room` or `peerId`). **No room mutation.**

### `open(ws)`

```
1. room = rooms.get(roomId) ?? createRoom(roomId)
2. existing = room.peers.get(peerId)

3. if existing:                                      // RECONNECTION
     - if existing.ws is still open → existing.ws.close(1000)   // boot the old tab
     - existing.ws = ws
     - existing.disconnectedAt = null
     - existing.waitingPong = false
     - ws.subscribe(room)
     - ws.send({ type: 'onopen', role: existing.role, reconnect: true })
     - ws.publish(room, { type: 'peer-reconnected' })
     - return

4. // NEW PEER path
   if room.peers.size >= 2:
     ws.close(CLOSE_CODES.ROOM_FULL)   // 4001
     return

5. role = room.caller === null ? 'caller' : 'callee'
   if role === 'caller': room.caller = peerId
   room.peers.set(peerId, { ws, role, disconnectedAt: null, waitingPong: false })
   ws.subscribe(room)
   ws.send({ type: 'onopen', role, reconnect: false })
   ws.publish(room, { type: 'enter' })
```

**Reconnection policy (decided):** Any new connection from an existing `peerId` is treated as reconnection. The old ws (if still open) is closed with code 1000 and the entry swaps to the new ws. This handles flaky-network F5 cleanly without waiting for liveness probes.

### `message(ws, raw)`

Parse just enough to detect `pong`:

- Attempt `JSON.parse(raw)`. If it succeeds and `msg.type === 'pong'` → mark `entry.waitingPong = false`, **do not relay**.
- Anything else (including malformed JSON) → `ws.publish(room, raw)` blind. Server does not validate WebRTC message structure.

### `close(ws)` — soft-evict

- Look up `entry` for `(room, peerId)`.
- Set `entry.ws = null`, `entry.disconnectedAt = Date.now()`.
- `ws.publish(room, { type: 'onclose', message: 'peer disconnected' })`.
- **Do not** `rooms.delete(roomId)` and **do not** remove the peer entry. GC owns eviction.

---

## 6. Heartbeat

`src/heartbeat.ts` — a single global `setInterval` started from `index.ts` on boot.

```typescript
const HEARTBEAT_MS = 60_000  // module constant; tests inject a faster value

// every tick, for each connected peer entry:
if (entry.ws === null) continue                    // already disconnected
if (entry.waitingPong === true) {
  entry.ws.close(CLOSE_CODES.PING_TIMEOUT)         // 4005 — triggers close handler → soft-evict
  continue
}
entry.waitingPong = true
entry.ws.send(JSON.stringify({ type: 'ping' }))
```

### Rationale for 60s cadence

Heartbeat only detects **ghost sockets** — sockets whose peer crashed without sending a clean close. A clean tab-close already notifies instantly via `ws.close`. Faster cadence:
- **Does not** make users lose their room faster (that's the GC window's job, §7).
- **Does** make transient 20s wifi hiccups trigger spurious `PING_TIMEOUT`/`peer-reconnected` flashes on the survivor.

60s gives worst-case ghost detection of ~120s (ping sent at t=0, second check at t=60, close at t=120), which is fine for a 2-peer call — the survivor's WebRTC stack will independently notice missing RTP/ICE traffic in that same window.

A `PING_TIMEOUT` close is a normal soft-evict — the peer can still reconnect within the GC window.

---

## 7. Garbage collection

`src/gc.ts` — a second global `setInterval` started from `index.ts` on boot.

```typescript
const GC_SWEEP_MS = 30 * 60 * 1000   // 30 min
const GC_IDLE_MS  = 60 * 60 * 1000   // 1 h

// every sweep, for each room:
if (room.peers.size === 0) { rooms.delete(roomId); continue }   // safety net

const allDisconnected = [...room.peers.values()].every(p => p.disconnectedAt !== null)
if (!allDisconnected) continue

const newest = Math.max(...[...room.peers.values()].map(p => p.disconnectedAt!))
if (Date.now() - newest > GC_IDLE_MS) rooms.delete(roomId)
```

### Accepted limitation

After a peer disconnects without reconnecting, their slot is reserved until GC evicts the room (up to 1h). **A third party cannot take over a vacated slot mid-call.** Workaround: the remaining peer creates a fresh room. This is a direct consequence of keeping peer entries alive across disconnects to support reconnection, and is an accepted tradeoff for V1.

---

## 8. Lifecycle integration

Both intervals are started from `src/index.ts` after `app.listen`, and both return handles so tests can stop/restart a clean environment.

```typescript
// heartbeat.ts
export function startHeartbeat(ms = HEARTBEAT_MS): NodeJS.Timeout { ... }
export function stopHeartbeat(h: NodeJS.Timeout): void { clearInterval(h) }

// gc.ts
export function startGC(sweepMs = GC_SWEEP_MS, idleMs = GC_IDLE_MS): NodeJS.Timeout { ... }
export function stopGC(h: NodeJS.Timeout): void { clearInterval(h) }
```

Module constants (`HEARTBEAT_MS`, `GC_SWEEP_MS`, `GC_IDLE_MS`) are injectable for tests only, not runtime config.

---

## 9. Protocol types (SYNC contract)

`src/types.ts` must stay **byte-identical** to the frontend's `src/types/signaling.ts`. Top of file:

```typescript
// SYNC: keep identical to videocall-frontend/src/types/signaling.ts
```

### Close codes

```typescript
export const CLOSE_CODES = {
  ROOM_FULL:         4001,
  PEER_DISCONNECTED: 4002,  // reserved; not emitted by V1 server
  ROOM_NOT_FOUND:    4003,  // reserved; V1 auto-creates rooms on open
  DUPLICATE_SESSION: 4004,  // reserved; V1 treats as reconnection
  PING_TIMEOUT:      4005,
} as const
```

Reserved codes are kept in the constant so the frontend can still *handle* them, and so the numbering is pinned for future use.

### Messages

```typescript
// Server → Client
export type ServerMessage =
  | { type: 'onopen'; role: 'caller' | 'callee'; reconnect: boolean }
  | { type: 'enter' }
  | { type: 'onclose'; message: string }
  | { type: 'peer-reconnected' }
  | { type: 'ping' }

// Client → Server
export type ClientMessage =
  | { type: 'offer'; offer: RTCSessionDescriptionInit }
  | { type: 'answer'; answer: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'pong' }
  | { type: 'error'; code: 'ICE_FAILED' | 'MEDIA_DENIED' }
```

### Server handling rules

1. `pong` → consumed, not relayed.
2. Everything else → `ws.publish(room, raw)` blind.
3. Server never `JSON.parse`s the relayed payload's inner structure — parse cost on hot path, zero value.

### tsconfig adjustment

Backend `tsconfig.json` needs `"lib": ["ESNext", "DOM"]` so `types.ts` can reference `RTCSessionDescriptionInit` / `RTCIceCandidateInit` directly. The server never instantiates these, only types the relay payload.

---

## 10. Test strategy

**Approach:** Rewrite the entire test suite upfront against the target contract (will go red), then make each test pass as implementation lands. TDD at the suite level.

### `test/rooms.test.ts`
- `createRoom` initializes empty `peers`, null `caller`, non-zero `createdAt`
- find-or-create idempotency
- Room membership accounting

### `test/ws.test.ts`
- **New peer**: first → caller, second → callee, third → close(4001)
- **onopen payload**: `{ type:'onopen', role, reconnect:false }` shape
- **enter publish**: fires on new peer join
- **Reconnection**: same `peerId` rejoining → old ws closed, entry swaps, `reconnect:true`, `peer-reconnected` published
- **Reconnect preserves role**: caller comes back as caller
- **Disconnect soft-evict**: `close` sets `ws=null` + `disconnectedAt`, keeps entry, publishes `onclose`
- **Relay**: arbitrary message published verbatim
- **Pong interception**: `pong` clears `waitingPong`, is NOT published

### `test/heartbeat.test.ts` (NEW)
- First tick → `ping` sent, `waitingPong=true`
- Pong received between ticks → next tick sends another ping, no close
- No pong between ticks → next tick calls `ws.close(4005)`

### `test/gc.test.ts` (NEW)
- Room all-disconnected < 1h → not deleted
- Room all-disconnected > 1h → deleted
- Room with one live peer → not deleted
- Empty room (`peers.size === 0`) → deleted

### `test/http.test.ts`
Audit existing content. Keep if it still tests something valuable (e.g. the `GET /` health route), otherwise drop.

**Integration tests:** out of scope for V1. Unit-level mocks are sufficient.

**Fake timers:** tests use `bun:test`'s time control. No real 15s/60s waits.

---

## 11. Implementation milestones

Each milestone is one commit, one review checkpoint.

1. **Scaffolding**: create `src/types.ts`, update `tsconfig.json` with DOM lib, update `src/app.ts` route path and query params. No behavior changes yet.
2. **Red suite**: rewrite all test files against the target contract. Everything fails.
3. **Rooms rewrite**: new `Room` / `PeerEntry` shape + helpers (`createRoom`, `findOrCreate`, etc.). No handlers yet. → `test/rooms.test.ts` green.
4. **ws-handlers — new peer path**: `open` (new peer only, with 4001), `message` (blind relay, no pong), `close` (soft-evict). → new-peer cases in `ws.test.ts` green.
5. **ws-handlers — reconnection path**: same-peerId branch in `open`, old ws close, `peer-reconnected` publish. → remaining `ws.test.ts` cases green.
6. **Heartbeat**: `heartbeat.ts` module, pong interception in `message`. → `heartbeat.test.ts` green.
7. **GC**: `gc.ts` module. → `gc.test.ts` green.
8. **Wire up**: start heartbeat + GC in `index.ts`. Smoke test the binary end-to-end with a real ws client (e.g. `websocat`).

Milestones 4 and 5 are deliberately split so the reconnection logic lands isolated from the new-peer logic — easier to review and revert.

---

## 12. Out of scope (V2+)

- TURN server / NAT traversal beyond STUN (mobile CGNAT)
- Chat / data channel support
- Redis Pub/Sub horizontal scaling
- >2 peers per room / SFU
- Connection quality telemetry
- Any persistence (database, history, logs)
- Wails desktop bridge

These are tracked in the full architecture doc's roadmap and are explicitly excluded from V1.
