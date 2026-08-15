import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MARKETS,
  SOURCE_FEEDS,
  classifyMarket,
  createMarketPayload,
  decodeXml,
  mergeMarketStories,
  parseRss,
  validateMarketPayload,
  writeMarketPayloadAtomically,
} from './fetch-market-news.mjs';

const NOW = new Date('2026-08-15T08:00:00.000Z');

function item({
  guid = 'https://news.rthk.hk/story-1',
  title = '港股低收279點',
  link = guid,
  pubDate = 'Sat, 15 Aug 2026 06:00:00 GMT',
} = {}) {
  return `<item><title><![CDATA[${title}]]></title><guid>${guid}</guid><link>${link}</link><pubDate>${pubDate}</pubDate></item>`;
}

test('classifies the approved four market groups', () => {
  assert.equal(classifyMarket('港股低開百點'), 'hk');
  assert.equal(classifyMarket('美股3大指數個別發展'), 'us');
  assert.equal(classifyMarket('A股收市　滬指造好'), 'cn');
  assert.equal(classifyMarket('英法股市偏軟　德股上升'), 'global');
  assert.equal(classifyMarket('美元指數回落'), '');
});

test('decodes XML entities and parses only stock-market headlines', () => {
  const xml = `<rss><channel>${item({ title: '港股 &amp; 恒指反彈' })}${item({ guid: 'https://news.rthk.hk/fx', title: '美元指數走強' })}</channel></rss>`;
  assert.equal(decodeXml('<![CDATA[A &amp; B]]>'), 'A & B');
  const stories = parseRss(xml);
  assert.equal(stories.length, 1);
  assert.equal(stories[0].title, '港股 & 恒指反彈');
  assert.equal(stories[0].market, 'hk');
});

test('keeps recent history, removes duplicates and drops items older than 72 hours', () => {
  const current = parseRss(`<rss><channel>${item()}</channel></rss>`);
  const previous = [
    { ...current[0] },
    { id: 'old', title: '美股舊聞', url: 'https://example.com/old', source: '測試', market: 'us', publishedAt: '2026-08-10T00:00:00Z' },
    { id: 'recent', title: '日股新聞', url: 'https://example.com/recent', source: '測試', market: 'global', publishedAt: '2026-08-14T00:00:00Z' },
  ];
  const stories = mergeMarketStories(current, previous, NOW);
  assert.deepEqual(stories.map((story) => story.id), [current[0].id, 'recent']);
});

test('creates the fixed market payload after the source succeeds', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(String(url), SOURCE_FEEDS[0].url);
    assert.match(options.headers.Accept, /rss/);
    return { ok: true, async text() { return `<rss><channel>${item({ title: '美股初段變動不大' })}</channel></rss>`; } };
  };
  const payload = await createMarketPayload({ now: NOW, fetchImpl });
  assert.deepEqual(payload.markets, MARKETS);
  assert.deepEqual(payload.sources, SOURCE_FEEDS);
  assert.equal(payload.stories.length, 1);
  assert.equal(validateMarketPayload(payload), payload);
});

test('rejects a failed source refresh', async () => {
  await assert.rejects(
    createMarketPayload({ now: NOW, fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /failed/,
  );
});

test('atomic writer leaves the prior file untouched when validation fails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'market-radar-atomic-'));
  const output = path.join(dir, 'market-news.json');
  await writeFile(output, '{"sentinel":true}\n');
  try {
    await assert.rejects(writeMarketPayloadAtomically(output, { nope: true }));
    assert.equal(await readFile(output, 'utf8'), '{"sentinel":true}\n');
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
