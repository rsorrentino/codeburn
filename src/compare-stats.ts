import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

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
        const primaryModel = turn.assistantCalls[0]!.model
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

export type ComparisonRow = {
  label: string
  valueA: number | null
  valueB: number | null
  formatFn: 'cost' | 'number' | 'percent' | 'decimal'
  winner: 'a' | 'b' | 'tie' | 'none'
}

type MetricDef = {
  label: string
  formatFn: ComparisonRow['formatFn']
  higherIsBetter: boolean
  compute: (s: ModelStats) => number | null
}

const METRICS: MetricDef[] = [
  {
    label: 'Cost / call',
    formatFn: 'cost',
    higherIsBetter: false,
    compute: s => s.calls > 0 ? s.cost / s.calls : null,
  },
  {
    label: 'Output tok / call',
    formatFn: 'number',
    higherIsBetter: false,
    compute: s => s.calls > 0 ? Math.round(s.outputTokens / s.calls) : null,
  },
  {
    label: 'Cache hit rate',
    formatFn: 'percent',
    higherIsBetter: true,
    compute: s => {
      const total = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens
      return total > 0 ? (s.cacheReadTokens / total) * 100 : null
    },
  },
  {
    label: 'One-shot rate',
    formatFn: 'percent',
    higherIsBetter: true,
    compute: s => s.editTurns > 0 ? (s.oneShotTurns / s.editTurns) * 100 : null,
  },
  {
    label: 'Retry rate',
    formatFn: 'decimal',
    higherIsBetter: false,
    compute: s => s.editTurns > 0 ? s.retries / s.editTurns : null,
  },
  {
    label: 'Self-correction',
    formatFn: 'percent',
    higherIsBetter: false,
    compute: s => s.totalTurns > 0 ? (s.selfCorrections / s.totalTurns) * 100 : null,
  },
]

function pickWinner(valueA: number | null, valueB: number | null, higherIsBetter: boolean): ComparisonRow['winner'] {
  if (valueA === null || valueB === null) return 'none'
  if (valueA === valueB) return 'tie'
  if (higherIsBetter) return valueA > valueB ? 'a' : 'b'
  return valueA < valueB ? 'a' : 'b'
}

export function computeComparison(a: ModelStats, b: ModelStats): ComparisonRow[] {
  return METRICS.map(m => {
    const valueA = m.compute(a)
    const valueB = m.compute(b)
    return {
      label: m.label,
      valueA,
      valueB,
      formatFn: m.formatFn,
      winner: pickWinner(valueA, valueB, m.higherIsBetter),
    }
  })
}

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

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join(' ')
}

async function collectJsonlFiles(sessionDir: string): Promise<string[]> {
  const entries = await readdir(sessionDir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(join(sessionDir, entry.name))
    } else if (entry.isDirectory() && entry.name === 'subagents') {
      const subEntries = await readdir(join(sessionDir, entry.name), { withFileTypes: true })
      for (const sub of subEntries) {
        if (sub.isFile() && sub.name.endsWith('.jsonl')) {
          files.push(join(sessionDir, entry.name, sub.name))
        }
      }
    }
  }
  return files
}

export async function scanSelfCorrections(sessionDirs: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()

  for (const dir of sessionDirs) {
    let sessionEntries
    try {
      sessionEntries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of sessionEntries) {
      if (!entry.isDirectory()) continue
      const sessionDir = join(dir, entry.name)

      let files: string[]
      try {
        files = await collectJsonlFiles(sessionDir)
      } catch {
        continue
      }

      for (const file of files) {
        let raw: string
        try {
          raw = await readFile(file, 'utf8')
        } catch {
          continue
        }

        for (const line of raw.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue

          let parsed: unknown
          try {
            parsed = JSON.parse(trimmed)
          } catch {
            continue
          }

          if (
            parsed === null ||
            typeof parsed !== 'object' ||
            (parsed as Record<string, unknown>)['type'] !== 'assistant'
          ) continue

          const msg = (parsed as Record<string, unknown>)['message']
          if (msg === null || typeof msg !== 'object') continue

          const model = (msg as Record<string, unknown>)['model']
          if (typeof model !== 'string' || model === '<synthetic>') continue

          const text = extractText((msg as Record<string, unknown>)['content'])
          if (SELF_CORRECTION_PATTERNS.some(p => p.test(text))) {
            counts.set(model, (counts.get(model) ?? 0) + 1)
          }
        }
      }
    }
  }

  return counts
}
