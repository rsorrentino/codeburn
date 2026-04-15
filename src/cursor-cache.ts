import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

type CacheEntry = {
  lastCreatedAt: string
  dbSizeBytes: number
}

const CACHE_FILE = 'cursor-cache.json'

function getCacheDir(): string {
  return join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

export async function readCursorCache(): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    return JSON.parse(raw) as CacheEntry
  } catch {
    return null
  }
}

export async function writeCursorCache(lastCreatedAt: string, dbSizeBytes: number): Promise<void> {
  const dir = getCacheDir()
  await mkdir(dir, { recursive: true })
  const entry: CacheEntry = { lastCreatedAt, dbSizeBytes }
  await writeFile(getCachePath(), JSON.stringify(entry), 'utf-8')
}
