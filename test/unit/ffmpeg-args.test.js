import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeArgs } from '../../src/lib/ffmpeg-args.js';

test('mergeArgs: video + audio maps both and keeps -shortest', () => {
  assert.deepEqual(mergeArgs({ audio: true, subtitles: [], transcode: false, audioCodec: 'aac' }), [
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    '-shortest',
  ]);
});

test('mergeArgs: transcode only leaves stream selection to ffmpeg', () => {
  assert.deepEqual(mergeArgs({ audio: false, subtitles: [], transcode: true, audioCodec: 'opus' }), [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    '-shortest',
  ]);
});

test('mergeArgs: subtitles become mov_text tracks with language and title, no -shortest', () => {
  const args = mergeArgs({
    audio: false,
    subtitles: [
      { language: 'tur', title: 'Türkçe' },
      { language: 'eng', title: null },
    ],
    transcode: false,
    audioCodec: 'aac',
  });
  assert.deepEqual(args, [
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-map',
    '1:0',
    '-map',
    '2:0',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-c:s',
    'mov_text',
    '-metadata:s:s:0',
    'language=tur',
    '-metadata:s:s:0',
    'title=Türkçe',
    '-metadata:s:s:0',
    'handler_name=Türkçe',
    '-metadata:s:s:1',
    'language=eng',
    '-disposition:s:0',
    'default',
    '-movflags',
    '+faststart',
  ]);
});

test('mergeArgs: separate audio shifts subtitle inputs by one', () => {
  const args = mergeArgs({ audio: true, subtitles: [{ language: 'tur' }], transcode: false, audioCodec: 'aac' });
  assert.deepEqual(args.slice(0, 6), ['-map', '0:v:0', '-map', '1:a:0', '-map', '2:0']);
});
