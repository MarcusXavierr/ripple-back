import type { ElysiaWS } from 'elysia/ws'
import { findOrCreateRoom, rooms, type PeerEntry } from './rooms'
import { CLOSE_CODES, type Role } from './types'
import { logger } from './logger'

type Query = { room: string; peerId: string }
export type Ws = ElysiaWS<{ query: Query }>

interface BeforeHandleContext {
  query: Query
}

export function beforeHandle({ query }: BeforeHandleContext): Response | undefined {
  const { room, peerId } = query ?? ({} as Query)
  if (!room || !peerId) {
    logger.warn({ room, peerId }, 'connection rejected: missing room or peerId')
    return new Response('Missing room or peerId', { status: 400 })
  }
}

export function open(ws: Ws): void {
  const { room: roomId, peerId } = ws.data.query
  const log = logger.child({ room: roomId, peerId })
  const room = findOrCreateRoom(roomId)

  const existing = room.peers.get(peerId)
  if (existing) {
    // RECONNECTION: boot the old ws (if any), swap in the new one, preserve role.
    if (existing.ws && existing.ws !== ws) {
      log.debug('booting stale ws for reconnecting peer')
      try { existing.ws.close(1000) } catch (err) { log.debug({ err }, 'failed to close stale ws (already closed?)') }
    }
    existing.ws = ws
    existing.disconnectedAt = null
    existing.waitingPong = false
    existing.log = log
    ws.subscribe(roomId)
    ws.send(JSON.stringify({ type: 'onopen', role: existing.role, reconnect: true }))
    ws.publish(roomId, JSON.stringify({ type: 'peer-reconnected' }))
    log.info({ role: existing.role }, 'peer reconnected')
    return
  }

  if (room.peers.size >= 2) {
    log.warn({ peerCount: room.peers.size }, 'connection rejected: room full')
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
    log,
  }
  room.peers.set(peerId, entry)

  ws.subscribe(roomId)
  ws.send(JSON.stringify({ type: 'onopen', role, reconnect: false }))
  ws.publish(roomId, JSON.stringify({ type: 'enter' }))
  log.info({ role }, 'peer connected')
}

export function close(ws: Ws): void {
  const { room: roomId, peerId } = ws.data.query
  const room = rooms.get(roomId)
  if (!room) {
    logger.debug({ room: roomId, peerId }, 'close for unknown room')
    return
  }
  const entry = room.peers.get(peerId)
  if (!entry) {
    logger.debug({ room: roomId, peerId }, 'close for unknown peer')
    return
  }

  // Guard against stale close events: when a peer reconnects, open() replaces
  // entry.ws before Bun fires the async close event for the old ws. Without this
  // check, the stale close would null out the new ws and publish a spurious
  // 'onclose' to the room, disconnecting the other peer.
  if (entry.ws !== ws) {
    entry.log.debug({ role: entry.role }, 'stale ws close event, ignoring')
    return
  }

  entry.ws = null
  entry.disconnectedAt = Date.now()

  ws.publish(roomId, JSON.stringify({ type: 'onclose', message: 'peer disconnected' }))
  ws.unsubscribe(roomId)

  entry.log.info({ role: entry.role }, 'peer disconnected')
}

export function message(ws: Ws, raw: string | Buffer): void {
  const { room: roomId, peerId } = ws.data.query

  // Elysia pre-parses valid JSON strings into objects before invoking this handler.
  // Handle both the pre-parsed object case (normal path) and raw string/Buffer fallback.
  let parsed: Record<string, unknown> | null = null
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) {
    parsed = raw as Record<string, unknown>
  } else if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch (err) { logger.debug({ err }, 'message is not valid JSON, relaying raw') }
  }

  if (parsed?.type === 'pong') {
    const room = rooms.get(roomId)
    const entry = room?.peers.get(peerId)
    if (!room) {
      logger.warn({ roomId, peerId }, 'pong received but room not found — waitingPong will stay true')
      return
    }
    if (!entry) {
      logger.warn({ roomId, peerId }, 'pong received but peer entry not found — waitingPong will stay true')
      return
    }
    if (!entry.waitingPong) {
      entry.log.warn('pong received but waitingPong was already false (duplicate pong?)')
      return
    }
    entry.waitingPong = false
    entry.log.debug('pong received, waitingPong cleared')
    return
  }

  const entry = rooms.get(roomId)?.peers.get(peerId)
  if (parsed !== null) {
    entry?.log.trace({ msgType: parsed?.type }, 'relay')
  } else {
    entry?.log.debug('message parse failed, relaying raw')
  }

  ws.publish(roomId, raw)
}
