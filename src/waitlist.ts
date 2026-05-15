import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import postgres from 'postgres'
import { logger } from './logger'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL env var is required for the waitlist route')
}

const db = postgres(databaseUrl)

await db`CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

export const waitlist = new Elysia()
  .use(cors({ origin: '*' }))
  .post(
    '/waitlist',
    async ({ body, set }) => {
      const email = body.email.trim().toLowerCase()
      try {
        await db`INSERT INTO waitlist (email) VALUES (${email}) ON CONFLICT DO NOTHING`
        return { ok: true }
      } catch (err) {
        logger.warn({ err, email }, 'failed to insert waitlist email')
        set.status = 500
        return { ok: false, error: 'internal' }
      }
    },
    {
      body: t.Object({
        email: t.String({
          pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
          maxLength: 254,
        }),
      }),
      detail: {
        summary: 'Join waitlist',
        description:
          'Submit an email to join the waitlist. Duplicates are ignored silently and still return `{ ok: true }`.',
        tags: ['Waitlist'],
      },
    },
  )
