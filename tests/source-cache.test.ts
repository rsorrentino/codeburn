import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
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

let root = ''

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
  })
})
