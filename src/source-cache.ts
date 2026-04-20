import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'

import type { SessionSummary } from './types.js'

export const SOURCE_CACHE_VERSION = 1

function traceCacheRead(op: string, filePath: string, note?: string): void {
  if (process.env['CODEBURN_FILE_TRACE'] !== '1') return
  const suffix = note ? ` ${note}` : ''
  process.stderr.write(`codeburn-trace source-cache ${op} ${filePath}${suffix}\n`)
}

const APPEND_TAIL_WINDOW_BYTES = 16 * 1024

type SourceCacheStrategy = 'full-reparse' | 'append-jsonl'

type SourceFingerprint = {
  mtimeMs: number
  sizeBytes: number
}

type AppendState = {
  endOffset: number
  tailHash: string
  lastEntryType?: string
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
  entries: Record<string, SourceCacheManifestEntry>
}

export type SourceCacheManifestEntry = {
  file: string
  provider: string
  logicalPath: string
  lastSeenParserVersion?: string
  cacheStrategy?: SourceCacheStrategy
  fingerprintPath?: string
  fingerprint?: SourceFingerprint
  firstTimestamp?: string
  lastTimestamp?: string
  appendState?: AppendState
}

type ReadSourceCacheEntryOptions = {
  allowStaleFingerprint?: boolean
}

type SourceRange = {
  firstTimestamp?: string
  lastTimestamp?: string
}

function sourceCacheKey(provider: string, logicalPath: string): string {
  return `${provider}:${logicalPath}`
}

export function getManifestEntry(manifest: SourceCacheManifest, provider: string, logicalPath: string): SourceCacheManifestEntry | null {
  return manifest.entries[sourceCacheKey(provider, logicalPath)] ?? null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isManifestEntry(value: unknown): value is SourceCacheManifest['entries'][string] {
  const isAppendStateValue = (entry: unknown): entry is AppendState =>
    isPlainObject(entry)
    && typeof entry.endOffset === 'number'
    && Number.isFinite(entry.endOffset)
    && typeof entry.tailHash === 'string'
    && (entry.lastEntryType === undefined || typeof entry.lastEntryType === 'string')

  const isFingerprint = (entry: unknown): entry is SourceFingerprint => isPlainObject(entry)
    && Number.isFinite(entry.mtimeMs)
    && typeof entry.mtimeMs === 'number'
    && Number.isFinite(entry.sizeBytes)
    && typeof entry.sizeBytes === 'number'

  return isPlainObject(value)
    && typeof value.file === 'string'
    && /^[a-f0-9]{40}\.json$/.test(value.file)
    && typeof value.provider === 'string'
    && typeof value.logicalPath === 'string'
    && (value.lastSeenParserVersion === undefined || typeof value.lastSeenParserVersion === 'string')
    && (value.cacheStrategy === undefined || value.cacheStrategy === 'full-reparse' || value.cacheStrategy === 'append-jsonl')
    && (value.fingerprintPath === undefined || typeof value.fingerprintPath === 'string')
    && (value.fingerprint === undefined || isFingerprint(value.fingerprint))
    && (value.firstTimestamp === undefined || typeof value.firstTimestamp === 'string')
    && (value.lastTimestamp === undefined || typeof value.lastTimestamp === 'string')
    && (value.appendState === undefined || isAppendStateValue(value.appendState))
}

function isSessionSummary(value: unknown): value is SessionSummary {
  return isPlainObject(value)
    && typeof value.sessionId === 'string'
    && typeof value.project === 'string'
    && typeof value.firstTimestamp === 'string'
    && typeof value.lastTimestamp === 'string'
    && isFiniteNumber(value.totalCostUSD)
    && isFiniteNumber(value.totalInputTokens)
    && isFiniteNumber(value.totalOutputTokens)
    && isFiniteNumber(value.totalCacheReadTokens)
    && isFiniteNumber(value.totalCacheWriteTokens)
    && isFiniteNumber(value.apiCalls)
    && Array.isArray(value.turns)
    && value.turns.every(isParsedTurn)
    && isBreakdownMap(value.modelBreakdown, isModelBreakdownEntry)
    && isBreakdownMap(value.toolBreakdown, isCallsBreakdownEntry)
    && isBreakdownMap(value.mcpBreakdown, isCallsBreakdownEntry)
    && isBreakdownMap(value.bashBreakdown, isCallsBreakdownEntry)
    && isBreakdownMap(value.categoryBreakdown, isCategoryBreakdownEntry)
}

function isTokenUsage(value: unknown): value is { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; cachedInputTokens: number; reasoningTokens: number; webSearchRequests: number } {
  return isPlainObject(value)
    && isFiniteNumber(value.inputTokens)
    && isFiniteNumber(value.outputTokens)
    && isFiniteNumber(value.cacheCreationInputTokens)
    && isFiniteNumber(value.cacheReadInputTokens)
    && isFiniteNumber(value.cachedInputTokens)
    && isFiniteNumber(value.reasoningTokens)
    && isFiniteNumber(value.webSearchRequests)
}

function isParsedApiCall(value: unknown): boolean {
  return isPlainObject(value)
    && typeof value.provider === 'string'
    && typeof value.model === 'string'
    && isTokenUsage(value.usage)
    && isFiniteNumber(value.costUSD)
    && Array.isArray(value.tools)
    && value.tools.every(tool => typeof tool === 'string')
    && Array.isArray(value.mcpTools)
    && value.mcpTools.every(tool => typeof tool === 'string')
    && typeof value.hasAgentSpawn === 'boolean'
    && typeof value.hasPlanMode === 'boolean'
    && (value.speed === 'standard' || value.speed === 'fast')
    && typeof value.timestamp === 'string'
    && Array.isArray(value.bashCommands)
    && value.bashCommands.every(command => typeof command === 'string')
    && typeof value.deduplicationKey === 'string'
}

function isParsedTurn(value: unknown): boolean {
  return isPlainObject(value)
    && typeof value.userMessage === 'string'
    && Array.isArray(value.assistantCalls)
    && value.assistantCalls.every(isParsedApiCall)
    && typeof value.timestamp === 'string'
    && typeof value.sessionId === 'string'
}

function isModelBreakdownEntry(value: unknown): value is { calls: number; costUSD: number; tokens: TokenUsage } {
  return isPlainObject(value)
    && isFiniteNumber(value.calls)
    && isFiniteNumber(value.costUSD)
    && isTokenUsage(value.tokens)
}

type TokenUsage = { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; cachedInputTokens: number; reasoningTokens: number; webSearchRequests: number }

function isCallsBreakdownEntry(value: unknown): value is { calls: number } {
  return isPlainObject(value) && isFiniteNumber(value.calls)
}

function isCategoryBreakdownEntry(value: unknown): value is { turns: number; costUSD: number; retries: number; editTurns: number; oneShotTurns: number } {
  return isPlainObject(value)
    && isFiniteNumber(value.turns)
    && isFiniteNumber(value.costUSD)
    && isFiniteNumber(value.retries)
    && isFiniteNumber(value.editTurns)
    && isFiniteNumber(value.oneShotTurns)
}

function isBreakdownMap<T>(value: unknown, predicate: (entry: unknown) => entry is T): value is Record<string, T> {
  return isPlainObject(value) && Object.values(value).every(predicate)
}

function isAppendState(value: unknown): value is AppendState {
  return isPlainObject(value)
    && typeof value.endOffset === 'number'
    && Number.isFinite(value.endOffset)
    && typeof value.tailHash === 'string'
    && (value.lastEntryType === undefined || typeof value.lastEntryType === 'string')
}

function rangeFromSessions(sessions: SessionSummary[]): SourceRange {
  if (sessions.length === 0) return {}

  let firstTs = sessions[0]?.firstTimestamp
  let lastTs = sessions[sessions.length - 1]?.lastTimestamp
  for (const session of sessions) {
    if (!firstTs || session.firstTimestamp < firstTs) firstTs = session.firstTimestamp
    if (!lastTs || session.lastTimestamp > lastTs) lastTs = session.lastTimestamp
  }

  return {
    firstTimestamp: firstTs,
    lastTimestamp: lastTs,
  }
}

async function readTailStateHash(filePath: string, endOffset: number): Promise<string | null> {
  if (endOffset <= 0) return null
  const start = Math.max(0, endOffset - APPEND_TAIL_WINDOW_BYTES)
  const length = Math.max(0, endOffset - start)
  if (length <= 0) return null

  const handle = await open(filePath, 'r')
  const buffer = Buffer.alloc(length)

  try {
    await handle.read(buffer, 0, length, start)
  } finally {
    await handle.close()
  }

  const chunk = buffer.toString('utf-8').replace(/[\r\n]+$/, '')
  if (chunk.length === 0) return null

  const lastNewline = chunk.lastIndexOf('\n')
  const lastLine = lastNewline >= 0 ? chunk.slice(lastNewline + 1) : chunk
  return lastLine.trim() ? createHash('sha1').update(lastLine).digest('hex') : null
}

function isDateRangeOverlap(
  firstTimestamp: string | undefined,
  lastTimestamp: string | undefined,
  rangeStart: number,
  rangeEnd: number,
): boolean | null {
  if (!firstTimestamp || !lastTimestamp) return null

  const firstMs = new Date(firstTimestamp).getTime()
  const lastMs = new Date(lastTimestamp).getTime()
  if (Number.isNaN(firstMs) || Number.isNaN(lastMs)) return null

  return lastMs >= rangeStart && firstMs <= rangeEnd
}

function isSourceCacheEntry(value: unknown): value is SourceCacheEntry {
  return isPlainObject(value)
    && typeof value.version === 'number'
    && typeof value.provider === 'string'
    && typeof value.logicalPath === 'string'
    && typeof value.fingerprintPath === 'string'
    && (value.cacheStrategy === 'full-reparse' || value.cacheStrategy === 'append-jsonl')
    && typeof value.parserVersion === 'string'
    && isPlainObject(value.fingerprint)
    && Number.isFinite(value.fingerprint.mtimeMs)
    && typeof value.fingerprint.mtimeMs === 'number'
    && Number.isFinite(value.fingerprint.sizeBytes)
    && typeof value.fingerprint.sizeBytes === 'number'
    && Array.isArray(value.sessions)
    && value.sessions.every(isSessionSummary)
    && (value.appendState === undefined || isAppendState(value.appendState))
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

function entryFilename(provider: string, logicalPath: string): string {
  return `${createHash('sha1').update(sourceCacheKey(provider, logicalPath)).digest('hex')}.json`
}

export function emptySourceCacheManifest(): SourceCacheManifest {
  return { version: SOURCE_CACHE_VERSION, entries: {} }
}

export async function computeFileFingerprint(filePath: string): Promise<SourceFingerprint> {
  const meta = await stat(filePath)
  return { mtimeMs: meta.mtimeMs, sizeBytes: meta.size }
}

export async function loadSourceCacheManifest(): Promise<SourceCacheManifest> {
  traceCacheRead('manifest:read', manifestPath())
  if (!existsSync(manifestPath())) return emptySourceCacheManifest()

  try {
    const raw = await readFile(manifestPath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainObject(parsed) || parsed.version !== SOURCE_CACHE_VERSION || !isPlainObject(parsed.entries)) {
      return emptySourceCacheManifest()
    }

    const entries: SourceCacheManifest['entries'] = {}
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!isManifestEntry(value)) return emptySourceCacheManifest()
      entries[key] = value
    }

    return { version: SOURCE_CACHE_VERSION, entries }
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
    } catch {}
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
  options: ReadSourceCacheEntryOptions = {},
): Promise<SourceCacheEntry | null> {
  const meta = manifest.entries[sourceCacheKey(provider, logicalPath)]
  if (!meta) return null
  if (meta.provider !== provider || meta.logicalPath !== logicalPath) return null

  const expectedFile = entryFilename(provider, logicalPath)
  if (meta.file !== expectedFile) return null

  try {
    const raw = await readFile(join(entryDir(), meta.file), 'utf-8')
    traceCacheRead('entry:read', join(entryDir(), meta.file), `provider=${provider} logicalPath=${logicalPath}`)
    const entry: unknown = JSON.parse(raw)
    if (!isSourceCacheEntry(entry) || entry.version !== SOURCE_CACHE_VERSION) return null
    if (entry.provider !== provider || entry.logicalPath !== logicalPath) return null

    if (!options.allowStaleFingerprint) {
      const currentFingerprint = await computeFileFingerprint(entry.fingerprintPath)
      if (
        currentFingerprint.mtimeMs !== entry.fingerprint.mtimeMs
        || currentFingerprint.sizeBytes !== entry.fingerprint.sizeBytes
      ) {
        const sizeMatches = currentFingerprint.sizeBytes === entry.fingerprint.sizeBytes
        if (!(
          entry.cacheStrategy === 'append-jsonl'
          && entry.appendState
          && sizeMatches
        )) {
          return null
        }

        const liveTailHash = await readTailStateHash(entry.fingerprintPath, entry.appendState.endOffset)
        if (liveTailHash !== entry.appendState.tailHash) return null
      }
    }

    return entry
  } catch {
    return null
  }
}

export async function writeSourceCacheEntry(manifest: SourceCacheManifest, entry: SourceCacheEntry): Promise<void> {
  await mkdir(entryDir(), { recursive: true })
  const file = entryFilename(entry.provider, entry.logicalPath)
  await atomicWriteJson(join(entryDir(), file), entry)
  const range = rangeFromSessions(entry.sessions)
  manifest.entries[sourceCacheKey(entry.provider, entry.logicalPath)] = {
    file,
    provider: entry.provider,
    logicalPath: entry.logicalPath,
    lastSeenParserVersion: entry.parserVersion,
    cacheStrategy: entry.cacheStrategy,
    fingerprintPath: entry.fingerprintPath,
    fingerprint: entry.fingerprint,
    ...range,
    appendState: entry.appendState,
  }
}

export function isManifestDateRangeOverlap(
  manifestEntry: SourceCacheManifestEntry | null,
  dateRange?: { start: Date; end: Date },
): boolean | null {
  if (!manifestEntry || !dateRange) return null
  return isDateRangeOverlap(manifestEntry.firstTimestamp, manifestEntry.lastTimestamp, dateRange.start.getTime(), dateRange.end.getTime())
}
