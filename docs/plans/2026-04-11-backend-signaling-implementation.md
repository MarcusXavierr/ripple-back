# Backend Signaling Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the existing minimal Elysia WebSocket server to the V1 signaling server contract: peerId-based reconnection, soft-evict on close, heartbeat, room GC, and semantic close codes.

**Architecture:** Single Bun process, in-memory state, WebSocket pub/sub via Elysia. No database, no Redis, no media routing. All rationale lives in the PRD — this plan is the mechanical "how". Source of truth: `docs/plans/2026-04-11-backend-signaling-prd.md`.

**Tech Stack:** Bun + Elysia (WebSocket framework) + TypeScript. `bun:test` for tests.

---

## Prerequisites for the executing engineer

**Read first (in order):**
1. `docs/plans/2026-04-11-backend-signaling-prd.md` — the PRD. Every `why` question is answered there.
2. This plan — the `how`.

**Key mental model:** The existing codebase is minimal but wrong-shaped for V1. Rather than incremental refactor, the strategy is:
- Task 1: scaffold non-behavioral pieces (types, tsconfig, route path).
- Task 2: rewrite the entire test suite against the V1 contract. Everything goes **red**.
- Tasks 3–7: implement each module, turning tests **green** subset-by-subset.
- Task 8: wire lifecycle (start heartbeat/GC) and run a smoke test.

**Running tests:** `bun test` (whole suite) or `bun test test/<file>` (one file). Bun's test runner supports `--watch`; prefer single-file runs during implementation.

**Per-task commit discipline:** every task ends with one commit. Never combine tasks. Commit message format matches repo style: `<type>: <subject>` where type is `feat` / `fix` / `refactor` / `test` / `docs`.

**Never skip hooks.** No `--no-verify`.

---

## Task 1: Scaffolding (types.ts, tsconfig, route path)

No behavior changes. Introduces the SYNC types module, gives `tsconfig.json` the DOM lib it needs to reference browser RTC types, and moves the WebSocket endpoint to `/ws`.

**Files:**
- Modify: `tsconfig.json` (add `"lib"` entry)
- Create: `src/types.ts`
- Modify: `src/app.ts` (rename query params, move ws route to `/ws`)

**Step 1.1: Add DOM lib to `tsconfig.json`**

Open `tsconfig.json`. Find the commented line near line 15:

```jsonc
// "lib": [],
```

Replace with:

```jsonc
"lib": ["ESNext", "DOM"],
```

**Step 1.2: Create `src/types.ts`**

```typescript
// SYNC: keep identical to videocall-frontend/src/types/signaling.ts

export const CLOSE_CODES = {
  ROOM_FULL:         4001,
  PEER_DISCONNECTED: 4002,
  ROOM_NOT_FOUND:    4003,
  DUPLICATE_SESSION: 4004,
  PING_TIMEOUT:      4005,
} as const

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES]

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

export type Role = 'caller' | 'callee'
```

**Step 1.3: Update `src/app.ts`**

Replace the entire file with:

```typescript
import { Elysia, t } from 'elysia'
import { beforeHandle, open, close, message } from './ws-handlers'

export const app = new Elysia()
  .get('/', () => 'Hello Ma friend')
  .ws('/ws', {
    query: t.Object({ room: t.String(), peerId: t.String() }),
    beforeHandle,
    open,
    close,
    message,
  } as any)
```

Two changes: route path `'/'` → `'/ws'`, query shape `{ roomId, userId }` → `{ room, peerId }`.

**Step 1.4: Verify typecheck**

Run: `bun run --silent tsc --noEmit`
Expected: Many errors in `src/ws-handlers.ts` and `test/` files (they still reference old names). This is expected — those files get rewritten in later tasks. **The only thing that must typecheck cleanly right now is `src/types.ts`, `src/app.ts`, and `tsconfig.json` itself.**

To confirm `types.ts` is clean in isolation:

```bash
bun run --silent tsc --noEmit src/types.ts
```
Expected: no errors.

**Step 1.5: Commit**

```bash
git add tsconfig.json src/types.ts src/app.ts
git commit -m "feat: scaffold V1 signaling types and /ws route

Adds src/types.ts with CLOSE_CODES and SYNC'd protocol types,
enables DOM lib in tsconfig for RTC type references, and moves
the WebSocket endpoint from / to /ws with the new query contract
(room + peerId). No handler behavior changes yet."
```

---

## Task 2: Rewrite the entire test suite (red)

All tests are written against the V1 target contract. The suite will be entirely red at the end of this task — that is the expected state. Tasks 3–7 will make it green piece by piece.

**Files:**
- Rewrite: `test/rooms.test.ts`
- Rewrite: `test/ws.test.ts`
- Create: `test/heartbeat.test.ts`
- Create: `test/gc.test.ts`
- Leave unchanged: `test/http.test.ts` (the `GET /` route is still present after Task 1)

### Step 2.1: Rewrite `test/rooms.test.ts`

```typescript
import { describe, expect, it, beforeEach } from 'bun:test'
import { rooms, createRoom, findOrCreateRoom } from '../src/rooms'

describe('rooms module', () => {
  beforeEach(() => rooms.clear())

  it('createRoom initializes an empty room', () => {
    const room = createRoom('r1')
    expect(room.peers.size).toBe(0)
    expect(room.caller).toBeNull()
    expect(typeof room.createdAt).toBe('number')
    expect(room.createdAt).toBeGreaterThan(0)
    expect(rooms.get('r1')).toBe(room)
  })

  it('findOrCreateRoom returns existing room if present', () => {
    const first = findOrCreateRoom('r1')
    const second = findOrCreateRoom('r1')
    expect(second).toBe(first)
  })

  it('findOrCreateRoom creates a new room if absent', () => {
    expect(rooms.has('r1')).toBe(false)
    const room = findOrCreateRoom('r1')
    expect(rooms.has('r1')).toBe(true)
    expect(room.peers.size).toBe(0)
  })
})
```

### Step 2.2: Rewrite `test/ws.test.ts`

```typescript
import { describe, expect, it, beforeEach } from 'bun:test'
import { rooms } from '../src/rooms'
import { beforeHandle, open, close, message, type Ws } from '../src/ws-handlers'
import { CLOSE_CODES } from '../src/types'

type MockWs = Ws & {
  _sends: string[]
  _publishes: [string, string | Buffer][]
  _subscribes: string[]
  _unsubscribes: string[]
  _closes: [number, string?][]
  _open: boolean
}

function makeMockWs(room: string, peerId: string): MockWs {
  const _sends: string[] = []
  const _publishes: [string, string | Buffer][] = []
  const _subscribes: string[] = []
  const _unsubscribes: string[] = []
  const _closes: [number, string?][] = []
  const mock: any = {
    data: { query: { room, peerId } },
    send: (msg: string) => _sends.push(msg),
    publish: (topic: string, msg: string | Buffer) => _publishes.push([topic, msg]),
    subscribe: (topic: string) => _subscribes.push(topic),
    unsubscribe: (topic: string) => _unsubscribes.push(topic),
    close: (code: number, reason?: string) => { _closes.push([code, reason]); mock._open = false },
    _open: true,
    get readyState() { return mock._open ? 1 : 3 },
    _sends, _publishes, _subscribes, _unsubscribes, _closes,
  }
  return mock as MockWs
}

describe('beforeHandle', () => {
  beforeEach(() => rooms.clear())

  it('returns 400 Response on empty room', () => {
    const res = beforeHandle({ query: { room: '', peerId: 'p1' } })
    expect(res).toBeInstanceOf(Response)
    expect(res?.status).toBe(400)
  })

  it('returns 400 Response on empty peerId', () => {
    const res = beforeHandle({ query: { room: 'r1', peerId: '' } })
    expect(res).toBeInstanceOf(Response)
    expect(res?.status).toBe(400)
  })

  it('returns nothing on valid query', () => {
    expect(beforeHandle({ query: { room: 'r1', peerId: 'p1' } })).toBeUndefined()
  })

  it('does NOT mutate rooms', () => {
    beforeHandle({ query: { room: 'r1', peerId: 'p1' } })
    expect(rooms.has('r1')).toBe(false)
  })
})

describe('open — new peer', () => {
  beforeEach(() => rooms.clear())

  it('first peer becomes caller and gets onopen with reconnect:false', () => {
    const ws = makeMockWs('r1', 'alice')
    open(ws)
    const onopen = ws._sends.find(m => m.includes('"onopen"'))
    expect(onopen).toBe(JSON.stringify({ type: 'onopen', role: 'caller', reconnect: false }))
    expect(ws._subscribes).toContain('r1')
    expect(ws._publishes).toContainEqual(['r1', JSON.stringify({ type: 'enter' })])

    const room = rooms.get('r1')!
    expect(room.caller).toBe('alice')
    expect(room.peers.get('alice')?.role).toBe('caller')
  })

  it('second peer becomes callee', () => {
    open(makeMockWs('r1', 'alice'))
    const bob = makeMockWs('r1', 'bob')
    open(bob)
    expect(bob._sends).toContain(JSON.stringify({ type: 'onopen', role: 'callee', reconnect: false }))

    const room = rooms.get('r1')!
    expect(room.caller).toBe('alice')
    expect(room.peers.get('bob')?.role).toBe('callee')
  })

  it('third peer is closed with ROOM_FULL (4001)', () => {
    open(makeMockWs('r1', 'alice'))
    open(makeMockWs('r1', 'bob'))
    const carol = makeMockWs('r1', 'carol')
    open(carol)
    expect(carol._closes[0]?.[0]).toBe(CLOSE_CODES.ROOM_FULL)
    const room = rooms.get('r1')!
    expect(room.peers.has('carol')).toBe(false)
  })
})

describe('open — reconnection', () => {
  beforeEach(() => rooms.clear())

  it('same peerId rejoining swaps ws and sends reconnect:true', () => {
    const alice1 = makeMockWs('r1', 'alice')
    open(alice1)

    // simulate disconnect soft-evict via close()
    close(alice1)
    expect(rooms.get('r1')!.peers.get('alice')?.ws).toBeNull()

    const alice2 = makeMockWs('r1', 'alice')
    open(alice2)

    expect(alice2._sends).toContain(JSON.stringify({ type: 'onopen', role: 'caller', reconnect: true }))
    expect(alice2._publishes).toContainEqual(['r1', JSON.stringify({ type: 'peer-reconnected' })])

    const entry = rooms.get('r1')!.peers.get('alice')!
    expect(entry.ws).toBe(alice2)
    expect(entry.disconnectedAt).toBeNull()
  })

  it('same peerId rejoining with old ws still open closes the old one first', () => {
    const alice1 = makeMockWs('r1', 'alice')
    open(alice1)
    // alice1 is still "open" — we did NOT call close()
    const alice2 = makeMockWs('r1', 'alice')
    open(alice2)

    expect(alice1._closes[0]?.[0]).toBe(1000)
    expect(rooms.get('r1')!.peers.get('alice')?.ws).toBe(alice2)
  })

  it('reconnect preserves role even if other peer joined in the meantime', () => {
    const alice1 = makeMockWs('r1', 'alice')
    open(alice1)
    close(alice1)

    const bob = makeMockWs('r1', 'bob')
    open(bob)
    expect(rooms.get('r1')!.peers.get('bob')?.role).toBe('callee')

    const alice2 = makeMockWs('r1', 'alice')
    open(alice2)
    expect(rooms.get('r1')!.peers.get('alice')?.role).toBe('caller')
    expect(rooms.get('r1')!.caller).toBe('alice')
  })
})

describe('close — soft-evict', () => {
  beforeEach(() => rooms.clear())

  it('publishes onclose, sets ws=null and disconnectedAt, keeps entry', () => {
    const ws = makeMockWs('r1', 'alice')
    open(ws)
    close(ws)

    expect(ws._publishes).toContainEqual([
      'r1',
      JSON.stringify({ type: 'onclose', message: 'peer disconnected' }),
    ])
    const entry = rooms.get('r1')!.peers.get('alice')!
    expect(entry.ws).toBeNull()
    expect(entry.disconnectedAt).not.toBeNull()
    expect(typeof entry.disconnectedAt).toBe('number')
  })
})

describe('message — relay and pong', () => {
  beforeEach(() => rooms.clear())

  it('relays arbitrary messages verbatim to the room', () => {
    const ws = makeMockWs('r1', 'alice')
    open(ws)
    const payload = JSON.stringify({ type: 'offer', offer: { sdp: 'v=0', type: 'offer' } })
    message(ws, payload)
    expect(ws._publishes).toContainEqual(['r1', payload])
  })

  it('does NOT publish pong messages', () => {
    const ws = makeMockWs('r1', 'alice')
    open(ws)
    const publishCountBefore = ws._publishes.length
    message(ws, JSON.stringify({ type: 'pong' }))
    // no new publish should have been added
    expect(ws._publishes.length).toBe(publishCountBefore)
  })

  it('pong clears waitingPong on the sender entry', () => {
    const ws = makeMockWs('r1', 'alice')
    open(ws)
    const entry = rooms.get('r1')!.peers.get('alice')!
    entry.waitingPong = true
    message(ws, JSON.stringify({ type: 'pong' }))
    expect(entry.waitingPong).toBe(false)
  })

  it('relays malformed JSON (server does not validate structure)', () => {
    const ws = makeMockWs('r1', 'alice')
    open(ws)
    message(ws, 'not json at all')
    expect(ws._publishes).toContainEqual(['r1', 'not json at all'])
  })
})
```

### Step 2.3: Create `test/heartbeat.test.ts`

```typescript
import { describe, expect, it, beforeEach } from 'bun:test'
import { rooms } from '../src/rooms'
import { heartbeatTick } from '../src/heartbeat'
import { CLOSE_CODES } from '../src/types'
import type { PeerEntry } from '../src/rooms'

function makeStubWs() {
  const _sends: string[] = []
  const _closes: [number, string?][] = []
  return {
    send: (m: string) => _sends.push(m),
    close: (c: number, r?: string) => _closes.push([c, r]),
    _sends,
    _closes,
  }
}

function seedRoom(peers: Record<string, Partial<PeerEntry> & { ws: any }>) {
  rooms.set('r1', {
    peers: new Map(
      Object.entries(peers).map(([id, p]) => [
        id,
        {
          ws: p.ws,
          role: p.role ?? 'caller',
          disconnectedAt: p.disconnectedAt ?? null,
          waitingPong: p.waitingPong ?? false,
        } as PeerEntry,
      ]),
    ),
    caller: 'alice',
    createdAt: Date.now(),
  })
}

describe('heartbeat', () => {
  beforeEach(() => rooms.clear())

  it('first tick sends ping and sets waitingPong', () => {
    const ws = makeStubWs()
    seedRoom({ alice: { ws } })
    heartbeatTick()
    expect(ws._sends).toContain(JSON.stringify({ type: 'ping' }))
    expect(rooms.get('r1')!.peers.get('alice')!.waitingPong).toBe(true)
  })

  it('second tick with no pong closes ws with PING_TIMEOUT', () => {
    const ws = makeStubWs()
    seedRoom({ alice: { ws, waitingPong: true } })
    heartbeatTick()
    expect(ws._closes[0]?.[0]).toBe(CLOSE_CODES.PING_TIMEOUT)
  })

  it('second tick after pong sends another ping', () => {
    const ws = makeStubWs()
    seedRoom({ alice: { ws } })
    heartbeatTick()
    // pong clears waitingPong
    rooms.get('r1')!.peers.get('alice')!.waitingPong = false
    heartbeatTick()
    expect(ws._sends.length).toBe(2)
    expect(ws._closes.length).toBe(0)
  })

  it('skips entries with null ws (already disconnected)', () => {
    seedRoom({ alice: { ws: null, disconnectedAt: Date.now() } })
    expect(() => heartbeatTick()).not.toThrow()
  })
})
```

### Step 2.4: Create `test/gc.test.ts`

```typescript
import { describe, expect, it, beforeEach } from 'bun:test'
import { rooms } from '../src/rooms'
import { gcSweep } from '../src/gc'
import type { PeerEntry } from '../src/rooms'

const HOUR_MS = 60 * 60 * 1000
const IDLE_MS = HOUR_MS
const now = () => Date.now()

function seed(id: string, peers: Record<string, Partial<PeerEntry>>) {
  rooms.set(id, {
    peers: new Map(
      Object.entries(peers).map(([pid, p]) => [
        pid,
        {
          ws: p.ws ?? null,
          role: p.role ?? 'caller',
          disconnectedAt: p.disconnectedAt ?? null,
          waitingPong: p.waitingPong ?? false,
        } as PeerEntry,
      ]),
    ),
    caller: Object.keys(peers)[0] ?? null,
    createdAt: now() - 2 * HOUR_MS,
  })
}

describe('gc', () => {
  beforeEach(() => rooms.clear())

  it('deletes a room where all peers have been disconnected > 1h', () => {
    seed('r1', {
      alice: { disconnectedAt: now() - IDLE_MS - 1000 },
      bob: { disconnectedAt: now() - IDLE_MS - 500 },
    })
    gcSweep(IDLE_MS)
    expect(rooms.has('r1')).toBe(false)
  })

  it('keeps a room where all peers disconnected <1h ago', () => {
    seed('r1', {
      alice: { disconnectedAt: now() - 10 * 60 * 1000 },
    })
    gcSweep(IDLE_MS)
    expect(rooms.has('r1')).toBe(true)
  })

  it('keeps a room with one still-connected peer', () => {
    const ws = {} as any
    seed('r1', {
      alice: { ws, disconnectedAt: null },
      bob: { disconnectedAt: now() - 2 * IDLE_MS },
    })
    gcSweep(IDLE_MS)
    expect(rooms.has('r1')).toBe(true)
  })

  it('deletes an empty room (peers.size === 0)', () => {
    rooms.set('r1', { peers: new Map(), caller: null, createdAt: now() - 2 * IDLE_MS })
    gcSweep(IDLE_MS)
    expect(rooms.has('r1')).toBe(false)
  })
})
```

### Step 2.5: Audit `test/http.test.ts`

Do not modify. The `GET /` route survives Task 1 unchanged, so this test remains valid.

### Step 2.6: Run full suite — expect red

Run: `bun test`
Expected: `test/http.test.ts` passes (2 tests). Every other file fails to compile or fails at runtime — they reference symbols (`createRoom`, `heartbeatTick`, `gcSweep`, `PeerEntry`, new `open`/`close` semantics) that don't exist yet.

**Do not try to make them pass here.** Red is the target state.

### Step 2.7: Commit

```bash
git add test/rooms.test.ts test/ws.test.ts test/heartbeat.test.ts test/gc.test.ts
git commit -m "test: rewrite signaling suite against V1 contract (red)

Rewrites rooms and ws-handler tests against the new Room/PeerEntry
shape with role-based onopen, reconnection flow, and soft-evict on
close. Adds heartbeat and GC test files. Suite is red until the
implementation tasks land."
```

---

## Task 3: Rooms module rewrite

Turns `test/rooms.test.ts` green. No handler changes yet.

**Files:**
- Rewrite: `src/rooms.ts`

### Step 3.1: Replace `src/rooms.ts` entirely

```typescript
import type { ElysiaWS } from 'elysia/ws'
import type { Role } from './types'

export type PeerEntry = {
  ws: ElysiaWS | null
  role: Role
  disconnectedAt: number | null
  waitingPong: boolean
}

export type Room = {
  peers: Map<string, PeerEntry>
  caller: string | null
  createdAt: number
}

export const rooms = new Map<string, Room>()

export function createRoom(id: string): Room {
  const room: Room = {
    peers: new Map(),
    caller: null,
    createdAt: Date.now(),
  }
  rooms.set(id, room)
  return room
}

export function findOrCreateRoom(id: string): Room {
  return rooms.get(id) ?? createRoom(id)
}
```

The old helpers (`getRoom`, `addUser`, `removeUser`) are gone — all membership is now handled in `ws-handlers` against the new shape.

### Step 3.2: Run rooms tests

Run: `bun test test/rooms.test.ts`
Expected: all 3 tests pass.

Other test files will still fail to compile because they import from `./ws-handlers` or `./heartbeat` which are stale. That's expected — only `rooms.test.ts` should be green at this point.

### Step 3.3: Commit

```bash
git add src/rooms.ts
git commit -m "refactor: rewrite rooms module with Room/PeerEntry shape

Replaces Map<string, string[]> with a richer Room type carrying
peer entries, the immutable caller peerId, and a createdAt timestamp.
Introduces createRoom and findOrCreateRoom helpers. Rooms tests go
green; handler tests still red (next task)."
```

---

## Task 4: ws-handlers — new peer path

Implements `beforeHandle`, the new-peer branch of `open`, `message` (blind relay + pong interception), and `close` (soft-evict). Reconnection branch is deliberately left out — it lands in Task 5.

**Files:**
- Rewrite: `src/ws-handlers.ts`

### Step 4.1: Replace `src/ws-handlers.ts` entirely

```typescript
import type { ElysiaWS } from 'elysia/ws'
import { findOrCreateRoom, rooms, type PeerEntry } from './rooms'
import { CLOSE_CODES, type Role } from './types'

type Query = { room: string; peerId: string }
export type Ws = ElysiaWS<{ query: Query }>

interface BeforeHandleContext {
  query: Query
}

export function beforeHandle({ query }: BeforeHandleContext): Response | undefined {
  const { room, peerId } = query ?? ({} as Query)
  if (!room || !peerId) {
    return new Response('Missing room or peerId', { status: 400 })
  }
}

export function open(ws: Ws): void {
  const { room: roomId, peerId } = ws.data.query
  const room = findOrCreateRoom(roomId)

  // reconnection path lands in Task 5 — for now, same peerId reconnect is not handled.
  // If an entry already exists, Task 5 will extend this function.
  const existing = room.peers.get(peerId)
  if (existing) {
    // temporary: treat as if room-full to keep tests deterministic until Task 5.
    // (Task 5 will replace this entire branch with the reconnection logic.)
    ws.close(CLOSE_CODES.ROOM_FULL)
    return
  }

  if (room.peers.size >= 2) {
    ws.close(CLOSE_CODES.ROOM_FULL)
    return
  }

  const role: Role = room.caller === null ? 'caller' : 'callee'
  if (role === 'caller') room.caller = peerId

  const entry: PeerEntry = {
    ws,
    role,
    disconnectedAt: null,
    waitingPong: false,
  }
  room.peers.set(peerId, entry)

  ws.subscribe(roomId)
  ws.send(JSON.stringify({ type: 'onopen', role, reconnect: false }))
  ws.publish(roomId, JSON.stringify({ type: 'enter' }))
}

export function close(ws: Ws): void {
  const { room: roomId, peerId } = ws.data.query
  const room = rooms.get(roomId)
  if (!room) return
  const entry = room.peers.get(peerId)
  if (!entry) return

  entry.ws = null
  entry.disconnectedAt = Date.now()

  ws.publish(roomId, JSON.stringify({ type: 'onclose', message: 'peer disconnected' }))
  ws.unsubscribe(roomId)
}

export function message(ws: Ws, raw: string | Buffer): void {
  const { room: roomId, peerId } = ws.data.query

  // Parse just enough to detect pong. Everything else is relayed verbatim.
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && parsed.type === 'pong') {
        const entry = rooms.get(roomId)?.peers.get(peerId)
        if (entry) entry.waitingPong = false
        return
      }
    } catch {
      // fall through to relay
    }
  }

  ws.publish(roomId, raw)
}
```

### Step 4.2: Run ws tests, filter out reconnection cases

Run: `bun test test/ws.test.ts`
Expected:
- `beforeHandle` tests: pass (4/4)
- `open — new peer` tests: pass (3/3)
- `open — reconnection` tests: the "same peerId with old ws still open" test may incidentally pass (because we call `ws.close(4001)` on the new one, but the test expects the *old* one to be closed with 1000). It will **fail**. The other two reconnection tests **fail**. That's expected — Task 5 fixes them.
- `close — soft-evict`: pass (1/1)
- `message — relay and pong`: pass (4/4)

### Step 4.3: Commit

```bash
git add src/ws-handlers.ts
git commit -m "feat: new-peer path + relay + soft-evict close

Implements beforeHandle shape validation, the new-peer branch of
open (role assignment, ROOM_FULL close), soft-evict close, and
the message handler with pong interception. Reconnection is stubbed
as ROOM_FULL; the real reconnection branch lands next."
```

---

## Task 5: ws-handlers — reconnection branch

Replaces the reconnection stub with the real swap-ws logic from the PRD §5. Makes the remaining `test/ws.test.ts` cases pass.

**Files:**
- Modify: `src/ws-handlers.ts` (replace the `if (existing)` branch)

### Step 5.1: Replace the existing `open` reconnection stub

In `src/ws-handlers.ts`, replace this block inside `open`:

```typescript
  const existing = room.peers.get(peerId)
  if (existing) {
    // temporary: treat as if room-full to keep tests deterministic until Task 5.
    // (Task 5 will replace this entire branch with the reconnection logic.)
    ws.close(CLOSE_CODES.ROOM_FULL)
    return
  }
```

with the real reconnection logic:

```typescript
  const existing = room.peers.get(peerId)
  if (existing) {
    // RECONNECTION: boot the old ws (if any), swap in the new one, preserve role.
    if (existing.ws && existing.ws !== ws) {
      try { existing.ws.close(1000) } catch { /* already closed */ }
    }
    existing.ws = ws
    existing.disconnectedAt = null
    existing.waitingPong = false
    ws.subscribe(roomId)
    ws.send(JSON.stringify({ type: 'onopen', role: existing.role, reconnect: true }))
    ws.publish(roomId, JSON.stringify({ type: 'peer-reconnected' }))
    return
  }
```

### Step 5.2: Run ws tests — expect fully green

Run: `bun test test/ws.test.ts`
Expected: all tests pass. If the "reconnect preserves role even if other peer joined in the meantime" test is still red, double-check that the callee branch does *not* reassign `room.caller` on reconnection (it must not — `room.caller` is set only once in the new-peer path).

### Step 5.3: Commit

```bash
git add src/ws-handlers.ts
git commit -m "feat: reconnection branch in ws-handlers open

Same-peerId reconnection closes the old ws with code 1000, swaps
the entry's ws to the new socket, clears disconnectedAt and
waitingPong, replies with onopen reconnect:true, and publishes
peer-reconnected to the room."
```

---

## Task 6: Heartbeat module

Introduces `src/heartbeat.ts` with a testable tick function plus lifecycle helpers. `message` already handles `pong` interception (Task 4), so this task only wires up the send side.

**Files:**
- Create: `src/heartbeat.ts`

### Step 6.1: Create `src/heartbeat.ts`

```typescript
import { rooms } from './rooms'
import { CLOSE_CODES } from './types'

export const HEARTBEAT_MS = 60_000

export function heartbeatTick(): void {
  for (const room of rooms.values()) {
    for (const entry of room.peers.values()) {
      if (entry.ws === null) continue
      if (entry.waitingPong) {
        try { entry.ws.close(CLOSE_CODES.PING_TIMEOUT) } catch { /* ignore */ }
        continue
      }
      entry.waitingPong = true
      try { entry.ws.send(JSON.stringify({ type: 'ping' })) } catch { /* ignore */ }
    }
  }
}

export function startHeartbeat(ms: number = HEARTBEAT_MS): ReturnType<typeof setInterval> {
  return setInterval(heartbeatTick, ms)
}

export function stopHeartbeat(h: ReturnType<typeof setInterval>): void {
  clearInterval(h)
}
```

### Step 6.2: Run heartbeat tests

Run: `bun test test/heartbeat.test.ts`
Expected: all 4 tests pass.

### Step 6.3: Commit

```bash
git add src/heartbeat.ts
git commit -m "feat: heartbeat module with 60s ping cycle

Introduces heartbeatTick walking rooms and sending ping to every
live peer, closing ghost sockets with PING_TIMEOUT (4005) on the
second missed cycle. startHeartbeat/stopHeartbeat are the
interval lifecycle helpers; HEARTBEAT_MS is module-level for
test injection."
```

---

## Task 7: GC module

Introduces `src/gc.ts`. Same lifecycle pattern as heartbeat.

**Files:**
- Create: `src/gc.ts`

### Step 7.1: Create `src/gc.ts`

```typescript
import { rooms } from './rooms'

export const GC_SWEEP_MS = 30 * 60 * 1000
export const GC_IDLE_MS = 60 * 60 * 1000

export function gcSweep(idleMs: number = GC_IDLE_MS): void {
  const nowMs = Date.now()
  for (const [roomId, room] of rooms.entries()) {
    if (room.peers.size === 0) {
      rooms.delete(roomId)
      continue
    }

    let allDisconnected = true
    let newestDisconnect = 0
    for (const entry of room.peers.values()) {
      if (entry.disconnectedAt === null) {
        allDisconnected = false
        break
      }
      if (entry.disconnectedAt > newestDisconnect) {
        newestDisconnect = entry.disconnectedAt
      }
    }

    if (!allDisconnected) continue
    if (nowMs - newestDisconnect > idleMs) {
      rooms.delete(roomId)
    }
  }
}

export function startGC(
  sweepMs: number = GC_SWEEP_MS,
  idleMs: number = GC_IDLE_MS,
): ReturnType<typeof setInterval> {
  return setInterval(() => gcSweep(idleMs), sweepMs)
}

export function stopGC(h: ReturnType<typeof setInterval>): void {
  clearInterval(h)
}
```

### Step 7.2: Run GC tests

Run: `bun test test/gc.test.ts`
Expected: all 4 tests pass.

### Step 7.3: Run full suite — should be fully green

Run: `bun test`
Expected: every test in every file passes (`http`, `rooms`, `ws`, `heartbeat`, `gc`). If anything is red, stop and fix before committing.

### Step 7.4: Commit

```bash
git add src/gc.ts
git commit -m "feat: room garbage collection module

Introduces gcSweep walking rooms every 30 minutes and deleting
rooms where all peers have been disconnected for more than an
hour, plus a safety net for empty rooms. startGC/stopGC manage
the interval; constants are test-injectable. Full suite green."
```

---

## Task 8: Wire up in index.ts + smoke test

Starts the heartbeat and GC intervals from `index.ts` and runs a manual end-to-end smoke test against the real server.

**Files:**
- Modify: `src/index.ts`

### Step 8.1: Update `src/index.ts`

```typescript
import { app } from './app'
import { startHeartbeat } from './heartbeat'
import { startGC } from './gc'

app.listen({
  port: 9999,
  tls: {
    cert: Bun.file('/home/marcus/Projects/courses/webrtc/192.168.3.141.pem'),
    key: Bun.file('/home/marcus/Projects/courses/webrtc/192.168.3.141-key.pem'),
  },
})

startHeartbeat()
startGC()

console.log(`Listening at :${app.server?.port}`)
```

### Step 8.2: Run full test suite one more time

Run: `bun test`
Expected: all tests pass.

### Step 8.3: Typecheck clean pass

Run: `bun run --silent tsc --noEmit`
Expected: zero errors across the project. If any surface (likely in the mock ws types in tests), fix before committing.

### Step 8.4: Smoke test (manual)

Start the server in one terminal:

```bash
bun run dev
```

In a second terminal, use `websocat` (`cargo install websocat` or `brew install websocat`) — ignore TLS verification since the cert is self-signed:

```bash
websocat -k 'wss://localhost:9999/ws?room=smoke&peerId=alice'
```

Expected: within a second, you should receive:

```json
{"type":"onopen","role":"caller","reconnect":false}
```

In a third terminal:

```bash
websocat -k 'wss://localhost:9999/ws?room=smoke&peerId=bob'
```

Expected:
- Bob receives `{"type":"onopen","role":"callee","reconnect":false}`.
- Alice receives `{"type":"enter"}`.

Type `{"type":"offer","offer":{"type":"offer","sdp":"fake"}}` into Alice's terminal. Bob should receive it verbatim. Type `{"type":"pong"}` into Alice's terminal — Bob should **not** receive it.

Kill Alice's websocat. Bob should receive `{"type":"onclose","message":"peer disconnected"}`.

Reconnect Alice with the same `peerId=alice` — Alice should receive `{"type":"onopen","role":"caller","reconnect":true}` and Bob should receive `{"type":"peer-reconnected"}`.

Stop the server (`Ctrl+C`). If any of the above did not match, file the mismatch as a bug and do **not** commit until fixed.

### Step 8.5: Commit

```bash
git add src/index.ts
git commit -m "feat: start heartbeat and GC on server boot

Wires startHeartbeat and startGC into index.ts after the server
binds. V1 signaling server is feature-complete: peerId-based
reconnection, soft-evict on close, 60s heartbeat, 30min GC sweep
with 1h idle threshold, and semantic close codes. Smoke-tested
end-to-end with websocat."
```

---

## Acceptance criteria summary

At the end of the plan:

- [ ] `bun test` — all tests green across `rooms`, `ws`, `heartbeat`, `gc`, `http`.
- [ ] `bun run --silent tsc --noEmit` — zero type errors.
- [ ] Two websocat clients can connect to `wss://localhost:9999/ws?room=X&peerId=Y` and exchange relayed messages.
- [ ] Third client to the same room is closed with 4001.
- [ ] Reconnection with the same peerId swaps sockets and delivers `reconnect:true`.
- [ ] Unclean disconnect is detected by heartbeat within ~2 minutes.
- [ ] A room with all peers disconnected is deleted by GC within 30 minutes of crossing the 1h idle threshold.
- [ ] Every task landed as its own commit, with conventional commit messages.

## Deferred (tracked in PRD §12)

TURN, chat, Redis, SFU, telemetry, database, Wails bridge. Do not touch in this plan.
