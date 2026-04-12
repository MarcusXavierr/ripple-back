import { app } from './app'
import { startHeartbeat } from './heartbeat'
import { startGC } from './gc'
import { logger } from './logger'

const port = Number(process.env.PORT) || 9999

app.listen({ port })

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
