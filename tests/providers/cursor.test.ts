import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { getAllProviders } from '../../src/providers/index.js'
import { createCursorProvider } from '../../src/providers/cursor.js'
import { createOpenCodeProvider } from '../../src/providers/opencode.js'
import type { Provider } from '../../src/providers/types.js'
import { isSqliteAvailable } from '../../src/sqlite.js'

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

describe('cursor provider', () => {
  let cursorProvider: Provider

  beforeEach(async () => {
    const all = await getAllProviders()
    cursorProvider = all.find(p => p.name === 'cursor')!
  })
  it('is registered', () => {
    expect(cursorProvider).toBeDefined()
    expect(cursorProvider.name).toBe('cursor')
    expect(cursorProvider.displayName).toBe('Cursor')
  })

  describe('model display names', () => {
    it('maps default to Auto with estimation label', () => {
      expect(cursorProvider.modelDisplayName('default')).toBe('Auto (Sonnet est.)')
    })

    it('maps known models to readable names', () => {
      expect(cursorProvider.modelDisplayName('claude-4.5-opus-high-thinking')).toBe('Opus 4.5 (Thinking)')
      expect(cursorProvider.modelDisplayName('claude-4-sonnet-thinking')).toBe('Sonnet 4 (Thinking)')
      expect(cursorProvider.modelDisplayName('grok-code-fast-1')).toBe('Grok Code Fast')
      expect(cursorProvider.modelDisplayName('gemini-3-pro')).toBe('Gemini 3 Pro')
      expect(cursorProvider.modelDisplayName('gpt-5')).toBe('GPT-5')
      expect(cursorProvider.modelDisplayName('composer-1')).toBe('Composer 1')
    })

    it('returns raw name for unknown models', () => {
      expect(cursorProvider.modelDisplayName('some-future-model')).toBe('some-future-model')
    })
  })

  describe('tool display names', () => {
    it('returns raw tool name as identity', () => {
      expect(cursorProvider.toolDisplayName('some_tool')).toBe('some_tool')
    })
  })

  describe('session discovery', () => {
    it('returns empty when sqlite is not available', async () => {
      const sessions = await cursorProvider.discoverSessions()
      expect(Array.isArray(sessions)).toBe(true)
    })

    it('returns empty when db does not exist', async () => {
      const sessions = await cursorProvider.discoverSessions()
      expect(sessions.every(s => s.provider === 'cursor')).toBe(true)
    })
  })
})

describe('cursor sqlite adapter', () => {
  it('reports availability', async () => {
    const { isSqliteAvailable } = await import('../../src/sqlite.js')
    const available = isSqliteAvailable()
    expect(typeof available).toBe('boolean')
  })

  it('provides error message when not available', async () => {
    const { getSqliteLoadError } = await import('../../src/sqlite.js')
    const error = getSqliteLoadError()
    expect(typeof error).toBe('string')
    expect(error.length).toBeGreaterThan(0)
  })
})

skipUnlessSqlite('shared cache metadata', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'provider-cache-meta-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function createOpenCodeTestDb(dir: string): Promise<string> {
    const ocDir = join(dir, 'opencode')
    const dbPath = join(ocDir, 'opencode.db')
    const { DatabaseSync: Database } = require('node:sqlite')

    await mkdir(ocDir, { recursive: true })
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
        slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
        version TEXT NOT NULL, time_created INTEGER, time_updated INTEGER,
        time_archived INTEGER
      )
    `)
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
        session_id TEXT NOT NULL, time_created INTEGER,
        time_updated INTEGER, data TEXT NOT NULL
      )
    `)
    db.prepare(`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('sess-1', 'proj-1', 'slug-1', '/home/user/myproject', 'My Project', '1.0', 1700000000000)
    db.close()
    return dbPath
  }

  it('cursor exposes the sqlite database as its fingerprint path', async () => {
    const dbPath = join(tmpDir, 'state.vscdb')
    await writeFile(dbPath, '')

    const cursor = createCursorProvider(dbPath)
    const sources = await cursor.discoverSessions()

    expect(sources).toHaveLength(1)
    for (const source of sources) {
      expect(source.cacheStrategy).toBe('full-reparse')
      expect(source.fingerprintPath).toBe(source.path)
      expect(source.progressLabel).toBe('Cursor state.vscdb')
      expect(source.parserVersion).toBe('cursor:v1')
    }
  })

  it('opencode sources fingerprint the backing database, not the logical dbPath:sessionId key', async () => {
    const dbPath = await createOpenCodeTestDb(tmpDir)

    const opencode = createOpenCodeProvider(tmpDir)
    const sources = await opencode.discoverSessions()

    expect(sources).toHaveLength(1)
    for (const source of sources) {
      expect(source.cacheStrategy).toBe('full-reparse')
      expect(source.fingerprintPath).toBeTruthy()
      expect(source.fingerprintPath).toBe(dbPath)
      expect(source.fingerprintPath).not.toBe(source.path)
      expect(source.progressLabel).toBe('opencode:sess-1')
      expect(source.parserVersion).toBe('opencode:v1')
    }
  })
})
