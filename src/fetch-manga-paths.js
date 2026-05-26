#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_BASE = 'https://dev-eternal-galaxy-doujinshipaid.pantheonsite.io/manga/';

function getArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function getNumberArg(name, fallback) {
  const raw = getArg(name, undefined);
  if (!raw) return fallback;
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const baseInput = getArg('base', DEFAULT_BASE);
const MAX_PAGES = getNumberArg('max-pages', 50);
const CONCURRENCY = getNumberArg('concurrency', 4);
const DELAY_MS = getNumberArg('delay', 350);

const baseUrl = new URL(baseInput.endsWith('/') ? baseInput : `${baseInput}/`);
const siteRoot = new URL('/', baseUrl);
const outDir = resolve(process.cwd(), 'output');

const seenUrls = new Map();
const visitedPages = new Set();

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url, baseUrl);
    parsed.hash = '';
    parsed.search = '';
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
    return parsed;
  } catch {
    return null;
  }
}

function isSameHost(url) {
  return url.hostname === baseUrl.hostname;
}

function isMangaDetailUrl(url) {
  if (!isSameHost(url)) return false;
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.startsWith(`${basePath}/`)) return false;

  const rest = path.slice(basePath.length + 1);
  if (!rest || rest.includes('/')) return false;

  const blocked = new Set(['page', 'feed', 'genre', 'manga-genre', 'tag', 'author']);
  return !blocked.has(rest.toLowerCase());
}

function remember(url, source) {
  const normalized = normalizeUrl(url);
  if (!normalized || !isMangaDetailUrl(normalized)) return;
  const key = normalized.href;
  if (!seenUrls.has(key)) {
    seenUrls.set(key, {
      url: key,
      path: normalized.pathname,
      slug: normalized.pathname.split('/').filter(Boolean).pop(),
      source,
    });
  }
}

function extractLinks(html, pageUrl) {
  const links = [];
  const hrefPattern = /href\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = hrefPattern.exec(html)) !== null) {
    const normalized = normalizeUrl(match[2]);
    if (normalized && isSameHost(normalized)) links.push(normalized.href);
  }

  const canonicalPattern = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  while ((match = canonicalPattern.exec(html)) !== null) {
    const normalized = normalizeUrl(match[1]);
    if (normalized && isSameHost(normalized)) links.push(normalized.href);
  }

  return [...new Set(links)];
}

async function fetchText(url, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8') {
  try {
    const response = await fetch(url, {
      headers: {
        accept,
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) manga-path-fetcher/1.0',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return { ok: false, status: response.status, text: '' };
    }

    return { ok: true, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: error.message };
  }
}

async function fetchJson(url) {
  const result = await fetchText(url, 'application/json,*/*;q=0.8');
  if (!result.ok) return null;
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

async function crawlRestApi() {
  const postTypes = ['wp-manga', 'manga', 'post'];
  let total = 0;

  for (const type of postTypes) {
    for (let page = 1; page <= Math.min(MAX_PAGES, 100); page += 1) {
      const url = new URL(`/wp-json/wp/v2/${type}`, siteRoot);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      url.searchParams.set('_fields', 'link,slug,title');

      const rows = await fetchJson(url.href);
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        if (row?.link) {
          remember(row.link, `rest:${type}`);
          total += 1;
        }
      }

      if (rows.length < 100) break;
      await sleep(DELAY_MS);
    }
  }

  return total;
}

async function crawlSitemaps() {
  const candidates = [
    '/sitemap.xml',
    '/wp-sitemap.xml',
    '/post-sitemap.xml',
    '/manga-sitemap.xml',
    '/wp-manga-sitemap.xml',
  ].map((path) => new URL(path, siteRoot).href);

  const queue = [...candidates];
  const done = new Set();

  while (queue.length) {
    const next = queue.shift();
    if (done.has(next)) continue;
    done.add(next);

    const result = await fetchText(next, 'application/xml,text/xml,*/*;q=0.8');
    if (!result.ok || !result.text) continue;

    const links = extractLinks(result.text, next);
    for (const link of links) {
      const normalized = normalizeUrl(link);
      if (!normalized) continue;
      if (normalized.pathname.includes('sitemap')) queue.push(normalized.href);
      remember(normalized.href, `sitemap:${new URL(next).pathname}`);
    }

    await sleep(DELAY_MS);
  }
}

function archivePageUrl(pageNumber) {
  if (pageNumber === 1) return baseUrl.href;
  return new URL(`page/${pageNumber}/`, baseUrl).href;
}

async function crawlArchivePage(url) {
  if (visitedPages.has(url)) return [];
  visitedPages.add(url);

  const result = await fetchText(url);
  if (!result.ok || !result.text) return [];

  const links = extractLinks(result.text, url);
  for (const link of links) remember(link, `archive:${new URL(url).pathname}`);

  return links.filter((link) => {
    const parsed = normalizeUrl(link);
    if (!parsed || !isSameHost(parsed)) return false;
    return parsed.pathname.startsWith(baseUrl.pathname) && parsed.pathname.includes('/page/');
  });
}

async function crawlArchive() {
  const queue = Array.from({ length: MAX_PAGES }, (_, index) => archivePageUrl(index + 1));
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const currentIndex = cursor;
      cursor += 1;
      const url = queue[currentIndex];
      const morePages = await crawlArchivePage(url);
      for (const page of morePages) {
        if (!visitedPages.has(page) && queue.length < MAX_PAGES * 2) queue.push(page);
      }
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function main() {
  console.log(`Base: ${baseUrl.href}`);
  console.log('Trying WordPress REST API...');
  await crawlRestApi();
  console.log(`Found after REST: ${seenUrls.size}`);

  console.log('Trying sitemaps...');
  await crawlSitemaps();
  console.log(`Found after sitemaps: ${seenUrls.size}`);

  console.log('Crawling archive pages...');
  await crawlArchive();

  const rows = [...seenUrls.values()].sort((a, b) => a.path.localeCompare(b.path));
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'manga-paths.txt'), rows.map((row) => row.path).join('\n') + '\n');
  await writeFile(resolve(outDir, 'manga-urls.json'), JSON.stringify(rows, null, 2) + '\n');

  console.log(`Done. Found ${rows.length} manga paths.`);
  console.log(`Wrote ${resolve(outDir, 'manga-paths.txt')}`);
  console.log(`Wrote ${resolve(outDir, 'manga-urls.json')}`);

  for (const row of rows.slice(0, 20)) console.log(row.path);
  if (rows.length > 20) console.log(`...and ${rows.length - 20} more`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
