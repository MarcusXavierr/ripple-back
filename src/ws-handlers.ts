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
