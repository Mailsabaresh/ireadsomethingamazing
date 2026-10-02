// Pulls everything you have tagged "Amazing" in Raindrop.io and writes articles.json.
//
// Run by GitHub Actions every 30 minutes (see .github/workflows/sync.yml).
// Needs Node 18 or newer. No packages to install.
//
//   Test without changing anything:   RAINDROP_TOKEN=... node scripts/sync.mjs --dry
//
// Settings (all optional):
//   PUBLISH_TAG       the Raindrop tag OR collection name that means "put this on the site"   (default: Amazing)
//                     Anything tagged Amazing, and anything saved in a collection called Amazing, is published.
//   FEATURE_TAG       add this tag too to show an article first          (default: Featured)
//   MAX_QUOTE_WORDS   longest quote shown on the site, in words            (default: 25)
//
// What ends up on the site for each bookmark:
//   title, link          from Raindrop
//   "From the article"   a line in your Raindrop note that starts with ">"  (or, failing that, your first highlight)
//   "The gist"           the rest of your Raindrop note
//   author, reading time read from the article's own web page (skipped quietly if the site does not allow it)

import { readFile, writeFile, appendFile } from 'node:fs/promises';

const API = process.env.RAINDROP_API_BASE || 'https://api.raindrop.io/rest/v1';
const TOKEN = process.env.RAINDROP_TOKEN;
const TAG = (process.env.PUBLISH_TAG || 'Amazing').trim();
const FEATURE_TAG = (process.env.FEATURE_TAG || 'Featured').trim().toLowerCase();
const MAX_QUOTE_WORDS = Number(process.env.MAX_QUOTE_WORDS || 25);
const DRY = process.argv.includes('--dry');
const OUT = 'articles.json';
const EXTRA = 'extra.json';
const PAGE_SIZE = 50;                       // the most Raindrop returns per page

if (!TOKEN) {
  console.error('RAINDROP_TOKEN is not set. Add it in GitHub under Settings > Secrets and variables > Actions.');
  process.exit(1);
}

/* ---------- talking to Raindrop (polite: under 2 requests a second, retries when asked to wait) ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function api(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Number(process.env.RAINDROP_GAP_MS ?? 600) - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
    } catch (e) {
      if (attempt < 2) { await sleep(3000); continue; }
      throw new Error(`Could not reach Raindrop (${e.cause?.code || e.message}).`);
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get('Retry-After') || 15);
      console.log(`Raindrop asked us to slow down. Waiting ${seconds}s.`);
      await sleep(seconds * 1000 + 500);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error(`Raindrop rejected the token (${res.status}). Make a new test token in Raindrop (Settings > Integrations) and update the RAINDROP_TOKEN secret in GitHub.`);
    if (!res.ok) throw new Error(`Raindrop error ${res.status} on ${url.pathname}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error('Gave up after Raindrop kept asking us to slow down.');
}

/* ---------- small helpers ---------- */
const clean = s => (s || '').replace(/\s+/g, ' ').trim();
const isHttp = u => /^https?:\/\//i.test(u || '');
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const slug = t => clean(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'article';
const stripQuoteMarks = s => clean(s).replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();

// The same article saved twice, or with tracking bits on the end, counts as one.
function normUrl(u) {
  try {
    const x = new URL(u);
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref']) x.searchParams.delete(k);
    return (x.origin + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase();
  } catch { return clean(u).toLowerCase(); }
}

// The link we publish: the same address, minus tracking bits like utm_source.
function cleanUrl(u) {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (k.startsWith('utm_') || k === 'ref') x.searchParams.delete(k);
    return x.toString();
  } catch { return u; }
}

// Keep quotes short: at most MAX_QUOTE_WORDS, ending on a full sentence when possible.
function trimQuote(text) {
  const words = stripQuoteMarks(text).split(' ').filter(Boolean);
  if (words.length <= MAX_QUOTE_WORDS) return words.join(' ');
  const cut = words.slice(0, MAX_QUOTE_WORDS).join(' ');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 40 ? cut.slice(0, end + 1) : cut.replace(/[,;:\-–—\s]+$/, '') + '…';
}

// Your Raindrop note: lines starting with ">" are the quote, everything else is the gist.
//     > Nobody makes themselves into who they are.
//     Free will may be an illusion, and so is the fantasy of running life from outside it.
function parseNote(note) {
  const quoteLines = [], rest = [];
  let inQuote = false, done = false;
  for (const line of String(note || '').split(/\r?\n/)) {
    const m = line.match(/^\s*>\s?(.*)$/);
    if (m && !done) { quoteLines.push(m[1]); inQuote = true; }
    else { if (inQuote) done = true; rest.push(line); }
  }
  return {
    quote: quoteLines.length ? trimQuote(quoteLines.join(' ')) : '',
    gist: clean(rest.join(' ').replace(/[*_`#]+/g, ''))
  };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

/* ---------- reading the article's own page for author and reading time ---------- */
const decode = s => (s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

function metaContent(html, key) {
  const a = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${key}["']`, 'i'));
  return decode((a || b || [])[1] || '');
}

function findAuthor(html) {
  const candidates = [metaContent(html, 'author'), metaContent(html, 'article:author'), metaContent(html, 'parsely-author')];
  for (const block of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const m = block[1].match(/"author"\s*:\s*(\{[^}]*\}|\[[^\]]*\]|"[^"]*")/);
    if (m) {
      const n = m[1].match(/"name"\s*:\s*"([^"]+)"/) || m[1].match(/^"([^"]+)"$/);
      if (n) candidates.push(decode(n[1]));
    }
  }
  return candidates.map(clean).find(c => c && c.length <= 80 && !/^https?:/i.test(c)) || '';
}

function readingMinutes(html) {
  const body = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ');
  const part = body.match(/<article[\s\S]*?<\/article>/i) || body.match(/<main[\s\S]*?<\/main>/i);
  const text = decode((part ? part[0] : body).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter(w => /\w/.test(w)).length;
  return words >= 200 ? Math.min(180, Math.max(1, Math.round(words / 238))) : 0;     // fewer words usually means a login wall or a page built in the browser
}

async function inspectPage(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ireadsomethingamazing-sync/1.0; +https://ireadsomethingamazing.com)', Accept: 'text/html,application/xhtml+xml' }
    });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || 'html')) return { author: '', minutes: 0 };
    const html = (await res.text()).slice(0, 2_000_000);
    return { author: findAuthor(html), minutes: readingMinutes(html) };
  } catch {
    return { author: '', minutes: 0 };
  }
}

/* ---------- 1. what we published last time, and the hand-written extras ---------- */
const previous = await readJson(OUT, { articles: [] });
const previousById = new Map((previous.articles || []).map(a => [a.id, a]));
const extras = (await readJson(EXTRA, [])).filter(a => a && a.title && isHttp(a.url));

/* ---------- 2. your Raindrop bookmarks: in a collection called Amazing, or tagged Amazing ---------- */
const hasTag = (it, name) => (it.tags || []).some(t => clean(t).toLowerCase() === name.toLowerCase());

async function fetchBookmarks(collectionId, searchText) {
  const out = [];
  for (let page = 0; page < 200; page++) {
    const params = { perpage: PAGE_SIZE, page, sort: '-created' };
    if (searchText) params.search = searchText;
    if (collectionId !== 0) params.nested = 'true';                              // include sub-collections
    const data = await api('/raindrops/' + collectionId, params);
    const items = data.items || [];
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return out;
}

// 2a. every collection (top level and nested) whose name is Amazing, ignoring capital letters
const allCollections = [
  ...((await api('/collections')).items || []),
  ...((await api('/collections/childrens')).items || [])
];
const wanted = allCollections.filter(c => clean(c.title).toLowerCase() === TAG.toLowerCase());
console.log(`Found ${wanted.length} Raindrop collection(s) called "${TAG}".`);
let fromCollections = [];
for (const c of wanted) fromCollections.push(...await fetchBookmarks(c._id, ''));

// 2b. bookmarks carrying the tag, wherever they are saved
console.log(`Reading bookmarks tagged "${TAG}" from Raindrop...`);
let fromTag = await fetchBookmarks(0, /\s/.test(TAG) ? `#"${TAG}"` : `#${TAG}`);
fromTag = fromTag.filter(it => hasTag(it, TAG));                                  // check again so nothing untagged slips through
console.log(`Collection: ${fromCollections.length} bookmarks. Tag search: ${fromTag.length} bookmarks.`);

let allBookmarks = null;                                                          // only filled if we have to scan everything
if (!fromCollections.length && !fromTag.length) {
  // Belt and braces: look at every bookmark and check the tags ourselves.
  console.log('Nothing found yet. Scanning all of your bookmarks instead...');
  allBookmarks = await fetchBookmarks(0, '');
  fromTag = allBookmarks.filter(it => hasTag(it, TAG));
  console.log(`Scanned ${allBookmarks.length} bookmarks in total, ${fromTag.length} tagged "${TAG}".`);
}

const seenIds = new Set();
const tagged = [...fromCollections, ...fromTag].filter(it => {
  if (!isHttp(it.link) || seenIds.has(it._id)) return false;                       // only web links, each bookmark once
  seenIds.add(it._id);
  return true;
});

if (!tagged.length) {
  const stem = TAG.toLowerCase().slice(0, 4);
  const similar = new Set();                                                       // only names that look like a typo of ours, so nothing private is printed
  for (const c of allCollections) if (clean(c.title).toLowerCase().includes(stem)) similar.add(`collection "${clean(c.title)}"`);
  for (const it of allBookmarks || []) for (const t of it.tags || []) if (clean(t).toLowerCase().includes(stem) && clean(t).toLowerCase() !== TAG.toLowerCase()) similar.add(`tag "${t}"`);
  if (allBookmarks && !allBookmarks.length) console.log('HINT: Raindrop returned no bookmarks at all. Check the token belongs to the Raindrop account you save into.');
  else if (similar.size) console.log(`HINT: nothing is called exactly "${TAG}", but these look similar: ${[...similar].slice(0, 5).join(', ')}. Rename it in Raindrop, or set PUBLISH_TAG to match.`);
  else console.log(`HINT: nothing found. Save articles into a Raindrop collection called ${TAG}, or give them the tag ${TAG}.`);
}
console.log(`${tagged.length} bookmarks will be published.`);

const now = new Date().toISOString();
const fromRaindrop = [];
for (const it of tagged) {
  const id = 'rd_' + it._id;
  const old = previousById.get(id);

  // quote and gist
  let quote, gist;
  if (old && old.lastUpdate === it.lastUpdate) {
    quote = old.quote; gist = old.summary;                             // nothing changed in Raindrop, reuse
  } else {
    const fromNote = parseNote(it.note);
    quote = fromNote.quote; gist = fromNote.gist;
    if (!quote || !gist) {
      let highlights = it.highlights;
      if (highlights === undefined && !quote) highlights = ((await api('/raindrop/' + it._id)).item || {}).highlights;
      highlights = [...(highlights || [])].sort((a, b) => String(a.created).localeCompare(String(b.created)));
      if (!quote && highlights.length) quote = trimQuote(highlights[0].text);
      if (!gist) gist = clean((highlights.find(h => clean(h.note)) || {}).note);
    }
  }

  // author and reading time: look once, then remember (try again after a week if the site said nothing)
  let author = old ? old.author : '', minutes = old ? old.minutes : 0, inspected = old ? old.inspected : null;
  const stale = !inspected || (!author && !minutes && Date.now() - Date.parse(inspected) > 7 * 864e5);
  if (stale) {
    const seen = await inspectPage(it.link);
    author = seen.author; minutes = seen.minutes; inspected = now;
  }

  fromRaindrop.push({
    id,
    title: clean(it.title) || it.link,
    author: clean(author),
    source: clean(it.domain).replace(/^www\./, '') || host(it.link),
    minutes: minutes || 0,
    url: cleanUrl(it.link),
    quote: quote || '',
    summary: gist || '',
    added: old ? old.added : now,                                      // when the sync first saw it tagged, so newly tagged always lands on top
    created: it.created || '',
    ...(hasTag(it, FEATURE_TAG) ? { featured: true } : {}),
    lastUpdate: it.lastUpdate,
    inspected
  });
}

/* ---------- 3. merge with extra.json (Raindrop wins where it has something to say) ---------- */
const byUrl = new Map();
for (const e of extras) {
  byUrl.set(normUrl(e.url), { ...e, id: e.id || 'x-' + slug(e.title), added: e.added || '2000-01-01T00:00:00.000Z' });
}
for (const m of fromRaindrop) {
  const key = normUrl(m.url);
  const e = byUrl.get(key);
  const filled = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== '' && v != null && v !== 0));
  byUrl.set(key, e ? { ...e, ...filled } : m);
}

const articles = [...byUrl.values()]
  .sort((a, b) => String(b.added).localeCompare(String(a.added)) || String(b.created || '').localeCompare(String(a.created || '')) || a.title.localeCompare(b.title));

/* ---------- 4. write the file, only if something visible changed ---------- */
const visible = list => JSON.stringify((list || []).map(({ lastUpdate, inspected, ...rest }) => rest));
const changed = visible(articles) !== visible(previous.articles);

if (DRY) {
  console.log('\nDry run: nothing written. These would be on the site:');
  articles.forEach((a, i) => console.log(`${String(i + 1).padStart(2)}. ${a.title}  (${a.source}${a.minutes ? ', ' + a.minutes + ' min' : ''})${a.author ? '  by ' + a.author : ''}${a.quote ? '  [quote]' : ''}${a.summary ? '  [gist]' : ''}`));
  process.exit(0);
}

if (changed) {
  await writeFile(OUT, JSON.stringify({ generated: now, articles }, null, 2) + '\n');
  console.log(`Wrote ${OUT} with ${articles.length} articles.`);
} else {
  console.log('No visible changes. Leaving articles.json as it is.');
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
