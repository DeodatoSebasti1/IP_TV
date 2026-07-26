#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const DEFAULT_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

const REQUEST_TIMEOUT_MS = 12000;

const URL_PATTERN = /https?:\/\/[^"'`\s<>()]+/gi;
const STREAM_PATTERN = /https?:\/\/[^"'`\s<>()]+?\.(?:m3u8|mpd)(?:\?[^"'`\s<>()]*)?/gi;
const IFRAME_PATTERN = /<iframe[^>]+src=["']([^"']+)["']/gi;
const SOURCE_PATTERN = /<(?:source|video)[^>]+src=["']([^"']+)["']/gi;

function usage() {
  console.log(`Usage:
  iptv-stream-doctor.mjs --input playlist.m3u [--output updated.m3u] [--report report.json]
  iptv-stream-doctor.mjs URL [URL ...]

Options:
  --input     M3U playlist to read
  --output    Write updated playlist here
  --report    Write JSON report here
  --depth     Discovery depth for linked pages (default: 2)
`);
}

function parseArgs(argv) {
  const args = { urls: [], depth: 2 };
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--input') args.input = argv[++i];
    else if (value === '--output') args.output = argv[++i];
    else if (value === '--report') args.report = argv[++i];
    else if (value === '--depth') args.depth = Number(argv[++i] || '2');
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    else args.urls.push(value);
  }
  return args;
}

function isProbablyStream(url) {
  return /\.(?:m3u8|mpd)(?:\?|$)/i.test(url);
}

function looksLikeDiscoveryTarget(url) {
  return (
    isProbablyStream(url) ||
    /youtube\.com|youtu\.be|\/embed\b|\/live\b|player|stream|watch|video|videos/i.test(url)
  );
}

function absolutize(candidate, baseUrl) {
  try {
    return new URL(candidate, baseUrl).href;
  } catch {
    return null;
  }
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function extractUrlsFromText(text, baseUrl) {
  const candidates = [];

  for (const match of text.matchAll(STREAM_PATTERN)) candidates.push(match[0]);
  for (const match of text.matchAll(URL_PATTERN)) candidates.push(match[0]);

  for (const match of text.matchAll(IFRAME_PATTERN)) candidates.push(match[1]);
  for (const match of text.matchAll(SOURCE_PATTERN)) candidates.push(match[1]);

  const normalized = candidates
    .map((candidate) => absolutize(candidate, baseUrl))
    .filter(Boolean)
    .filter((candidate) => looksLikeDiscoveryTarget(candidate));

  return unique(normalized);
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    redirect: 'follow',
    headers: DEFAULT_HEADERS,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  return { response, contentType, body };
}

function extractStreamNameHints(text) {
  const matches = [];
  for (const match of text.matchAll(/"streamName"\s*:\s*"([^"]+)"/g)) {
    matches.push(match[1]);
  }
  return unique(matches);
}

function buildFlussonicCandidates(pageUrl, streamName) {
  const origin = new URL(pageUrl).origin;
  return [
    `${origin}/${streamName}/index.fmp4.m3u8`,
    `${origin}/${streamName}/index.m3u8`,
    `${origin}/${streamName}/playlist.m3u8`,
    `${origin}/${streamName}/index.mpd`,
  ];
}

function tryYtDlp(url) {
  const result = spawnSync('yt-dlp', ['-g', '--no-playlist', url], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  return unique(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

async function probeUrl(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), REQUEST_TIMEOUT_MS);
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        ...DEFAULT_HEADERS,
        range: 'bytes=0-2047',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    const startsLikePlaylist = body.trimStart().startsWith('#EXTM3U') || /<MPD\b/i.test(body);
    return {
      url,
      ok: response.ok,
      status: response.status,
      contentType,
      playable: response.ok && (startsLikePlaylist || /mpegurl|dash\+xml/i.test(contentType)),
      bodyPreview: body.slice(0, 180),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      contentType: '',
      playable: false,
      error: error.message,
    };
  }
}

async function discoverFromPage(sourceUrl, depth, seen = new Set()) {
  if (depth < 0 || seen.has(sourceUrl)) return [];
  seen.add(sourceUrl);

  const results = [];

  let page;
  try {
    page = await fetchText(sourceUrl);
  } catch (error) {
    return [{ sourceUrl, error: error.message, candidates: [] }];
  }

  const directCandidates = extractUrlsFromText(page.body, sourceUrl).filter(
    (candidate) => looksLikeDiscoveryTarget(candidate)
  );

  const streamNames = extractStreamNameHints(page.body);
  for (const streamName of streamNames) {
    directCandidates.push(...buildFlussonicCandidates(sourceUrl, streamName));
  }

  if (/youtube\.com|youtu\.be/i.test(sourceUrl)) {
    directCandidates.push(...tryYtDlp(sourceUrl));
  }

  const playableCandidates = [];
  for (const candidate of directCandidates) {
    const probe = await probeUrl(candidate);
    if (probe.playable) playableCandidates.push(probe);
  }

  if (playableCandidates.length > 0) {
    results.push({ sourceUrl, candidates: playableCandidates });
    return results;
  }

  const linkedPages = directCandidates.filter(
    (candidate) =>
      !isProbablyStream(candidate) &&
      looksLikeDiscoveryTarget(candidate)
  );

  if (depth === 0) {
    results.push({ sourceUrl, candidates: [] });
    return results;
  }

  for (const linkedPage of linkedPages.slice(0, 10)) {
    const nested = await discoverFromPage(linkedPage, depth - 1, seen);
    if (nested.length > 0) results.push(...nested);
  }

  if (results.length === 0) results.push({ sourceUrl, candidates: [] });
  return results;
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let pendingInfo = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#EXTM3U')) continue;
    if (trimmed.startsWith('#EXTINF:')) {
      pendingInfo = trimmed;
      continue;
    }
    if (trimmed.startsWith('#')) continue;

    items.push({
      info: pendingInfo || '',
      url: trimmed,
    });
    pendingInfo = null;
  }

  return items;
}

function formatM3U(items) {
  return ['#EXTM3U', ...items.flatMap((item) => [item.info, item.url]).filter(Boolean)].join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  let entries = [];
  if (args.input) {
    const inputText = await readFile(args.input, 'utf8');
    entries = parseM3U(inputText);
  } else if (args.urls.length > 0) {
    entries = args.urls.map((url, index) => ({
      info: `#EXTINF:-1,Input ${index + 1}`,
      url,
    }));
  } else {
    usage();
    process.exit(1);
  }

  const report = [];
  const updated = [];

  for (const entry of entries) {
    const sourceUrl = entry.url;
    const directProbe = isProbablyStream(sourceUrl)
      ? await probeUrl(sourceUrl)
      : { url: sourceUrl, ok: false, status: 0, contentType: '', playable: false };
    let chosen = directProbe.playable ? directProbe : null;

    let discoveries = [];
    if (!chosen && !isProbablyStream(sourceUrl)) {
      if (/youtube\.com|youtu\.be/i.test(sourceUrl)) {
        const ytCandidates = tryYtDlp(sourceUrl);
        const ytProbes = [];
        for (const ytCandidate of ytCandidates) {
          const probe = await probeUrl(ytCandidate);
          if (probe.playable) ytProbes.push(probe);
        }
        discoveries = [{ sourceUrl, candidates: ytProbes }];
      } else {
        discoveries = await discoverFromPage(sourceUrl, args.depth);
      }
      const flatCandidates = discoveries.flatMap((item) => item.candidates || []);
      chosen = flatCandidates.find((candidate) => candidate.playable) || null;
    }

    const chosenUrl = chosen?.url || sourceUrl;
    updated.push({
      info: entry.info,
      url: chosenUrl,
    });

    report.push({
      input: sourceUrl,
      chosen: chosenUrl,
      direct: directProbe,
      discoveries,
      status: chosen ? 'resolved' : 'unresolved',
    });
  }

  const outputText = formatM3U(updated);
  if (args.output) {
    await writeFile(args.output, outputText, 'utf8');
  } else {
    process.stdout.write(outputText);
  }

  if (args.report) {
    await writeFile(args.report, JSON.stringify(report, null, 2), 'utf8');
  } else {
    process.stderr.write(JSON.stringify(report, null, 2) + '\n');
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
