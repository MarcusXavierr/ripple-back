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
