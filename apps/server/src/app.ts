import type { HonoEnv } from './types/hono'

import process from 'node:process'

import { initLogger, LoggerFormat, LoggerLevel, useLogger } from '@guiiai/logg'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { createLoggLogger, injeca, lifecycle } from 'injeca'

import { createAuth } from './libs/auth'
import { createDrizzle, migrateDatabase } from './libs/db'
import { parsedEnv } from './libs/env'
import { initOtel } from './libs/otel'
import { sessionMiddleware } from './middlewares/auth'
import { otelMiddleware } from './middlewares/otel'
import { createCharacterRoutes } from './routes/characters'
import { createChatRoutes } from './routes/chats'
import { createKnowledgeRoutes } from './routes/knowledge'
import { createMemoryRoutes } from './routes/memory'
import { createProviderRoutes } from './routes/providers'
import { createWebRoutes } from './routes/web'
import { createCharacterService } from './services/characters'
import { createChatService } from './services/chats'
import { createEmbeddingService } from './services/embedding'
import { createMemoryService, ensureMemoryTable } from './services/memory'
import { createProviderService } from './services/providers'
import { ApiError, createInternalError } from './utils/error'
import { getTrustedOrigin } from './utils/origin'

type AuthService = ReturnType<typeof createAuth>
type CharacterService = ReturnType<typeof createCharacterService>
type ChatService = ReturnType<typeof createChatService>
type ProviderService = ReturnType<typeof createProviderService>
type MemoryService = ReturnType<typeof createMemoryService>

type OtelMetrics = ReturnType<typeof initOtel>

interface AppDeps {
  auth: AuthService
  characterService: CharacterService
  chatService: ChatService
  providerService: ProviderService
  memoryService: MemoryService
  knowledgeRoot: string
  searxngUrl: string
  otel: OtelMetrics | null
}

function buildApp({ auth, characterService, chatService, providerService, memoryService, knowledgeRoot, searxngUrl, otel }: AppDeps) {
  const logger = useLogger('app').useGlobalConfig()

  const app = new Hono<HonoEnv>()
    .use(
      '/api/*',
      cors({
        origin: origin => getTrustedOrigin(origin),
        credentials: true,
      }),
    )
    .use(honoLogger())

  if (otel) {
    app.use('*', otelMiddleware(otel))
  }

  return app
    .use('*', sessionMiddleware(auth))
    .use('*', bodyLimit({ maxSize: 1024 * 1024 }))
    .onError((err, c) => {
      if (err instanceof ApiError) {
        logger.withError(err).warn('API error occurred')

        return c.json({
          error: err.errorCode,
          message: err.message,
          details: err.details,
        }, err.statusCode)
      }

      logger.withError(err).error('Unhandled error')
      const internalError = createInternalError()
      return c.json({
        error: internalError.errorCode,
        message: internalError.message,
      }, internalError.statusCode)
    })

    /**
     * Health check route.
     */
    .on('GET', '/health', c => c.json({ status: 'ok' }))

    /**
     * Auth routes are handled by the auth instance directly,
     * Powered by better-auth.
     */
    .on(['POST', 'GET'], '/api/auth/*', c => auth.handler(c.req.raw))

    /**
     * Character routes are handled by the character service.
     */
    .route('/api/characters', createCharacterRoutes(characterService))

    /**
     * Provider routes are handled by the provider service.
     */
    .route('/api/providers', createProviderRoutes(providerService))

    /**
     * Chat routes are handled by the chat service.
     */
    .route('/api/chats', createChatRoutes(chatService))

    /**
     * Memory routes — Nova's backend brain (Alaya-compatible STM).
     */
    .route('/api/memory', createMemoryRoutes(memoryService))

    /**
     * Knowledge routes — sandboxed file search/read over the knowledge folder.
     */
    .route('/api/knowledge', createKnowledgeRoutes(knowledgeRoot))

    /**
     * Web routes — SearXNG-backed web search.
     */
    .route('/api/web', createWebRoutes(searxngUrl))
}

export type AppType = ReturnType<typeof buildApp>

async function createApp() {
  initLogger(LoggerLevel.Debug, LoggerFormat.Pretty)
  injeca.setLogger(createLoggLogger(useLogger('injeca').useGlobalConfig()))
  const logger = useLogger('app').useGlobalConfig()

  const otel = injeca.provide('otel', {
    dependsOn: { env: parsedEnv, lifecycle },
    build: ({ dependsOn }) => {
      const o = initOtel(dependsOn.env)
      if (!o)
        return null

      dependsOn.lifecycle.appHooks.onStop(() => o.shutdown())
      return o
    },
  })

  const db = injeca.provide('services:db', {
    dependsOn: { env: parsedEnv, lifecycle },
    build: async ({ dependsOn }) => {
      const { db: dbInstance, pool } = await createDrizzle(dependsOn.env.DATABASE_URL)
      await dbInstance.execute('SELECT 1')
      logger.log('Connected to database')
      await migrateDatabase(dbInstance)
      logger.log('Applied schema')

      dependsOn.lifecycle.appHooks.onStop(() => pool.end())
      return dbInstance
    },
  })

  const auth = injeca.provide('services:auth', {
    dependsOn: { db, env: parsedEnv },
    build: ({ dependsOn }) => createAuth(dependsOn.db, dependsOn.env),
  })

  const characterService = injeca.provide('services:characters', {
    dependsOn: { db },
    build: ({ dependsOn }) => createCharacterService(dependsOn.db),
  })

  const providerService = injeca.provide('services:providers', {
    dependsOn: { db },
    build: ({ dependsOn }) => createProviderService(dependsOn.db),
  })

  const chatService = injeca.provide('services:chats', {
    dependsOn: { db },
    build: ({ dependsOn }) => createChatService(dependsOn.db),
  })

  const embeddingService = injeca.provide('services:embedding', {
    dependsOn: {},
    build: () => createEmbeddingService(),
  })

  const memoryService = injeca.provide('services:memory', {
    dependsOn: { db, embedding: embeddingService },
    build: async ({ dependsOn }) => {
      await ensureMemoryTable(dependsOn.db)
      return createMemoryService(dependsOn.db, dependsOn.embedding)
    },
  })

  await injeca.start()
  const resolved = await injeca.resolve({ auth, characterService, chatService, providerService, memoryService, env: parsedEnv, otel })
  const app = buildApp({
    auth: resolved.auth,
    characterService: resolved.characterService,
    chatService: resolved.chatService,
    providerService: resolved.providerService,
    memoryService: resolved.memoryService,
    knowledgeRoot: resolved.env.KNOWLEDGE_ROOT,
    searxngUrl: resolved.env.SEARXNG_URL,
    otel: resolved.otel,
  })

  logger.withFields({ port: 3000 }).log('Server started')

  return app
}

// eslint-disable-next-line antfu/no-top-level-await
const server = serve(await createApp())

// Keep process alive (PGlite workaround)
const keepalive = setInterval(() => {}, 1 << 30)
process.on('SIGTERM', () => { clearInterval(keepalive); server.close() })
process.on('SIGINT', () => { clearInterval(keepalive); server.close() })

function handleError(error: unknown, type: string) {
  useLogger().withError(error).error(type)
}

process.on('uncaughtException', error => handleError(error, 'Uncaught exception'))
process.on('unhandledRejection', error => handleError(error, 'Unhandled rejection'))
