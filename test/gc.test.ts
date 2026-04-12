import { describe, expect, it, beforeEach } from 'bun:test'
import { rooms } from '../src/rooms'
import { gcSweep } from '../src/gc'
import type { PeerEntry } from '../src/rooms'
import { logger } from '../src/logger'

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
          log: logger.child({ room: id, peerId: pid }),
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
