// Audio track choice by language: sites often list a dub (usually the
// default) next to the original soundtrack. Pure (unit-tested).

import { normalizeLanguage, languageMatches, languageFromName, languageLabel } from './subtitles.js';
import { t } from './i18n.js';

/** 'default' (the site's default track), 'original' (not the dub), or a language code. */
export const AUDIO_PREFS = ['default', 'original'];

/** Language of an audio track: its tag, else what its name spells out. */
export function audioLanguage(track) {
  return normalizeLanguage(track?.lang) ?? languageFromName(track?.name ?? track?.label) ?? null;
}

/** "Türkçe", "English", else the track's own name. */
export function audioTrackLabel(track) {
  const lang = audioLanguage(track);
  return lang ? languageLabel(lang) : track?.name || track?.label || t('audioTrackFallback');
}

/**
 * The audio track to download.
 * @param {{lang?:string|null, name?:string|null, label?:string|null, default?:boolean}[]} tracks  best first
 * @param {string} pref  'default' | 'original' | language code
 *   original: a track named "Orijinal"/"Original", else the first one that is
 *   not Turkish (dubs on these sites are Turkish), else the default
 */
export function pickAudio(tracks, pref = 'default') {
  if (!tracks?.length) return null;
  const fallback = tracks.find((t) => t.default) ?? tracks[0];
  if (pref === 'original') {
    const named = tracks.find((t) => /\b(orijinal|original|orig)\b/i.test(`${t.name ?? ''} ${t.label ?? ''}`));
    if (named) return named;
    const foreign = tracks.find((t) => {
      const lang = audioLanguage(t);
      return lang && !languageMatches(lang, ['tr']);
    });
    return foreign ?? fallback;
  }
  const code = normalizeLanguage(pref);
  if (code) return tracks.find((t) => languageMatches(audioLanguage(t), [code])) ?? fallback;
  return fallback;
}
