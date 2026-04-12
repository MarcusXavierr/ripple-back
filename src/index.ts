import { app } from './app'
import { startHeartbeat } from './heartbeat'
import { startGC } from './gc'
import { logger } from './logger'

app.listen({
  port: 9999,
  tls: {
    cert: Bun.file('/home/marcus/Projects/courses/webrtc/192.168.3.141.pem'),
    key: Bun.file('/home/marcus/Projects/courses/webrtc/192.168.3.141-key.pem'),
  },
})

startHeartbeat()
startGC()

logger.info({ port: app.server?.port }, 'signaling server listening')

process.on('SIGINT', () => {
  logger.info('shutting down (SIGINT)')
  process.exit(0)
})
process.on('SIGTERM', () => {
  logger.info('shutting down (SIGTERM)')
  process.exit(0)
})
