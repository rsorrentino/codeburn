import { stripVTControlCharacters } from 'node:util'

import { Chalk } from 'chalk'

import type { SourceProgressReporter } from './parser.js'
import { providerColor, providerLabel } from './provider-colors.js'

function getBarWidth(columns: number | undefined): number {
  if (!columns || columns >= 80) return 16
  if (columns >= 56) return 12
  return 8
}

function renderBar(current: number, total: number, width: number): { filled: number; empty: number } {
  if (total <= 0) return { filled: 0, empty: width }

  const filled = Math.max(0, Math.min(width, Math.round((current / total) * width)))
  return { filled, empty: Math.max(0, width - filled) }
}

function mapChalkLevel(colorDepth: number): 0 | 1 | 2 | 3 {
  if (colorDepth >= 24) return 3
  if (colorDepth >= 8) return 2
  if (colorDepth >= 1) return 1
  return 0
}

export function createTerminalProgressReporter(
  enabled: boolean,
  stream: NodeJS.WriteStream = process.stderr,
): SourceProgressReporter | null {
  if (!enabled || !stream.isTTY) return null

  let total = 0
  let current = 0
  let lastProvider = 'all'
  let lastLineLength = 0
  let active = false
  const colorDepth = typeof stream.getColorDepth === 'function' ? stream.getColorDepth() : 0
  const chalk = new Chalk({ level: mapChalkLevel(colorDepth) })

  function buildFrame(provider: string, done = false): string {
    const columns = 'columns' in stream ? (stream as NodeJS.WriteStream & { columns?: number }).columns : process.stderr.columns
    const width = getBarWidth(columns)
    const label = providerLabel(provider)
    const { filled, empty } = renderBar(current, total, width)
    const accent = providerColor(provider)
    const line = [
      chalk.dim('Updating'),
      chalk.bold.hex(accent)(label),
      chalk.dim('cache'),
      `[${chalk.hex(accent)('█'.repeat(filled))}${chalk.hex('#666666')('░'.repeat(empty))}]`,
      `${current}/${total}`,
    ].join(' ')
    const visible = stripVTControlCharacters(line)
    const pad = lastLineLength > visible.length ? ' '.repeat(lastLineLength - visible.length) : ''
    lastLineLength = Math.max(lastLineLength, visible.length)
    return `${line}${pad}${done ? '\n' : '\r'}`
  }

  return {
    start(nextTotal: number) {
      total = nextTotal
      current = 0
      lastProvider = 'all'
      lastLineLength = 0
      active = nextTotal > 0
    },
    advance(provider: string) {
      if (!active) return
      lastProvider = provider
      current += 1
      stream.write(buildFrame(provider))
    },
    finish(provider?: string) {
      if (!active) return
      if (current === 0) return
      stream.write(buildFrame(provider ?? lastProvider, true))
      active = false
      total = 0
      current = 0
      lastProvider = 'all'
      lastLineLength = 0
    },
  }
}
