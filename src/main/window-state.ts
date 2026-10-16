/**
 * Window geometry persistence: pure validation/clamping so the rules are testable
 * without Electron. The state file lives in the shell's own userData directory
 * (never under ~/.dsh), written only on clean closes and read on startup.
 */

/** Hard floor mirrors the BrowserWindow minWidth/minHeight in main.ts. */
const MIN_WIDTH = 520
const MIN_HEIGHT = 400

export interface WindowState {
  readonly width: number
  readonly height: number
  readonly x?: number
  readonly y?: number
  readonly maximized: boolean
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Accepts raw stored values; keeps what is usable, drops the rest. */
export function normalizeWindowState(raw: Partial<WindowState> | null | undefined): WindowState {
  const width = finite(raw?.width) ? Math.max(MIN_WIDTH, Math.round(raw.width)) : 1280
  const height = finite(raw?.height) ? Math.max(MIN_HEIGHT, Math.round(raw.height)) : 820
  const state: WindowState = { width, height, maximized: raw?.maximized === true }
  if (finite(raw?.x) && finite(raw?.y)) {
    return { ...state, x: Math.round(raw.x), y: Math.round(raw.y) }
  }
  return state
}

/**
 * Pull a stored geometry back into a connected display's work area: an off-screen
 * window (monitor unplugged since last run) must not open invisible, and a window
 * larger than any current display must not overflow it. Keeps a 100px strip visible
 * when the stored size exceeds the work area.
 */
export function clampToWorkArea(state: WindowState, workArea: Rect): WindowState {
  const width = Math.min(state.width, workArea.width)
  const height = Math.min(state.height, workArea.height)
  const next: WindowState = { ...state, width, height }
  if (state.x === undefined || state.y === undefined) return next
  const maxX = workArea.x + workArea.width - Math.min(width, 100)
  const maxY = workArea.y + workArea.height - Math.min(height, 100)
  return {
    ...next,
    x: Math.min(Math.max(state.x, workArea.x), Math.max(workArea.x, maxX)),
    y: Math.min(Math.max(state.y, workArea.y), Math.max(workArea.y, maxY)),
  }
}

/** Type guard for what comes off disk (JSON.parse gives `any`). */
export function isRestorableState(raw: unknown): raw is WindowState {
  if (typeof raw !== 'object' || raw === null) return false
  const candidate = raw as Record<string, unknown>
  return finite(candidate.width) && finite(candidate.height)
    && (candidate.x === undefined || finite(candidate.x))
    && (candidate.y === undefined || finite(candidate.y))
    && typeof candidate.maximized === 'boolean'
}
