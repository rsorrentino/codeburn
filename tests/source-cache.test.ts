import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  SOURCE_CACHE_VERSION,
  emptySourceCacheManifest,
  loadSourceCacheManifest,
  saveSourceCacheManifest,
  readSourceCacheEntry,
  writeSourceCacheEntry,
  computeFileFingerprint,
  type SourceCacheEntry,
} from '../src/source-cache.js'
import type { SessionSummary } from '../src/types.js'

let root = ''

function emptySession(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    project: 'project',
    firstTimestamp: '2026-04-10T00:00:00Z',
    lastTimestamp: '2026-04-10T00:00:00Z',
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 0,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {},
    ...overrides,
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-source-cache-'))
  process.env['CODEBURN_CACHE_DIR'] = root
})

afterEach(async () => {
  delete process.env['CODEBURN_CACHE_DIR']
  if (root) await rm(root, { recursive: true, force: true })
})

describe('source cache manifest', () => {
  it('returns an empty manifest when no file exists', async () => {
    await expect(loadSourceCacheManifest()).resolves.toEqual(emptySourceCacheManifest())
  })

  it('returns an empty manifest when the manifest shape is invalid', async () => {
    await mkdir(join(root, 'source-cache-v1'), { recursive: true })
    await writeFile(join(root, 'source-cache-v1', 'manifest.json'), JSON.stringify({
      version: SOURCE_CACHE_VERSION,
      entries: { bad: { file: 123, provider: 'fake' } },
    }), 'utf-8')

    await expect(loadSourceCacheManifest()).resolves.toEqual(emptySourceCacheManifest())
  })

  it('returns an empty manifest when an entry filename is unsafe', async () => {
    await mkdir(join(root, 'source-cache-v1'), { recursive: true })
    await writeFile(join(root, 'source-cache-v1', 'manifest.json'), JSON.stringify({
      version: SOURCE_CACHE_VERSION,
      entries: {
        bad: {
          file: '../escape.json',
          provider: 'fake',
          logicalPath: join(root, 'source.jsonl'),
        },
      },
    }), 'utf-8')

    await expect(loadSourceCacheManifest()).resolves.toEqual(emptySourceCacheManifest())
  })

  it('round-trips a manifest and entry', async () => {
    const sourcePath = join(root, 'source.jsonl')
    await writeFile(sourcePath, '{"ok":true}\n', 'utf-8')
    const fingerprint = await computeFileFingerprint(sourcePath)
    const entry: SourceCacheEntry = {
      version: SOURCE_CACHE_VERSION,
      provider: 'fake',
      logicalPath: sourcePath,
      fingerprintPath: sourcePath,
      cacheStrategy: 'full-reparse',
      parserVersion: 'fake-v1',
      fingerprint,
      sessions: [],
    }

    const manifest = await loadSourceCacheManifest()
    await writeSourceCacheEntry(manifest, entry)
    await saveSourceCacheManifest(manifest)

    const loadedManifest = await loadSourceCacheManifest()
    const loadedEntry = await readSourceCacheEntry(loadedManifest, 'fake', sourcePath)
    expect(loadedEntry).toEqual(entry)
  })

  it('returns null when the fingerprint no longer matches', async () => {
    const sourcePath = join(root, 'source.jsonl')
    await writeFile(sourcePath, 'one\n', 'utf-8')
    const fingerprint = await computeFileFingerprint(sourcePath)
    const entry: SourceCacheEntry = {
      version: SOURCE_CACHE_VERSION,
      provider: 'fake',
      logicalPath: sourcePath,
      fingerprintPath: sourcePath,
      cacheStrategy: 'full-reparse',
      parserVersion: 'fake-v1',
      fingerprint,
      sessions: [],
    }

    const manifest = await loadSourceCacheManifest()
    await writeSourceCacheEntry(manifest, entry)
    await saveSourceCacheManifest(manifest)

    await writeFile(sourcePath, 'one\ntwo\n', 'utf-8')
    const loaded = await readSourceCacheEntry(await loadSourceCacheManifest(), 'fake', sourcePath)
    expect(loaded).toBeNull()
  })

  it('returns null when the cached entry shape is invalid', async () => {
    const sourcePath = join(root, 'source.jsonl')
    await writeFile(sourcePath, 'one\n', 'utf-8')
    const manifest = await loadSourceCacheManifest()
    const file = `${createHash('sha1').update(`fake:${sourcePath}`).digest('hex')}.json`
    manifest.entries[`fake:${sourcePath}`] = { file, provider: 'fake', logicalPath: sourcePath }
    await saveSourceCacheManifest(manifest)
    await mkdir(join(root, 'source-cache-v1', 'entries'), { recursive: true })
    await writeFile(join(root, 'source-cache-v1', 'entries', file), JSON.stringify({
      version: SOURCE_CACHE_VERSION,
      provider: 'fake',
      logicalPath: sourcePath,
      fingerprintPath: sourcePath,
      cacheStrategy: 'full-reparse',
      parserVersion: 'fake-v1',
      fingerprint: { mtimeMs: 'nope', sizeBytes: 4 },
      sessions: [],
    }), 'utf-8')

    const loaded = await readSourceCacheEntry(await loadSourceCacheManifest(), 'fake', sourcePath)
    expect(loaded).toBeNull()
  })

  it('returns null when the manifest metadata does not match the lookup request', async () => {
    const sourcePath = join(root, 'source.jsonl')
    await writeFile(sourcePath, 'one\n', 'utf-8')
    const fingerprint = await computeFileFingerprint(sourcePath)
    const file = `${createHash('sha1').update(`fake:${sourcePath}`).digest('hex')}.json`
    const manifest = await loadSourceCacheManifest()
    manifest.entries[`fake:${sourcePath}`] = {
      file,
      provider: 'other',
      logicalPath: sourcePath,
    }
    await saveSourceCacheManifest(manifest)
    await mkdir(join(root, 'source-cache-v1', 'entries'), { recursive: true })
    await writeFile(join(root, 'source-cache-v1', 'entries', file), JSON.stringify({
      version: SOURCE_CACHE_VERSION,
      provider: 'fake',
      logicalPath: sourcePath,
      fingerprintPath: sourcePath,
      cacheStrategy: 'full-reparse',
      parserVersion: 'fake-v1',
      fingerprint,
      sessions: [],
    }), 'utf-8')

    const loaded = await readSourceCacheEntry(await loadSourceCacheManifest(), 'fake', sourcePath)
    expect(loaded).toBeNull()
  })

  it('returns null when a nested assistant call is malformed', async () => {
    const sourcePath = join(root, 'source.jsonl')
    await writeFile(sourcePath, 'one\n', 'utf-8')
    const fingerprint = await computeFileFingerprint(sourcePath)
    const entry: SourceCacheEntry = {
      version: SOURCE_CACHE_VERSION,
      provider: 'fake',
      logicalPath: sourcePath,
      fingerprintPath: sourcePath,
      cacheStrategy: 'full-reparse',
      parserVersion: 'fake-v1',
      fingerprint,
      sessions: [
        emptySession('session-1', {
          turns: [{
            userMessage: 'hello',
            assistantCalls: [{
              provider: 'fake',
              model: 'model',
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                webSearchRequests: 0,
              },
              costUSD: 1,
              tools: [],
              mcpTools: [],
              hasAgentSpawn: false,
              hasPlanMode: false,
              speed: 'standard',
              timestamp: '2026-04-10T00:00:00Z',
              bashCommands: [],
              deduplicationKey: 'k',
            }],
            timestamp: '2026-04-10T00:00:00Z',
            sessionId: 'session-1',
          }],
        }),
      ],
    }

    const manifest = await loadSourceCacheManifest()
    await writeSourceCacheEntry(manifest, entry)
    await saveSourceCacheManifest(manifest)

    await writeFile(join(root, 'source-cache-v1', 'entries', `${createHash('sha1').update(`fake:${sourcePath}`).digest('hex')}.json`), JSON.stringify({
      ...entry,
      sessions: [{
        ...entry.sessions[0],
        turns: [{
          ...entry.sessions[0].turns[0],
          assistantCalls: [{
            ...entry.sessions[0].turns[0].assistantCalls[0],
            usage: { ...entry.sessions[0].turns[0].assistantCalls[0].usage, inputTokens: 'bad' },
          }],
        }],
      }],
    }), 'utf-8')

    const loaded = await readSourceCacheEntry(await loadSourceCacheManifest(), 'fake', sourcePath)
    expect(loaded).toBeNull()
  })

  it('returns null when append state is malformed', async () => {
    const sourcePath = join(root, 'source.jsonl')
    await writeFile(sourcePath, 'one\n', 'utf-8')
    const fingerprint = await computeFileFingerprint(sourcePath)
    const entry = {
      version: SOURCE_CACHE_VERSION,
      provider: 'fake',
      logicalPath: sourcePath,
      fingerprintPath: sourcePath,
      cacheStrategy: 'append-jsonl' as const,
      parserVersion: 'fake-v1',
      fingerprint,
      sessions: [],
      appendState: { endOffset: 'bad', tailHash: 'abc' },
    }

    const manifest = await loadSourceCacheManifest()
    await writeSourceCacheEntry(manifest, entry as SourceCacheEntry)
    await saveSourceCacheManifest(manifest)

    const loaded = await readSourceCacheEntry(await loadSourceCacheManifest(), 'fake', sourcePath)
    expect(loaded).toBeNull()
  })

  it('returns null when a breakdown map contains malformed values', async () => {
    const sourcePath = join(root, 'source.jsonl')
    await writeFile(sourcePath, 'one\n', 'utf-8')
    const fingerprint = await computeFileFingerprint(sourcePath)
    const entry: SourceCacheEntry = {
      version: SOURCE_CACHE_VERSION,
      provider: 'fake',
      logicalPath: sourcePath,
      fingerprintPath: sourcePath,
      cacheStrategy: 'full-reparse',
      parserVersion: 'fake-v1',
      fingerprint,
      sessions: [
        emptySession('session-2', {
          modelBreakdown: {
            modelA: {
              calls: 'bad',
              costUSD: 0,
              tokens: {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                webSearchRequests: 0,
              },
            },
          },
        }),
      ],
    }

    const manifest = await loadSourceCacheManifest()
    await writeSourceCacheEntry(manifest, entry)
    await saveSourceCacheManifest(manifest)

    const loaded = await readSourceCacheEntry(await loadSourceCacheManifest(), 'fake', sourcePath)
    expect(loaded).toBeNull()
  })

  it('writes atomically without leaving temp files behind', async () => {
    const sourcePath = join(root, 'source.jsonl')
    await writeFile(sourcePath, 'x\n', 'utf-8')
    const manifest = await loadSourceCacheManifest()
    await writeSourceCacheEntry(manifest, {
      version: SOURCE_CACHE_VERSION,
      provider: 'fake',
      logicalPath: sourcePath,
      fingerprintPath: sourcePath,
      cacheStrategy: 'full-reparse',
      parserVersion: 'fake-v1',
      fingerprint: await computeFileFingerprint(sourcePath),
      sessions: [],
    })
    await saveSourceCacheManifest(manifest)

    const files = JSON.parse(await readFile(join(root, 'source-cache-v1', 'manifest.json'), 'utf-8'))
    expect(files.version).toBe(SOURCE_CACHE_VERSION)
    expect(existsSync(join(root, 'source-cache-v1', 'entries'))).toBe(true)
    const cacheFiles = await readdir(join(root, 'source-cache-v1'))
    const entryFiles = await readdir(join(root, 'source-cache-v1', 'entries'))
    expect(cacheFiles.some(f => f.endsWith('.tmp'))).toBe(false)
    expect(entryFiles.some(f => f.endsWith('.tmp'))).toBe(false)
  })

  it('does not mutate the manifest when the entry write fails', async () => {
    const sourcePath = join(root, 'source.jsonl')
    await writeFile(sourcePath, 'x\n', 'utf-8')
    const manifest = await loadSourceCacheManifest()
    const provider = 'fake'
    const logicalPath = sourcePath
    const file = `${createHash('sha1').update(`${provider}:${logicalPath}`).digest('hex')}.json`
    await mkdir(join(root, 'source-cache-v1', 'entries', file), { recursive: true })

    await expect(writeSourceCacheEntry(manifest, {
      version: SOURCE_CACHE_VERSION,
      provider,
      logicalPath,
      fingerprintPath: sourcePath,
      cacheStrategy: 'full-reparse',
      parserVersion: 'fake-v1',
      fingerprint: await computeFileFingerprint(sourcePath),
      sessions: [],
    })).rejects.toBeTruthy()

    expect(manifest.entries[`fake:${sourcePath}`]).toBeUndefined()
  })
})
