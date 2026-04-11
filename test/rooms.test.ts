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
