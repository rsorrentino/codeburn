import { createHash } from 'crypto'
import { open, readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { directoryPathFromMarker, discoveryDirectoryMarker, isDiscoveryDirectoryMarker, loadDiscoveryCacheEntryUnchecked, saveDiscoveryCache, type DiscoverySnapshotEntry } from './discovery-cache.js'
import { readSessionFile, readSessionLinesFromOffset } from './fs-utils.js'
import { calculateCost, getShortModelName } from './models.js'
import { discoverAllSessions, getProvider } from './providers/index.js'
import type { ParsedProviderCall, Provider, SessionSource } from './providers/types.js'
import {
  computeFileFingerprint,
  getManifestEntry,
  isManifestDateRangeOverlap,
  loadSourceCacheManifest,
  readSourceCacheEntry,
  saveSourceCacheManifest,
  SOURCE_CACHE_VERSION,
  type SourceCacheManifestEntry,
  writeSourceCacheEntry,
} from './source-cache.js'
import type {
  AssistantMessageContent,
  ClassifiedTurn,
  ContentBlock,
  DateRange,
  JournalEntry,
  ParsedApiCall,
  ParsedTurn,
  ProjectSummary,
  SessionSummary,
  TokenUsage,
  ToolUseBlock,
} from './types.js'
import { classifyTurn, BASH_TOOLS } from './classifier.js'
import { extractBashCommands } from './bash-utils.js'

function unsanitizePath(dirName: string): string {
  return dirName.replace(/-/g, '/')
}

function parseJsonlLine(line: string): JournalEntry | null {
  try {
    return JSON.parse(line) as JournalEntry
  } catch {
    return null
  }
}

function extractToolNames(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use')
    .map(b => b.name)
}

function extractMcpTools(tools: string[]): string[] {
  return tools.filter(t => t.startsWith('mcp__'))
}

function extractCoreTools(tools: string[]): string[] {
  return tools.filter(t => !t.startsWith('mcp__'))
}

function extractBashCommandsFromContent(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && BASH_TOOLS.has((b as ToolUseBlock).name))
    .flatMap(b => {
      const command = (b.input as Record<string, unknown>)?.command
      return typeof command === 'string' ? extractBashCommands(command) : []
    })
}

function getUserMessageText(entry: JournalEntry): string {
  if (!entry.message || entry.message.role !== 'user') return ''
  const content = entry.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ')
  }
  return ''
}

function getMessageId(entry: JournalEntry): string | null {
  if (entry.type !== 'assistant') return null
  const msg = entry.message as AssistantMessageContent | undefined
  return msg?.id ?? null
}

function parseApiCall(entry: JournalEntry): ParsedApiCall | null {
  if (entry.type !== 'assistant') return null
  const msg = entry.message as AssistantMessageContent | undefined
  if (!msg?.usage || !msg?.model) return null

  const usage = msg.usage
  const tokens: TokenUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
  }

  const tools = extractToolNames(msg.content ?? [])
  const costUSD = calculateCost(
    msg.model,
    tokens.inputTokens,
    tokens.outputTokens,
    tokens.cacheCreationInputTokens,
    tokens.cacheReadInputTokens,
    tokens.webSearchRequests,
    usage.speed ?? 'standard',
  )

  const bashCmds = extractBashCommandsFromContent(msg.content ?? [])

  return {
    provider: 'claude',
    model: msg.model,
    usage: tokens,
    costUSD,
    tools,
    mcpTools: extractMcpTools(tools),
    hasAgentSpawn: tools.includes('Agent'),
    hasPlanMode: tools.includes('EnterPlanMode'),
    speed: usage.speed ?? 'standard',
    timestamp: entry.timestamp ?? '',
    bashCommands: bashCmds,
    deduplicationKey: msg.id ?? `claude:${entry.timestamp}`,
  }
}

function groupIntoTurns(entries: JournalEntry[], seenMsgIds: Set<string>): ParsedTurn[] {
  const turns: ParsedTurn[] = []
  let currentUserMessage = ''
  let currentCalls: ParsedApiCall[] = []
  let currentTimestamp = ''
  let currentSessionId = ''

  for (const entry of entries) {
    if (entry.type === 'user') {
      const text = getUserMessageText(entry)
      if (text.trim()) {
        if (currentCalls.length > 0) {
          turns.push({
            userMessage: currentUserMessage,
            assistantCalls: currentCalls,
            timestamp: currentTimestamp,
            sessionId: currentSessionId,
          })
        }
        currentUserMessage = text
        currentCalls = []
        currentTimestamp = entry.timestamp ?? ''
        currentSessionId = entry.sessionId ?? ''
      }
    } else if (entry.type === 'assistant') {
      const msgId = getMessageId(entry)
      if (msgId && seenMsgIds.has(msgId)) continue
      if (msgId) seenMsgIds.add(msgId)
      const call = parseApiCall(entry)
      if (call) currentCalls.push(call)
    }
  }

  if (currentCalls.length > 0) {
    turns.push({
      userMessage: currentUserMessage,
      assistantCalls: currentCalls,
      timestamp: currentTimestamp,
      sessionId: currentSessionId,
    })
  }

  return turns
}

function buildSessionSummary(
  sessionId: string,
  project: string,
  turns: ClassifiedTurn[],
): SessionSummary {
  const modelBreakdown: SessionSummary['modelBreakdown'] = Object.create(null)
  const toolBreakdown: SessionSummary['toolBreakdown'] = Object.create(null)
  const mcpBreakdown: SessionSummary['mcpBreakdown'] = Object.create(null)
  const bashBreakdown: SessionSummary['bashBreakdown'] = Object.create(null)
  const categoryBreakdown: SessionSummary['categoryBreakdown'] = Object.create(null)

  let totalCost = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let apiCalls = 0
  let firstTs = ''
  let lastTs = ''

  for (const turn of turns) {
    const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)

    if (!categoryBreakdown[turn.category]) {
      categoryBreakdown[turn.category] = { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
    }
    categoryBreakdown[turn.category].turns++
    categoryBreakdown[turn.category].costUSD += turnCost
    if (turn.hasEdits) {
      categoryBreakdown[turn.category].editTurns++
      categoryBreakdown[turn.category].retries += turn.retries
      if (turn.retries === 0) categoryBreakdown[turn.category].oneShotTurns++
    }

    for (const call of turn.assistantCalls) {
      totalCost += call.costUSD
      totalInput += call.usage.inputTokens
      totalOutput += call.usage.outputTokens
      totalCacheRead += call.usage.cacheReadInputTokens
      totalCacheWrite += call.usage.cacheCreationInputTokens
      apiCalls++

      const modelKey = getShortModelName(call.model)
      if (!modelBreakdown[modelKey]) {
        modelBreakdown[modelKey] = {
          calls: 0,
          costUSD: 0,
          tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
        }
      }
      modelBreakdown[modelKey].calls++
      modelBreakdown[modelKey].costUSD += call.costUSD
      modelBreakdown[modelKey].tokens.inputTokens += call.usage.inputTokens
      modelBreakdown[modelKey].tokens.outputTokens += call.usage.outputTokens
      modelBreakdown[modelKey].tokens.cacheReadInputTokens += call.usage.cacheReadInputTokens
      modelBreakdown[modelKey].tokens.cacheCreationInputTokens += call.usage.cacheCreationInputTokens

      for (const tool of extractCoreTools(call.tools)) {
        toolBreakdown[tool] = toolBreakdown[tool] ?? { calls: 0 }
        toolBreakdown[tool].calls++
      }
      for (const mcp of call.mcpTools) {
        const server = mcp.split('__')[1] ?? mcp
        mcpBreakdown[server] = mcpBreakdown[server] ?? { calls: 0 }
        mcpBreakdown[server].calls++
      }
      for (const cmd of call.bashCommands) {
        bashBreakdown[cmd] = bashBreakdown[cmd] ?? { calls: 0 }
        bashBreakdown[cmd].calls++
      }

      if (!firstTs || call.timestamp < firstTs) firstTs = call.timestamp
      if (!lastTs || call.timestamp > lastTs) lastTs = call.timestamp
    }
  }

  return {
    sessionId,
    project,
    firstTimestamp: firstTs || turns[0]?.timestamp || '',
    lastTimestamp: lastTs || turns[turns.length - 1]?.timestamp || '',
    totalCostUSD: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    apiCalls,
    turns,
    modelBreakdown,
    toolBreakdown,
    mcpBreakdown,
    bashBreakdown,
    categoryBreakdown,
  }
}

export type SourceProgressReporter = {
  start(total: number): void
  advance(provider: string): void
  finish(provider?: string): void
}

export type ParseOptions = {
  noCache?: boolean
  progress?: SourceProgressReporter | null
}

function wrapProgressReporter(progress?: SourceProgressReporter | null): SourceProgressReporter | null {
  if (!progress) return null

  let lastProvider: string | undefined

  return {
    start(total: number) {
      progress.start(total)
    },
    advance(provider: string) {
      lastProvider = provider
      progress.advance(provider)
    },
    finish(provider?: string) {
      progress.finish(provider ?? lastProvider)
    },
  }
}

function addSessionToProjectMap(projectMap: Map<string, SessionSummary[]>, session: SessionSummary) {
  if (session.apiCalls === 0) return
  const existing = projectMap.get(session.project) ?? []
  existing.push(session)
  projectMap.set(session.project, existing)
}

function buildProjects(projectMap: Map<string, SessionSummary[]>): ProjectSummary[] {
  const projects: ProjectSummary[] = []
  for (const [dirName, sessions] of projectMap) {
    projects.push({
      project: dirName,
      projectPath: unsanitizePath(dirName),
      sessions,
      totalCostUSD: sessions.reduce((s, sess) => s + sess.totalCostUSD, 0),
      totalApiCalls: sessions.reduce((s, sess) => s + sess.apiCalls, 0),
    })
  }
  return projects
}

function filterSessionSummaryToRange(session: SessionSummary, dateRange?: DateRange): SessionSummary | null {
  if (!dateRange) return session

  const turns = session.turns
    .map(turn => ({
      ...turn,
      assistantCalls: turn.assistantCalls.filter(call => {
        const ts = new Date(call.timestamp)
        return ts >= dateRange.start && ts <= dateRange.end
      }),
    }))
    .filter(turn => turn.assistantCalls.length > 0)

  if (turns.length === 0) return null
  return buildSessionSummary(session.sessionId, session.project, turns)
}

function addSeenDeduplicationKeysFromSessions(sessions: SessionSummary[], seenKeys: Set<string>) {
  for (const session of sessions) {
    for (const turn of session.turns) {
      for (const call of turn.assistantCalls) {
        seenKeys.add(call.deduplicationKey)
      }
    }
  }
}

function buildSessionSummaryFromEntries(
  entries: JournalEntry[],
  project: string,
  seenMsgIds: Set<string>,
  sessionIdFallback: string,
  dateRange?: DateRange,
): SessionSummary | null {
  if (entries.length === 0) return null

  let filteredEntries = entries
  if (dateRange) {
    filteredEntries = entries.filter(entry => {
      if (!entry.timestamp) return entry.type === 'user'
      const ts = new Date(entry.timestamp)
      return ts >= dateRange.start && ts <= dateRange.end
    })
    if (filteredEntries.length === 0) return null
  }

  const sessionId = entries.find(entry => typeof entry.sessionId === 'string')?.sessionId ?? sessionIdFallback
  const turns = groupIntoTurns(filteredEntries, seenMsgIds)
  if (turns.length === 0) return null

  return buildSessionSummary(sessionId, project, turns.map(classifyTurn))
}

function buildClaudeSessionSummaryFromLines(
  lines: string[],
  project: string,
  seenMsgIds: Set<string>,
  sessionIdFallback: string,
  dateRange?: DateRange,
): SessionSummary | null {
  const entries = lines
    .map(parseJsonlLine)
    .filter((entry): entry is JournalEntry => entry !== null)
  return buildSessionSummaryFromEntries(entries, project, seenMsgIds, sessionIdFallback, dateRange)
}

async function parseSessionFile(
  filePath: string,
  project: string,
  seenMsgIds: Set<string>,
  dateRange?: DateRange,
): Promise<SessionSummary | null> {
  // Skip files whose mtime is older than the range start. A session file
  // can only contain entries up to its last-modified time; if that predates
  // the requested range, nothing in this file can match.
  if (dateRange) {
    try {
      const s = await stat(filePath)
      if (s.mtimeMs < dateRange.start.getTime()) return null
    } catch { /* fall through to normal read; missing stat shouldn't break parsing */ }
  }
  const content = await readSessionFile(filePath)
  if (content === null) return null
  const lines = content.split('\n').filter(l => l.trim())
  return buildClaudeSessionSummaryFromLines(lines, project, seenMsgIds, basename(filePath, '.jsonl'), dateRange)
}

async function collectJsonlFiles(dirPath: string): Promise<string[]> {
  const files = await readdir(dirPath).catch(() => [])
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).map(f => join(dirPath, f))

  for (const entry of files) {
    if (entry.endsWith('.jsonl')) continue
    const subagentsPath = join(dirPath, entry, 'subagents')
    const subFiles = await readdir(subagentsPath).catch(() => [])
    for (const sf of subFiles) {
      if (sf.endsWith('.jsonl')) jsonlFiles.push(join(subagentsPath, sf))
    }
  }

  return jsonlFiles
}

const CLAUDE_TAIL_WINDOW_BYTES = 16 * 1024
const CLAUDE_PARSER_VERSION = 'claude:v1'
const DEBUG_CACHE = process.env['CODEBURN_CACHE_DEBUG'] === '1'

type SourceCacheRefreshReason = 'missing-entry' | 'parser-version' | 'fingerprint-miss' | 'range-miss'

type SourceManifestAction = 'skip' | 'refresh' | 'use-cache'

type SourceManifestState = {
  source: SessionSource
  parserVersion: string
  manifestEntry: SourceCacheManifestEntry | null
  action: SourceManifestAction
  reason?: SourceCacheRefreshReason
  currentFingerprint?: { mtimeMs: number; sizeBytes: number }
  appendOnly?: boolean
}

type ClaudeCacheUnit = {
  path: string
  project: string
  progressLabel: string
}

type ClaudeCacheDiscovery = {
  units: ClaudeCacheUnit[]
  snapshot: DiscoverySnapshotEntry[]
}

type PlannedClaudeRefresh = SourceManifestState & { unit: ClaudeCacheUnit }

function logCacheDebug(provider: string, path: string, reason: SourceCacheRefreshReason): void {
  if (!DEBUG_CACHE) return
  process.stderr.write(`codeburn cache refresh [${provider}] ${path} (${reason})\n`)
}

function fingerprintMatches(left: { mtimeMs: number; sizeBytes: number }, right: { mtimeMs: number; sizeBytes: number }): boolean {
  return left.mtimeMs === right.mtimeMs && left.sizeBytes === right.sizeBytes
}

async function readClaudeTailState(filePath: string, endOffset: number): Promise<{ tailHash: string; lastEntryType?: string } | null> {
  const start = Math.max(0, endOffset - CLAUDE_TAIL_WINDOW_BYTES)
  const length = Math.max(0, endOffset - start)
  if (length === 0) return null

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
  if (lastNewline < 0 && start > 0) return null

  const lastLine = lastNewline >= 0 ? chunk.slice(lastNewline + 1) : chunk
  if (!lastLine.trim()) return null

  const entry = parseJsonlLine(lastLine)
  return {
    tailHash: createHash('sha1').update(lastLine).digest('hex'),
    lastEntryType: entry?.type,
  }
}

async function buildClaudeAppendState(filePath: string, endOffset: number): Promise<{
  endOffset: number
  tailHash: string
  lastEntryType?: string
}> {
  const tailState = await readClaudeTailState(filePath, endOffset)
  return {
    endOffset,
    tailHash: tailState?.tailHash ?? '',
    lastEntryType: tailState?.lastEntryType,
  }
}

function mergeClaudeAppendSession(
  cachedSession: SessionSummary,
  appendedSession: SessionSummary,
  lastEntryType?: string,
): SessionSummary | null {
  const mergedTurns = [...cachedSession.turns]
  const appendedTurns = [...appendedSession.turns]
  const firstAppendedTurn = appendedTurns[0]

  if (firstAppendedTurn && firstAppendedTurn.userMessage === '') {
    if (lastEntryType !== 'assistant' || mergedTurns.length === 0) return null

    const previousTurn = mergedTurns[mergedTurns.length - 1]!
    mergedTurns[mergedTurns.length - 1] = classifyTurn({
      userMessage: previousTurn.userMessage,
      assistantCalls: [...previousTurn.assistantCalls, ...firstAppendedTurn.assistantCalls],
      timestamp: previousTurn.timestamp,
      sessionId: previousTurn.sessionId,
    })
    appendedTurns.shift()
  }

    return buildSessionSummary(
      cachedSession.sessionId,
      cachedSession.project,
      [...mergedTurns, ...appendedTurns],
    )
  }

async function isDirectoryMarkerUnchanged(cachedSnapshot: DiscoverySnapshotEntry[]): Promise<boolean> {
  for (const entry of cachedSnapshot) {
    if (!isDiscoveryDirectoryMarker(entry.path)) continue
    const path = directoryPathFromMarker(entry.path)
    if (!path) return false
    const markerStat = await stat(path).catch(() => null)
    if (!markerStat || markerStat.mtimeMs !== entry.mtimeMs) return false
    if (entry.dirSignature !== undefined) {
      const entries = await readdir(path).catch(() => [])
      const actualSignature = createHash('sha256').update(entries.sort().join('\n')).digest('hex')
      if (actualSignature !== entry.dirSignature) return false
    }
  }
  return true
}

async function collectJsonlFilesWithSnapshot(dirPath: string): Promise<ClaudeCacheDiscovery> {
  const entries = await readdir(dirPath).catch(() => [])
  const units: ClaudeCacheUnit[] = []
  const filePaths = new Set<string>()
  const snapshot: DiscoverySnapshotEntry[] = []
  const markerPaths = new Set([dirPath])

  for (const entry of entries) {
    if (entry.endsWith('.jsonl')) {
      const filePath = join(dirPath, entry)
      filePaths.add(filePath)
      const fileStat = await stat(filePath).catch(() => null)
      if (fileStat) snapshot.push({ path: filePath, mtimeMs: fileStat.mtimeMs })
      continue
    }

    const subagentsPath = join(dirPath, entry, 'subagents')
    const subFiles = await readdir(subagentsPath).catch(() => [])
    if (subFiles.length > 0) markerPaths.add(subagentsPath)
    for (const sf of subFiles) {
      if (!sf.endsWith('.jsonl')) continue
      const filePath = join(subagentsPath, sf)
      filePaths.add(filePath)
      const fileStat = await stat(filePath).catch(() => null)
      if (fileStat) snapshot.push({ path: filePath, mtimeMs: fileStat.mtimeMs })
    }
  }

  for (const markerPath of markerPaths) {
    const markerStat = await stat(markerPath).catch(() => null)
    if (markerStat) {
      const entries = await readdir(markerPath).catch(() => [])
      const dirSignature = createHash('sha256').update(entries.sort().join('\n')).digest('hex')
      snapshot.push({
        ...discoveryDirectoryMarker(markerPath, dirSignature),
        mtimeMs: markerStat.mtimeMs,
      })
    }
  }

  const discoveredUnits = [...filePaths].map(filePath => ({
    path: filePath,
    project: basename(dirPath),
    progressLabel: filePath.split(/[\\/]/).slice(-2).join('/'),
  }))

  return { units: discoveredUnits, snapshot }
}

async function listClaudeCacheUnitsFromCache(source: SessionSource): Promise<ClaudeCacheDiscovery> {
  const cached = await loadDiscoveryCacheEntryUnchecked('claude', source.path)
  if (cached) {
    const valid = await isDirectoryMarkerUnchanged(cached.snapshot)
    if (valid) {
      const units = cached.sources
        .filter(candidate => candidate.provider === 'claude')
        .map(candidate => ({
          path: candidate.path,
          project: candidate.project,
          progressLabel: candidate.progressLabel
            ?? candidate.path.split(/[\\/]/).slice(-2).join('/'),
        }))
      if (units.length > 0) return { units, snapshot: cached.snapshot }
    }
  }

  const discovery = await collectJsonlFilesWithSnapshot(source.path)
  const sources: SessionSource[] = discovery.units.map(unit => ({
    path: unit.path,
    provider: 'claude',
    project: source.project,
    progressLabel: unit.progressLabel,
  }))
  await saveDiscoveryCache('claude', source.path, discovery.snapshot, sources)
  return discovery
}

function isRefreshReason(reason?: SourceCacheRefreshReason): reason is SourceCacheRefreshReason {
  return !!reason
}

async function evaluateSourceManifestState(
  manifest: Awaited<ReturnType<typeof loadSourceCacheManifest>>,
  source: SessionSource,
  parserVersion: string,
  dateRange: DateRange | undefined,
  options: ParseOptions,
  shouldAllowAppend: boolean,
): Promise<SourceManifestState> {
  const fingerprintPath = source.fingerprintPath ?? source.path
  const manifestEntry = getManifestEntry(manifest, source.provider, source.path)

  if (options.noCache) {
    const state: SourceManifestState = { source, parserVersion, manifestEntry, action: 'refresh', reason: 'missing-entry' }
    if (isRefreshReason(state.reason)) logCacheDebug(source.provider, source.path, state.reason)
    return state
  }

  if (!manifestEntry) {
    const state: SourceManifestState = { source, parserVersion, manifestEntry, action: 'refresh', reason: 'missing-entry' }
    logCacheDebug(source.provider, source.path, state.reason!)
    return state
  }

  if (manifestEntry.lastSeenParserVersion !== parserVersion) {
    const state: SourceManifestState = { source, parserVersion, manifestEntry, action: 'refresh', reason: 'parser-version' }
    logCacheDebug(source.provider, source.path, state.reason!)
    return state
  }

  if (source.cacheStrategy && manifestEntry.cacheStrategy && source.cacheStrategy !== manifestEntry.cacheStrategy) {
    const state: SourceManifestState = { source, parserVersion, manifestEntry, action: 'refresh', reason: 'parser-version' }
    logCacheDebug(source.provider, source.path, state.reason!)
    return state
  }

  const overlap = isManifestDateRangeOverlap(manifestEntry, dateRange)
  if (overlap === false) {
    return { source, parserVersion, manifestEntry, action: 'skip', reason: 'range-miss' }
  }

  if (!manifestEntry.fingerprint || manifestEntry.fingerprintPath !== fingerprintPath) {
    const state: SourceManifestState = { source, parserVersion, manifestEntry, action: 'refresh', reason: 'fingerprint-miss' }
    logCacheDebug(source.provider, source.path, state.reason!)
    return state
  }

  const currentFingerprint = await computeFileFingerprint(fingerprintPath).catch(() => null)
  if (!currentFingerprint) {
    const state: SourceManifestState = { source, parserVersion, manifestEntry, action: 'refresh', reason: 'fingerprint-miss' }
    logCacheDebug(source.provider, source.path, state.reason!)
    return state
  }

  if (fingerprintMatches(currentFingerprint, manifestEntry.fingerprint)) {
    return { source, parserVersion, manifestEntry, action: 'use-cache', currentFingerprint }
  }

  if (shouldAllowAppend && manifestEntry.cacheStrategy === 'append-jsonl' && manifestEntry.appendState && manifestEntry.fingerprint) {
    const sizeDelta = currentFingerprint.sizeBytes - manifestEntry.fingerprint.sizeBytes
    if (sizeDelta >= 0) {
      const tailState = await readClaudeTailState(fingerprintPath, manifestEntry.appendState.endOffset)
      const tailMatches = !!(
        tailState
        && manifestEntry.appendState.tailHash
        && tailState.tailHash === manifestEntry.appendState.tailHash
      )
      if (tailMatches) {
        if (sizeDelta === 0) {
          return { source, parserVersion, manifestEntry, action: 'use-cache', currentFingerprint, appendOnly: false }
        }
        return {
          source,
          parserVersion,
          manifestEntry,
          action: 'refresh',
          reason: 'fingerprint-miss',
          currentFingerprint,
          appendOnly: true,
        }
      }
    }
  }

  const state: SourceManifestState = { source, parserVersion, manifestEntry, action: 'refresh', reason: 'fingerprint-miss', currentFingerprint }
  logCacheDebug(source.provider, source.path, state.reason!)
  return state
}

async function planClaudeRefreshes(
  manifest: Awaited<ReturnType<typeof loadSourceCacheManifest>>,
  units: ClaudeCacheUnit[],
  dateRange: DateRange | undefined,
  options: ParseOptions,
): Promise<PlannedClaudeRefresh[]> {
  return Promise.all(units.map(async unit => {
    const plan = await evaluateSourceManifestState(
      manifest,
      { path: unit.path, project: unit.project, provider: 'claude', fingerprintPath: unit.path, cacheStrategy: 'append-jsonl' },
      CLAUDE_PARSER_VERSION,
      dateRange,
      options,
      true,
    )
    if (DEBUG_CACHE) {
      process.stderr.write(`codeburn cache plan [claude] ${unit.path} -> ${plan.action}\n`)
    }
    return { ...plan, unit }
  }))
}

async function refreshClaudeCacheUnit(
  manifest: Awaited<ReturnType<typeof loadSourceCacheManifest>>,
  state: PlannedClaudeRefresh,
  seenMsgIds: Set<string>,
  options: ParseOptions,
): Promise<{ session: SessionSummary | null; wrote: boolean; refreshed: boolean }> {
  const { unit, appendOnly } = state
  const localSeenMsgIds = new Set<string>()
  const manifestAppendState = state.manifestEntry?.appendState
  const fingerprint = state.currentFingerprint ?? await computeFileFingerprint(unit.path)

  if (DEBUG_CACHE) {
    process.stderr.write(`codeburn cache refresh-file ${unit.path} action=${state.action} appendOnly=${String(appendOnly)}\n`)
  }

  if (state.action === 'skip') {
    return { session: null, wrote: false, refreshed: false }
  }

  if (state.action === 'use-cache') {
    const cached = await readSourceCacheEntry(manifest, 'claude', state.source.path, { allowStaleFingerprint: true })
    if (cached) {
      addSeenDeduplicationKeysFromSessions(cached.sessions, localSeenMsgIds)
      return { session: cached.sessions[0] ?? null, wrote: false, refreshed: false }
    }
  }

  const cached = await readSourceCacheEntry(manifest, 'claude', state.source.path, { allowStaleFingerprint: true })
  let shouldUseAppendOnly = !!appendOnly
    && !!cached
    && !!cached.appendState
    && cached.sessions.length > 0
    && !!state.currentFingerprint
  if (shouldUseAppendOnly && manifestAppendState && cached?.appendState) {
    if (
      manifestAppendState.tailHash !== cached.appendState.tailHash
      || manifestAppendState.endOffset !== cached.appendState.endOffset
      || manifestAppendState.lastEntryType !== cached.appendState.lastEntryType
    ) {
      shouldUseAppendOnly = false
    }
  }

  if (shouldUseAppendOnly && cached && cached.appendState) {
    addSeenDeduplicationKeysFromSessions(cached.sessions, localSeenMsgIds)
    const appendedLines: string[] = []
    for await (const line of readSessionLinesFromOffset(unit.path, cached.appendState.endOffset)) {
      if (line.trim()) appendedLines.push(line)
    }

    const appended = buildClaudeSessionSummaryFromLines(
      appendedLines,
      unit.project,
      localSeenMsgIds,
      cached.sessions[0]?.sessionId ?? basename(unit.path, '.jsonl'),
    )

    if (appended && cached.sessions[0]) {
      const merged = mergeClaudeAppendSession(
        cached.sessions[0],
        appended,
        cached.appendState.lastEntryType,
      )

      if (merged) {
        await writeSourceCacheEntry(manifest, {
          version: SOURCE_CACHE_VERSION,
          provider: 'claude',
          logicalPath: unit.path,
          fingerprintPath: unit.path,
          cacheStrategy: 'append-jsonl',
          parserVersion: CLAUDE_PARSER_VERSION,
          fingerprint: state.currentFingerprint ?? fingerprint,
          sessions: [merged],
          appendState: await buildClaudeAppendState(unit.path, (state.currentFingerprint ?? fingerprint).sizeBytes),
        })
        options.progress?.advance('claude')
        return { session: merged, wrote: true, refreshed: true }
      }
    }
  }

  options.progress?.advance('claude')
  const session = await parseSessionFile(unit.path, unit.project, localSeenMsgIds)
  if (!session) {
    await writeSourceCacheEntry(manifest, {
      version: SOURCE_CACHE_VERSION,
      provider: 'claude',
      logicalPath: unit.path,
      fingerprintPath: unit.path,
      cacheStrategy: 'append-jsonl',
      parserVersion: CLAUDE_PARSER_VERSION,
      fingerprint: state.currentFingerprint ?? fingerprint,
      sessions: [],
      appendState: await buildClaudeAppendState(unit.path, (state.currentFingerprint ?? fingerprint).sizeBytes),
    })
    return { session: null, wrote: true, refreshed: true }
  }

  await writeSourceCacheEntry(manifest, {
    version: SOURCE_CACHE_VERSION,
    provider: 'claude',
    logicalPath: unit.path,
    fingerprintPath: unit.path,
    cacheStrategy: 'append-jsonl',
    parserVersion: CLAUDE_PARSER_VERSION,
    fingerprint: state.currentFingerprint ?? fingerprint,
    sessions: [session],
    appendState: await buildClaudeAppendState(unit.path, (state.currentFingerprint ?? fingerprint).sizeBytes),
  })
  return { session, wrote: true, refreshed: true }
}

async function scanClaudeDirsWithCache(
  dirs: Array<{ path: string; name: string }>,
  seenMsgIds: Set<string>,
  dateRange: DateRange | undefined,
  manifest?: Awaited<ReturnType<typeof loadSourceCacheManifest>>,
  refreshStates?: PlannedClaudeRefresh[],
  options: ParseOptions = {},
): Promise<ProjectSummary[]> {
  const projectMap = new Map<string, SessionSummary[]>()
  const cacheManifest = manifest ?? await loadSourceCacheManifest()
  const claudeGroups = await Promise.all(
    dirs.map(dir => listClaudeCacheUnitsFromCache({ path: dir.path, project: dir.name, provider: 'claude' })),
  )
  const allUnits = claudeGroups.flatMap(group => group.units)
  const plan = refreshStates
    ?? await planClaudeRefreshes(cacheManifest, allUnits, dateRange, options)

  let wroteManifest = false
  for (const state of plan) {
    if (state.action === 'skip') continue

    const { session, wrote } = await refreshClaudeCacheUnit(cacheManifest, state, seenMsgIds, options)
    if (wrote) wroteManifest = true
    if (!session) continue

    const filtered = filterSessionSummaryToRange(session, dateRange)
    if (filtered) addSessionToProjectMap(projectMap, filtered)
  }

  if (wroteManifest) await saveSourceCacheManifest(cacheManifest)
  return buildProjects(projectMap)
}

async function planProviderSources(
  manifest: Awaited<ReturnType<typeof loadSourceCacheManifest>>,
  providerName: string,
  sources: SessionSource[],
  dateRange: DateRange | undefined,
  options: ParseOptions,
): Promise<SourceManifestState[]> {
  return Promise.all(sources.map(async source => {
    const parserVersion = source.parserVersion ?? `${providerName}:v1`
    return evaluateSourceManifestState(
      manifest,
      source,
      parserVersion,
      dateRange,
      options,
      false,
    )
  }))
}

function providerCallToTurn(call: ParsedProviderCall): ParsedTurn {
  const tools = call.tools
  const usage: TokenUsage = {
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    cacheCreationInputTokens: call.cacheCreationInputTokens,
    cacheReadInputTokens: call.cacheReadInputTokens,
    cachedInputTokens: call.cachedInputTokens,
    reasoningTokens: call.reasoningTokens,
    webSearchRequests: call.webSearchRequests,
  }

  const apiCall: ParsedApiCall = {
    provider: call.provider,
    model: call.model,
    usage,
    costUSD: call.costUSD,
    tools,
    mcpTools: extractMcpTools(tools),
    hasAgentSpawn: tools.includes('Agent'),
    hasPlanMode: tools.includes('EnterPlanMode'),
    speed: call.speed,
    timestamp: call.timestamp,
    bashCommands: call.bashCommands,
    deduplicationKey: call.deduplicationKey,
  }

  return {
    userMessage: call.userMessage,
    assistantCalls: [apiCall],
    timestamp: call.timestamp,
    sessionId: call.sessionId,
  }
}

async function parseProviderSources(
  providerName: string,
  sources: SessionSource[],
  seenKeys: Set<string>,
  dateRange?: DateRange,
  manifest?: Awaited<ReturnType<typeof loadSourceCacheManifest>>,
  sourceStates?: SourceManifestState[],
  options: ParseOptions = {},
): Promise<ProjectSummary[]> {
  const projectMap = new Map<string, SessionSummary[]>()
  const cacheManifest = manifest ?? await loadSourceCacheManifest()
  const plannedSources = sourceStates
    ?? await planProviderSources(cacheManifest, providerName, sources, dateRange, options)
  let provider: Provider | undefined
  let wroteManifest = false

  for (const state of plannedSources) {
    if (state.action === 'skip') continue

    let fullSessions: SessionSummary[] | null = null
    if (state.action === 'use-cache') {
      const cached = await readSourceCacheEntry(cacheManifest, providerName, state.source.path, { allowStaleFingerprint: true })
      if (cached) fullSessions = cached.sessions
    }

    if (!fullSessions) {
      provider ??= await getProvider(providerName)
      if (!provider) continue

      options.progress?.advance(providerName)
      fullSessions = await parseFreshProviderSource(provider, providerName, state.source, seenKeys)

      const fingerprintPath = state.source.fingerprintPath ?? state.source.path
      await writeSourceCacheEntry(cacheManifest, {
        version: SOURCE_CACHE_VERSION,
        provider: providerName,
        logicalPath: state.source.path,
        fingerprintPath,
        cacheStrategy: state.source.cacheStrategy ?? 'full-reparse',
        parserVersion: state.parserVersion,
        fingerprint: await computeFileFingerprint(fingerprintPath),
        sessions: fullSessions,
      })
      wroteManifest = true
    }

    if (fullSessions) addSeenDeduplicationKeysFromSessions(fullSessions, seenKeys)

    for (const session of fullSessions
      .map(session => filterSessionSummaryToRange(session, dateRange))
      .filter((session): session is SessionSummary => session !== null)) {
      addSessionToProjectMap(projectMap, session)
    }
  }

  if (wroteManifest) await saveSourceCacheManifest(cacheManifest)

  return buildProjects(projectMap)
}

const CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 10

type CachedSessionWindow = {
  data: ProjectSummary[]
  sourceSignature: string
  ts: number
  rangeStart: number | null
  rangeEnd: number | null
  context: string
}

const sessionCache = new Map<string, CachedSessionWindow>()

function cacheContextKey(providerFilter?: string, noCache = false): string {
  return `${providerFilter ?? 'all'}:${noCache ? 'nocache' : 'cache'}`
}

function cacheKey(dateRange: DateRange | undefined, providerFilter?: string, noCache = false): string {
  const range = dateRange ? `${dateRange.start.getTime()}:${dateRange.end.getTime()}` : 'none'
  return `${cacheContextKey(providerFilter, noCache)}:${range}`
}

async function sourceSignatureForCache(sources: SessionSource[]): Promise<string> {
  const fingerprints = await Promise.all(sources.map(async source => {
    if (source.provider === 'claude') {
      const discovery = await listClaudeCacheUnitsFromCache(source)
      if (discovery.units.length === 0) {
        return [`${source.provider}:${source.project}:${source.path}:empty`]
      }

      const signatures = await Promise.all(discovery.units.map(async unit => {
        try {
          const meta = await stat(unit.path)
          return `${source.provider}:${source.project}:${unit.path}:mtime:${meta.mtimeMs}:size:${meta.size}`
        } catch {
          return `${source.provider}:${source.project}:${unit.path}:missing`
        }
      }))
      return signatures
    }

    const fingerprintPath = source.fingerprintPath ?? source.path
    try {
      const meta = await stat(fingerprintPath)
      return [[
        source.provider,
        source.project,
        source.path,
        fingerprintPath,
        String(meta.mtimeMs),
        String(meta.size),
      ].join(':')]
    } catch {
      return [[source.provider, source.project, source.path, fingerprintPath, 'missing'].join(':')]
    }
  }))

  return fingerprints.flat().sort().join('|')
}

function rangeCoversCandidate(entry: CachedSessionWindow, dateRange?: DateRange): boolean {
  if (!dateRange || entry.rangeStart === null || entry.rangeEnd === null) return false
  return entry.rangeStart <= dateRange.start.getTime() && entry.rangeEnd >= dateRange.end.getTime()
}

function getCachedWindow(context: string, dateRange: DateRange | undefined, sourceSignature: string): ProjectSummary[] | null {
  const now = Date.now()
  let bestKey: string | null = null
  let bestWidth = Number.POSITIVE_INFINITY

  if (!dateRange) return null

  for (const [key, entry] of sessionCache) {
    if (entry.context !== context) continue
    if (entry.sourceSignature !== sourceSignature) continue
    if (now - entry.ts >= CACHE_TTL_MS) continue
    if (!rangeCoversCandidate(entry, dateRange)) continue

    const width = entry.rangeEnd! - entry.rangeStart!
    if (width < bestWidth || (width === bestWidth && (bestKey === null || key < bestKey))) {
      bestWidth = width
      bestKey = key
    }
  }

  if (bestKey === null) return null
  const cached = sessionCache.get(bestKey)
  if (!cached) return null
  return filterProjectsByDateRange(cached.data, dateRange)
}

function cachePut(key: string, data: ProjectSummary[], sourceSignature: string, context: string, dateRange: DateRange | undefined) {
  const now = Date.now()
  for (const [k, v] of sessionCache) {
    if (now - v.ts > CACHE_TTL_MS) sessionCache.delete(k)
  }
  if (sessionCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) sessionCache.delete(oldest[0])
  }
  sessionCache.set(key, {
    data,
    sourceSignature,
    ts: now,
    rangeStart: dateRange?.start.getTime() ?? null,
    rangeEnd: dateRange?.end.getTime() ?? null,
    context,
  })
}

export function filterProjectsByName(
  projects: ProjectSummary[],
  include?: string[],
  exclude?: string[],
): ProjectSummary[] {
  let result = projects
  if (include && include.length > 0) {
    const patterns = include.map(s => s.toLowerCase())
    result = result.filter(p => {
      const name = p.project.toLowerCase()
      const path = p.projectPath.toLowerCase()
      return patterns.some(pat => name.includes(pat) || path.includes(pat))
    })
  }
  if (exclude && exclude.length > 0) {
    const patterns = exclude.map(s => s.toLowerCase())
    result = result.filter(p => {
      const name = p.project.toLowerCase()
      const path = p.projectPath.toLowerCase()
      return !patterns.some(pat => name.includes(pat) || path.includes(pat))
    })
  }
  return result
}

export function filterProjectsByDateRange(
  projects: ProjectSummary[],
  dateRange?: DateRange,
): ProjectSummary[] {
  if (!dateRange) return projects

  const filtered = projects.flatMap(project => {
    const sessions = project.sessions
      .map(session => filterSessionSummaryToRange(session, dateRange))
      .filter((session): session is NonNullable<SessionSummary> => session !== null)

    if (sessions.length === 0) return []

    const totalCostUSD = sessions.reduce((sum, session) => sum + session.totalCostUSD, 0)
    const totalApiCalls = sessions.reduce((sum, session) => sum + session.apiCalls, 0)
    return [{
      ...project,
      sessions,
      totalCostUSD,
      totalApiCalls,
    }]
  })

  return filtered.sort((a, b) => b.totalCostUSD - a.totalCostUSD)
}

async function parseFreshProviderSource(
  provider: Provider,
  providerName: string,
  source: SessionSource,
  seenKeys: Set<string>,
): Promise<SessionSummary[]> {
  const sessionMap = new Map<string, { project: string; turns: ClassifiedTurn[] }>()
  const parser = provider.createSessionParser(source, seenKeys)

  for await (const call of parser.parse()) {
    const turn = providerCallToTurn(call)
    const classified = classifyTurn(turn)
    const key = `${providerName}:${call.sessionId}:${source.project}`
    const existing = sessionMap.get(key)

    if (existing) {
      existing.turns.push(classified)
    } else {
      sessionMap.set(key, { project: source.project, turns: [classified] })
    }
  }

  return [...sessionMap.entries()].map(([key, value]) => {
    const sessionId = key.split(':')[1] ?? key
    return buildSessionSummary(sessionId, value.project, value.turns)
  })
}

export async function parseAllSessions(
  dateRange?: DateRange,
  providerFilter?: string,
  options: ParseOptions = {},
): Promise<ProjectSummary[]> {
  const key = cacheKey(dateRange, providerFilter, options.noCache === true)
  const context = cacheContextKey(providerFilter, options.noCache === true)
  const allSources = await discoverAllSessions(providerFilter)
  const sourceSignature = await sourceSignatureForCache(allSources)

  const cached = getCachedWindow(context, dateRange, sourceSignature)
  if (cached) return cached

  const exact = sessionCache.get(key)
  if (exact && Date.now() - exact.ts < CACHE_TTL_MS && exact.sourceSignature === sourceSignature) {
    return exact.data
  }

  const seenMsgIds = new Set<string>()
  const seenKeys = new Set<string>()
  const progress = wrapProgressReporter(options.progress)
  const parseOptions: ParseOptions = { ...options, progress }
  const manifest = await loadSourceCacheManifest()

  const claudeSources = allSources.filter(s => s.provider === 'claude')
  const nonClaudeSources = allSources.filter(s => s.provider !== 'claude')

  const claudeDiscovery = await Promise.all(
    claudeSources.map(source => listClaudeCacheUnitsFromCache(source)),
  )
  const claudeDirs = claudeSources.map(s => ({ path: s.path, name: s.project }))
  const claudeUnits = claudeDiscovery.flatMap(discovery => discovery.units)
  const plannedClaudeRefreshes = await planClaudeRefreshes(manifest, claudeUnits, dateRange, parseOptions)

  const providerGroups = new Map<string, SessionSource[]>()
  for (const source of nonClaudeSources) {
    const existing = providerGroups.get(source.provider) ?? []
    existing.push(source)
    providerGroups.set(source.provider, existing)
  }

  const plannedProviderGroups = new Map<string, SourceManifestState[]>()
  for (const [providerName, sources] of providerGroups) {
    plannedProviderGroups.set(
      providerName,
      await planProviderSources(manifest, providerName, sources, dateRange, parseOptions),
    )
  }

  const refreshCount = plannedClaudeRefreshes.filter(state => state.action === 'refresh').length
    + [...plannedProviderGroups.values()]
      .flat()
      .filter(state => state.action === 'refresh').length

  const otherProjects: ProjectSummary[] = []
  if (refreshCount > 0) progress?.start(refreshCount)

  try {
    const claudeProjects = await scanClaudeDirsWithCache(
      claudeDirs,
      seenMsgIds,
      dateRange,
      manifest,
      plannedClaudeRefreshes,
      parseOptions,
    )

    for (const [providerName, sources] of providerGroups) {
      const projects = await parseProviderSources(
        providerName,
        sources,
        seenKeys,
        dateRange,
        manifest,
        plannedProviderGroups.get(providerName),
        parseOptions,
      )
      otherProjects.push(...projects)
    }

    const mergedMap = new Map<string, ProjectSummary>()
    for (const p of [...claudeProjects, ...otherProjects]) {
      const existing = mergedMap.get(p.project)
      if (existing) {
        existing.sessions.push(...p.sessions)
        existing.totalCostUSD += p.totalCostUSD
        existing.totalApiCalls += p.totalApiCalls
      } else {
        mergedMap.set(p.project, { ...p })
      }
    }

    const result = Array.from(mergedMap.values()).sort((a, b) => b.totalCostUSD - a.totalCostUSD)
    cachePut(key, result, sourceSignature, context, dateRange)
    return result
  } finally {
    if (refreshCount > 0) progress?.finish()
  }
}
