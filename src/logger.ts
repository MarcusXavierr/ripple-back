import pino from 'pino'
import pretty from 'pino-pretty'

const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    name: 'signaling',
  },
  isDev
    ? pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' })
    : undefined,
)

export type Logger = typeof logger
