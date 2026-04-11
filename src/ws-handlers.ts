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
