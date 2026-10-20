// Gil's Arena League — standings updater.
// Reads league.json (teams + picks exported from the draft control page),
// downloads season box scores from BALLDONTLIE, and writes data.json for the app.
// Runs hourly on GitHub Actions. Needs the BDL_API_KEY secret.
//   node scripts/update.mjs            normal run
//   node scripts/update.mjs --offline  rebuild data.json without calling the API

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const file = (p) => new URL(p, ROOT);
const BASE = (process.env.BDL_BASE || 'https://api.balldontlie.io').replace(/\/$/, '');
const KEY = (process.env.BDL_API_KEY || '').trim();
const OFFLINE = process.argv.includes('--offline');

const WK = ['pts', 'fg3m', 'fga', 'fgm', 'fta', 'ftm', 'reb', 'ast', 'stl', 'blk', 'to'];
const W0 = { pts: 1, fg3m: 1, fga: -1, fgm: 2, fta: -1, ftm: 1, reb: 1, ast: 2, stl: 4, blk: 4, to: -2 };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(file(p), 'utf8')); } catch { return fallback; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zero = () => Object.fromEntries([['gp', 0], ...WK.map((k) => [k, 0])]);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.'’]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
const curSeason = () => { const d = new Date(); return d.getUTCMonth() >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };
const fmtDay = (d) => { const p = String(d).slice(0, 10).split('-'); return p.length < 3 ? '' : MON[+p[1] - 1] + ' ' + (+p[2]); };

let lastCall = 0;
async function api(path) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = 1100 - (Date.now() - lastCall);   // stay under 60 requests/minute
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res;
    try { res = await fetch(BASE + path, { headers: { Authorization: KEY } }); }
    catch (e) { if (attempt < 5) { await sleep(5000); continue; } throw e; }
    if (res.status === 429 || res.status >= 500) { await sleep(15000 * (attempt + 1)); continue; }
    if (!res.ok) { const err = new Error(`BALLDONTLIE ${res.status} on ${path.split('?')[0]}`); err.status = res.status; throw err; }
    return res.json();
  }
  throw new Error('BALLDONTLIE kept rate-limiting; will try again next run');
}

// ---------- scoring (same rules as the app) ----------
function fp(st, w) { let t = 0; for (const k of WK) t += (+st?.[k] || 0) * (+w[k] || 0); return Math.round(t * 10) / 10; }
function standings(data) {
  const map = {};
  data.teams.forEach((t, ix) => { map[t.id] = { id: t.id, ix, fp: 0, players: [] }; });
  data.picks.forEach((pk, i) => { const e = map[pk.teamId]; if (e) e.players.push({ pk, i, fp: fp(pk.st, data.weights) }); });
  for (const e of Object.values(map)) {
    if (data.countMode === 'best') [...e.players].sort((a, b) => (b.fp - a.fp) || (a.i - b.i)).forEach((p, k) => { p.c = k < data.countN; });
    else e.players.forEach((p) => { p.c = data.countMode === 'all' || !p.pk.bench; });
    e.fp = Math.round(e.players.reduce((s, p) => s + (p.c ? p.fp : 0), 0) * 10) / 10;
  }
  const arr = Object.values(map).sort((a, b) => (b.fp - a.fp) || (a.ix - b.ix));
  let r = 0, prev = null;
  arr.forEach((e, k) => { if (prev === null || e.fp < prev - 1e-9) { r = k + 1; prev = e.fp; } e.rank = r; });
  return arr;
}
function snapshot(data, ts) {
  const teams = {}, players = {};
  for (const e of standings(data)) teams[e.id] = { fp: e.fp, rank: e.rank };
  for (const pk of data.picks) players[pk.teamId + '|' + pk.player] = { fp: fp(pk.st, data.weights), gp: +pk.st?.gp || 0 };
  return { ts, teams, players };
}
// Weeks run Monday to Sunday; a new week starts Monday 10:00 UTC (6 AM Eastern).
function weekStart(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10));
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  if (d > now) d.setUTCDate(d.getUTCDate() - 7);
  return d.getTime();
}

// ---------- player lookup ----------
async function findPlayer(name, cache) {
  const key = norm(name);
  if (cache[key]) return cache[key];
  const parts = key.split(' ');
  const term = parts.length > 1 ? parts[parts.length - 1] : key;
  let list = [];
  for (const ep of ['/v1/players/active', '/v1/players']) {
    try { list = (await api(`${ep}?per_page=100&search=${encodeURIComponent(term)}`)).data || []; }
    catch (e) { if (e.status === 401 || e.status === 403 || e.status === 404) continue; throw e; }
    const hits = list.filter((p) => norm(`${p.first_name} ${p.last_name}`) === key);
    if (!hits.length) { // nickname fallback, e.g. "Ace" Bailey is listed as Airious Bailey
      const ln = key.split(' ').slice(1).join(' ');
      const loose = list.filter((p) => norm(p.last_name) === ln && norm(p.first_name)[0] === key[0] && (p.draft_year || 0) >= season - 20).sort((a, b) => (b.draft_year || 0) - (a.draft_year || 0));
      if (loose.length) hits.push(loose[0]);
    }
    if (hits.length) {
      hits.sort((a, b) => (+!!b.team - +!!a.team) || ((b.draft_year || 0) - (a.draft_year || 0)) || (b.id - a.id));
      const p = hits[0];
      cache[key] = { id: p.id, name: `${p.first_name} ${p.last_name}`, team: p.team?.abbreviation || '' };
      return cache[key];
    }
  }
  return null;
}

// ---------- main ----------
const league = await readJson('league.json', null);
if (!league || !Array.isArray(league.teams)) { console.error('league.json is missing or broken.'); process.exit(1); }
const prevData = await readJson('data.json', null);
const cache = await readJson('state/player-ids.json', {});

const weights = league.wv === 2 && league.weights ? { ...W0, ...league.weights } : { ...W0 };
const rounds = league.teams.length ? Math.ceil((league.picks || []).length / league.teams.length) : 0;
const countMode = ['best', 'first', 'all'].includes(league.countMode) ? league.countMode : 'best';
const countN = +league.countN || Math.max(1, (rounds || 8) - (+league.bench || 0)) || 5;
const season = +league.season || curSeason();

const oldStats = {};
for (const pk of prevData?.picks || []) oldStats[pk.teamId + '|' + pk.player] = pk.st;
const picks = (league.picks || []).filter((p) => p && p.player && !p.hidden).map((p) => ({
  player: String(p.player), pos: String(p.pos || ''), nba: String(p.nba || ''), teamId: String(p.teamId || ''), bench: !!p.bench,
  bdlId: p.bdlId ? +p.bdlId : null, st: oldStats[p.teamId + '|' + p.player] || zero(),
}));

let statsAsOf = prevData?.statsAsOf || '';
const ws = weekStart();
const wsDay = new Date(ws).toISOString().slice(0, 10);   // Monday of this week
const preStats = {};   // totals from games before this week, for weekly movement
const unmatched = [];
let apiError = '';

if (!OFFLINE && picks.length) {
  if (!KEY) { console.error('BDL_API_KEY secret is not set. Add it in Settings → Secrets and variables → Actions.'); process.exit(1); }
  try {
    for (const pk of picks) {
      if (pk.bdlId) continue;
      const hit = await findPlayer(pk.player, cache);
      if (hit) pk.bdlId = hit.id; else unmatched.push(pk.player);
    }
    const ids = [...new Set(picks.map((p) => p.bdlId).filter(Boolean))];
    const tot = {}, pre = {};
    let latest = '';
    for (let g = 0; g < ids.length; g += 25) {
      const chunk = ids.slice(g, g + 25);
      let cursor = null;
      do {
        const q = `/v1/stats?per_page=100&seasons[]=${season}${chunk.map((id) => `&player_ids[]=${id}`).join('')}${cursor ? `&cursor=${cursor}` : ''}`;
        const j = await api(q);
        for (const r of j.data || []) {
          const id = r.player?.id; if (!id || r.game?.postseason) continue;
          const t = tot[id] || (tot[id] = zero());
          if (parseInt(String(r.min ?? '0').split(':')[0], 10) > 0) t.gp++;
          t.pts += r.pts || 0; t.fg3m += r.fg3m || 0; t.fga += r.fga || 0; t.fgm += r.fgm || 0; t.fta += r.fta || 0; t.ftm += r.ftm || 0;
          t.reb += r.reb || 0; t.ast += r.ast || 0; t.stl += r.stl || 0; t.blk += r.blk || 0; t.to += r.turnover || 0;
          if (String(r.game?.date || '').slice(0, 10) < wsDay) {
            const q = pre[id] || (pre[id] = zero());
            if (parseInt(String(r.min ?? '0').split(':')[0], 10) > 0) q.gp++;
            q.pts += r.pts || 0; q.fg3m += r.fg3m || 0; q.fga += r.fga || 0; q.fgm += r.fgm || 0; q.fta += r.fta || 0; q.ftm += r.ftm || 0;
            q.reb += r.reb || 0; q.ast += r.ast || 0; q.stl += r.stl || 0; q.blk += r.blk || 0; q.to += r.turnover || 0;
          }
          const d = r.game?.date; if (d && String(d) > latest) latest = String(d);
        }
        cursor = j.meta?.next_cursor;
      } while (cursor);
    }
    for (const pk of picks) if (pk.bdlId) { pk.st = tot[pk.bdlId] || zero(); preStats[pk.teamId + '|' + pk.player] = pre[pk.bdlId] || zero(); }
    if (latest) statsAsOf = fmtDay(latest);
  } catch (e) {
    apiError = String(e.message || e);
    if (e.status === 401 || e.status === 403) apiError += ' — the BDL_API_KEY secret looks wrong or your BALLDONTLIE plan no longer includes box scores.';
    process.exitCode = (e.status === 401 || e.status === 403) ? 1 : 0;
    console.error('Stats update failed, keeping the previous numbers:', apiError);
  }
}

const data = {
  app: 'gils-league', v: 2, sample: false,
  title: String(league.title || "GIL'S ARENA"), subtitle: String(league.subtitle || ''),
  season, statsAsOf, wv: 2, weights, countMode, countN, bench: +league.bench || 0, benchScores: countMode === 'all',
  scorePrev: prevData?.scorePrev || null,
  updatedAt: (apiError || OFFLINE) && prevData?.updatedAt ? prevData.updatedAt : Date.now(),
  teams: league.teams.map((t) => {
    const o = { id: String(t.id), name: String(t.name || 'Host'), color: /^#[0-9a-f]{3,8}$/i.test(t.color || '') ? t.color : '#ff2bd6' };
    if (typeof t.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(t.photo)) o.photo = t.photo;
    return o;
  }),
  picks: picks.map(({ bdlId, ...p }) => p),
  unmatched,
};

// Weekly movement: standings as of Monday, rebuilt from the box scores every run.
if (picks.length && !OFFLINE && !apiError) {
  data.scorePrev = snapshot({ ...data, picks: data.picks.map((p) => ({ ...p, st: preStats[p.teamId + '|' + p.player] || zero() })) }, ws);
}

await mkdir(file('state/'), { recursive: true });
await writeFile(file('data.json'), JSON.stringify(data));
await writeFile(file('state/player-ids.json'), JSON.stringify(cache, null, 1));

const st = standings(data);
console.log(`Season ${season}-${String(season + 1).slice(2)} · ${picks.length} picks · stats through ${statsAsOf || '—'}`);
for (const e of st) console.log(`  ${e.rank}. ${data.teams.find((t) => t.id === e.id)?.name}  ${e.fp}`);
if (unmatched.length) console.log('::warning::No BALLDONTLIE match for: ' + unmatched.join(', ') + '. Check spelling in league.json or add "bdlId".');
if (apiError) console.log('::warning::' + apiError);
