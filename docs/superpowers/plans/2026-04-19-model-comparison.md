# Model Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick any two AI models and see a fair, normalized side-by-side comparison of cost efficiency, edit reliability, and self-correction rates.

**Architecture:** Pure data module (`compare-stats.ts`) handles aggregation and comparison logic. Ink TUI module (`compare.tsx`) handles model selection and results display. Accessible via `codeburn compare` standalone command and `c` shortcut in the dashboard.

**Tech Stack:** TypeScript, React 19, Ink 7, vitest

---

## File Structure

```
src/compare-stats.ts     -- ModelStats type, aggregateModelStats(), computeComparison(),
                            self-correction JSONL scanner. Pure data, no UI.
src/compare.tsx           -- ModelSelector, ComparisonResults, CompareView components.
                            Exported renderCompare() for standalone command.
tests/compare-stats.test.ts -- Unit tests for aggregation, comparison, edge cases.
src/cli.ts                -- Add `compare` command (modify ~line 650).
src/dashboard.tsx          -- Add 'compare' to View type, 'c' keybinding, CompareView
                            render branch, StatusBar hint (modify ~5 locations).
```

---

### Task 1: ModelStats type and aggregateModelStats()

**Files:**
- Create: `src/compare-stats.ts`
- Test: `tests/compare-stats.test.ts`

- [ ] **Step 1: Write the failing test for aggregateModelStats**

Create `tests/compare-stats.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { aggregateModelStats, type ModelStats } from '../src/compare-stats.js'
import type { ProjectSummary, SessionSummary, ClassifiedTurn } from '../src/types.js'

function makeTurn(model: string, cost: number, opts: { hasEdits?: boolean; retries?: number; outputTokens?: number; inputTokens?: number; cacheRead?: number; cacheWrite?: number; timestamp?: string } = {}): ClassifiedTurn {
  return {
    timestamp: opts.timestamp ?? '2026-04-15T10:00:00Z',
    category: 'coding',
    retries: opts.retries ?? 0,
    hasEdits: opts.hasEdits ?? false,
    userMessage: '',
    assistantCalls: [{
      provider: 'claude',
      model,
      usage: {
        inputTokens: opts.inputTokens ?? 100,
        outputTokens: opts.outputTokens ?? 200,
        cacheCreationInputTokens: opts.cacheWrite ?? 500,
        cacheReadInputTokens: opts.cacheRead ?? 5000,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
      },
      costUSD: cost,
      tools: opts.hasEdits ? ['Edit'] : ['Read'],
      mcpTools: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: 'standard' as const,
      timestamp: opts.timestamp ?? '2026-04-15T10:00:00Z',
      bashCommands: [],
      deduplicationKey: `key-${Math.random()}`,
    }],
  }
}

function makeProject(turns: ClassifiedTurn[]): ProjectSummary {
  const session: SessionSummary = {
    sessionId: 'test-session',
    project: 'test-project',
    firstTimestamp: turns[0]?.timestamp ?? '',
    lastTimestamp: turns[turns.length - 1]?.timestamp ?? '',
    totalCostUSD: turns.reduce((s, t) => s + t.assistantCalls.reduce((s2, c) => s2 + c.costUSD, 0), 0),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: turns.reduce((s, t) => s + t.assistantCalls.length, 0),
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
  }
  return {
    project: 'test-project',
    projectPath: '/test',
    sessions: [session],
    totalCostUSD: session.totalCostUSD,
    totalApiCalls: session.apiCalls,
  }
}

describe('aggregateModelStats', () => {
  it('aggregates calls, cost, and tokens per model', () => {
    const project = makeProject([
      makeTurn('opus-4-6', 0.10, { outputTokens: 200, inputTokens: 50, cacheRead: 5000, cacheWrite: 500 }),
      makeTurn('opus-4-6', 0.15, { outputTokens: 300, inputTokens: 80, cacheRead: 6000, cacheWrite: 600 }),
      makeTurn('opus-4-7', 0.25, { outputTokens: 800, inputTokens: 100, cacheRead: 7000, cacheWrite: 700 }),
    ])
    const stats = aggregateModelStats([project])
    const m6 = stats.find(s => s.model === 'opus-4-6')!
    const m7 = stats.find(s => s.model === 'opus-4-7')!

    expect(m6.calls).toBe(2)
    expect(m6.cost).toBeCloseTo(0.25)
    expect(m6.outputTokens).toBe(500)
    expect(m7.calls).toBe(1)
    expect(m7.cost).toBeCloseTo(0.25)
    expect(m7.outputTokens).toBe(800)
  })

  it('attributes turn-level metrics to the primary model', () => {
    const project = makeProject([
      makeTurn('opus-4-6', 0.10, { hasEdits: true, retries: 0 }),
      makeTurn('opus-4-6', 0.10, { hasEdits: true, retries: 2 }),
      makeTurn('opus-4-7', 0.20, { hasEdits: true, retries: 0 }),
      makeTurn('opus-4-7', 0.20, { hasEdits: false }),
    ])
    const stats = aggregateModelStats([project])
    const m6 = stats.find(s => s.model === 'opus-4-6')!
    const m7 = stats.find(s => s.model === 'opus-4-7')!

    expect(m6.editTurns).toBe(2)
    expect(m6.oneShotTurns).toBe(1)
    expect(m6.retries).toBe(2)
    expect(m7.editTurns).toBe(1)
    expect(m7.oneShotTurns).toBe(1)
    expect(m7.totalTurns).toBe(2)
  })

  it('tracks firstSeen and lastSeen timestamps', () => {
    const project = makeProject([
      makeTurn('opus-4-6', 0.10, { timestamp: '2026-04-10T08:00:00Z' }),
      makeTurn('opus-4-6', 0.10, { timestamp: '2026-04-15T20:00:00Z' }),
    ])
    const stats = aggregateModelStats([project])
    const m = stats.find(s => s.model === 'opus-4-6')!
    expect(m.firstSeen).toBe('2026-04-10T08:00:00Z')
    expect(m.lastSeen).toBe('2026-04-15T20:00:00Z')
  })

  it('filters out <synthetic> model entries', () => {
    const project = makeProject([
      makeTurn('<synthetic>', 0, {}),
      makeTurn('opus-4-6', 0.10, {}),
    ])
    const stats = aggregateModelStats([project])
    expect(stats.find(s => s.model === '<synthetic>')).toBeUndefined()
    expect(stats).toHaveLength(1)
  })

  it('returns empty array for no projects', () => {
    expect(aggregateModelStats([])).toEqual([])
  })

  it('sorts by cost descending', () => {
    const project = makeProject([
      makeTurn('cheap-model', 0.01),
      makeTurn('expensive-model', 5.00),
    ])
    const stats = aggregateModelStats([project])
    expect(stats[0].model).toBe('expensive-model')
    expect(stats[1].model).toBe('cheap-model')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compare-stats.test.ts`
Expected: FAIL with "Cannot find module '../src/compare-stats.js'"

- [ ] **Step 3: Write minimal implementation**

Create `src/compare-stats.ts`:

```ts
import type { ProjectSummary } from './types.js'

export type ModelStats = {
  model: string
  calls: number
  cost: number
  outputTokens: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTurns: number
  editTurns: number
  oneShotTurns: number
  retries: number
  selfCorrections: number
  firstSeen: string
  lastSeen: string
}

export function aggregateModelStats(projects: ProjectSummary[]): ModelStats[] {
  const byModel = new Map<string, ModelStats>()

  const ensure = (model: string): ModelStats => {
    let s = byModel.get(model)
    if (!s) {
      s = { model, calls: 0, cost: 0, outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTurns: 0, editTurns: 0, oneShotTurns: 0, retries: 0, selfCorrections: 0, firstSeen: '', lastSeen: '' }
      byModel.set(model, s)
    }
    return s
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (turn.assistantCalls.length === 0) continue
        const primaryModel = turn.assistantCalls[0].model
        if (primaryModel === '<synthetic>') continue

        const ms = ensure(primaryModel)
        ms.totalTurns++
        if (turn.hasEdits) ms.editTurns++
        if (turn.hasEdits && turn.retries === 0) ms.oneShotTurns++
        ms.retries += turn.retries

        for (const call of turn.assistantCalls) {
          if (call.model === '<synthetic>') continue
          const cs = call.model === primaryModel ? ms : ensure(call.model)
          cs.calls++
          cs.cost += call.costUSD
          cs.outputTokens += call.usage.outputTokens
          cs.inputTokens += call.usage.inputTokens
          cs.cacheReadTokens += call.usage.cacheReadInputTokens
          cs.cacheWriteTokens += call.usage.cacheCreationInputTokens

          if (!cs.firstSeen || call.timestamp < cs.firstSeen) cs.firstSeen = call.timestamp
          if (!cs.lastSeen || call.timestamp > cs.lastSeen) cs.lastSeen = call.timestamp
        }
      }
    }
  }

  return [...byModel.values()].sort((a, b) => b.cost - a.cost)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compare-stats.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/compare-stats.ts tests/compare-stats.test.ts
git commit --author="iamtoruk <hello@agentseal.org>" -m "feat(compare): add ModelStats type and aggregateModelStats"
```

---

### Task 2: computeComparison()

**Files:**
- Modify: `src/compare-stats.ts`
- Modify: `tests/compare-stats.test.ts`

- [ ] **Step 1: Write the failing test for computeComparison**

Add to `tests/compare-stats.test.ts`:

```ts
import { computeComparison, type ComparisonRow } from '../src/compare-stats.js'

function makeStats(model: string, overrides: Partial<ModelStats> = {}): ModelStats {
  return {
    model,
    calls: 1000,
    cost: 100,
    outputTokens: 200000,
    inputTokens: 10000,
    cacheReadTokens: 500000,
    cacheWriteTokens: 50000,
    totalTurns: 500,
    editTurns: 100,
    oneShotTurns: 80,
    retries: 30,
    selfCorrections: 5,
    firstSeen: '2026-04-01T00:00:00Z',
    lastSeen: '2026-04-15T00:00:00Z',
    ...overrides,
  }
}

describe('computeComparison', () => {
  it('computes normalized metrics and picks winners', () => {
    const a = makeStats('opus-4-6', { calls: 1000, cost: 100, outputTokens: 200000 })
    const b = makeStats('opus-4-7', { calls: 500, cost: 100, outputTokens: 400000 })
    const rows = computeComparison(a, b)

    const costRow = rows.find(r => r.label === 'Cost / call')!
    expect(costRow.valueA).toBeCloseTo(0.10)
    expect(costRow.valueB).toBeCloseTo(0.20)
    expect(costRow.winner).toBe('a')

    const outputRow = rows.find(r => r.label === 'Output tok / call')!
    expect(outputRow.valueA).toBe(200)
    expect(outputRow.valueB).toBe(800)
    expect(outputRow.winner).toBe('a')
  })

  it('handles zero edit turns gracefully', () => {
    const a = makeStats('opus-4-6', { editTurns: 0, oneShotTurns: 0, retries: 0 })
    const b = makeStats('opus-4-7', { editTurns: 50, oneShotTurns: 40, retries: 15 })
    const rows = computeComparison(a, b)

    const osRow = rows.find(r => r.label === 'One-shot rate')!
    expect(osRow.valueA).toBeNull()
    expect(osRow.valueB).not.toBeNull()
    expect(osRow.winner).toBe('none')
  })

  it('returns tie when values are equal', () => {
    const a = makeStats('opus-4-6')
    const b = makeStats('opus-4-7')
    const rows = computeComparison(a, b)
    for (const row of rows) {
      expect(row.winner).toBe('tie')
    }
  })

  it('higher-is-better metrics pick the higher value', () => {
    const a = makeStats('opus-4-6', { cacheReadTokens: 900000, inputTokens: 10000, cacheWriteTokens: 90000 })
    const b = makeStats('opus-4-7', { cacheReadTokens: 500000, inputTokens: 10000, cacheWriteTokens: 490000 })
    const rows = computeComparison(a, b)
    const cacheRow = rows.find(r => r.label === 'Cache hit rate')!
    expect(cacheRow.winner).toBe('a')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compare-stats.test.ts`
Expected: FAIL with "computeComparison is not a function"

- [ ] **Step 3: Write minimal implementation**

Add to `src/compare-stats.ts`:

```ts
export type ComparisonRow = {
  label: string
  valueA: number | null
  valueB: number | null
  formatFn: 'cost' | 'number' | 'percent' | 'decimal'
  winner: 'a' | 'b' | 'tie' | 'none'
}

type MetricDef = {
  label: string
  extract: (s: ModelStats) => number | null
  format: ComparisonRow['formatFn']
  higherIsBetter: boolean
}

const METRICS: MetricDef[] = [
  {
    label: 'Cost / call',
    extract: s => s.calls > 0 ? s.cost / s.calls : null,
    format: 'cost',
    higherIsBetter: false,
  },
  {
    label: 'Output tok / call',
    extract: s => s.calls > 0 ? Math.round(s.outputTokens / s.calls) : null,
    format: 'number',
    higherIsBetter: false,
  },
  {
    label: 'Cache hit rate',
    extract: s => {
      const total = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens
      return total > 0 ? (s.cacheReadTokens / total) * 100 : null
    },
    format: 'percent',
    higherIsBetter: true,
  },
  {
    label: 'One-shot rate',
    extract: s => s.editTurns > 0 ? (s.oneShotTurns / s.editTurns) * 100 : null,
    format: 'percent',
    higherIsBetter: true,
  },
  {
    label: 'Retry rate',
    extract: s => s.editTurns > 0 ? s.retries / s.editTurns : null,
    format: 'decimal',
    higherIsBetter: false,
  },
  {
    label: 'Self-correction',
    extract: s => s.totalTurns > 0 ? (s.selfCorrections / s.totalTurns) * 100 : null,
    format: 'percent',
    higherIsBetter: false,
  },
]

function pickWinner(a: number | null, b: number | null, higherIsBetter: boolean): ComparisonRow['winner'] {
  if (a === null || b === null) return 'none'
  if (a === b) return 'tie'
  if (higherIsBetter) return a > b ? 'a' : 'b'
  return a < b ? 'a' : 'b'
}

export function computeComparison(a: ModelStats, b: ModelStats): ComparisonRow[] {
  return METRICS.map(m => {
    const valueA = m.extract(a)
    const valueB = m.extract(b)
    return {
      label: m.label,
      valueA,
      valueB,
      formatFn: m.format,
      winner: pickWinner(valueA, valueB, m.higherIsBetter),
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compare-stats.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/compare-stats.ts tests/compare-stats.test.ts
git commit --author="iamtoruk <hello@agentseal.org>" -m "feat(compare): add computeComparison with normalized metrics"
```

---

### Task 3: Self-correction JSONL scanner

**Files:**
- Modify: `src/compare-stats.ts`
- Modify: `tests/compare-stats.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/compare-stats.test.ts`:

```ts
import { scanSelfCorrections } from '../src/compare-stats.js'
import { writeFile, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach } from 'vitest'

const TMP_DIR = join(tmpdir(), `codeburn-compare-test-${Date.now()}`)

function jsonlLine(type: string, model: string, text: string, timestamp = '2026-04-15T10:00:00Z'): string {
  if (type === 'assistant') {
    return JSON.stringify({
      type: 'assistant',
      timestamp,
      message: { model, content: [{ type: 'text', text }], id: `msg-${Math.random()}`, usage: { input_tokens: 0, output_tokens: 0 } },
    })
  }
  return JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: text } })
}

describe('scanSelfCorrections', () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true })
  })

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true })
  })

  it('counts apology patterns per model', async () => {
    const lines = [
      jsonlLine('user', '', 'fix this'),
      jsonlLine('assistant', 'opus-4-6', 'Sure, let me fix that.'),
      jsonlLine('assistant', 'opus-4-6', "I'm sorry, I made a mistake in the previous edit."),
      jsonlLine('assistant', 'opus-4-7', 'My bad, that was incorrect.'),
      jsonlLine('assistant', 'opus-4-7', 'Here is the correct version.'),
    ]
    await writeFile(join(TMP_DIR, 'session1.jsonl'), lines.join('\n'), 'utf-8')

    const counts = await scanSelfCorrections([TMP_DIR])
    expect(counts.get('opus-4-6')).toBe(1)
    expect(counts.get('opus-4-7')).toBe(1)
  })

  it('does not count non-apology text', async () => {
    const lines = [
      jsonlLine('assistant', 'opus-4-6', 'Everything looks good. The tests pass.'),
      jsonlLine('assistant', 'opus-4-6', 'I have fixed the bug successfully.'),
    ]
    await writeFile(join(TMP_DIR, 'session1.jsonl'), lines.join('\n'), 'utf-8')

    const counts = await scanSelfCorrections([TMP_DIR])
    expect(counts.get('opus-4-6') ?? 0).toBe(0)
  })

  it('handles missing or empty directories', async () => {
    const counts = await scanSelfCorrections(['/nonexistent/path'])
    expect(counts.size).toBe(0)
  })

  it('scans subagent directories', async () => {
    const subDir = join(TMP_DIR, 'abc123', 'subagents')
    await mkdir(subDir, { recursive: true })
    const lines = [
      jsonlLine('assistant', 'opus-4-7', "I apologize for the confusion."),
    ]
    await writeFile(join(subDir, 'sub1.jsonl'), lines.join('\n'), 'utf-8')

    const counts = await scanSelfCorrections([TMP_DIR])
    expect(counts.get('opus-4-7')).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compare-stats.test.ts`
Expected: FAIL with "scanSelfCorrections is not exported"

- [ ] **Step 3: Write the implementation**

Add to `src/compare-stats.ts`:

```ts
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

const SELF_CORRECTION_PATTERNS = [
  /\bI('m| am) sorry\b/i,
  /\bmy mistake\b/i,
  /\bmy apolog/i,
  /\bI made (a |an )?(error|mistake)\b/i,
  /\bI was wrong\b/i,
  /\bmy bad\b/i,
  /\bI apologize\b/i,
  /\bsorry about that\b/i,
  /\bsorry for (the|that|this)\b/i,
  /\bI should have\b/i,
  /\bI shouldn't have\b/i,
  /\bI incorrectly\b/i,
  /\bI mistakenly\b/i,
]

function hasSelfCorrection(text: string): boolean {
  return SELF_CORRECTION_PATTERNS.some(p => p.test(text))
}

function extractAssistantText(entry: { message?: { content?: unknown } }): string {
  const content = entry.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string')
      .map((b: { text: string }) => b.text)
      .join(' ')
  }
  return ''
}

async function collectJsonlPaths(dirPath: string): Promise<string[]> {
  const paths: string[] = []
  const files = await readdir(dirPath).catch(() => [])
  for (const f of files) {
    if (f.endsWith('.jsonl')) {
      paths.push(join(dirPath, f))
    } else {
      const subagents = join(dirPath, f, 'subagents')
      const subs = await readdir(subagents).catch(() => [])
      for (const sf of subs) {
        if (sf.endsWith('.jsonl')) paths.push(join(subagents, sf))
      }
    }
  }
  return paths
}

export async function scanSelfCorrections(sessionDirs: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()

  for (const dir of sessionDirs) {
    const jsonlPaths = await collectJsonlPaths(dir)
    for (const filePath of jsonlPaths) {
      const content = await readFile(filePath, 'utf-8').catch(() => null)
      if (!content) continue
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry.type !== 'assistant') continue
          const model = entry.message?.model
          if (!model || model === '<synthetic>') continue
          const text = extractAssistantText(entry)
          if (text && hasSelfCorrection(text)) {
            counts.set(model, (counts.get(model) ?? 0) + 1)
          }
        } catch {}
      }
    }
  }

  return counts
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compare-stats.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/compare-stats.ts tests/compare-stats.test.ts
git commit --author="iamtoruk <hello@agentseal.org>" -m "feat(compare): add self-correction JSONL scanner"
```

---

### Task 4: ModelSelector Ink component

**Files:**
- Create: `src/compare.tsx`

- [ ] **Step 1: Create the ModelSelector component**

Create `src/compare.tsx`:

```tsx
import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

import type { ModelStats, ComparisonRow } from './compare-stats.js'
import { formatCost } from './format.js'

const ORANGE = '#FF8C42'
const GREEN = '#5BF5A0'
const DIM = '#555555'
const GOLD = '#FFD700'

const LOW_DATA_THRESHOLD = 20

type ModelSelectorProps = {
  models: ModelStats[]
  onSelect: (a: ModelStats, b: ModelStats) => void
  onBack: () => void
}

export function ModelSelector({ models, onSelect, onBack }: ModelSelectorProps) {
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useInput((input, key) => {
    if (input === 'q') { process.exit(0) }
    if (key.escape) { onBack(); return }

    if (key.upArrow) {
      setCursor(c => (c - 1 + models.length) % models.length)
    } else if (key.downArrow) {
      setCursor(c => (c + 1) % models.length)
    } else if (input === ' ') {
      setSelected(prev => {
        const next = new Set(prev)
        const model = models[cursor].model
        if (next.has(model)) {
          next.delete(model)
        } else if (next.size < 2) {
          next.add(model)
        }
        return next
      })
    } else if (key.return && selected.size === 2) {
      const picks = models.filter(m => selected.has(m.model))
      onSelect(picks[0], picks[1])
    }
  })

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color={ORANGE}>Model Comparison</Text>
      <Text>{''}</Text>
      <Text>Select two models to compare:</Text>
      <Text>{''}</Text>
      {models.map((m, i) => {
        const isCursor = i === cursor
        const isSelected = selected.has(m.model)
        const isLowData = m.calls < LOW_DATA_THRESHOLD
        const prefix = isCursor ? '> ' : '  '
        const marker = isSelected ? ' [selected]' : ''
        const lowLabel = isLowData ? '  low data' : ''
        return (
          <Text key={m.model}>
            <Text color={isCursor ? ORANGE : undefined} bold={isCursor}>
              {prefix}{m.model.padEnd(28)}
            </Text>
            <Text>{String(m.calls.toLocaleString()).padStart(10)} calls</Text>
            <Text color={GOLD}>{formatCost(m.cost).padStart(10)}</Text>
            <Text color={isSelected ? GREEN : undefined} bold={isSelected}>{marker}</Text>
            <Text dimColor>{lowLabel}</Text>
          </Text>
        )
      })}
      <Text>{''}</Text>
      <Text dimColor>
        [space] select  {selected.size === 2 ? <Text color={GREEN}>[enter] compare</Text> : <Text dimColor>[enter] compare</Text>}  [esc] back  [q] quit
      </Text>
    </Box>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx --eval "import './src/compare.js'" 2>&1 | head -5`
Expected: No import errors (may warn about unused exports, that's fine)

- [ ] **Step 3: Commit**

```bash
git add src/compare.tsx
git commit --author="iamtoruk <hello@agentseal.org>" -m "feat(compare): add ModelSelector component"
```

---

### Task 5: ComparisonResults Ink component

**Files:**
- Modify: `src/compare.tsx`

- [ ] **Step 1: Add the ComparisonResults component**

Add to `src/compare.tsx`:

```tsx
type ComparisonResultsProps = {
  modelA: ModelStats
  modelB: ModelStats
  rows: ComparisonRow[]
  onBack: () => void
}

function formatValue(value: number | null, fmt: ComparisonRow['formatFn']): string {
  if (value === null) return '-'
  switch (fmt) {
    case 'cost': return '$' + value.toFixed(4)
    case 'number': return value.toLocaleString()
    case 'percent': return value.toFixed(1) + '%'
    case 'decimal': return value.toFixed(2)
  }
}

function shortName(model: string): string {
  return model.replace(/^claude-/, '')
}

function daysOfData(first: string, last: string): number {
  if (!first || !last) return 0
  const ms = new Date(last).getTime() - new Date(first).getTime()
  return Math.max(1, Math.ceil(ms / 86400000))
}

const LABEL_WIDTH = 20
const VALUE_WIDTH = 14
const WINNER_WIDTH = 12

export function ComparisonResults({ modelA, modelB, rows, onBack }: ComparisonResultsProps) {
  const nameA = shortName(modelA.model)
  const nameB = shortName(modelB.model)

  useInput((input, key) => {
    if (input === 'q') process.exit(0)
    if (key.escape) onBack()
  })

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color={ORANGE}>{modelA.model}  <Text color={DIM}>vs</Text>  {modelB.model}</Text>
      <Text>{''}</Text>

      <Text dimColor>
        {''.padEnd(LABEL_WIDTH)}{nameA.padStart(VALUE_WIDTH)}{nameB.padStart(VALUE_WIDTH)}
      </Text>

      {rows.map(row => (
        <Text key={row.label}>
          <Text>{'  ' + row.label.padEnd(LABEL_WIDTH - 2)}</Text>
          <Text color={row.winner === 'a' ? GREEN : undefined}>
            {formatValue(row.valueA, row.formatFn).padStart(VALUE_WIDTH)}
          </Text>
          <Text color={row.winner === 'b' ? GREEN : undefined}>
            {formatValue(row.valueB, row.formatFn).padStart(VALUE_WIDTH)}
          </Text>
          <Text color={row.winner === 'a' ? GREEN : row.winner === 'b' ? GREEN : DIM}>
            {(row.winner === 'a' ? `${nameA} wins` : row.winner === 'b' ? `${nameB} wins` : row.winner === 'tie' ? 'tie' : '').padStart(WINNER_WIDTH)}
          </Text>
        </Text>
      ))}

      <Text>{''}</Text>
      <Text dimColor>{'  ' + '\u2500'.repeat(LABEL_WIDTH + VALUE_WIDTH * 2 + WINNER_WIDTH - 4) + ' Context'}</Text>

      <Text dimColor>
        {'  ' + 'Calls'.padEnd(LABEL_WIDTH - 2)}
        {modelA.calls.toLocaleString().padStart(VALUE_WIDTH)}
        {modelB.calls.toLocaleString().padStart(VALUE_WIDTH)}
      </Text>
      <Text dimColor>
        {'  ' + 'Cost'.padEnd(LABEL_WIDTH - 2)}
        {formatCost(modelA.cost).padStart(VALUE_WIDTH)}
        {formatCost(modelB.cost).padStart(VALUE_WIDTH)}
      </Text>
      <Text dimColor>
        {'  ' + 'Days of data'.padEnd(LABEL_WIDTH - 2)}
        {String(daysOfData(modelA.firstSeen, modelA.lastSeen)).padStart(VALUE_WIDTH)}
        {String(daysOfData(modelB.firstSeen, modelB.lastSeen)).padStart(VALUE_WIDTH)}
      </Text>
      <Text dimColor>
        {'  ' + 'Edit turns'.padEnd(LABEL_WIDTH - 2)}
        {modelA.editTurns.toLocaleString().padStart(VALUE_WIDTH)}
        {modelB.editTurns.toLocaleString().padStart(VALUE_WIDTH)}
      </Text>

      {(modelA.calls < LOW_DATA_THRESHOLD || modelB.calls < LOW_DATA_THRESHOLD) && (
        <>
          <Text>{''}</Text>
          <Text color="#F5C85B">  Note: {modelA.calls < LOW_DATA_THRESHOLD ? nameA : nameB} has limited data ({Math.min(modelA.calls, modelB.calls)} calls). Results may not be representative.</Text>
        </>
      )}

      <Text>{''}</Text>
      <Text dimColor>[esc] back  [q] quit</Text>
    </Box>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx --eval "import './src/compare.js'" 2>&1 | head -5`
Expected: No import errors

- [ ] **Step 3: Commit**

```bash
git add src/compare.tsx
git commit --author="iamtoruk <hello@agentseal.org>" -m "feat(compare): add ComparisonResults component"
```

---

### Task 6: CompareView orchestrator and renderCompare()

**Files:**
- Modify: `src/compare.tsx`

- [ ] **Step 1: Add CompareView and renderCompare**

Add to `src/compare.tsx`:

```tsx
import { render } from 'ink'

import { aggregateModelStats, computeComparison, scanSelfCorrections } from './compare-stats.js'
import { parseAllSessions } from './parser.js'
import { getAllProviders } from './providers/index.js'
import type { ProjectSummary, DateRange } from './types.js'

type ComparePhase = 'select' | 'loading' | 'results'

type CompareViewProps = {
  projects: ProjectSummary[]
  onBack: () => void
}

export function CompareView({ projects, onBack }: CompareViewProps) {
  const [phase, setPhase] = useState<ComparePhase>('select')
  const [models] = useState(() => aggregateModelStats(projects))
  const [pickedA, setPickedA] = useState<ModelStats | null>(null)
  const [pickedB, setPickedB] = useState<ModelStats | null>(null)
  const [rows, setRows] = useState<ComparisonRow[]>([])

  if (models.length < 2) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color={ORANGE}>Model Comparison</Text>
        <Text>{''}</Text>
        <Text>Need at least 2 models to compare. Found: {models.map(m => m.model).join(', ') || 'none'}</Text>
        <Text>{''}</Text>
        <Text dimColor>[esc] back  [q] quit</Text>
      </Box>
    )
  }

  const handleSelect = async (a: ModelStats, b: ModelStats) => {
    setPickedA(a)
    setPickedB(b)
    setPhase('loading')

    const providers = await getAllProviders()
    const dirs: string[] = []
    for (const p of providers) {
      const sources = await p.discoverSessions()
      for (const s of sources) dirs.push(s.path)
    }
    const corrections = await scanSelfCorrections(dirs)
    a.selfCorrections = corrections.get(a.model) ?? 0
    b.selfCorrections = corrections.get(b.model) ?? 0

    setRows(computeComparison(a, b))
    setPhase('results')
  }

  if (phase === 'select') {
    return <ModelSelector models={models} onSelect={handleSelect} onBack={onBack} />
  }

  if (phase === 'loading') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color={ORANGE}>Comparing {pickedA?.model} vs {pickedB?.model}...</Text>
      </Box>
    )
  }

  return (
    <ComparisonResults
      modelA={pickedA!}
      modelB={pickedB!}
      rows={rows}
      onBack={() => setPhase('select')}
    />
  )
}

export async function renderCompare(
  range: DateRange,
  provider: string,
): Promise<void> {
  const projects = await parseAllSessions(range, provider)
  if (projects.length === 0) {
    console.log('\n  No usage data found.\n')
    return
  }

  const isTTY = process.stdin.isTTY && process.stdout.isTTY
  if (!isTTY) {
    console.log('\n  Model comparison requires an interactive terminal.\n')
    return
  }

  const { waitUntilExit } = render(
    <CompareView projects={projects} onBack={() => process.exit(0)} />
  )
  await waitUntilExit()
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx --eval "import './src/compare.js'" 2>&1 | head -5`
Expected: No import errors

- [ ] **Step 3: Commit**

```bash
git add src/compare.tsx
git commit --author="iamtoruk <hello@agentseal.org>" -m "feat(compare): add CompareView orchestrator and renderCompare"
```

---

### Task 7: CLI compare command

**Files:**
- Modify: `src/cli.ts` (add command at ~line 650, before `program.parse()`)

- [ ] **Step 1: Add the compare command**

Add before the `program.parse()` line in `src/cli.ts`:

```ts
import { renderCompare } from './compare.js'
```

Add at the top with other imports. Then add the command before `program.parse()`:

```ts
program
  .command('compare')
  .description('Compare two AI models side-by-side')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'all')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .action(async (opts) => {
    await loadPricing()
    const { range } = getDateRange(opts.period)
    await renderCompare(range, opts.provider)
  })
```

- [ ] **Step 2: Test the standalone command**

Run: `npx tsx src/cli.ts compare`
Expected: Model selection screen appears with arrow-key navigation. Press `q` to quit.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit --author="iamtoruk <hello@agentseal.org>" -m "feat(compare): add codeburn compare command"
```

---

### Task 8: Dashboard integration

**Files:**
- Modify: `src/dashboard.tsx` (~5 changes)

- [ ] **Step 1: Add 'compare' to View type**

Change line 16 in `src/dashboard.tsx`:

```ts
// Before:
type View = 'dashboard' | 'optimize'

// After:
type View = 'dashboard' | 'optimize' | 'compare'
```

- [ ] **Step 2: Add import**

Add to imports at the top of `src/dashboard.tsx`:

```ts
import { CompareView } from './compare.js'
```

- [ ] **Step 3: Add modelCount state and 'c' keybinding**

In the `InteractiveDashboard` component, add state tracking after `optimizeAvailable`:

```ts
const modelCount = new Set(
  projects.flatMap(p => p.sessions.flatMap(s => Object.keys(s.modelBreakdown)))
).size
const compareAvailable = modelCount >= 2
```

In the `useInput` handler, add after the optimize toggle:

```ts
if (input === 'c' && compareAvailable && view === 'dashboard') { setView('compare'); return }
if (key.escape && view === 'compare') { setView('dashboard'); return }
```

Update the existing escape handler for optimize to also check compare:

```ts
// Before:
if ((input === 'b' || key.escape) && view === 'optimize') { setView('dashboard'); return }

// After:
if ((input === 'b' || key.escape) && (view === 'optimize' || view === 'compare')) { setView('dashboard'); return }
```

- [ ] **Step 4: Add CompareView to render**

In the return JSX, extend the conditional render (around line 704):

```tsx
// Before:
{view === 'optimize' && optimizeResult
  ? <OptimizeView ... />
  : <DashboardContent ... />}

// After:
{view === 'compare'
  ? <CompareView projects={projects} onBack={() => setView('dashboard')} />
  : view === 'optimize' && optimizeResult
    ? <OptimizeView ... />
    : <DashboardContent ... />}
```

- [ ] **Step 5: Update StatusBar**

Add `compareAvailable` prop to StatusBar and render the hint. In the StatusBar component, add after the optimize hint:

```tsx
{!isOptimize && view !== 'compare' && compareAvailable && (
  <><Text dimColor>   </Text><Text color={ORANGE} bold>c</Text><Text dimColor> compare</Text></>
)}
```

Update StatusBar props:

```ts
function StatusBar({ width, showProvider, view, findingCount, optimizeAvailable, compareAvailable }: {
  width: number; showProvider?: boolean; view?: View; findingCount?: number; optimizeAvailable?: boolean; compareAvailable?: boolean
})
```

Pass `compareAvailable` at both StatusBar call sites.

- [ ] **Step 6: Test the dashboard integration**

Run: `npx tsx src/cli.ts report`
Expected: Status bar shows `c compare`. Press `c` to open model selection. Press `Esc` to go back. Press `q` to quit.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard.tsx
git commit --author="iamtoruk <hello@agentseal.org>" -m "feat(compare): integrate into dashboard with c shortcut"
```

---

### Task 9: End-to-end verification

**Files:** None (testing only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass (including new compare-stats tests)

- [ ] **Step 2: Test standalone compare**

Run: `npx tsx src/cli.ts compare`
Expected: Model selection screen. Select two models with spacebar. Press Enter. See comparison table with color-coded winners. Press Esc to go back. Press q to quit.

- [ ] **Step 3: Test dashboard integration**

Run: `npx tsx src/cli.ts report`
Expected: Press `c` to open compare. Select models. See results. Press Esc twice to return to dashboard. Verify `o` for optimize still works.

- [ ] **Step 4: Verify edge cases**

Run: `npx tsx src/cli.ts compare --provider codex`
Expected: If Codex has < 2 models, shows "Need at least 2 models" message.

- [ ] **Step 5: Final commit on branch**

```bash
git add -A
git status  # verify no unrelated files
# Only if there are unstaged fixes:
git commit --author="iamtoruk <hello@agentseal.org>" -m "fix(compare): polish from end-to-end testing"
```
