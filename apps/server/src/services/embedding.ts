import type { MemoryEmbeddingProvider } from '@proj-airi/memory-pgvector/ports'

import { useLogger } from '@guiiai/logg'

import { MEMORY_EMBEDDING_DIMENSIONS } from '../schemas/memories'

type ExtractionPipeline = (
  text: string,
  options: { pooling: 'mean', normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>

let pipelinePromise: Promise<ExtractionPipeline> | null = null

async function loadPipeline(): Promise<ExtractionPipeline> {
  const logger = useLogger('embedding').useGlobalConfig()
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')

  const transformers = await import('@huggingface/transformers')

  // pnpm's content-addressed store leaves the default cacheDir read-only;
  // pin caches to a writable user dir so first-call download succeeds.
  const cacheDir = process.env.TRANSFORMERS_CACHE_DIR ?? join(homedir(), '.cache', 'airi-transformers')
  transformers.env.cacheDir = cacheDir
  transformers.env.localModelPath = cacheDir
  transformers.env.allowLocalModels = true
  transformers.env.allowRemoteModels = true

  logger.withFields({ cacheDir }).log('Loading all-MiniLM-L6-v2 (first call may download ~80MB)')
  const pipe = await transformers.pipeline(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2',
  ) as unknown as ExtractionPipeline
  logger.log('Embedding pipeline ready')
  return pipe
}

function getPipeline(): Promise<ExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = loadPipeline().catch((err) => {
      // Don't cache failures — allow retry on next call.
      pipelinePromise = null
      throw err
    })
  }
  return pipelinePromise
}

export function createEmbeddingService(): MemoryEmbeddingProvider {
  return {
    dimensions: MEMORY_EMBEDDING_DIMENSIONS,
    async embed(text: string): Promise<number[]> {
      const pipe = await getPipeline()
      const output = await pipe(text, { pooling: 'mean', normalize: true })
      return Array.from(output.data as Float32Array)
    },
  }
}

export type EmbeddingService = ReturnType<typeof createEmbeddingService>
