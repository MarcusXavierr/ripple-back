import { describe, expect, it, beforeEach } from 'bun:test'
import { rooms, addUser } from '../src/rooms'
import { beforeHandle, open, close, message, type Ws } from '../src/ws-handlers'

function makeMockWs(roomId: string, userId: string) {
  const _sends: string[] = []
  const _publishes: [string, string | Buffer][] = []
  const _subscribes: string[] = []
  const _unsubscribes: string[] = []

  const mock = {
    data: { query: { roomId, userId } },
    send: (msg: string) => { _sends.push(msg) },
    publish: (topic: string, msg: string | Buffer) => { _publishes.push([topic, msg]) },
    subscribe: (topic: string) => { _subscribes.push(topic) },
    unsubscribe: (topic: string) => { _unsubscribes.push(topic) },
    _sends,
    _publishes,
    _subscribes,
    _unsubscribes,
  }

  return mock as unknown as Ws & typeof mock
}

describe('beforeHandle', () => {
  beforeEach(() => rooms.clear())

  it('returns 403 if room is full', () => {
    addUser('r1', 'alice')
    addUser('r1', 'bob')
    const res = beforeHandle({ query: { roomId: 'r1', userId: 'carol' } })
    expect(res?.status).toBe(403)
  })

  it('returns a Response if userId is already taken', () => {
    addUser('r1', 'alice')
    const res = beforeHandle({ query: { roomId: 'r1', userId: 'alice' } })
    expect(res).toBeInstanceOf(Response)
  })

  it('adds user to room and returns nothing on success', () => {
    const res = beforeHandle({ query: { roomId: 'r1', userId: 'alice' } })
    expect(res).toBeUndefined()
    expect(rooms.get('r1')).toEqual(['alice'])
  })
})

describe('open', () => {
  beforeEach(() => rooms.clear())

  it('sends order 1 to the first user, subscribes, and publishes enter', () => {
    addUser('r1', 'alice')
    const ws = makeMockWs('r1', 'alice')
    open(ws)
    expect(ws._sends).toContain(JSON.stringify({ order: 1, type: 'onopen' }))
    expect(ws._subscribes).toContain('r1')
    expect(ws._publishes).toContainEqual(['r1', JSON.stringify({ type: 'enter' })])
  })

  it('sends order 2 to the second user', () => {
    addUser('r1', 'alice')
    addUser('r1', 'bob')
    const ws = makeMockWs('r1', 'bob')
    open(ws)
    expect(ws._sends).toContain(JSON.stringify({ order: 2, type: 'onopen' }))
  })
})

describe('close', () => {
  beforeEach(() => rooms.clear())

  it('publishes onclose, unsubscribes, and removes user', () => {
    addUser('r1', 'alice')
    const ws = makeMockWs('r1', 'alice')
    close(ws)
    expect(ws._publishes).toContainEqual(['r1', JSON.stringify({ type: 'onclose', message: 'o outro otario saiu' })])
    expect(ws._unsubscribes).toContain('r1')
    expect(rooms.get('r1')).toEqual([])
  })
})

describe('message', () => {
  it('publishes the raw message to the room', () => {
    const ws = makeMockWs('r1', 'alice')
    message(ws, 'hello')
    expect(ws._publishes).toContainEqual(['r1', 'hello'])
  })
})
