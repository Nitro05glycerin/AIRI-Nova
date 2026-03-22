import { migrate } from '@proj-airi/drizzle-orm-browser-migrator/pg'
import { migrations } from '@proj-airi/server-schema'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { sql } from 'drizzle-orm'
import { Pool } from 'pg'

import * as fullSchema from '../schemas'

export type Database = Awaited<ReturnType<typeof createDrizzle>>['db']

export async function createDrizzle(dsn: string) {
  if (dsn === 'pglite' || dsn.startsWith('pglite://')) {
    const dataDir = dsn === 'pglite' ? './pglite-data' : dsn.replace('pglite://', '')
    const client = await PGlite.create({ dataDir, extensions: { vector } })
    const db = drizzlePglite(client, { schema: fullSchema }) as any
    return { db, pool: { end: () => client.close() } as any }
  }
  const pool = new Pool({ connectionString: dsn })
  const db = drizzlePg(pool, { schema: fullSchema })
  return { db, pool }
}

export async function migrateDatabase(db: Database) {
  // Enable vector extension for PGlite
  try { await (db as any).execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`) } catch {}
  return migrate(db, migrations)
}
