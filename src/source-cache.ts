import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'

import type { SessionSummary } from './types.js'

export const SOURCE_CACHE_VERSION = 1

export type SourceCacheStrategy = 'full-reparse' | 'append-jsonl'

export type SourceFingerprint = {
  mtimeMs: number
  sizeBytes: number
}

export type AppendState = {
  endOffset: number
  tailHash: string
}

export type SourceCacheEntry = {
  version: number
  provider: string
  logicalPath: string
  fingerprintPath: string
  cacheStrategy: SourceCacheStrategy
  parserVersion: string
  fingerprint: SourceFingerprint
  sessions: SessionSummary[]
  appendState?: AppendState
}

export type SourceCacheManifest = {
  version: number
  entries: Record<string, { file: string; provider: string; logicalPath: string }>
}

function cacheRoot(): string {
  const base = process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
  return join(base, 'source-cache-v1')
}

function manifestPath(): string {
  return join(cacheRoot(), 'manifest.json')
}

function entryDir(): string {
  return join(cacheRoot(), 'entries')
}

function sourceKey(provider: string, logicalPath: string): string {
  return `${provider}:${logicalPath}`
}

function entryFilename(provider: string, logicalPath: string): string {
  return `${createHash('sha1').update(sourceKey(provider, logicalPath)).digest('hex')}.json`
}

export function emptySourceCacheManifest(): SourceCacheManifest {
  return { version: SOURCE_CACHE_VERSION, entries: {} }
}

export async function computeFileFingerprint(filePath: string): Promise<SourceFingerprint> {
  const meta = await stat(filePath)
  return { mtimeMs: meta.mtimeMs, sizeBytes: meta.size }
}

export async function loadSourceCacheManifest(): Promise<SourceCacheManifest> {
  if (!existsSync(manifestPath())) return emptySourceCacheManifest()

  try {
    const raw = await readFile(manifestPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SourceCacheManifest>
    if (parsed.version !== SOURCE_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      return emptySourceCacheManifest()
    }
    return { version: SOURCE_CACHE_VERSION, entries: parsed.entries as SourceCacheManifest['entries'] }
  } catch {
    return emptySourceCacheManifest()
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value), { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await rename(temp, path)
  } catch (err) {
    try {
      await unlink(temp)
    } catch {
      // ignore cleanup failures
    }
    throw err
  }
}

export async function saveSourceCacheManifest(manifest: SourceCacheManifest): Promise<void> {
  await mkdir(cacheRoot(), { recursive: true })
  await atomicWriteJson(manifestPath(), manifest)
}

export async function readSourceCacheEntry(
  manifest: SourceCacheManifest,
  provider: string,
  logicalPath: string,
): Promise<SourceCacheEntry | null> {
  const meta = manifest.entries[sourceKey(provider, logicalPath)]
  if (!meta) return null

  try {
    const raw = await readFile(join(entryDir(), meta.file), 'utf-8')
    const entry = JSON.parse(raw) as SourceCacheEntry
    if (entry.version !== SOURCE_CACHE_VERSION) return null

    const currentFingerprint = await computeFileFingerprint(entry.fingerprintPath)
    if (
      currentFingerprint.mtimeMs !== entry.fingerprint.mtimeMs
      || currentFingerprint.sizeBytes !== entry.fingerprint.sizeBytes
    ) {
      return null
    }

    return entry
  } catch {
    return null
  }
}

export async function writeSourceCacheEntry(manifest: SourceCacheManifest, entry: SourceCacheEntry): Promise<void> {
  await mkdir(entryDir(), { recursive: true })
  const file = entryFilename(entry.provider, entry.logicalPath)
  manifest.entries[sourceKey(entry.provider, entry.logicalPath)] = {
    file,
    provider: entry.provider,
    logicalPath: entry.logicalPath,
  }
  await atomicWriteJson(join(entryDir(), file), entry)
}
