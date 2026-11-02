import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, DEFAULTS } from '../../src/lib/settings.js';

test('normalizeSettings clamps and falls back to defaults', () => {
  assert.deepEqual(normalizeSettings({}), { ...DEFAULTS });
  const s = normalizeSettings({ mergeTracks: false, transcodeToH264: 'yes', concurrency: 99, filenameTemplate: '   ', historyLimit: -1 });
  assert.equal(s.mergeTracks, false);
  assert.equal(s.transcodeToH264, DEFAULTS.transcodeToH264);
  assert.equal(s.concurrency, DEFAULTS.concurrency);
  assert.equal(s.filenameTemplate, DEFAULTS.filenameTemplate);
  assert.equal(s.historyLimit, DEFAULTS.historyLimit);
  assert.equal(normalizeSettings({ concurrency: '2', filenameTemplate: ' {title} ' }).concurrency, 2);
  assert.equal(normalizeSettings({ filenameTemplate: ' {title} ' }).filenameTemplate, '{title}');
  assert.equal(normalizeSettings({}).stripJunk, true);
  assert.equal(normalizeSettings({ stripJunk: false }).stripJunk, false);
  assert.equal(normalizeSettings({}).maxCooldownMinutes, 10);
  assert.equal(normalizeSettings({}).hideAds, true);
  assert.equal(normalizeSettings({}).badgeMode, 'hover');
  assert.equal(normalizeSettings({ badgeMode: 'always' }).badgeMode, 'always');
  assert.equal(normalizeSettings({ badgeMode: 'sometimes' }).badgeMode, 'hover');
  assert.deepEqual(normalizeSettings({}).badgeDisabledHosts, []);
  assert.deepEqual(
    normalizeSettings({ badgeDisabledHosts: 'https://www.Instagram.com/reels/\n youtube.com, not a host,  x.com ' }).badgeDisabledHosts,
    ['instagram.com', 'youtube.com', 'x.com'],
  );
  assert.deepEqual(normalizeSettings({ badgeDisabledHosts: ['a.test', 'a.test'] }).badgeDisabledHosts, ['a.test']);
  assert.deepEqual(normalizeSettings({ badgeDisabledHosts: '127.0.0.1\nlocalhost\nhttp://192.168.1.5:8080/x' }).badgeDisabledHosts, [
    '127.0.0.1',
    'localhost',
    '192.168.1.5',
  ]);
  assert.equal(normalizeSettings({ hideAds: false }).hideAds, false);
  assert.equal(normalizeSettings({ hideAds: 'no' }).hideAds, true);
  assert.equal(normalizeSettings({ maxCooldownMinutes: 0 }).maxCooldownMinutes, 0);
  assert.equal(normalizeSettings({ maxCooldownMinutes: 999 }).maxCooldownMinutes, 10);
  assert.equal(normalizeSettings({ maxCooldownMinutes: '30' }).maxCooldownMinutes, 30);
});

test('normalizeSettings: subtitle languages, format and embedding', () => {
  const d = normalizeSettings({});
  assert.deepEqual(d.subtitleLangs, ['tr']);
  assert.equal(d.subtitleFormat, 'srt');
  assert.equal(d.embedSubtitles, false);
  assert.deepEqual(normalizeSettings({ subtitleLangs: 'TR, en_US;  tur  ger, Türkçe' }).subtitleLangs, ['tr', 'en-us', 'de']);
  assert.deepEqual(normalizeSettings({ subtitleLangs: ['*'] }).subtitleLangs, ['*']);
  assert.deepEqual(normalizeSettings({ subtitleLangs: '' }).subtitleLangs, []);
  assert.equal(normalizeSettings({ subtitleFormat: 'vtt' }).subtitleFormat, 'vtt');
  assert.equal(normalizeSettings({ subtitleFormat: 'ass' }).subtitleFormat, 'srt');
  assert.equal(normalizeSettings({ embedSubtitles: true }).embedSubtitles, true);
  assert.equal(d.audioLang, 'default');
  assert.equal(normalizeSettings({ audioLang: 'original' }).audioLang, 'original');
  assert.equal(normalizeSettings({ audioLang: 'ENG' }).audioLang, 'en');
  assert.equal(normalizeSettings({ audioLang: 'dublaj!' }).audioLang, 'default');
  assert.equal(d.uiLanguage, 'auto');
  assert.equal(normalizeSettings({ uiLanguage: 'en' }).uiLanguage, 'en');
  assert.equal(normalizeSettings({ uiLanguage: 'tr' }).uiLanguage, 'tr');
  assert.equal(normalizeSettings({ uiLanguage: 'de' }).uiLanguage, 'auto');
  assert.equal(normalizeSettings({ embedSubtitles: 'yes' }).embedSubtitles, false);
});
