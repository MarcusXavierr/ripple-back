import { Elysia, t } from 'elysia'
import { beforeHandle, open, close, message } from './ws-handlers'

export const app = new Elysia()
  .get('/', () => 'Hello Ma friend')
  .ws('/ws', {
    query: t.Object({ room: t.String(), peerId: t.String() }),
    beforeHandle,
    open,
    close,
    message,
  } as any)
