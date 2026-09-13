#!/usr/bin/env node
// What a storefront page ships, per theme and key page, against PAGE in k6/config/budgets.js.
//
//   make page-budget                          TARGET=local: org1-store2 through the load stack's spg
//   TARGET=aws make page-budget               the deployed storefront (previews must be on: dev's flavour has them)
//   PAGE_BUDGET_THEMES=fashion,basic make page-budget      STORES=<store> picks the store (first of the list)
//
// Every theme is rendered through `?theme=<id>` plus the preview cookie, on the store's home, a category, a product and
// a search (from the store's seed file). Per page: the HTML (bytes, gzip, and the inline RSC payload in it), the
// payload of a client-side navigation to it (`RSC: 1`), the stylesheets and scripts it loads (count, bytes) and every
// one of them that carries another theme, and inline CSS that appears twice. Attribution is cvhome#356's: a stylesheet
// carries theme X through its [data-theme=X] rules; a script through the client modules of themes/X/ it defines, which
// needs the build's client-reference manifests — copied out of the running landing-ui container locally
// (docker cp), or from PAGE_BUDGET_BUILD=<.next dir>; without them scripts are counted but not attributed.
// Exit 1 when a budget fails. The result also goes to results/page-budget-<target>-<utc>.json.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {budgets, root, table, targetFile} from './lib/runs.mjs';

const target = process.env.TARGET || 'local';
const file = targetFile(target);
const {PAGE: B} = await budgets();
const themes = (process.env.PAGE_BUDGET_THEMES || B.themes.join(',')).split(',').map((t) => t.trim()).filter(Boolean);
const wanted = (process.env.STORES || '').split(',')[0].trim();
const store = file.stores.find((s) => s.name === wanted) || file.stores.find((s) => s.name === 'org1-store2') || file.stores[0];
const lang = store.defaultLang || file.lang || 'en';
const seedFile = [join(root, 'k6', 'data', `seed-${store.name}.json`), join(root, 'k6', 'data', 'seed-org1-store1.json')].find(existsSync);
const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
const base = new URL(store.url || `http://${store.name}.${process.env.POD_DOMAIN || file.podDomain}`);
const PATHS = {
  home: `/${lang}`,
  category: `/${lang}/category/${seed.categories[0]}`,
  product: `/${lang}/product/${seed.productSlugs[0]}`,
  search: `/${lang}/search?q=${encodeURIComponent(seed.searchTerms[0])}`,
};

// The target file's host overrides (`*.spg-507f1f77.gateway.com` → 127.0.0.1), as k6 applies them.
function mapped(hostname) {
  for (const [pattern, ip] of Object.entries(file.hosts || {})) {
    const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')}$`);
    if (re.test(hostname)) return ip;
  }
  return null;
}

function get(url, headers = {}, redirects = 3) {
  const u = new URL(url, base);
  const ip = mapped(u.hostname);
  const lookup = ip ? (_host, opts, cb) => (opts && opts.all ? cb(null, [{address: ip, family: 4}]) : cb(null, ip, 4)) : undefined;
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, {headers: {'User-Agent': 'cvhome-page-budget', ...headers}, lookup, timeout: 60000}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          resolve(get(new URL(res.headers.location, u).toString(), headers, redirects - 1));
        } else resolve({status: res.statusCode, body: Buffer.concat(chunks), type: res.headers['content-type'] || ''});
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${u}`)));
    req.on('error', reject);
    req.end();
  });
}

// ─── the build's client-reference manifests: module id → theme ───────────────────────────────────────────────────
function manifestsDir() {
  if (process.env.PAGE_BUDGET_BUILD) return {dir: join(process.env.PAGE_BUDGET_BUILD, 'server', 'app'), from: process.env.PAGE_BUDGET_BUILD};
  if (target !== 'local') return null;
  try {
    const container = 'cvhome-load-landing-ui-1';
    const [workdir, cmd] = execFileSync('docker', ['inspect', '-f', '{{.Config.WorkingDir}}|{{json .Config.Cmd}}', container], {encoding: 'utf8'}).trim().split('|');
    const entry = JSON.parse(cmd).find((a) => /\.m?js$/.test(a));
    const app = join(workdir || '/', entry.split('/').slice(0, -1).join('/'), '.next', 'server', 'app');
    const tmp = mkdtempSync(join(tmpdir(), 'page-budget-'));
    execFileSync('docker', ['cp', `${container}:${app}`, tmp], {stdio: 'ignore'});
    return {dir: join(tmp, 'app'), from: `${container}:${app}`, tmp};
  } catch {
    return null;
  }
}
function moduleThemes(dir) {
  const ids = new Map();
  const walk = (d) => readdirSync(d).forEach((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('_client-reference-manifest.js')) {
      const m = /__RSC_MANIFEST\[".*?"\]\s*=\s*(\{.*\})\s*;?\s*$/s.exec(readFileSync(p, 'utf8'));
      if (!m) return;
      for (const [key, mod] of Object.entries(JSON.parse(m[1]).clientModules || {})) {
        const t = /\/themes\/([a-z-]+)\//.exec(key);
        if (t) ids.set(String(mod.id), t[1]);
      }
    }
  });
  walk(dir);
  return ids;
}
const build = manifestsDir();
const id2theme = build && existsSync(build.dir) ? moduleThemes(build.dir) : null;
if (build?.tmp) rmSync(build.tmp, {recursive: true, force: true});
const DEF = /[,[](\d{2,7}),(?:e|\(e|\()/g;

// ─── one page ────────────────────────────────────────────────────────────────────────────────────────────────────
const files = new Map();
async function asset(url) {
  if (!files.has(url)) {
    const r = await get(url);
    const text = r.body.toString('utf8');
    const themesIn = url.split('?')[0].endsWith('.css')
      ? new Set([...text.matchAll(/\[data-theme=["']?([a-z-]+)["']?\]/g)].map((m) => m[1]))
      : id2theme ? new Set([...text.matchAll(DEF)].map((m) => id2theme.get(m[1])).filter(Boolean)) : null;
    files.set(url, {bytes: r.body.length, themes: themesIn, status: r.status});
  }
  return files.get(url);
}
const unique = (list) => [...new Set(list)];
const kib = (b) => b / 1024;

async function measure(theme, page) {
  const path = PATHS[page];
  const url = `${path}${path.includes('?') ? '&' : '?'}theme=${theme}`;
  const headers = {Cookie: `storefront-theme=${theme}`};
  const r = await get(url, headers);
  const html = r.body.toString('utf8');
  const css = unique([...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0])
    .filter((tag) => /\brel=["']?stylesheet/.test(tag)).map((tag) => /\bhref=["']([^"']+)["']/.exec(tag)?.[1]).filter(Boolean));
  const js = unique([...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]));
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const flight = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((t) => t.includes('__next_f'));
  // An inline stylesheet "appears twice" when a slice of it occurs again anywhere in the HTML, raw or escaped into the
  // RSC payload (one JSON escape for the flight row, one more for the JS string that carries it).
  const escapes = (t) => [t, JSON.stringify(t).slice(1, -1), JSON.stringify(JSON.stringify(t).slice(1, -1)).slice(1, -1)];
  const count = (needle) => { let n = 0; let i = -1; while ((i = html.indexOf(needle, i + 1)) !== -1) n += 1; return n; };
  const duplicated = styles.filter((t) => t.length >= 256).filter((t) => {
    const mid = Math.floor(t.length / 2);
    return escapes(t.slice(mid, mid + 120)).reduce((n, e) => n + count(e), 0) >= 2;
  });
  const rendered = /data-theme="([a-z-]+)"/.exec(html)?.[1] ?? null;
  const nav = await get(url, {...headers, RSC: '1'});
  const cssFiles = await Promise.all(css.map(asset));
  const jsFiles = await Promise.all(js.map(asset));
  const other = (list, urls) => list.map((f, i) => ({f, url: urls[i]})).filter(({f}) => f.themes && [...f.themes].some((t) => t !== theme));
  const otherCss = other(cssFiles, css);
  const otherJs = other(jsFiles, js);
  const row = {
    theme, page, status: r.status, rendered,
    htmlKiB: kib(r.body.length), htmlGzKiB: kib(gzipSync(r.body).length),
    rscInlineKiB: kib(flight.reduce((n, t) => n + Buffer.byteLength(t), 0)),
    rscNavKiB: nav.type.includes('x-component') ? kib(nav.body.length) : null,
    inlineCssKiB: kib(styles.reduce((n, t) => n + Buffer.byteLength(t), 0)),
    duplicateInlineCssKiB: kib(duplicated.reduce((n, t) => n + Buffer.byteLength(t), 0)),
    cssFiles: css.length, cssKiB: kib(cssFiles.reduce((n, f) => n + f.bytes, 0)),
    jsFiles: js.length, jsKiB: kib(jsFiles.reduce((n, f) => n + f.bytes, 0)),
    otherThemeFiles: otherCss.length + (id2theme ? otherJs.length : 0),
    otherThemeList: [...otherCss, ...(id2theme ? otherJs : [])].map(({f, url: u}) => `${u.split('?')[0].split('/').pop()} [${[...f.themes].join(',')}]`),
    failures: [],
  };
  if (r.status !== 200) row.failures.push(`answered ${r.status}`);
  if (rendered && rendered !== theme) row.failures.push(`rendered ${rendered}, not ${theme} (are previews on? STOREFRONT_THEME_OVERRIDE)`);
  for (const key of ['otherThemeFiles', 'duplicateInlineCssKiB', 'htmlKiB', 'cssFiles', 'cssKiB', 'jsFiles', 'jsKiB', 'rscNavKiB']) {
    if (B[key] !== null && B[key] !== undefined && row[key] !== null && row[key] > B[key]) {
      row.failures.push(`${key} ${Number.isInteger(row[key]) ? row[key] : row[key].toFixed(1)} > ${B[key]}`);
    }
  }
  return row;
}

// ─── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log(`page-budget  ${base.origin} (${store.name}, ${lang})  themes: ${themes.length}  pages: ${B.pages.join(', ')}`);
console.log(`  scripts attributed ${id2theme ? `through ${id2theme.size} theme modules from ${build.from}` : 'no: no build manifests (PAGE_BUDGET_BUILD=<.next dir>), stylesheets only'}`);
const rows = [];
for (const theme of themes) {
  for (const page of B.pages) {
    try {
      rows.push(await measure(theme, page));
    } catch (e) {
      rows.push({theme, page, failures: [`no answer: ${e.message}`]});
    }
  }
}
const f1 = (v) => (v === null || v === undefined ? '-' : v.toFixed(0));
console.log(table([['theme', 'page', 'status', 'html KiB (gz)', 'rsc inline', 'rsc nav', 'css files/KiB', 'js files/KiB', 'other theme', 'dup inline css', ''],
  ...rows.map((r) => [r.theme, r.page, r.status ?? '-', r.htmlKiB === undefined ? '-' : `${f1(r.htmlKiB)} (${f1(r.htmlGzKiB)})`, f1(r.rscInlineKiB), f1(r.rscNavKiB),
    r.cssFiles === undefined ? '-' : `${r.cssFiles} / ${f1(r.cssKiB)}`, r.jsFiles === undefined ? '-' : `${r.jsFiles} / ${f1(r.jsKiB)}`,
    r.otherThemeFiles ?? '-', r.duplicateInlineCssKiB ? `${f1(r.duplicateInlineCssKiB)} KiB` : '0', r.failures.length ? 'FAIL' : ''])]));
const failed = rows.filter((r) => r.failures.length);
for (const r of failed) {
  console.log(`  ${r.theme} ${r.page}: ${r.failures.join('; ')}`);
  (r.otherThemeList || []).slice(0, 6).forEach((f) => console.log(`      ${f}`));
}
const budget = Object.entries(B).filter(([k]) => !['themes', 'pages'].includes(k)).map(([k, v]) => `${k} ${v ?? 'reported'}`).join(', ');
console.log(failed.length ? `page-budget: FAIL — ${failed.length} of ${rows.length} pages over budget (${budget})` : `page-budget: pass — ${rows.length} pages (${budget})`);
mkdirSync(join(root, 'results'), {recursive: true});
const out = join(root, 'results', `page-budget-${target}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z.json`);
writeFileSync(out, JSON.stringify({target, store: store.name, base: base.origin, attributedScripts: Boolean(id2theme), budgets: B, rows}, null, 2) + '\n');
process.exit(failed.length ? 1 : 0);
