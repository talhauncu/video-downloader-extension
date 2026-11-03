import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeArgs, pickCore, mtThreads, MT_INPUT_LIMIT } from '../../src/lib/ffmpeg-args.js';

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

test('mergeArgs: encoder threads only when given (the multi-threaded core)', () => {
  const args = mergeArgs({ audio: false, subtitles: [], transcode: true, audioCodec: 'aac', threads: 4 });
  assert.deepEqual(args.slice(args.indexOf('libx264') - 1, args.indexOf('-c:a')), [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '4',
  ]);
  assert.ok(!mergeArgs({ audio: true, subtitles: [], transcode: false, audioCodec: 'aac', threads: 4 }).includes('-threads'));
});

test('mtThreads: at most 4, at least 1', () => {
  assert.equal(mtThreads(8), 4);
  assert.equal(mtThreads(2), 2);
  assert.equal(mtThreads(undefined), 4);
  assert.equal(mtThreads(0), 4);
});

test('pickCore: the multi-threaded core only transcodes inputs that fit, when isolated', () => {
  const base = { transcode: true, isolated: true, inputBytes: 10 };
  assert.equal(pickCore(base), 'mt');
  assert.equal(pickCore({ ...base, inputBytes: MT_INPUT_LIMIT }), 'mt');
  assert.equal(pickCore({ ...base, inputBytes: MT_INPUT_LIMIT + 1 }), 'single');
  assert.equal(pickCore({ ...base, transcode: false }), 'single'); // merging is a copy: the single core is enough
  assert.equal(pickCore({ ...base, isolated: false }), 'single');
  assert.equal(pickCore({ ...base, mode: 'single' }), 'single');
});
