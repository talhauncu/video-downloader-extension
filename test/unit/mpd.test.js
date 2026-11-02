import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMpd, parseDuration, fillTemplate, tracksOf, videoLabel, audioLabel } from '../../src/lib/mpd.js';

const URL_ = 'https://cdn.test/v/abc/manifest.mpd';

test('parseDuration', () => {
  assert.equal(parseDuration('PT4S'), 4);
  assert.equal(parseDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseDuration('PT0H0M28.03S'), 28.03);
  assert.equal(parseDuration('P1DT1S'), 86401);
  assert.equal(parseDuration(undefined), null);
  assert.equal(parseDuration('garbage'), null);
});

test('fillTemplate substitutes identifiers with padding', () => {
  assert.equal(fillTemplate('chunk-$RepresentationID$-$Number%05d$.m4s', { RepresentationID: 'v0', Number: 7 }), 'chunk-v0-00007.m4s');
  assert.equal(fillTemplate('$Bandwidth$/$Time$.m4s', { Bandwidth: 800000, Time: 12000 }), '800000/12000.m4s');
  assert.equal(fillTemplate('a$$b', {}), 'a$b');
});

const TEMPLATE_TIMELINE = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S">
  <Period id="0" start="PT0S">
    <AdaptationSet id="0" contentType="video" segmentAlignment="true">
      <SegmentTemplate timescale="15360" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="15360" r="2"/>
          <S d="15360"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="0" mimeType="video/mp4" codecs="avc1.64001e" bandwidth="800000" width="640" height="360" frameRate="15"/>
      <Representation id="1" mimeType="video/mp4" codecs="avc1.64000d" bandwidth="300000" width="320" height="180"/>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" lang="tr">
      <SegmentTemplate timescale="44100" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1">
        <SegmentTimeline><S t="0" d="44100" r="3"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="2" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="48000" audioSamplingRate="44100"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test('SegmentTemplate + SegmentTimeline: inherited template, numbered chunks, tracks sorted', () => {
  const m = parseMpd(TEMPLATE_TIMELINE, URL_);
  assert.equal(m.live, false);
  assert.equal(m.duration, 4);
  assert.deepEqual(m.drm, []);
  const { videos, audios } = tracksOf(m);
  assert.deepEqual(
    videos.map((v) => v.height),
    [360, 180],
  );
  assert.equal(videos[0].plan.mode, 'template');
  assert.equal(videos[0].plan.init.url, 'https://cdn.test/v/abc/init-0.m4s');
  assert.deepEqual(
    videos[0].plan.segments.map((s) => s.url),
    [1, 2, 3, 4].map((n) => `https://cdn.test/v/abc/chunk-0-0000${n}.m4s`),
  );
  assert.equal(audios.length, 1);
  assert.equal(audios[0].lang, 'tr');
  assert.equal(audios[0].plan.segments.length, 4);
  assert.equal(audios[0].plan.init.url, 'https://cdn.test/v/abc/init-2.m4s');
  assert.equal(videoLabel(videos[0]), '360p · 0.8 Mbps · avc1');
  assert.equal(audioLabel(audios[0]), 'tr · 48 kbps');
});

test('SegmentTemplate without timeline derives the count from duration', () => {
  const xml = `<MPD type="static" mediaPresentationDuration="PT10S"><Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v" bandwidth="1" width="1" height="1">
        <SegmentTemplate timescale="1000" duration="4000" startNumber="0" initialization="i.m4s" media="s-$Number$.m4s"/>
      </Representation>
    </AdaptationSet></Period></MPD>`;
  const { videos } = tracksOf(parseMpd(xml, URL_));
  assert.deepEqual(
    videos[0].plan.segments.map((s) => s.url.split('/').pop()),
    ['s-0.m4s', 's-1.m4s', 's-2.m4s'],
  );
});

test('SegmentList with ranges', () => {
  const xml = `<MPD type="static" mediaPresentationDuration="PT2S"><Period>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a" bandwidth="1">
        <BaseURL>audio/</BaseURL>
        <SegmentList timescale="1000" duration="1000">
          <Initialization sourceURL="all.mp4" range="0-999"/>
          <SegmentURL media="all.mp4" mediaRange="1000-4999"/>
          <SegmentURL media="all.mp4" mediaRange="5000-8999"/>
        </SegmentList>
      </Representation>
    </AdaptationSet></Period></MPD>`;
  const { audios } = tracksOf(parseMpd(xml, URL_));
  const plan = audios[0].plan;
  assert.equal(plan.mode, 'list');
  assert.deepEqual(plan.init, { url: 'https://cdn.test/v/abc/audio/all.mp4', byteRange: { offset: 0, length: 1000 } });
  assert.deepEqual(plan.segments[1], { url: 'https://cdn.test/v/abc/audio/all.mp4', byteRange: { offset: 5000, length: 4000 } });
});

const REDDIT_LIKE = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0H0M28.03S" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="PT0H0M28.03S">
    <AdaptationSet segmentAlignment="true" subsegmentAlignment="true" subsegmentStartsWithSAP="1" maxWidth="1920" maxHeight="1080">
      <Representation id="video_1" mimeType="video/mp4" codecs="avc1.640028" width="1920" height="1080" frameRate="30" bandwidth="4500000">
        <BaseURL>DASH_1080.mp4</BaseURL>
        <SegmentBase indexRangeExact="true" indexRange="912-1023"><Initialization range="0-911"/></SegmentBase>
      </Representation>
      <Representation id="video_2" mimeType="video/mp4" codecs="avc1.4d401f" width="1280" height="720" bandwidth="2000000">
        <BaseURL>DASH_720.mp4</BaseURL>
        <SegmentBase indexRangeExact="true" indexRange="912-1023"><Initialization range="0-911"/></SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet segmentAlignment="true" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="audio_1" mimeType="audio/mp4" codecs="mp4a.40.2" audioSamplingRate="48000" bandwidth="128000">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
        <BaseURL>DASH_AUDIO_128.mp4</BaseURL>
        <SegmentBase indexRangeExact="true" indexRange="820-931"><Initialization range="0-819"/></SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

test('Reddit-style SegmentBase: one whole file per representation, content types inferred', () => {
  const m = parseMpd(REDDIT_LIKE, 'https://v.redd.it/abc123/DASHPlaylist.mpd?a=1');
  assert.equal(m.duration, 28.03);
  const { videos, audios } = tracksOf(m);
  assert.deepEqual(
    videos.map((v) => v.height),
    [1080, 720],
  );
  assert.equal(videos[0].plan.mode, 'base');
  assert.equal(videos[0].plan.init, null);
  assert.deepEqual(videos[0].plan.segments, [{ url: 'https://v.redd.it/abc123/DASH_1080.mp4', byteRange: null }]);
  assert.equal(audios[0].contentType, 'audio');
  assert.equal(audios[0].plan.segments[0].url, 'https://v.redd.it/abc123/DASH_AUDIO_128.mp4');
});

test('dynamic MPD is live; ContentProtection is reported', () => {
  const xml = `<MPD type="dynamic" availabilityStartTime="2020-01-01T00:00:00Z"><Period>
    <AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v" bandwidth="1" width="1" height="1"><BaseURL>v.mp4</BaseURL></Representation>
    </AdaptationSet></Period></MPD>`;
  const m = parseMpd(xml, URL_);
  assert.equal(m.live, true);
  assert.deepEqual(m.drm, ['video']);
  assert.equal(tracksOf(m).videos[0].drm, true);
});

test('tracksOf prefers H.264 representations unless told otherwise', () => {
  const xml = `<MPD type="static" mediaPresentationDuration="PT4S"><Period>
    <AdaptationSet contentType="video">
      <Representation id="vp9hi" mimeType="video/mp4" codecs="vp09.00.40.08" bandwidth="3000000" width="1080" height="1920"><BaseURL>vp9hi.mp4</BaseURL></Representation>
      <Representation id="avc" mimeType="video/mp4" codecs="avc1.640028" bandwidth="2500000" width="720" height="1280"><BaseURL>avc.mp4</BaseURL></Representation>
      <Representation id="vp9lo" mimeType="video/mp4" codecs="vp09.00.30.08" bandwidth="800000" width="480" height="854"><BaseURL>vp9lo.mp4</BaseURL></Representation>
    </AdaptationSet></Period></MPD>`;
  const m = parseMpd(xml, URL_);
  assert.deepEqual(
    tracksOf(m).videos.map((v) => v.id),
    ['avc', 'vp9hi', 'vp9lo'],
  );
  assert.deepEqual(
    tracksOf(m, { preferH264: false }).videos.map((v) => v.id),
    ['vp9hi', 'avc', 'vp9lo'],
  );
});

test('tracksOf lists text representations with their format', () => {
  const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v1" bandwidth="1000" width="320" height="180" codecs="avc1.64000d"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet>
    <AdaptationSet mimeType="text/vtt" lang="tr"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/><Representation id="sub-tr" bandwidth="100"><BaseURL>subs/tr.vtt</BaseURL></Representation></AdaptationSet>
    <AdaptationSet mimeType="application/ttml+xml" lang="en" label="English (CC)"><Representation id="sub-en" bandwidth="100"><BaseURL>subs/en.ttml</BaseURL></Representation></AdaptationSet>
    <AdaptationSet contentType="text" mimeType="application/mp4" lang="de"><Representation id="sub-de" bandwidth="100" codecs="stpp"><SegmentTemplate media="de/$Number$.m4s" initialization="de/init.mp4" duration="2" startNumber="1"/></Representation></AdaptationSet>
  </Period>
</MPD>`;
  const t = tracksOf(parseMpd(mpd, 'https://cdn.test/d/manifest.mpd'));
  assert.equal(t.videos.length, 1);
  assert.equal(t.audios.length, 0);
  assert.deepEqual(
    t.texts.map((x) => [x.id, x.lang, x.label, x.format]),
    [
      ['sub-tr', 'tr', null, 'vtt'],
      ['sub-en', 'en', 'English (CC)', 'ttml'],
      ['sub-de', 'de', null, 'mp4'],
    ],
  );
  assert.equal(t.texts[0].plan.segments[0].url, 'https://cdn.test/d/subs/tr.vtt');
  assert.equal(t.texts[0].plan.mode, 'base');
});
