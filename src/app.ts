import { Elysia, t } from 'elysia'
import { beforeHandle, open, close, message } from './ws-handlers'

export const app = new Elysia()
  .get('/', () => 'Hello Ma friend')
  .ws('/', {
    query: t.Object({ roomId: t.String(), userId: t.String() }),
    beforeHandle,
    open,
    close,
    message,
  } as any)
