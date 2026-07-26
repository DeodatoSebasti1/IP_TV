#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = process.cwd();
const sourcePath = path.resolve(repoRoot, process.argv[2] || '../FILL.m3u8');
const playlistOutPath = path.resolve(repoRoot, process.argv[3] || 'LISTA_PERFEITA.m3u8');
const dataOutPath = path.resolve(repoRoot, process.argv[4] || 'LISTA_PERFEITA.json');

const TARGET_COUNT = 1100;

const regionRules = [
  { region: 'Angola', keywords: ['angola', ' tpa', 'zimbo', 'girassol', 'palanca', '.ao'] },
  { region: 'Portugal', keywords: ['portugal', ' rtp', 'sic ', ' tvi', 'sport tv', 'sporttv', 'cmtv', 'canal 11', 'a bola', 'axn white portugal'] },
  { region: 'Brazil', keywords: ['brasil', ' brazil', 'band ', 'record', 'sbt', 'globo', 'tv brasil', 'cazé', 'caze', 'amazonsat', 'canalgov', 'conectv', 'rctv brasil'] },
];

const categoryRules = [
  {
    category: 'Sports',
    keywords: [' sports', 'sport ', ' futebol', 'football', 'soccer', 'espn', 'dazn', 'fox sports', 'premiere', 'bein sports', 'arryadia', 'canal 11', 'cazetv', 'cazétv', 'sport tv', 'sporttv', 'golf', 'tennis'],
  },
  {
    category: 'Movies',
    keywords: ['movies', 'movie', ' cinema', 'film', 'axn', 'tnt', 'paramount', 'hbo', 'cinemax', 'amc', 'showtime', 'cine', 'vintage', 'classic movie'],
  },
  {
    category: 'Kids',
    keywords: ['kids', ' cartoon', 'disney', 'nickelodeon', 'nick jr', 'boomerang', 'baby tv', 'babyshark', 'junior', 'children'],
  },
  {
    category: 'Music',
    keywords: ['music', 'trace', 'mtv', 'vh1', 'sol musica', 'bandamax', 'music box', 'qmusic', 'vevo', 'karaoke', 'radio tv'],
  },
  {
    category: 'News',
    keywords: ['news', 'noticias', 'jornal', 'inform', 'bbc news', 'cnn', 'euronews', 'al jazeera', 'france 24', 'record news', 'bandnews', 'globonews', 'sic noticias', 'rtp noticias', 'tvi24'],
  },
  {
    category: 'Series',
    keywords: ['series', 'novela', 'telenovela', 'fiction', 'reality', 'drama', 'sitcom', 'classic tv', 'retro', 'crime drama'],
  },
  {
    category: 'Documentary',
    keywords: ['documentary', 'doc ', 'history', 'nat geo', 'national geographic', 'discovery', 'science', 'travel', 'wild'],
  },
  {
    category: 'General',
    keywords: ['public', 'general', 'entertainment', 'live', 'tv', 'channel'],
  },
];

const brandBonuses = [
  ['sport tv', 24],
  ['sporttv', 24],
  ['rtp', 22],
  ['sic', 20],
  ['tvi', 20],
  ['cmtv', 18],
  ['canal 11', 20],
  ['cazétv', 22],
  ['cazetv', 22],
  ['tv brasil', 18],
  ['band sports', 18],
  ['bandnews', 16],
  ['record news', 16],
  ['record', 14],
  ['sbt', 14],
  ['globo', 18],
  ['globonews', 18],
  ['espn', 18],
  ['fox sports', 18],
  ['dazn', 18],
  ['premiere', 16],
  ['disney', 18],
  ['nickelodeon', 16],
  ['trace', 16],
  ['axn', 16],
  ['tnt', 16],
  ['paramount', 16],
  ['amazon sat', 14],
];

const penaltyRules = [
  ['religious', -10],
  ['shop', -6],
  ['shopping', -6],
  ['adult', -25],
  ['erotic', -25],
  ['test', -4],
  ['placeholder', -50],
  ['geo-blocked', -4],
  ['weather', -6],
];

const sectionPriority = [
  'Portugal/Sports',
  'Portugal/News',
  'Portugal/General',
  'Portugal/Movies',
  'Portugal/Kids',
  'Portugal/Music',
  'Portugal/Series',
  'Portugal/Documentary',
  'Brazil/Futebol',
  'Brasil/News',
  'Brasil/General',
  'Brasil/Movies',
  'Brasil/Kids',
  'Brasil/Music',
  'Brasil/Series',
  'Angola/TV',
  'Angola/Sports',
  'Angola/News',
  'Angola/Music',
  'Angola/Kids',
  'Sports/International',
  'Movies/International',
  'Kids/International',
  'Music/International',
  'News/International',
  'Series/International',
  'Documentary/International',
  'General/International',
];

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isYouTubeUrl(url) {
  return /(^|\.)(youtube\.com|youtu\.be)$/i.test(new URL(url).hostname);
}

function displayName(rawName) {
  return rawName.replace(/\s*\((?:\d{2,4}p|hd|sd|fhd|uhd|\d+i)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
}

function splitExtinfInfo(extinf) {
  let inQuotes = false;
  for (let index = 0; index < extinf.length; index += 1) {
    const character = extinf[index];
    if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === ',' && !inQuotes) {
      return {
        metadata: extinf.slice(0, index),
        title: extinf.slice(index + 1).trim(),
      };
    }
  }
  return {
    metadata: extinf,
    title: '',
  };
}

function parseAttributes(extinf) {
  const attrs = {};
  for (const match of extinf.matchAll(/([a-z0-9-]+)="([^"]*)"/gi)) {
    const [, key, value] = match;
    attrs[key] = value;
  }
  return attrs;
}

function parsePlaylist(text) {
  const items = [];
  const lines = text.split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '#EXTM3U') continue;

    if (trimmed.startsWith('#EXTINF:')) {
      current = {
        extinf: trimmed,
        directives: [],
        url: '',
      };
      continue;
    }

    if (!current) continue;

    if (trimmed.startsWith('#EXTVLCOPT:') || trimmed.startsWith('#EXTGRP:')) {
      current.directives.push(trimmed);
      continue;
    }

    if (trimmed.startsWith('#')) continue;

    current.url = trimmed;
    const info = current.extinf;
    const attrs = parseAttributes(info);
    const name = splitExtinfInfo(info).title || trimmed;
    items.push({
      attrs,
      directives: current.directives,
      displayName: displayName(name),
      groupTitle: attrs['group-title'] || 'Undefined',
      logo: attrs['tvg-logo'] || '',
      rawExtinf: info,
      tvgId: attrs['tvg-id'] || '',
      sourceUrl: trimmed,
      url: trimmed,
    });
    current = null;
  }

  return items;
}

function resolvePlayableUrl(url) {
  if (!isYouTubeUrl(url)) return url;

  try {
    const output = execFileSync(
      'yt-dlp',
      ['-g', '--no-playlist', '--no-warnings', '-f', 'best[protocol^=m3u8]/best', url],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();

    const candidate = output.split(/\r?\n/).find((line) => /^https?:\/\//i.test(line));
    return candidate || url;
  } catch {
    return url;
  }
}

function classify(item) {
  const text = normalize([item.displayName, item.groupTitle, item.url, item.tvgId].join(' '));
  const sectionHits = [];
  let score = 0;

  for (const [needle, bonus] of brandBonuses) {
    if (text.includes(needle)) score += bonus;
  }

  for (const [needle, delta] of penaltyRules) {
    if (text.includes(needle)) score += delta;
  }

  const matchedCategories = [];
  for (const rule of categoryRules) {
    const found = rule.keywords.some((needle) => text.includes(needle));
    if (found) {
      matchedCategories.push(rule.category);
      score += rule.category === 'General' ? 2 : 8;
    }
  }

  let region = '';
  for (const rule of regionRules) {
    const found = rule.keywords.some((needle) => text.includes(needle));
    if (found) {
      region = rule.region;
      score += rule.region === 'Portugal' ? 10 : rule.region === 'Brazil' ? 10 : 8;
      break;
    }
  }

  if (!region) {
    if (text.includes('pt')) score += 2;
    if (text.includes('br')) score += 2;
    if (text.includes('ao')) score += 1;
  }

  const category = matchedCategories[0] || 'General';
  const section = `${region || 'International'}/${category}`;

  return {
    ...item,
    category,
    region: region || 'International',
    score,
    section,
  };
}

function sectionRank(section) {
  const index = sectionPriority.indexOf(section);
  return index === -1 ? sectionPriority.length + 100 : index;
}

function sortItems(items) {
  return [...items].sort((left, right) => {
    const rankDiff = sectionRank(left.section) - sectionRank(right.section);
    if (rankDiff !== 0) return rankDiff;
    const scoreDiff = right.score - left.score;
    if (scoreDiff !== 0) return scoreDiff;
    return left.displayName.localeCompare(right.displayName);
  });
}

function writeM3U(items) {
  const lines = ['#EXTM3U', '# Curated IPTV playlist with interactive categories'];
  let currentSection = '';

  for (const item of items) {
    if (item.section !== currentSection) {
      currentSection = item.section;
      lines.push('');
      lines.push(`# --- ${currentSection} ---`);
    }

    const logo = item.logo || '';
    const tvgId = item.tvgId || '';
    const attrs = {
      ...item.attrs,
      'tvg-id': tvgId,
      'tvg-logo': logo,
      'group-title': item.section,
    };
    const streamUrl = item.playableUrl || item.url;
    const extinf =
      `#EXTINF:-1 ${Object.entries(attrs)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}="${String(value).replace(/"/g, '&quot;')}"`)
        .join(' ')},${item.displayName}`;
    lines.push(extinf);
    for (const directive of item.directives) lines.push(directive);
    lines.push(streamUrl);
  }

  return `${lines.join('\n')}\n`;
}

function buildInteractiveHtml(data) {
  const json = JSON.stringify(data);
  return `<!doctype html>
<html lang="pt">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lista Perfeita IPTV</title>
  <style>
    :root{
      --bg:#08111f;
      --panel:#0f1b2f;
      --panel2:#13233d;
      --text:#eaf1ff;
      --muted:#9ab0d0;
      --accent:#6be4c8;
      --accent2:#7aa7ff;
      --line:rgba(255,255,255,.08);
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(122,167,255,.18), transparent 30%),
        radial-gradient(circle at top right, rgba(107,228,200,.14), transparent 25%),
        linear-gradient(180deg, #07101c, #0b1627 55%, #09101b);
      color:var(--text);
    }
    .wrap{max-width:1200px;margin:0 auto;padding:24px}
    .hero{
      background:linear-gradient(135deg, rgba(19,35,61,.92), rgba(15,27,47,.88));
      border:1px solid var(--line);
      border-radius:24px;
      padding:24px;
      box-shadow:0 24px 70px rgba(0,0,0,.35);
    }
    h1{margin:0 0 8px;font-size:34px;letter-spacing:-.03em}
    .sub{color:var(--muted);max-width:70ch;line-height:1.5}
    .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:18px}
    .stat{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:18px;padding:14px}
    .stat b{display:block;font-size:22px;margin-bottom:4px}
    .controls{
      display:grid;
      grid-template-columns:2fr 1fr 1fr;
      gap:12px;
      margin:20px 0 18px;
    }
    input, select{
      width:100%;
      background:rgba(255,255,255,.05);
      color:var(--text);
      border:1px solid var(--line);
      border-radius:14px;
      padding:14px 16px;
      outline:none;
    }
    .chips{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px}
    .chip{
      border:1px solid var(--line);
      background:rgba(255,255,255,.04);
      color:var(--text);
      border-radius:999px;
      padding:10px 14px;
      cursor:pointer;
      user-select:none;
    }
    .chip.active{background:linear-gradient(135deg, rgba(107,228,200,.22), rgba(122,167,255,.22));border-color:rgba(107,228,200,.35)}
    .sections{display:flex;flex-direction:column;gap:18px}
    details{
      background:rgba(255,255,255,.03);
      border:1px solid var(--line);
      border-radius:20px;
      overflow:hidden;
    }
    summary{
      list-style:none;
      cursor:pointer;
      padding:16px 18px;
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:12px;
      font-weight:700;
      background:rgba(255,255,255,.02);
    }
    summary::-webkit-details-marker{display:none}
    .count{color:var(--muted);font-weight:600}
    .table{display:grid;grid-template-columns:1.6fr .8fr .8fr 1fr auto;gap:10px;padding:14px 18px;border-top:1px solid var(--line);align-items:center}
    .table.header{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.12em;background:rgba(255,255,255,.02)}
    .name{font-weight:650}
    .muted{color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .btn{
      background:linear-gradient(135deg, rgba(107,228,200,.16), rgba(122,167,255,.18));
      border:1px solid rgba(255,255,255,.12);
      color:var(--text);
      border-radius:12px;
      padding:10px 12px;
      text-decoration:none;
      text-align:center;
      white-space:nowrap;
    }
    .footer{color:var(--muted);margin:18px 0 8px;font-size:13px}
    @media (max-width: 920px){
      .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
      .controls{grid-template-columns:1fr}
      .table,.table.header{grid-template-columns:1fr}
      .table.header{display:none}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1>Lista Perfeita IPTV</h1>
      <div class="sub">Playlist curada com foco em Portugal, Brasil, Angola, futebol, filmes, desenhos, música e canais internacionais relevantes. Usa a busca para filtrar por canal, categoria ou país.</div>
      <div class="stats" id="stats"></div>
      <div class="controls">
        <input id="search" placeholder="Pesquisar canal, categoria, país..." />
        <select id="region"></select>
        <select id="category"></select>
      </div>
      <div class="chips" id="chips"></div>
    </div>

    <p class="footer">Clica em “Abrir” para testar o canal ou em “Copiar” para copiar a URL. O ficheiro M3U fica ao lado desta página no GitHub Pages.</p>
    <div class="sections" id="sections"></div>
  </div>

  <script>
    const data = ${json};
    const searchEl = document.getElementById('search');
    const regionEl = document.getElementById('region');
    const categoryEl = document.getElementById('category');
    const chipsEl = document.getElementById('chips');
    const sectionsEl = document.getElementById('sections');
    const statsEl = document.getElementById('stats');

    const sections = [...new Set(data.map(item => item.section))];
    const regions = ['All', ...new Set(data.map(item => item.region))];
    const categories = ['All', ...new Set(data.map(item => item.category))];

    regionEl.innerHTML = regions.map(value => \`<option value="\${value}">\${value}</option>\`).join('');
    categoryEl.innerHTML = categories.map(value => \`<option value="\${value}">\${value}</option>\`).join('');

    const topSections = sections.slice(0, 18);
    chipsEl.innerHTML = topSections.map(section => \`<button class="chip" data-section="\${section}">\${section}</button>\`).join('');

    function renderStats(filtered) {
      const byRegion = filtered.reduce((acc, item) => (acc[item.region] = (acc[item.region] || 0) + 1, acc), {});
      statsEl.innerHTML = [
        ['Canais', filtered.length],
        ['Secções', new Set(filtered.map(item => item.section)).size],
        ['Portugal', byRegion.Portugal || 0],
        ['Brasil', byRegion.Brazil || 0],
      ].map(([label, value]) => \`<div class="stat"><b>\${value}</b><span>\${label}</span></div>\`).join('');
    }

    function filterData() {
      const query = searchEl.value.trim().toLowerCase();
      const region = regionEl.value;
      const category = categoryEl.value;
      const activeChip = document.querySelector('.chip.active')?.dataset.section || 'All';

      return data.filter(item => {
        const hay = [item.displayName, item.section, item.region, item.category, item.tvgId, item.url, item.sourceUrl, item.playableUrl].join(' ').toLowerCase();
        if (query && !hay.includes(query)) return false;
        if (region !== 'All' && item.region !== region) return false;
        if (category !== 'All' && item.category !== category) return false;
        if (activeChip !== 'All' && item.section !== activeChip) return false;
        return true;
      });
    }

    function render() {
      const filtered = filterData();
      renderStats(filtered);
      const grouped = filtered.reduce((acc, item) => {
        (acc[item.section] ||= []).push(item);
        return acc;
      }, {});

      sectionsEl.innerHTML = Object.entries(grouped).map(([section, items]) => \`
        <details open>
          <summary><span>\${section}</span><span class="count">\${items.length}</span></summary>
          <div class="table header"><div>Canal</div><div>País</div><div>Categoria</div><div>Fonte</div><div>Ações</div></div>
          \${items.map(item => \`
            <div class="table">
              <div>
                <div class="name">\${item.displayName}</div>
                <div class="muted">\${item.tvgId || 'sem tvg-id'}</div>
              </div>
              <div>\${item.region}</div>
              <div>\${item.category}</div>
              <div class="muted">\${item.sourceUrl || item.url}</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <a class="btn" href="\${item.playableUrl || item.url}" target="_blank" rel="noreferrer">Abrir</a>
                <button class="btn copy" data-url="\${item.playableUrl || item.url}">Copiar</button>
              </div>
            </div>
          \`).join('')}
        </details>
      \`).join('');

      document.querySelectorAll('.copy').forEach(button => {
        button.onclick = async () => {
          await navigator.clipboard.writeText(button.dataset.url);
          button.textContent = 'Copiado';
          setTimeout(() => button.textContent = 'Copiar', 1200);
        };
      });
    }

    chipsEl.addEventListener('click', event => {
      const button = event.target.closest('.chip');
      if (!button) return;
      document.querySelectorAll('.chip').forEach(chip => chip.classList.remove('active'));
      button.classList.add('active');
      render();
    });

    searchEl.addEventListener('input', render);
    regionEl.addEventListener('change', render);
    categoryEl.addEventListener('change', render);
    chipsEl.querySelector('.chip')?.classList.add('active');
    render();
  </script>
</body>
</html>`;
}

async function main() {
  const sourceText = await readFile(sourcePath, 'utf8');
  const parsed = parsePlaylist(sourceText).map((item) => {
    const playableUrl = resolvePlayableUrl(item.url);
    return classify({
      ...item,
      playableUrl,
      isPlayable: !isYouTubeUrl(item.url) || playableUrl !== item.url,
    });
  });

  const seenUrls = new Set();
  const selected = [];
  for (const item of parsed.sort((left, right) => right.score - left.score || left.displayName.localeCompare(right.displayName))) {
    if (item.score < 3) continue;
    if (!item.isPlayable) continue;
    const dedupeUrl = item.playableUrl || item.url;
    if (seenUrls.has(dedupeUrl)) continue;
    seenUrls.add(dedupeUrl);
    selected.push(item);
    if (selected.length >= TARGET_COUNT) break;
  }

  const ordered = sortItems(selected);
  const playlistText = writeM3U(ordered);
  const data = {
    generatedAt: new Date().toISOString(),
    sourcePath,
    totalSourceEntries: parsed.length,
    selectedCount: ordered.length,
    sections: [...new Set(ordered.map((item) => item.section))],
    items: ordered,
  };

  await writeFile(playlistOutPath, playlistText, 'utf8');
  await writeFile(dataOutPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(repoRoot, 'index.html'), buildInteractiveHtml(data), 'utf8');

  console.log(JSON.stringify({
    sourcePath,
    playlistOutPath,
    dataOutPath,
    selectedCount: ordered.length,
    totalSourceEntries: parsed.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
