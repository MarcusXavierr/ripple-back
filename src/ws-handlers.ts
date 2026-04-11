import type { ElysiaWS } from 'elysia/ws'
import { getRoom, addUser, removeUser } from './rooms'

type Query = { roomId: string; userId: string }
export type Ws = ElysiaWS<{ query: Query }>

interface BeforeHandleContext {
  query: Query
}

export function beforeHandle({ query }: BeforeHandleContext): Response | undefined {
  const { roomId, userId } = query
  const ids = getRoom(roomId)
  if (ids.length >= 2) {
    console.log(`room is full: ${ids.length}`)
    return new Response('Room is full', { status: 403 })
  }

  for (const id of ids) {
    if (id === userId) {
      console.log(`The user id ${userId} was already taken for this room`)
      return new Response('The user id was already taken for this room')
    }
  }

  addUser(roomId, userId)
}

export function open(ws: Ws): void {
  const { roomId, userId } = ws.data.query
  const room = getRoom(roomId)

  if (room[0] === userId) {
    ws.send(JSON.stringify({ order: 1, type: 'onopen' }))
  } else if (room[1] === userId) {
    ws.send(JSON.stringify({ order: 2, type: 'onopen' }))
  }

  ws.subscribe(roomId)
  ws.publish(roomId, JSON.stringify({ type: 'enter' }))
}

export function close(ws: Ws): void {
  const { roomId, userId } = ws.data.query
  ws.publish(roomId, JSON.stringify({ type: 'onclose', message: 'o outro otario saiu' }))
  ws.unsubscribe(roomId)
  removeUser(roomId, userId)
}

export function message(ws: Ws, msg: string | Buffer): void {
  ws.publish(ws.data.query.roomId, msg)
}
