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

  it('GET /reference returns Scalar documentation UI', async () => {
    const res = await app.handle(new Request('http://localhost/reference'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body.toLowerCase()).toContain('scalar')
  })

  it('GET /reference/json returns OpenAPI JSON spec', async () => {
    const res = await app.handle(new Request('http://localhost/reference/json'))
    expect(res.status).toBe(200)
    const spec = await res.json() as any
    expect(spec.openapi).toMatch(/^3\./)
    expect(spec.info.title).toBe('Signaling Server')
    expect(spec.paths['/']).toBeDefined()
  })
})
