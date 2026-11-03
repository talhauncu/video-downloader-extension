// Progress of a job that downloads several tracks one after another.
// Every track's piece count is known before the first one starts, so the
// total does not grow while the job runs and the share never goes back.
// Subtitle pieces count only when the job has nothing else: next to video
// and audio they are tiny and would fill the bar before the real work.

export class TrackProgress {
  /** @param {string[]} roles  one per track, in download order ('subtitle', 'video', 'audio' …) */
  constructor(roles) {
    const onlySubtitles = roles.every((r) => r === 'subtitle');
    this.counted = roles.map((r) => onlySubtitles || r !== 'subtitle');
    this.totals = roles.map(() => 0);
    this.done = roles.map(() => 0);
  }

  /** Piece count of track i, before it starts (0 when unknown). */
  setTotal(i, total) {
    this.totals[i] = Math.max(0, total ?? 0);
  }

  /** Progress inside track i; its own total wins if the playlist changed since planning. */
  update(i, done, total) {
    if (total != null) this.totals[i] = Math.max(0, total);
    this.done[i] = Math.max(this.done[i], Math.min(done, this.totals[i]));
  }

  /** @returns {{done:number, total:number}} counted pieces of the whole job */
  snapshot() {
    let done = 0;
    let total = 0;
    for (let i = 0; i < this.totals.length; i++) {
      if (!this.counted[i]) continue;
      done += this.done[i];
      total += this.totals[i];
    }
    return { done, total };
  }
}
