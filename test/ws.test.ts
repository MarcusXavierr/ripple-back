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
