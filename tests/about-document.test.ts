import { describe, expect, it } from 'vitest'
import { aboutDocument, escapeHtml, type AboutProps } from '../src/main/about-document.ts'

function props(overrides: Partial<AboutProps> = {}): AboutProps {
  return {
    shellVersion: '0.1.0',
    dshVersion: '0.2.1-rc.3',
    electron: '44.7.0',
    node: '24.21.0',
    chrome: '152.0.7977.130',
    hostNode: '/usr/bin/node',
    safeMode: false,
    iconDataUri: 'data:image/png;base64,AAAA',
    update: { kind: 'idle', log: [] },
    ...overrides,
  }
}

describe('escapeHtml', () => {
  it('escapes text nodes and double-quoted attributes', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`))
      .toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;')
  })
})

describe('aboutDocument', () => {
  it('shows every version the native dialog used to show', () => {
    const html = aboutDocument(props())
    expect(html).toContain('dsh-shell-linux')
    expect(html).toContain('0.1.0')
    expect(html).toContain('0.2.1-rc.3')
    expect(html).toContain('44.7.0')
    expect(html).toContain('24.21.0')
    expect(html).toContain('152.0.7977.130')
    expect(html).toContain('/usr/bin/node')
  })
  it('marks safe mode with a badge and normal mode with another', () => {
    expect(aboutDocument(props({ safeMode: true }))).toContain('安全模式')
    expect(aboutDocument(props({ safeMode: false }))).toContain('>正常<')
  })
  it('escapes hostile version strings instead of injecting markup', () => {
    const hostile = '<script>alert(1)</script>'
    const html = aboutDocument(props({ dshVersion: hostile }))
    expect(html).not.toContain(hostile)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
  it('seeds the page with the initial update state', () => {
    const html = aboutDocument(props({
      update: { kind: 'available', version: '0.2.1-rc.4', channel: 'next', canUpgrade: true, command: 'npm i -g @deepseek-ai/dsh@next', log: [] },
    }))
    expect(html).toContain('const initial = {"kind":"available"')
    expect(html).toContain('0.2.1-rc.4')
  })
  it('keeps the icon out of the header when none could be read', () => {
    expect(aboutDocument(props({ iconDataUri: '' }))).not.toContain('id="app-icon"')
    expect(aboutDocument(props())).toContain('id="app-icon"')
  })
  it('offers the update buttons and the copy/repo/close footer', () => {
    const html = aboutDocument(props())
    for (const id of ['check', 'upgrade', 'cancel', 'relaunch', 'copy', 'repo', 'close']) {
      expect(html).toContain(`id="${id}"`)
    }
  })
})
