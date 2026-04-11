import { rooms } from './rooms'
import { CLOSE_CODES } from './types'

export const HEARTBEAT_MS = 60_000

export function heartbeatTick(): void {
  for (const room of rooms.values()) {
    for (const entry of room.peers.values()) {
      if (entry.ws === null) continue
      if (entry.waitingPong) {
        try { entry.ws.close(CLOSE_CODES.PING_TIMEOUT) } catch { /* ignore */ }
        continue
      }
      entry.waitingPong = true
      try { entry.ws.send(JSON.stringify({ type: 'ping' })) } catch { /* ignore */ }
    }
  }
}

export function startHeartbeat(ms: number = HEARTBEAT_MS): ReturnType<typeof setInterval> {
  return setInterval(heartbeatTick, ms)
}

export function stopHeartbeat(h: ReturnType<typeof setInterval>): void {
  clearInterval(h)
}
