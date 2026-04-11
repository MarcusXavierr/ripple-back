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
