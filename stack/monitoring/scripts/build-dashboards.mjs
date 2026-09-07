#!/usr/bin/env node
// Renders dashboards.spec.mjs into Grafana dashboard JSON under ../grafana/dashboards/<folder>/<uid>.json.
//   node build-dashboards.mjs          write the files
//   node build-dashboards.mjs --check  fail if a file on disk differs from the spec (CI)
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import specs from './dashboards.spec.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'grafana', 'dashboards');
const check = process.argv.includes('--check');

/** Places panels left to right, wrapping at 24 columns; a row header always starts a new line. */
function layout(panels) {
  let x = 0, y = 0, lineHeight = 0, id = 1;
  return panels.map((p) => {
    const w = p.gridPos.w, h = p.gridPos.h;
    if (p.type === 'row' || x + w > 24) { y += lineHeight; x = 0; lineHeight = 0; }
    const placed = {...p, id: id++, gridPos: {x, y, w, h}};
    x += w; lineHeight = Math.max(lineHeight, h);
    if (p.type === 'row') { y += 1; x = 0; lineHeight = 0; }
    delete placed.__columns;
    return placed;
  });
}

function render(d) {
  return {
    id: null,
    uid: d.uid,
    title: d.title,
    description: d.description,
    tags: ['cvhome', d.folder],
    timezone: 'browser',
    editable: false,
    graphTooltip: 1,
    schemaVersion: 41,
    version: 1,
    refresh: d.refresh,
    time: {from: d.time, to: 'now'},
    timepicker: {},
    templating: {list: d.variables},
    annotations: {list: [
      {builtIn: 1, datasource: {type: 'grafana', uid: '-- Grafana --'}, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard'},
      ...d.annotations,
    ]},
    links: d.links.map((l) => ({...l, type: 'link', icon: 'dashboard', keepTime: true})),
    panels: layout(d.panels),
  };
}

let failed = false;
for (const d of specs) {
  const dir = join(out, d.folder);
  mkdirSync(dir, {recursive: true});
  const file = join(dir, `${d.uid}.json`);
  const json = JSON.stringify(render(d), null, 2) + '\n';
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current !== json) { console.error(`out of date: ${file} (run node stack/monitoring/scripts/build-dashboards.mjs)`); failed = true; }
  } else {
    writeFileSync(file, json);
    console.log(`wrote ${file} (${d.panels.length} panels)`);
  }
}
if (failed) process.exit(1);
