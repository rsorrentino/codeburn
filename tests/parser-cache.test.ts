import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ParsedProviderCall, Provider, SessionSource } from '../src/providers/types.js'

let root = ''
let sourcePath = ''
let parseCalls = 0

function makeCall(index: number): ParsedProviderCall {
  const second = String(index).padStart(2, '0')
  return {
    provider: 'fake',
    model: 'gpt-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.01,
    tools: ['Edit'],
    bashCommands: [],
    timestamp: `2026-04-20T09:00:${second}.000Z`,
    speed: 'standard',
    deduplicationKey: `fake:${index}`,
    userMessage: `prompt ${index}`,
    sessionId: 'fake-session',
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-parser-cache-'))
  sourcePath = join(root, 'fake.jsonl')
  parseCalls = 0
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  await writeFile(sourcePath, 'one\n', 'utf-8')
})

afterEach(async () => {
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(root, { recursive: true, force: true })
  vi.resetModules()
  vi.clearAllMocks()
})

describe('parseAllSessions source cache', () => {
  it('reuses unchanged cached sources, refreshes changed sources, and honors noCache', async () => {
    const fakeSource = {
      path: sourcePath,
      fingerprintPath: sourcePath,
      project: 'fake-project',
      provider: 'fake',
      cacheStrategy: 'full-reparse',
      progressLabel: 'fake.jsonl',
    } as SessionSource

    const fakeProvider: Provider = {
      name: 'fake',
      displayName: 'Fake',
      modelDisplayName: model => model,
      toolDisplayName: tool => tool,
      discoverSessions: async () => [fakeSource],
      createSessionParser() {
        return {
          async *parse() {
            parseCalls += 1
            const lineCount = (await readFile(sourcePath, 'utf-8')).trim().split('\n').filter(Boolean).length
            for (let i = 0; i < lineCount; i += 1) yield makeCall(i)
          },
        }
      },
    }

    vi.doMock('../src/providers/index.js', () => ({
      discoverAllSessions: async () => [fakeSource],
      getProvider: async () => fakeProvider,
    }))

    const { parseAllSessions } = await import('../src/parser.js')

    const progress = {
      start: vi.fn(),
      advance: vi.fn(),
      finish: vi.fn(),
    }

    const first = await parseAllSessions(undefined, 'fake', { progress })
    expect(first[0]?.totalApiCalls).toBe(1)
    expect(parseCalls).toBe(1)
    expect(progress.start).toHaveBeenCalledWith('Updating cache', 1)
    expect(progress.advance).toHaveBeenCalledWith('fake.jsonl')
    expect(progress.finish).toHaveBeenCalled()

    const second = await parseAllSessions(undefined, 'fake')
    expect(second[0]?.totalApiCalls).toBe(1)
    expect(parseCalls).toBe(1)

    await writeFile(sourcePath, 'one\ntwo\n', 'utf-8')
    const third = await parseAllSessions(undefined, 'fake')
    expect(third[0]?.totalApiCalls).toBe(2)
    expect(parseCalls).toBe(2)

    const rebuilt = await parseAllSessions(undefined, 'fake', { noCache: true })
    expect(rebuilt[0]?.totalApiCalls).toBe(2)
    expect(parseCalls).toBe(3)
  })

  it('filters cached full sessions down to the requested date range', async () => {
    const fakeSource = {
      path: sourcePath,
      fingerprintPath: sourcePath,
      project: 'fake-project',
      provider: 'fake',
      cacheStrategy: 'full-reparse',
      progressLabel: 'fake.jsonl',
    } as SessionSource

    const fakeProvider: Provider = {
      name: 'fake',
      displayName: 'Fake',
      modelDisplayName: model => model,
      toolDisplayName: tool => tool,
      discoverSessions: async () => [fakeSource],
      createSessionParser() {
        return {
          async *parse() {
            yield makeCall(0)
            yield { ...makeCall(1), timestamp: '2026-04-21T10:00:00.000Z', deduplicationKey: 'fake:next-day' }
          },
        }
      },
    }

    vi.doMock('../src/providers/index.js', () => ({
      discoverAllSessions: async () => [fakeSource],
      getProvider: async () => fakeProvider,
    }))

    const { parseAllSessions } = await import('../src/parser.js')
    await parseAllSessions(undefined, 'fake')

    const onlyFirstDay = await parseAllSessions({
      start: new Date('2026-04-20T00:00:00.000Z'),
      end: new Date('2026-04-20T23:59:59.999Z'),
    }, 'fake')

    expect(onlyFirstDay[0]?.totalApiCalls).toBe(1)
  })
})
