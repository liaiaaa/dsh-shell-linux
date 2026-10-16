import { describe, expect, it } from 'vitest'
import { describeHostExit } from '../src/main/host-process.ts'

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
