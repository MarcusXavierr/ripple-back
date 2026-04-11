import { app } from './app'

app.listen({
  port: 9999,
  tls: {
    cert: Bun.file('/home/marcus/Projects/courses/webrtc/192.168.3.141.pem'),
    key: Bun.file('/home/marcus/Projects/courses/webrtc/192.168.3.141-key.pem'),
  },
})

console.log(`Listening at :${app.server?.port}`)
