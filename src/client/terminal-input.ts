/**
 * Terminal input filtering for the interactive terminal view.
 *
 * xterm.js answers host queries — the shell's startup "what terminal / what
 * colors" interrogation — by emitting reply sequences on its `onData` event,
 * interleaved with real keystrokes. A remote login shell sends these queries
 * fire-and-forget (it never reads the reply), so the reply lands on the pty's
 * stdin during a canonical/echo window and is echoed back as garbage at the
 * prompt. Those replies are never real user input, so they are stripped before
 * the input is forwarded to the host pty. A shell that does read a reply (the
 * common color-detection snippet reads it synchronously right after asking)
 * is unaffected because it consumes the reply before it could echo.
 */

const ESC = '\x1b'

/**
 * Reply sequences xterm.js emits in response to host queries:
 * - DA1/DA2 device attributes:  ESC [ ?|> ... c
 * - DECRPM mode report:         ESC [ [?] mode ; value $y
 * - OSC 10/11/12 color report:  ESC ] 10|11|12 ; ... ST|BEL
 */
const REPLY_PATTERNS: readonly RegExp[] = [
  /\x1b\[[?>][0-9;]*c/g,
  /\x1b\[\??[0-9]+;[0-9]+\$y/g,
  /\x1b\](?:10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)/g,
]

/** Strip terminal query replies from an input chunk, returning what remains. */
export function stripTerminalReplies(data: string): string {
  let result = data
  for (const pattern of REPLY_PATTERNS) {
    result = result.replace(pattern, '')
  }
  return result
}
