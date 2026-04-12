import { Elysia, t } from 'elysia'
import { openapi } from '@elysiajs/openapi'
import { beforeHandle, open, close, message } from './ws-handlers'

const WS_DOCS = `
## WebSocket Endpoint \`/ws\`

Upgrade to WebSocket for real-time WebRTC signaling. Max **2 peers** per room.

**Connection URL**
\`\`\`
wss://<host>:9999/ws?room=<roomId>&peerId=<uuid>
\`\`\`

| Query Param | Type | Required | Description |
|-------------|------|----------|-------------|
| \`room\` | string | ✓ | Room ID. First joiner becomes \`caller\`, second becomes \`callee\`. |
| \`peerId\` | string | ✓ | Unique peer identifier. Reuse same ID to reconnect within 60 min. |

Returns \`400\` if either parameter is missing.

---

### Server → Client Messages

| Type | Fields | When |
|------|--------|------|
| \`onopen\` | \`role: "caller"│"callee"\`, \`reconnect: boolean\` | Sent on connection accepted. \`reconnect: true\` when reusing a known peerId. |
| \`enter\` | — | Broadcast to room when a new (non-reconnecting) peer joins. |
| \`onclose\` | \`message: string\` | Broadcast to room when a peer disconnects. |
| \`peer-reconnected\` | — | Broadcast to room when a disconnected peer returns. |
| \`ping\` | — | Heartbeat probe every 60 s. Respond with \`pong\` within 60 s or connection closes (4005). |

### Client → Server Messages

| Type | Fields | Notes |
|------|--------|-------|
| \`offer\` | \`offer: RTCSessionDescriptionInit\` | Relayed verbatim to other peer. |
| \`answer\` | \`answer: RTCSessionDescriptionInit\` | Relayed verbatim to other peer. |
| \`ice-candidate\` | \`candidate: RTCIceCandidateInit\` | Relayed verbatim to other peer. |
| \`pong\` | — | Heartbeat response. Consumed by server, not relayed. |
| \`error\` | \`code: "ICE_FAILED"│"MEDIA_DENIED"\` | Relayed verbatim to other peer. |

### Close Codes

| Code | Name | Cause |
|------|------|-------|
| \`4001\` | ROOM_FULL | A third peer tried to join a full room. |
| \`4002\` | PEER_DISCONNECTED | Reserved. |
| \`4003\` | ROOM_NOT_FOUND | Reserved. |
| \`4004\` | DUPLICATE_SESSION | Reserved. |
| \`4005\` | PING_TIMEOUT | No \`pong\` received within 60 s. |

### Connection Flow

\`\`\`
Peer A connects  →  wss://.../ws?room=r1&peerId=alice
  ← { type: "onopen", role: "caller", reconnect: false }

Peer B connects  →  wss://.../ws?room=r1&peerId=bob
  ← { type: "onopen", role: "callee", reconnect: false }
  ← { type: "enter" }  (broadcast to room)

WebRTC signaling (caller initiates):
  B → { type: "offer",         offer: {...} }        →  relayed to A
  A → { type: "answer",        answer: {...} }        →  relayed to B
  * → { type: "ice-candidate", candidate: {...} }     →  relayed to other peer

Heartbeat (every 60 s):
  ← { type: "ping" }
  → { type: "pong" }   (consumed, not relayed)

Peer A drops:
  ← { type: "onclose", message: "peer disconnected" }  (broadcast)
  Reconnect window: 60 minutes

Peer A reconnects  →  wss://.../ws?room=r1&peerId=alice
  ← { type: "onopen", role: "caller", reconnect: true }
  ← { type: "peer-reconnected" }  (broadcast to room)
\`\`\`
`

export const app = new Elysia()
  .use(openapi({
    path: '/reference',
    documentation: {
      info: {
        title: 'Signaling Server',
        version: '2.0.0',
        description: WS_DOCS,
      },
    },
  }))
  .get('/', () => 'Hello Ma friend', {
    detail: {
      summary: 'Health check',
      description: 'Returns a plain-text greeting to confirm the server is running.',
      tags: ['System'],
    },
  })
  .ws('/ws', {
    query: t.Object({ room: t.String(), peerId: t.String() }),
    beforeHandle,
    open,
    close,
    message,
  } as any)
