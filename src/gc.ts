import { rooms } from './rooms'
import { logger } from './logger'

export const GC_SWEEP_MS = 30 * 60 * 1000
export const GC_IDLE_MS = 60 * 60 * 1000

export function gcSweep(idleMs: number = GC_IDLE_MS): void {
  const roomsBefore = rooms.size
  const nowMs = Date.now()
  for (const [roomId, room] of rooms.entries()) {
    if (room.peers.size === 0) {
      logger.debug({ room: roomId }, 'gc deleted empty room')
      rooms.delete(roomId)
      continue
    }

    let allDisconnected = true
    let newestDisconnect = 0
    for (const entry of room.peers.values()) {
      if (entry.disconnectedAt === null) {
        allDisconnected = false
        break
      }
      if (entry.disconnectedAt > newestDisconnect) {
        newestDisconnect = entry.disconnectedAt
      }
    }

    if (!allDisconnected) continue
    if (nowMs - newestDisconnect > idleMs) {
      logger.debug({ room: roomId, idleMs }, 'gc deleted idle room')
      rooms.delete(roomId)
    }
  }
  const roomsAfter = rooms.size
  if (roomsBefore !== roomsAfter) {
    logger.info({ roomsBefore, roomsAfter, roomsDeleted: roomsBefore - roomsAfter }, 'gc sweep completed')
  }
}

export function startGC(
  sweepMs: number = GC_SWEEP_MS,
  idleMs: number = GC_IDLE_MS,
): ReturnType<typeof setInterval> {
  return setInterval(() => gcSweep(idleMs), sweepMs)
}

export function stopGC(h: ReturnType<typeof setInterval>): void {
  clearInterval(h)
}
