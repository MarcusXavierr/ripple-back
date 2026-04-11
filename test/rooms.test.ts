import { describe, expect, it, beforeEach } from 'bun:test'
import { rooms, getRoom, addUser, removeUser } from '../src/rooms'

describe('rooms', () => {
  beforeEach(() => rooms.clear())

  it('getRoom returns empty array for unknown room', () => {
    expect(getRoom('r1')).toEqual([])
  })

  it('addUser adds a user to the room', () => {
    addUser('r1', 'alice')
    expect(getRoom('r1')).toEqual(['alice'])
  })

  it('addUser can add a second user', () => {
    addUser('r1', 'alice')
    addUser('r1', 'bob')
    expect(getRoom('r1')).toEqual(['alice', 'bob'])
  })

  it('removeUser removes a user from the room', () => {
    addUser('r1', 'alice')
    addUser('r1', 'bob')
    removeUser('r1', 'alice')
    expect(getRoom('r1')).toEqual(['bob'])
  })

  it('removeUser on unknown user leaves the room unchanged', () => {
    addUser('r1', 'alice')
    removeUser('r1', 'ghost')
    expect(getRoom('r1')).toEqual(['alice'])
  })
})
