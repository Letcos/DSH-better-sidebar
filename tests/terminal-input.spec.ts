/**
 * Terminal input filter tests: xterm.js emits terminal-query replies (device
 * attributes, mode reports, OSC color reports) on `onData` alongside real
 * keystrokes. Those replies must be stripped so a remote login shell's
 * fire-and-forget startup queries don't echo back as garbage at the prompt,
 * while ordinary keystrokes and escape-key sequences pass through untouched.
 */
import { describe, expect, it } from 'vitest'
import { stripTerminalReplies } from '../src/client/terminal-input.ts'

const ESC = '\x1b'

describe('stripTerminalReplies', () => {
  it('strips DA1 device-attributes replies', () => {
    expect(stripTerminalReplies(`${ESC}[?1;2c`)).toBe('')
    expect(stripTerminalReplies(`${ESC}[?6c`)).toBe('')
  })

  it('strips DA2 device-attributes replies', () => {
    expect(stripTerminalReplies(`${ESC}[>0;276;0c`)).toBe('')
    expect(stripTerminalReplies(`${ESC}[>85;95;0c`)).toBe('')
    expect(stripTerminalReplies(`${ESC}[>83;40003;0c`)).toBe('')
  })

  it('strips DECRPM mode reports', () => {
    expect(stripTerminalReplies(`${ESC}[?2026;2$y`)).toBe('')
    expect(stripTerminalReplies(`${ESC}[12;1$y`)).toBe('')
  })

  it('strips OSC 10/11/12 color reports (ST and BEL terminated)', () => {
    expect(stripTerminalReplies(`${ESC}]10;rgb:0f0f/1111/1515${ESC}\\`)).toBe('')
    expect(stripTerminalReplies(`${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\`)).toBe('')
    expect(stripTerminalReplies(`${ESC}]12;rgb:0f0f/1111/1515${ESC}\\`)).toBe('')
    expect(stripTerminalReplies(`${ESC}]10;rgb:0000/0000/0000\x07`)).toBe('')
  })

  it('preserves ordinary keystrokes', () => {
    expect(stripTerminalReplies('ls -la\r')).toBe('ls -la\r')
    expect(stripTerminalReplies('echo hello\n')).toBe('echo hello\n')
  })

  it('preserves escape-key sequences (arrows, function keys, bare ESC)', () => {
    expect(stripTerminalReplies(`${ESC}[A`)).toBe(`${ESC}[A`)
    expect(stripTerminalReplies(`${ESC}[1;5C`)).toBe(`${ESC}[1;5C`)
    expect(stripTerminalReplies(`${ESC}OP`)).toBe(`${ESC}OP`)
    expect(stripTerminalReplies(`${ESC}`)).toBe(`${ESC}`)
  })

  it('strips replies from a mixed chunk while keeping the input', () => {
    const chunk = `${ESC}[>0;276;0c` + 'git status\r' + `${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\`
    expect(stripTerminalReplies(chunk)).toBe('git status\r')
  })

  it('strips the real startup reply burst to nothing', () => {
    const burst = `${ESC}[>0;276;0c${ESC}[?2026;2$y${ESC}[>0;276;0c${ESC}[?2026;2$y` +
      `${ESC}]10;rgb:0f0f/1111/1515${ESC}\\${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\${ESC}]12;rgb:0f0f/1111/1515${ESC}\\${ESC}[?2026;2$y`
    expect(stripTerminalReplies(burst)).toBe('')
  })

  it('is a no-op for an empty string', () => {
    expect(stripTerminalReplies('')).toBe('')
  })
})
