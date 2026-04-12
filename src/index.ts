import { app } from './app'

const port = Number(process.env.PORT) || 9999

app.listen({ port })

console.log(`Listening at :${app.server?.port}`)
