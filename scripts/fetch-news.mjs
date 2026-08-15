import { rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const QUERIES = ['AI', 'LLM', 'AI agent', 'AI automation', 'OpenAI', 'Anthropic'];
export const WINDOW_DAYS = 7;
export const MAX_CANDIDATES_PER_QUERY = 100;
export const MAX_STORIES = 20;
export const DEFAULT_API_URL = 'https://hn.algolia.com/api/v1/search';

function asIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date.toISOString();
}

export function buildSearchUrl(query, windowStart, apiUrl = DEFAULT_API_URL) {
  const url = new URL(apiUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('numericFilters', `created_at_i>=${Math.floor(new Date(windowStart).getTime() / 1000)}`);
  url.searchParams.set('hitsPerPage', String(MAX_CANDIDATES_PER_QUERY));
  return url;
}

export function normalizeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return '';
  }
}

export function getDomain(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'news.ycombinator.com';
  }
}

export function toStory(hit) {
  const objectID = String(hit?.objectID ?? '').trim();
  const title = String(hit?.title ?? hit?.story_title ?? '').trim();
  if (!objectID || !title) return null;

  const publishedAt = asIso(hit.created_at ?? new Date(Number(hit.created_at_i) * 1000));
  const normalizedOriginal = normalizeUrl(hit.url);
  const url = normalizedOriginal || `https://news.ycombinator.com/item?id=${encodeURIComponent(objectID)}`;
  const points = Math.max(0, Math.trunc(Number(hit.points) || 0));

  return { objectID, title, url, domain: getDomain(url), points, publishedAt };
}

export function mergeStories(hits, windowStart) {
  const earliest = new Date(windowStart).getTime();
  const byId = new Set();
  const byUrl = new Set();
  const stories = [];

  for (const hit of hits) {
    let story;
    try {
      story = toStory(hit);
    } catch {
      continue;
    }
    if (!story || new Date(story.publishedAt).getTime() < earliest) continue;
    const urlKey = normalizeUrl(story.url);
    if (byId.has(story.objectID) || byUrl.has(urlKey)) continue;
    byId.add(story.objectID);
    byUrl.add(urlKey);
    stories.push(story);
  }

  return stories
    .sort((a, b) => b.points - a.points || new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, MAX_STORIES);
}

export function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Payload must be an object');
  if (!Number.isFinite(Date.parse(payload.fetchedAt))) throw new Error('Invalid fetchedAt');
  if (!Number.isFinite(Date.parse(payload.windowStart))) throw new Error('Invalid windowStart');
  if (JSON.stringify(payload.queries) !== JSON.stringify(QUERIES)) throw new Error('Unexpected queries');
  if (!Array.isArray(payload.stories) || payload.stories.length > MAX_STORIES) throw new Error('Invalid stories');
  for (const story of payload.stories) {
    const keys = Object.keys(story).sort().join(',');
    if (keys !== 'domain,objectID,points,publishedAt,title,url') throw new Error('Unexpected story schema');
    if (!story.objectID || !story.title || !/^https?:\/\//.test(story.url)) throw new Error('Invalid story');
    if (!story.domain || !Number.isInteger(story.points) || story.points < 0) throw new Error('Invalid story metadata');
    if (!Number.isFinite(Date.parse(story.publishedAt))) throw new Error('Invalid publishedAt');
  }
  return payload;
}

async function fetchQuery(query, windowStart, apiUrl, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(buildSearchUrl(query, windowStart, apiUrl), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.hits)) throw new Error('Response has no hits array');
    return body.hits;
  } catch (error) {
    throw new Error(`Query “${query}” failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function createPayload({ now = new Date(), apiUrl = DEFAULT_API_URL, fetchImpl = fetch } = {}) {
  const fetchedAt = asIso(now);
  const windowStart = new Date(new Date(fetchedAt).getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const results = await Promise.all(QUERIES.map((query) => fetchQuery(query, windowStart, apiUrl, fetchImpl)));
  return validatePayload({ fetchedAt, windowStart, queries: [...QUERIES], stories: mergeStories(results.flat(), windowStart) });
}

export async function writePayloadAtomically(outputPath, payload) {
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(validatePayload(payload), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function main() {
  const outputPath = path.resolve(process.env.AI_NEWS_OUTPUT_PATH || 'data/news.json');
  const apiUrl = process.env.AI_NEWS_API_URL || DEFAULT_API_URL;
  try {
    const payload = await createPayload({ apiUrl });
    await writePayloadAtomically(outputPath, payload);
    console.log(`Updated ${outputPath} with ${payload.stories.length} stories from ${QUERIES.length} queries.`);
  } catch (error) {
    console.error(`\x1b[31mAI news update failed. Existing JSON was preserved.\n${error.stack || error.message}\x1b[0m`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
