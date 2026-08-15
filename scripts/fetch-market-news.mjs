import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SOURCE_FEEDS = [
  {
    name: '香港電台財經新聞',
    url: 'https://rthk.hk/rthk/news/rss/c_expressnews_cfinance.xml',
  },
];

export const MARKETS = [
  { id: 'hk', label: '港股' },
  { id: 'us', label: '美股' },
  { id: 'cn', label: 'A 股' },
  { id: 'global', label: '全球' },
];

export const WINDOW_HOURS = 72;
export const MAX_STORIES = 60;

const MARKET_PATTERNS = [
  ['hk', /(?:港股|香港股市|恒指|恆指|恒生指數|科指|國企指數|夜期|預託證券)/i],
  ['us', /(?:美股|美國股市|道指|納指|標普|S&P\s*500|華爾街|紐約股市)/i],
  ['cn', /(?:A股|Ａ股|內地股市|中國股市|滬指|上證|深證|深指|創業板指|滬深)/i],
  ['global', /(?:歐股|歐洲股市|英股|德股|法股|倫敦股市|德國股市|法國股市|日股|日經|韓股|南韓股市|台股|台灣股市|澳洲股市|亞太股市|亞洲股市|新加坡股市|印度股市)/i],
];

function asIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date.toISOString();
}

export function decodeXml(value) {
  return String(value ?? '')
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .trim();
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(match?.[1] ?? '');
}

export function classifyMarket(title) {
  return MARKET_PATTERNS.find(([, pattern]) => pattern.test(title))?.[0] ?? '';
}

export function parseRss(xml, sourceName = SOURCE_FEEDS[0].name) {
  const stories = [];
  for (const match of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const title = tagValue(block, 'title').replace(/<[^>]+>/g, '').trim();
    const url = tagValue(block, 'link') || tagValue(block, 'guid');
    const id = tagValue(block, 'guid') || url;
    const market = classifyMarket(title);
    let publishedAt;
    try {
      publishedAt = asIso(tagValue(block, 'pubDate'));
    } catch {
      continue;
    }
    if (!title || !id || !/^https:\/\//.test(url) || !market) continue;
    stories.push({ id, title, url, source: sourceName, market, publishedAt });
  }
  return stories;
}

export function mergeMarketStories(incoming, previous = [], now = new Date()) {
  const cutoff = new Date(now).getTime() - WINDOW_HOURS * 60 * 60 * 1000;
  const seenIds = new Set();
  const seenUrls = new Set();
  const stories = [];

  for (const story of [...incoming, ...previous]) {
    if (!story || !MARKETS.some((market) => market.id === story.market)) continue;
    if (!Number.isFinite(Date.parse(story.publishedAt)) || Date.parse(story.publishedAt) < cutoff) continue;
    if (!story.id || !story.title || !/^https:\/\//.test(story.url) || !story.source) continue;
    if (seenIds.has(story.id) || seenUrls.has(story.url)) continue;
    seenIds.add(story.id);
    seenUrls.add(story.url);
    stories.push({
      id: String(story.id),
      title: String(story.title),
      url: String(story.url),
      source: String(story.source),
      market: String(story.market),
      publishedAt: asIso(story.publishedAt),
    });
  }

  return stories
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, MAX_STORIES);
}

export function validateMarketPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Payload must be an object');
  if (!Number.isFinite(Date.parse(payload.fetchedAt))) throw new Error('Invalid fetchedAt');
  if (!Number.isFinite(Date.parse(payload.windowStart))) throw new Error('Invalid windowStart');
  if (Date.parse(payload.fetchedAt) - Date.parse(payload.windowStart) !== WINDOW_HOURS * 60 * 60 * 1000) {
    throw new Error('Unexpected market-news window');
  }
  if (JSON.stringify(payload.markets) !== JSON.stringify(MARKETS)) throw new Error('Unexpected markets');
  if (JSON.stringify(payload.sources) !== JSON.stringify(SOURCE_FEEDS)) throw new Error('Unexpected sources');
  if (!Array.isArray(payload.stories) || payload.stories.length > MAX_STORIES) throw new Error('Invalid stories');
  for (const story of payload.stories) {
    const keys = Object.keys(story).sort().join(',');
    if (keys !== 'id,market,publishedAt,source,title,url') throw new Error('Unexpected market story schema');
    if (!story.id || !story.title || !/^https:\/\//.test(story.url) || !story.source) throw new Error('Invalid market story');
    if (!MARKETS.some((market) => market.id === story.market)) throw new Error('Invalid market');
    if (!Number.isFinite(Date.parse(story.publishedAt))) throw new Error('Invalid publishedAt');
  }
  return payload;
}

async function fetchFeed(feed, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(feed.url, {
      headers: {
        Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'User-Agent': 'Daniel-Market-News-Radar/1.0',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseRss(await response.text(), feed.name);
  } catch (error) {
    throw new Error(`Feed “${feed.name}” failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function createMarketPayload({ now = new Date(), fetchImpl = fetch, previous = [] } = {}) {
  const fetchedAt = asIso(now);
  const windowStart = new Date(Date.parse(fetchedAt) - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const incoming = (await Promise.all(SOURCE_FEEDS.map((feed) => fetchFeed(feed, fetchImpl)))).flat();
  const stories = mergeMarketStories(incoming, previous, now);
  return validateMarketPayload({
    fetchedAt,
    windowStart,
    markets: MARKETS.map((market) => ({ ...market })),
    sources: SOURCE_FEEDS.map((source) => ({ ...source })),
    stories,
  });
}

export async function writeMarketPayloadAtomically(outputPath, payload) {
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(validateMarketPayload(payload), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function main() {
  const outputPath = path.resolve(process.env.MARKET_NEWS_OUTPUT_PATH || 'data/market-news.json');
  try {
    const existing = await readFile(outputPath, 'utf8')
      .then((content) => JSON.parse(content)?.stories)
      .catch(() => []);
    const payload = await createMarketPayload({ previous: Array.isArray(existing) ? existing : [] });
    await writeMarketPayloadAtomically(outputPath, payload);
    console.log(`Updated ${outputPath} with ${payload.stories.length} market stories.`);
  } catch (error) {
    console.error(`\x1b[31mMarket news update failed. Existing JSON was preserved.\n${error.stack || error.message}\x1b[0m`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
