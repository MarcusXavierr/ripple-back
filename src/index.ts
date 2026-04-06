const rooms = new Map<string, string[]>()

type WebsocketData = {
  roomId: string
  userId: string
}

const server = Bun.serve<WebsocketData>({
  port: 9999,
  tls: {
    cert: Bun.file("/home/marcus/Projects/courses/webrtc/192.168.3.141.pem"),
    key:  Bun.file("/home/marcus/Projects/courses/webrtc/192.168.3.141-key.pem"),
  },
  development: {
    console: true
  },
  fetch(req, server) {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") === "websocket") {
      const roomId = url.searchParams.get("roomId");
      const userId = url.searchParams.get("userId");
      if (!roomId) {
        console.log(`undefined roomId: ${roomId}`)
        return new Response("Missing roomId", { status: 400 });
      }

      if (!userId) {
        console.log(`undefined userId: ${userId}`)
        return new Response("Missing userId", { status: 400 });
      }

      const ids = rooms.get(roomId) ?? []
      if (ids.length >= 2) {
        console.log(`room is full: ${ids.length}`)
        return new Response("Room is full", { status: 403 });
      }

      for (const id of ids) {
        if (id === userId) {
          console.log(`The user id ${userId} was already taken for this room`)
          return new Response("The user id was already taken for this room")
        }
      }

      rooms.set(roomId, [...ids, userId])

      server.upgrade(req, { data: { roomId, userId } })

      return
    }

    if (url.pathname === "/") return new Response("Hello Ma friend");

    return new Response("Unknown request", { status: 404 });
  },
  websocket: {
    open(ws) {
      const roomId = ws.data.roomId
      const userId = ws.data.userId
      const room = rooms.get(roomId) ?? []
      if (room[0] === userId) {
        ws.send(JSON.stringify({ order: 1, type: 'onopen' }))
      } else if (room[1] === userId) {
        ws.send(JSON.stringify({ order: 2, type: 'onopen' }))
      }

      ws.subscribe(roomId)
      ws.publish(roomId, JSON.stringify({ type: 'enter' }))
    },
    close(ws) {
      const id = ws.data.roomId
      const user =  ws.data.userId
      ws.publish(id, JSON.stringify({ type: 'onclose', message: 'o outro otario saiu' }))
      ws.unsubscribe(id)
      const room = rooms.get(id) ?? []
      rooms.set(id, room.filter(n => n !== user))
    },
    message(ws, message) {
      ws.publish(ws.data.roomId, message)
    }
  }
})
console.log(`Listening at :${server.port}`)
