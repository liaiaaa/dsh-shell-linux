import { describe, expect, it } from 'vitest'
import { describeHostExit, redactTokens } from '../src/main/host-process.ts'

describe('describeHostExit', () => {
  it('a clean stopping shutdown is silent', () => {
    expect(describeHostExit({ code: 0, signal: null, stopping: true, stderrTail: '' })).toBeUndefined()
    expect(describeHostExit({ code: null, signal: 'SIGTERM', stopping: true, stderrTail: 'partial logs' })).toBeUndefined()
  })
  it('a non-zero exit carries the code and the stderr tail', () => {
    expect(describeHostExit({ code: 1, signal: null, stopping: false, stderrTail: 'boom' }))
      .toBe('dsh desktop host exited with 1: boom')
    expect(describeHostExit({ code: 1, signal: null, stopping: false, stderrTail: '' }))
      .toBe('dsh desktop host exited with 1')
  })
  it('a signal kill names the signal, not "stopped"', () => {
    expect(describeHostExit({ code: null, signal: 'SIGKILL', stopping: false, stderrTail: '' }))
      .toBe('dsh desktop host was killed by SIGKILL')
  })
  it('a plain exit-0 without stopping is still reported', () => {
    expect(describeHostExit({ code: 0, signal: null, stopping: false, stderrTail: '' }))
      .toBe('dsh desktop host stopped')
  })
})

describe('redactTokens', () => {
  const TOKEN = 'UdKbUZnJ9RE0mTnR8J0MyoErresrGYDzaKiUhUEr_m0'
  it('masks the query token the host prints at boot', () => {
    const line = `dsh web: http://127.0.0.1:41707/?token=${TOKEN}`
    const redacted = redactTokens(line)
    expect(redacted).toBe('dsh web: http://127.0.0.1:41707/?token=<redacted>')
    expect(redacted).not.toContain(TOKEN)
  })
  it('masks a token that is not the first query parameter', () => {
    expect(redactTokens('https://example.test/path?x=1&token=abc&y=2'))
      .toBe('https://example.test/path?x=1&token=<redacted>&y=2')
  })
  it('leaves lines without a token untouched', () => {
    expect(redactTokens('[dsh-desktop] tunnel example.com:443 up 7ms proxy=ok'))
      .toBe('[dsh-desktop] tunnel example.com:443 up 7ms proxy=ok')
    expect(redactTokens('tokenizer=on, token = abc, mytoken=zzz')).toBe('tokenizer=on, token = abc, mytoken=zzz')
  })
  it('masks every token on one line', () => {
    expect(redactTokens('a?token=one b?token=two')).toBe('a?token=<redacted> b?token=<redacted>')
  })
})
