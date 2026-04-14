import { basename } from 'path'

const BASH_TOOLS = new Set(['Bash', 'BashTool', 'PowerShellTool'])

/**
 * Strips quoted substrings from a command string before splitting on separators,
 * so that separators inside quotes (e.g. "hello && world") are not treated as
 * command boundaries.
 */
function stripQuotedStrings(command: string): string {
  return command.replace(/"[^"]*"|'[^']*'/g, '""')
}

export function extractBashCommands(command: string): string[] {
  if (!command || !command.trim()) return []

  // Strip quoted content so separators inside quotes are ignored
  const stripped = stripQuotedStrings(command)

  // Find separator positions (start and end) in the stripped version
  const separatorRegex = /\s*(?:&&|;|\|)\s*/g
  const separators: Array<{ start: number; end: number }> = []
  let match: RegExpExecArray | null

  while ((match = separatorRegex.exec(stripped)) !== null) {
    separators.push({ start: match.index, end: match.index + match[0].length })
  }

  // Build segment ranges from the original command
  const ranges: Array<[number, number]> = []
  let cursor = 0
  for (const sep of separators) {
    ranges.push([cursor, sep.start])
    cursor = sep.end
  }
  ranges.push([cursor, command.length])

  // Extract the first token from each segment
  const commands: string[] = []
  for (const [start, end] of ranges) {
    const segment = command.slice(start, end).trim()
    if (!segment) continue

    const firstToken = segment.split(/\s+/)[0]
    const base = basename(firstToken)

    if (base && base !== 'cd') {
      commands.push(base)
    }
  }

  return commands
}

export function isBashTool(toolName: string): boolean {
  return BASH_TOOLS.has(toolName)
}
