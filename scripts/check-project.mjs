import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUERIES, normalizeUrl, validatePayload } from './fetch-news.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function collectFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', '_site', 'screenshots'].includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

const payload = JSON.parse(await readFile(path.join(root, 'data/news.json'), 'utf8'));
validatePayload(payload);
assert.deepEqual(payload.queries, QUERIES);
assert.equal(Date.parse(payload.fetchedAt) - Date.parse(payload.windowStart), 7 * 24 * 60 * 60 * 1000);
assert.ok(payload.stories.every((story) => Date.parse(story.publishedAt) >= Date.parse(payload.windowStart)));
assert.equal(new Set(payload.stories.map((story) => story.objectID)).size, payload.stories.length);
assert.equal(new Set(payload.stories.map((story) => normalizeUrl(story.url))).size, payload.stories.length);

const workflow = await readFile(path.join(root, '.github/workflows/update-news.yml'), 'utf8');
for (const action of [
  'actions/checkout@v7',
  'actions/setup-node@v6',
  'actions/configure-pages@v6',
  'actions/upload-pages-artifact@v5',
  'actions/deploy-pages@v5',
]) assert.match(workflow, new RegExp(action.replace('/', '\\/')));
assert.match(workflow, /contents:\s*write/);
assert.match(workflow, /pages:\s*write/);
assert.match(workflow, /id-token:\s*write/);
assert.doesNotMatch(workflow, /secrets\./i);

const html = await readFile(path.join(root, 'news.html'), 'utf8');
for (const required of ['Hacker News', 'Algolia HN Search API', '10,000', '八小時', '不保存新聞全文']) {
  assert.ok(html.includes(required), `Missing public-page disclosure: ${required}`);
}

const credentialPatterns = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[opurs]_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(?:password|passwd)\s*[:=]\s*["'][^"']+["']/gi,
];
for (const file of await collectFiles(root)) {
  const content = await readFile(file, 'utf8').catch(() => '');
  for (const pattern of credentialPatterns) {
    assert.doesNotMatch(content, pattern, `Possible credential in ${path.relative(root, file)}`);
  }
  const emails = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  assert.ok(
    emails.every((email) => email === '41898282+github-actions[bot]@users.noreply.github.com'),
    `Possible personal email in ${path.relative(root, file)}`,
  );
}

console.log(`Project checks passed: schema, workflow, disclosures, and ${await collectFiles(root).then((files) => files.length)} public files scanned.`);
