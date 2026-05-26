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

const seenMangaUrls = new Map();
const seenFinalUrls = new Map();
const visitedArchivePages = new Set();
const visitedMangaPages = new Set();

const BLOCKED_MANGA_SLUGS = new Set([
  'page',
  'feed',
  'genre',
  'manga-genre',
  'tag',
  'author',
  'artist',
  'release',
  'wp-json',
]);

const BLOCKED_FINAL_SLUGS = new Set([
  'feed',
  'comments',
  'comment-page-1',
]);

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

function pathSegments(url) {
  return url.pathname.split('/').filter(Boolean);
}

function baseSegments() {
  return baseUrl.pathname.split('/').filter(Boolean);
}

function startsWithBaseSegments(segments) {
  const base = baseSegments();
  if (segments.length < base.length) return false;
  return base.every((segment, index) => segments[index] === segment);
}

function isMangaDetailUrl(url) {
  if (!isSameHost(url)) return false;

  const base = baseSegments();
  const segments = pathSegments(url);
  if (!startsWithBaseSegments(segments)) return false;
  if (segments.length !== base.length + 1) return false;

  const mangaSlug = segments[base.length];
  return Boolean(mangaSlug) && !BLOCKED_MANGA_SLUGS.has(mangaSlug.toLowerCase());
}

function isFinalPathUrl(url) {
  if (!isSameHost(url)) return false;

  const base = baseSegments();
  const segments = pathSegments(url);
  if (!startsWithBaseSegments(segments)) return false;
  if (segments.length !== base.length + 2) return false;

  const mangaSlug = segments[base.length];
  const finalSlug = segments[base.length + 1];

  if (!mangaSlug || !finalSlug) return false;
  if (BLOCKED_MANGA_SLUGS.has(mangaSlug.toLowerCase())) return false;
  if (BLOCKED_FINAL_SLUGS.has(finalSlug.toLowerCase())) return false;

  return true;
}

function parentMangaUrlForFinal(url) {
  const base = baseSegments();
  const segments = pathSegments(url);
  const mangaSegments = segments.slice(0, base.length + 1);
  const parent = new URL(`/${mangaSegments.join('/')}/`, siteRoot);
  return parent;
}

function rememberManga(url, source) {
  const normalized = normalizeUrl(url);
  if (!normalized || !isMangaDetailUrl(normalized)) return;

  const segments = pathSegments(normalized);
  const mangaSlug = segments[baseSegments().length];
  const key = normalized.href;

  if (!seenMangaUrls.has(key)) {
    seenMangaUrls.set(key, {
      url: key,
      path: normalized.pathname,
      slug: mangaSlug,
      source,
    });
  }
}

function rememberFinal(url, source) {
  const normalized = normalizeUrl(url);
  if (!normalized || !isFinalPathUrl(normalized)) return;

  const segments = pathSegments(normalized);
  const base = baseSegments();
  const mangaSlug = segments[base.length];
  const finalSlug = segments[base.length + 1];
  const parent = parentMangaUrlForFinal(normalized);
  const key = normalized.href;

  rememberManga(parent.href, `parent-of-final:${source}`);

  if (!seenFinalUrls.has(key)) {
    seenFinalUrls.set(key, {
      url: key,
      path: normalized.pathname,
      mangaPath: parent.pathname,
      mangaSlug,
      finalSlug,
      source,
    });
  }
}

function rememberCandidate(url, source) {
  rememberFinal(url, source);
  rememberManga(url, source);
}

function extractLinks(html) {
  const links = [];
  const hrefPattern = /href\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = hrefPattern.exec(html)) !== null) {
    const normalized = normalizeUrl(match[2]);
    if (normalized && isSameHost(normalized)) links.push(normalized.href);
  }

  const locPattern = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  while ((match = locPattern.exec(html)) !== null) {
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
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) manga-final-path-fetcher/1.1',
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
          rememberCandidate(row.link, `rest:${type}`);
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
    '/chapter-sitemap.xml',
  ].map((path) => new URL(path, siteRoot).href);

  const queue = [...candidates];
  const done = new Set();

  while (queue.length) {
    const next = queue.shift();
    if (done.has(next)) continue;
    done.add(next);

    const result = await fetchText(next, 'application/xml,text/xml,*/*;q=0.8');
    if (!result.ok || !result.text) continue;

    const links = extractLinks(result.text);
    for (const link of links) {
      const normalized = normalizeUrl(link);
      if (!normalized) continue;
      if (normalized.pathname.includes('sitemap')) queue.push(normalized.href);
      rememberCandidate(normalized.href, `sitemap:${new URL(next).pathname}`);
    }

    await sleep(DELAY_MS);
  }
}

function archivePageUrl(pageNumber) {
  if (pageNumber === 1) return baseUrl.href;
  return new URL(`page/${pageNumber}/`, baseUrl).href;
}

async function crawlArchivePage(url) {
  if (visitedArchivePages.has(url)) return [];
  visitedArchivePages.add(url);

  const result = await fetchText(url);
  if (!result.ok || !result.text) return [];

  const links = extractLinks(result.text);
  for (const link of links) rememberCandidate(link, `archive:${new URL(url).pathname}`);

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
        if (!visitedArchivePages.has(page) && queue.length < MAX_PAGES * 2) queue.push(page);
      }
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function crawlMangaPage(manga) {
  if (visitedMangaPages.has(manga.url)) return;
  visitedMangaPages.add(manga.url);

  const result = await fetchText(manga.url);
  if (!result.ok || !result.text) return;

  const links = extractLinks(result.text);
  for (const link of links) {
    const normalized = normalizeUrl(link);
    if (!normalized) continue;

    if (normalized.pathname.startsWith(manga.path)) {
      rememberFinal(normalized.href, `manga-page:${manga.path}`);
    } else {
      rememberCandidate(normalized.href, `manga-page:${manga.path}`);
    }
  }
}

async function crawlMangaPagesForFinalPaths() {
  const mangaRows = [...seenMangaUrls.values()].sort((a, b) => a.path.localeCompare(b.path));
  let cursor = 0;

  async function worker() {
    while (cursor < mangaRows.length) {
      const currentIndex = cursor;
      cursor += 1;
      await crawlMangaPage(mangaRows[currentIndex]);
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function rowsByManga(mangaRows, finalRows) {
  const finalsByManga = new Map();
  for (const final of finalRows) {
    if (!finalsByManga.has(final.mangaPath)) finalsByManga.set(final.mangaPath, []);
    finalsByManga.get(final.mangaPath).push(final);
  }

  return mangaRows.map((manga) => ({
    ...manga,
    finalCount: finalsByManga.get(manga.path)?.length ?? 0,
    finalPaths: (finalsByManga.get(manga.path) ?? []).map((final) => final.path),
  }));
}

async function writeOutputs() {
  const mangaRows = [...seenMangaUrls.values()].sort((a, b) => a.path.localeCompare(b.path));
  const finalRows = [...seenFinalUrls.values()].sort((a, b) => a.path.localeCompare(b.path));
  const groupedRows = rowsByManga(mangaRows, finalRows);

  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'manga-paths.txt'), mangaRows.map((row) => row.path).join('\n') + '\n');
  await writeFile(resolve(outDir, 'manga-urls.json'), JSON.stringify(mangaRows, null, 2) + '\n');
  await writeFile(resolve(outDir, 'final-paths.txt'), finalRows.map((row) => row.path).join('\n') + '\n');
  await writeFile(resolve(outDir, 'final-urls.json'), JSON.stringify(finalRows, null, 2) + '\n');
  await writeFile(resolve(outDir, 'manga-with-final-paths.json'), JSON.stringify(groupedRows, null, 2) + '\n');

  return { mangaRows, finalRows };
}

async function main() {
  console.log(`Base: ${baseUrl.href}`);
  console.log('Trying WordPress REST API...');
  await crawlRestApi();
  console.log(`Manga pages after REST: ${seenMangaUrls.size}`);
  console.log(`Final paths after REST: ${seenFinalUrls.size}`);

  console.log('Trying sitemaps...');
  await crawlSitemaps();
  console.log(`Manga pages after sitemaps: ${seenMangaUrls.size}`);
  console.log(`Final paths after sitemaps: ${seenFinalUrls.size}`);

  console.log('Crawling manga archive pages...');
  await crawlArchive();
  console.log(`Manga pages after archive: ${seenMangaUrls.size}`);
  console.log(`Final paths after archive: ${seenFinalUrls.size}`);

  console.log('Opening each manga page to collect final nested paths...');
  await crawlMangaPagesForFinalPaths();

  const { mangaRows, finalRows } = await writeOutputs();

  console.log(`Done. Found ${mangaRows.length} manga pages and ${finalRows.length} final paths.`);
  console.log(`Wrote ${resolve(outDir, 'manga-paths.txt')}`);
  console.log(`Wrote ${resolve(outDir, 'manga-urls.json')}`);
  console.log(`Wrote ${resolve(outDir, 'final-paths.txt')}`);
  console.log(`Wrote ${resolve(outDir, 'final-urls.json')}`);
  console.log(`Wrote ${resolve(outDir, 'manga-with-final-paths.json')}`);

  for (const row of finalRows.slice(0, 20)) console.log(row.path);
  if (finalRows.length > 20) console.log(`...and ${finalRows.length - 20} more final paths`);
  if (finalRows.length === 0) console.log('No final paths found. Try increasing --max-pages or check whether the site loads chapters with JavaScript/AJAX.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
