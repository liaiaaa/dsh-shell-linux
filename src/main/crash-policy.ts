/**
 * Renderer-crash recovery policy: reload the page on the occasional crash, but stop
 * trying when crashes pile up inside a short window — a wedged renderer would otherwise
 * turn one bug into an infinite reload loop.
 */
export class CrashBackoff {
  private readonly timestamps: number[] = []
  constructor(private readonly options: { windowMs: number; maxReloads: number }) {}
  /** Record a crash at `now` and decide whether another reload attempt is allowed. */
  registerAndDecide(now: number): boolean {
    while (this.timestamps.length > 0 && now - this.timestamps[0] > this.options.windowMs) this.timestamps.shift()
    this.timestamps.push(now)
    return this.timestamps.length <= this.options.maxReloads
  }
}
