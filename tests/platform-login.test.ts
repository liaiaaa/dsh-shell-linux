import { describe, expect, it } from 'vitest'
import { watchPlatformLogin, type PlatformLoginAccount, type PlatformLoginRequest } from '../src/host/platform-login.ts'

function scriptedAccount(views: { attempt: { id: string; phase: string; authorizeUrl?: string } | null }[]): PlatformLoginAccount {
  return {
    async *watch() { for (const view of views) yield view },
  }
}

describe('watchPlatformLogin', () => {
  it('opens each attempt once and settles it once', async () => {
    const requests: PlatformLoginRequest[] = []
    await watchPlatformLogin(
      scriptedAccount([
        { attempt: null },
        { attempt: { id: 'a1', phase: 'initializing' } },
        { attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/authorize?x=1' } },
        { attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/authorize?x=1' } },
        { attempt: { id: 'a1', phase: 'succeeded' } },
        { attempt: { id: 'a2', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/authorize?x=2' } },
      ]),
      (request) => { requests.push(request) },
      new AbortController().signal,
    )
    expect(requests).toEqual([
      { action: 'open', url: 'https://platform.deepseek.com/authorize?x=1' },
      { action: 'close', focus: false },
      { action: 'open', url: 'https://platform.deepseek.com/authorize?x=2' },
    ])
  })
  it('asks for focus when an attempt failed or expired', async () => {
    const requests: PlatformLoginRequest[] = []
    await watchPlatformLogin(
      scriptedAccount([{ attempt: { id: 'a1', phase: 'expired' } }]),
      (request) => { requests.push(request) },
      new AbortController().signal,
    )
    expect(requests).toEqual([{ action: 'close', focus: true }])
  })
})
