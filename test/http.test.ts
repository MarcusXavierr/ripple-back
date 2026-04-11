import { describe, expect, it } from 'bun:test'
import { app } from '../src/app'

describe('HTTP', () => {
  it('GET / returns "Hello Ma friend"', async () => {
    const res = await app.handle(new Request('http://localhost/'))
    expect(await res.text()).toBe('Hello Ma friend')
  })

  it('unknown route returns 404', async () => {
    const res = await app.handle(new Request('http://localhost/unknown'))
    expect(res.status).toBe(404)
  })
})
