// MPEG-TS → fragmented MP4 remux with mux.js (loaded globally as `muxjs`).
// Segments must be pushed in playback order.

// The output is repaired for QuickTime as it is written (see fmp4-fix.js):
// real durations in the init segment, increasing fragment numbers.

import { setInitDuration, renumberFragments } from '../lib/fmp4-fix.js';
import { t } from '../lib/i18n.js';

export class TsRemuxer {
  /** @param {{duration?:number}} [opts] stream length in seconds (playlist total) */
  constructor({ duration = 0 } = {}) {
    if (!globalThis.muxjs?.Transmuxer) throw new Error(t('errMuxjsMissing'));
    this.transmuxer = new globalThis.muxjs.Transmuxer({ remux: true });
    this.initWritten = false;
    this.pending = [];
    this.sequence = 1;
    this.transmuxer.on('data', (segment) => {
      if (!this.initWritten && segment.initSegment) {
        this.pending.push(setInitDuration(segment.initSegment, duration));
        this.initWritten = true;
      }
      this.sequence = renumberFragments(segment.data, this.sequence);
      this.pending.push(segment.data);
    });
    this.transmuxer.on('error', (e) => {
      this.error = e;
    });
  }

  /** Feeds one TS segment, returns the fMP4 chunks produced for it. */
  push(tsBytes) {
    this.pending = [];
    this.transmuxer.push(tsBytes);
    this.transmuxer.flush();
    if (this.error) throw new Error(t('errRemux', this.error.message ?? this.error));
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
