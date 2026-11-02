// ffmpeg command line pieces, kept pure so they can be unit-tested in Node.

/**
 * ffmpeg arguments between the inputs and the output name. Pure (unit-tested).
 * Without subtitles and separate audio the stream choice is left to ffmpeg,
 * as before; with them every stream is mapped explicitly.
 * @param {{audio:boolean, subtitles:{language:string, title?:string|null}[], transcode:boolean, audioCodec:string|null}} o
 */
export function mergeArgs({ audio, subtitles = [], transcode, audioCodec }) {
  const args = [];
  if (audio || subtitles.length) {
    args.push('-map', '0:v:0', '-map', audio ? '1:a:0' : '0:a:0?');
    const first = audio ? 2 : 1;
    subtitles.forEach((_, i) => args.push('-map', `${first + i}:0`));
  }
  if (transcode) {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }
  // AAC stays; anything else (Opus etc.) becomes AAC so QuickTime can play it.
  args.push('-c:a', audioCodec && audioCodec !== 'aac' ? 'aac' : 'copy');
  if (subtitles.length) {
    args.push('-c:s', 'mov_text');
    subtitles.forEach((s, i) => {
      args.push(`-metadata:s:s:${i}`, `language=${s.language || 'und'}`);
      if (s.title) args.push(`-metadata:s:s:${i}`, `title=${s.title}`, `-metadata:s:s:${i}`, `handler_name=${s.title}`);
    });
    args.push('-disposition:s:0', 'default');
  }
  // -shortest would cut the video at the last subtitle cue.
  args.push('-movflags', '+faststart', ...(subtitles.length ? [] : ['-shortest']));
  return args;
}
