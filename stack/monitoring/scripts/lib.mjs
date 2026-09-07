// Building blocks for the dashboard spec. A spec is plain data; build-dashboards.mjs turns it into Grafana JSON and
// dashboard-docs.mjs turns the JSON into docs. Every helper takes a `what` — the question the panel answers, in
// plain words — and it lands in the panel description and the documentation.

export const DS = {
  prometheus: {type: 'prometheus', uid: 'prometheus'},
  loki: {type: 'loki', uid: 'loki'},
  tempo: {type: 'tempo', uid: 'tempo'},
};

/**
 * Explore URL for one query. The JSON is percent-encoded except for the Grafana variables inside it
 * (`$service`, `${__data.fields.uri}`, `${__from}`): Grafana interpolates them in the link text before the browser
 * decodes it, and an encoded `%24%7B` is not a variable to it — the literal text would reach the query.
 */
const explore = (ds, query) => {
  const panes = {
    a: {datasource: ds.uid, queries: [query], range: {from: '${__from}', to: '${__to}'}},
  };
  const encoded = encodeURIComponent(JSON.stringify(panes))
    .replace(/%24%7B([A-Za-z0-9_.:]+)%7D/g, '${$1}')
    .replace(/%24([A-Za-z_][A-Za-z0-9_]*)/g, '$$$1');
  return '/explore?schemaVersion=1&panes=' + encoded;
};

/** Data link to Tempo search with a TraceQL query. */
export const tempoLink = (title, traceql) =>
  ({title, targetBlank: true, url: explore(DS.tempo, {refId: 'A', queryType: 'traceql', query: traceql, limit: 20})});

/** Data link to Loki with a LogQL query. */
export const lokiLink = (title, logql) =>
  ({title, targetBlank: true, url: explore(DS.loki, {refId: 'A', expr: logql})});

/** Data link to another dashboard, carrying the time range and the given variables. */
export const dashLink = (title, uid, vars = {}) => ({
  title,
  url: `/d/${uid}?${Object.entries(vars).map(([k, v]) => `var-${k}=${v}`).concat(['${__url_time_range}']).join('&')}`,
});

const steps = (thresholds) => {
  if (!thresholds) return [{color: 'green', value: null}];
  const [amber, red] = thresholds;
  return [{color: 'green', value: null}, {color: 'orange', value: amber}, {color: 'red', value: red}];
};

const base = (type, title, what, targets, opts) => ({
  type,
  title,
  description: what,
  datasource: targets[0]?.datasource ?? DS.prometheus,
  gridPos: {w: opts.w ?? 12, h: opts.h ?? 8},
  targets: targets.map((t, i) => ({refId: String.fromCharCode(65 + i), ...t})),
  fieldConfig: {
    defaults: {
      unit: opts.unit,
      min: opts.min,
      max: opts.max,
      decimals: opts.decimals,
      thresholds: {mode: 'absolute', steps: steps(opts.thresholds)},
      custom: opts.custom,
    },
    overrides: opts.overrides ?? [],
  },
  options: opts.options ?? {},
  links: opts.links ?? [],
});

const prom = (expr, legend, extra = {}) => ({datasource: DS.prometheus, expr, legendFormat: legend, ...extra});

/** Time series over Prometheus. `series` is [[expr, legend], ...]. */
export const timeseries = (title, what, series, opts = {}) =>
  base('timeseries', title, what, series.map(([e, l]) => prom(e, l)), {
    ...opts,
    custom: {lineWidth: 1, fillOpacity: opts.stack ? 30 : 8, stacking: {mode: opts.stack ? 'normal' : 'none'},
      thresholdsStyle: {mode: opts.thresholds ? 'dashed' : 'off'}, ...(opts.custom ?? {})},
    options: {legend: {displayMode: 'list', placement: 'bottom', calcs: opts.calcs ?? []}, tooltip: {mode: 'multi', sort: 'desc'}},
  });

/** Single number over Prometheus. */
export const stat = (title, what, expr, opts = {}) =>
  base('stat', title, what, [prom(expr, opts.legend ?? '', {instant: opts.instant ?? false})], {
    w: opts.w ?? 4, h: opts.h ?? 4, ...opts,
    options: {reduceOptions: {calcs: [opts.calc ?? 'lastNotNull'], fields: '', values: false}, colorMode: 'value',
      graphMode: opts.graph === false ? 'none' : 'area', textMode: 'value', orientation: 'auto'},
  });

/** Gauge over Prometheus. */
export const gauge = (title, what, expr, opts = {}) =>
  base('gauge', title, what, [prom(expr, opts.legend ?? '{{service_name}}')], {
    w: opts.w ?? 6, h: opts.h ?? 6, min: 0, max: 1, unit: 'percentunit', ...opts,
    options: {reduceOptions: {calcs: ['lastNotNull'], fields: '', values: false}, showThresholdLabels: false, showThresholdMarkers: true},
  });

/** Heatmap of a Prometheus histogram. */
export const heatmap = (title, what, bucketExpr, opts = {}) =>
  base('heatmap', title, what, [prom(bucketExpr, '{{le}}', {format: 'heatmap'})], {
    ...opts,
    options: {calculate: false, yAxis: {unit: opts.unit ?? 's'}, color: {mode: 'scheme', scheme: 'Oranges', steps: 64},
      cellGap: 1, tooltip: {mode: 'single', showColorScale: true}},
  });

/**
 * Table built from instant Prometheus queries joined on their labels. `columns` is [[expr, name], ...]; every query
 * is joined on the shared labels (service_name, uri, ...) and each value column carries `name`.
 */
export const table = (title, what, columns, opts = {}) => {
  const targets = columns.map(([expr]) => prom(expr, '', {instant: true, format: 'table'}));
  const names = columns.map(([, name]) => name);
  const hidden = {Time: true, __name__: true, job: true, instance: true};
  targets.forEach((_, i) => { hidden[`Time ${i + 1}`] = true; hidden[`Value #${String.fromCharCode(65 + i)}`] = false; });
  const rename = {};
  names.forEach((n, i) => { rename[`Value #${String.fromCharCode(65 + i)}`] = n; });
  const p = base('table', title, what, targets, {w: opts.w ?? 24, h: opts.h ?? 9, ...opts,
    options: {sortBy: opts.sortBy ? [{displayName: opts.sortBy, desc: true}] : [], cellHeight: 'sm', showHeader: true}});
  p.transformations = [
    {id: 'merge', options: {}},
    {id: 'organize', options: {excludeByName: hidden, renameByName: rename}},
  ];
  p.__columns = names;
  return p;
};

/** Loki logs panel. */
export const logs = (title, what, logql, opts = {}) =>
  base('logs', title, what, [{datasource: DS.loki, expr: logql}], {w: opts.w ?? 24, h: opts.h ?? 12, ...opts,
    options: {showTime: true, wrapLogMessage: true, enableLogDetails: true, dedupStrategy: 'none', sortOrder: 'Descending'}});

/** Time series over Loki metric queries. */
export const lokiSeries = (title, what, series, opts = {}) =>
  base('timeseries', title, what, series.map(([expr, legendFormat]) => ({datasource: DS.loki, expr, legendFormat})), {
    ...opts,
    custom: {lineWidth: 1, fillOpacity: 30, stacking: {mode: 'normal'}, drawStyle: 'bars'},
    options: {legend: {displayMode: 'list', placement: 'bottom'}, tooltip: {mode: 'multi', sort: 'desc'}},
  });

/** Single number over an instant Loki metric query. */
export const lokiStat = (title, what, logql, opts = {}) =>
  base('stat', title, what, [{datasource: DS.loki, expr: logql, queryType: 'instant'}], {
    w: opts.w ?? 4, h: opts.h ?? 4, ...opts,
    options: {reduceOptions: {calcs: ['lastNotNull'], fields: '', values: false}, colorMode: 'value', graphMode: 'none', textMode: 'value', orientation: 'auto'},
  });

/** Table over an instant Loki metric query. */
export const lokiTable = (title, what, logql, opts = {}) =>
  base('table', title, what, [{datasource: DS.loki, expr: logql, queryType: 'instant', format: 'table'}], {
    w: opts.w ?? 12, h: opts.h ?? 9, ...opts, options: {sortBy: [{displayName: 'Value #A', desc: true}], cellHeight: 'sm'}});

/** Table of spans/traces from a TraceQL query. */
export const traceql = (title, what, query, opts = {}) =>
  base('table', title, what, [{datasource: DS.tempo, queryType: 'traceql', query, limit: opts.limit ?? 20, tableType: 'traces'}], {
    w: opts.w ?? 12, h: opts.h ?? 9, ...opts, options: {cellHeight: 'sm'}});

/** Node graph of the service map (Tempo's serviceMap query over the Prometheus service-graph series). */
export const serviceMap = (title, what, opts = {}) =>
  base('nodeGraph', title, what, [{datasource: DS.tempo, queryType: 'serviceMap', serviceMapQuery: opts.filter ?? ''}], {w: opts.w ?? 24, h: opts.h ?? 14, ...opts});

/** A collapsed-row header. */
export const row = (title) => ({type: 'row', title, collapsed: false, gridPos: {w: 24, h: 1}, panels: []});

/** Template variable from label values. */
export const variable = (name, label, query, opts = {}) => ({
  type: 'query',
  name,
  label,
  datasource: opts.datasource ?? DS.prometheus,
  query: {query, refId: 'var'},
  definition: query,
  refresh: 2,
  includeAll: opts.all ?? true,
  multi: opts.multi ?? true,
  // `.+`, not `.*`: Loki refuses a selector that can match the empty string, and Prometheus accepts either.
  allValue: opts.all === false ? undefined : '.+',
  current: opts.all === false ? {} : {text: 'All', value: '$__all', selected: true},
  sort: opts.sort ?? 1,
  hide: 0,
});

export const textbox = (name, label, def = '') => ({type: 'textbox', name, label, query: def, current: {text: def, value: def}, hide: 0});

export const custom = (name, label, values, def) => ({
  type: 'custom', name, label, query: values.join(','),
  options: values.map((v) => ({text: v, value: v, selected: v === def})),
  current: {text: def, value: def}, multi: false, includeAll: false, hide: 0,
});

/** Grafana built-in annotations filtered by tags (k6 runs are posted with tag `k6`). */
export const tagAnnotations = (name, tags, color = 'purple') => ({
  datasource: {type: 'datasource', uid: 'grafana'}, enable: true, iconColor: color, name,
  target: {type: 'tags', tags, limit: 100, matchAny: false},
});

/** A dashboard. Panels are laid out left to right, wrapping at 24 columns; a row header always starts a new line. */
export const dashboard = (uid, title, folder, what, panels, opts = {}) =>
  ({uid, title, folder, description: what, panels, variables: opts.variables ?? [], annotations: opts.annotations ?? [],
    links: opts.links ?? [], time: opts.time ?? 'now-1h', refresh: opts.refresh ?? '10s'});
