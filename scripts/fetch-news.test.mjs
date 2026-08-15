import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  QUERIES,
  buildSearchUrl,
  createPayload,
  getDomain,
  mergeStories,
  normalizeUrl,
  toStory,
  validatePayload,
  writePayloadAtomically,
} from './fetch-news.mjs';

const NOW = new Date('2026-08-15T04:00:00.000Z');
const START = new Date(NOW.getTime() - 7 * 864e5).toISOString();

function hit(overrides = {}) {
  return {
    objectID: '101',
    title: 'Useful AI builder story',
    url: 'https://www.Example.com/article/?utm_source=test#section',
    points: 42,
    created_at: '2026-08-14T04:00:00.000Z',
    ...overrides,
  };
}

test('uses the exact six approved queries and a seven-day server filter', () => {
  assert.deepEqual(QUERIES, ['AI', 'LLM', 'AI agent', 'AI automation', 'OpenAI', 'Anthropic']);
  const url = buildSearchUrl('AI agent', START);
  assert.equal(url.searchParams.get('query'), 'AI agent');
  assert.equal(url.searchParams.get('tags'), 'story');
  assert.equal(url.searchParams.get('hitsPerPage'), '100');
  assert.equal(url.searchParams.get('numericFilters'), `created_at_i>=${Math.floor(Date.parse(START) / 1000)}`);
});

test('normalizes URLs and domains', () => {
  assert.equal(normalizeUrl('https://www.Example.com/a/?utm_source=x&b=2&a=1#z'), 'https://example.com/a?a=1&b=2');
  assert.equal(getDomain('https://WWW.Example.com/a'), 'example.com');
});

test('uses the HN discussion when an original URL is absent', () => {
  const story = toStory(hit({ objectID: '999', url: null }));
  assert.equal(story.url, 'https://news.ycombinator.com/item?id=999');
  assert.equal(story.domain, 'news.ycombinator.com');
});

test('deduplicates by objectID and normalized URL, then sorts', () => {
  const stories = mergeStories([
    hit({ objectID: '1', url: 'https://a.test/post', points: 10 }),
    hit({ objectID: '1', url: 'https://b.test/post', points: 999 }),
    hit({ objectID: '2', url: 'https://www.a.test/post/', points: 99 }),
    hit({ objectID: '3', url: 'https://c.test/post', points: 30, created_at: '2026-08-13T04:00:00Z' }),
    hit({ objectID: '4', url: 'https://d.test/post', points: 30, created_at: '2026-08-14T04:00:00Z' }),
  ], START);
  assert.deepEqual(stories.map((story) => story.objectID), ['4', '3', '1']);
});

test('creates and validates the fixed JSON schema only after all queries succeed', async () => {
  let calls = 0;
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      calls += 1;
      return { hits: [hit({ objectID: String(calls), url: `https://example.com/${calls}` })] };
    },
  });
  const payload = await createPayload({ now: NOW, fetchImpl });
  assert.equal(calls, 6);
  assert.equal(payload.windowStart, START);
  assert.deepEqual(Object.keys(payload), ['fetchedAt', 'windowStart', 'queries', 'stories']);
  assert.deepEqual(Object.keys(payload.stories[0]), ['objectID', 'title', 'url', 'domain', 'points', 'publishedAt']);
  assert.equal(validatePayload(payload), payload);
});

test('one failed query rejects the complete refresh', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 3) return { ok: false, status: 503 };
    return { ok: true, async json() { return { hits: [] }; } };
  };
  await assert.rejects(createPayload({ now: NOW, fetchImpl }), /failed/);
});

test('atomic writer leaves no temporary file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-radar-atomic-'));
  try {
    const output = path.join(dir, 'news.json');
    const payload = { fetchedAt: NOW.toISOString(), windowStart: START, queries: [...QUERIES], stories: [] };
    await writePayloadAtomically(output, payload);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), payload);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dead endpoint exits 1, preserves the old hash, and leaves no .tmp', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-radar-fail-'));
  const output = path.join(dir, 'news.json');
  const original = '{"sentinel":"preserve me"}\n';
  await writeFile(output, original);
  const before = createHash('sha256').update(original).digest('hex');
  const script = new URL('./fetch-news.mjs', import.meta.url);
  try {
    const exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script], {
        cwd: path.dirname(fileURLToPathCompat(script)),
        env: { ...process.env, AI_NEWS_API_URL: 'http://127.0.0.1:1/dead', AI_NEWS_OUTPUT_PATH: output },
        stdio: 'ignore',
      });
      child.on('exit', resolve);
    });
    const afterContent = await readFile(output, 'utf8');
    const after = createHash('sha256').update(afterContent).digest('hex');
    assert.equal(exitCode, 1);
    assert.equal(after, before);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fileURLToPathCompat(url) {
  return decodeURIComponent(url.pathname);
}
