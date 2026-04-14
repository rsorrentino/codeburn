import { describe, it, expect } from 'vitest'
import { extractBashCommands } from '../src/bash-utils.js'

describe('extractBashCommands', () => {
  it('extracts single command', () => {
    expect(extractBashCommands('git status')).toEqual(['git'])
  })

  it('extracts chained commands with &&', () => {
    expect(extractBashCommands('git add . && git commit -m "x"')).toEqual(['git', 'git'])
  })

  it('extracts chained commands with ;', () => {
    expect(extractBashCommands('ls; pwd')).toEqual(['ls', 'pwd'])
  })

  it('extracts piped commands', () => {
    expect(extractBashCommands('cat file | grep pattern')).toEqual(['cat', 'grep'])
  })

  it('filters out cd', () => {
    expect(extractBashCommands('cd /path && git status')).toEqual(['git'])
  })

  it('returns empty for cd only', () => {
    expect(extractBashCommands('cd /path')).toEqual([])
  })

  it('returns empty for empty string', () => {
    expect(extractBashCommands('')).toEqual([])
  })

  it('returns empty for whitespace only', () => {
    expect(extractBashCommands('   ')).toEqual([])
  })

  it('extracts basename from full path binary', () => {
    expect(extractBashCommands('/usr/bin/git status')).toEqual(['git'])
  })

  it('handles mixed separators', () => {
    expect(extractBashCommands('cd /x && npm install; npm run build | tee log')).toEqual(['npm', 'npm', 'tee'])
  })

  it('handles extra whitespace', () => {
    expect(extractBashCommands('  git   status  ')).toEqual(['git'])
  })

  it('handles command with quotes containing separators', () => {
    expect(extractBashCommands('echo "hello && world"')).toEqual(['echo'])
  })
})
