import { app } from './app'
import { startHeartbeat } from './heartbeat'
import { startGC } from './gc'

app.listen({
  port: 9999,
  tls: {
    cert: Bun.file('/home/marcus/Projects/courses/webrtc/192.168.3.141.pem'),
    key: Bun.file('/home/marcus/Projects/courses/webrtc/192.168.3.141-key.pem'),
  },
})

startHeartbeat()
startGC()

console.log(`Listening at :${app.server?.port}`)
