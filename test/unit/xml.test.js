import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, childrenOf, childOf, textOf } from '../../src/lib/xml.js';

test('parseXml handles declaration, comments, attributes, nesting, self-closing and entities', () => {
  const root = parseXml(`<?xml version="1.0"?>
<!-- comment -->
<MPD type="static" xmlns:xlink="http://www.w3.org/1999/xlink" mediaPresentationDuration='PT4S'>
  <BaseURL>https://cdn.test/v/&amp;x/</BaseURL>
  <Period id="0">
    <AdaptationSet contentType="video"><Representation id="v1" bandwidth="1000"/></AdaptationSet>
    <AdaptationSet contentType="audio"><Representation id="a1" bandwidth="100"></Representation></AdaptationSet>
  </Period>
</MPD>`);
  assert.equal(root.name, 'MPD');
  assert.equal(root.attrs.type, 'static');
  assert.equal(root.attrs.mediaPresentationDuration, 'PT4S');
  assert.equal(textOf(childOf(root, 'BaseURL')), 'https://cdn.test/v/&x/');
  const period = childOf(root, 'Period');
  assert.equal(childrenOf(period, 'AdaptationSet').length, 2);
  assert.equal(childOf(childrenOf(period, 'AdaptationSet')[0], 'Representation').attrs.id, 'v1');
});

test('parseXml keeps attribute values containing > and quotes', () => {
  const root = parseXml(`<a title="x > y" alt='say "hi"'><b/></a>`);
  assert.equal(root.attrs.title, 'x > y');
  assert.equal(root.attrs.alt, 'say "hi"');
  assert.equal(root.children[0].name, 'b');
});

test('parseXml reads CDATA as text', () => {
  const root = parseXml(`<a><![CDATA[<raw & text>]]></a>`);
  assert.equal(textOf(root), '<raw & text>');
});
