/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

const getRuntime = rpc.declare({ object: 'luci.homeproxy', method: 'runtime', params: ['instance'], expect: { '': {} } });
const runStage = rpc.declare({ object: 'luci.homeproxy', method: 'diagnose', params: ['stage', 'target', 'instance'], expect: { '': {} } });

function apiLibrary() {
 if (window.HomeProxyAPI) return Promise.resolve();
 return new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = L.resource('homeproxy-api.js') + '?v=20260909-jobs1'; script.onload = resolve; script.onerror = () => reject(new Error(_('Cannot load API client')));
  document.head.appendChild(script);
 });
}
function bytes(value) {
 let n = Number(value || 0), unit = 0;
 while (n >= 1024 && unit < 3) { n /= 1024; unit++; }
 return n.toFixed(unit ? 1 : 0) + ' ' + ['B', 'KiB', 'MiB', 'GiB'][unit];
}
function button(label, action, extra) { return E('button', { type: 'button', class: 'btn cbi-button ' + (extra || ''), click: ui.createHandlerFn(null, action) }, label); }
function setContent(node, children) { node.replaceChildren(...(Array.isArray(children) ? children : [children])); }

return view.extend({
 load() { return Promise.all([apiLibrary(), getRuntime('client')]); },
 render(data) {
  let instance = 'client', runtime = data[1], client, active = 'overview', stops = [], generation = 0, diagnosticsCancelled = false;
  let latestReport = null;
  const status = E('div', { class: 'hp-observe-status', role: 'status', 'aria-live': 'polite' });
  const panel = E('div', { class: 'cbi-section hp-observe-panel', id: 'hp-observe-panel', role: 'tabpanel' });
  const nav = E('ul', { class: 'cbi-tabmenu hp-observe-tabs', role: 'tablist', 'aria-label': _('Observability pages') });
  const instances = E('select', { class: 'cbi-input-select', 'aria-label': _('Instance'), change: ui.createHandlerFn(this, async () => {
   stop(); instance = instances.value; runtime = await getRuntime(instance); show(active);
  }) }, [E('option', { value: 'client' }, _('Client')), E('option', { value: 'server' }, _('Server'))]);
  const root = E('div', { class: 'cbi-map hp-observe' }, [
   // LuCI themes do not share a color-variable API. Inherit foreground/fonts
   // and shade transparent surfaces instead of falling back to light colors.
   E('style', {}, `
.hp-observe{color:inherit;font-family:inherit}
.hp-observe .hp-observe-tabs,.hp-observe .hp-observe-tabs>li{color:inherit}
.hp-observe .hp-observe-tabs button{font:inherit;color:inherit!important}
.hp-observe .cbi-button:not(.cbi-button-negative){font-family:inherit;color:inherit!important;background:transparent!important;border:1px solid color-mix(in srgb,currentColor 35%,transparent)!important}
.hp-observe .cbi-button:not(.cbi-button-negative):hover:not(:disabled){background:color-mix(in srgb,currentColor 10%,transparent)!important}
.hp-observe .cbi-button:disabled{opacity:.5;cursor:default}
.hp-observe input,.hp-observe select{font-family:inherit;color:inherit}
.hp-observe input::placeholder{color:inherit;opacity:.75}
.hp-observe .hp-observe-panel pre{color:inherit}
.hp-observe .hp-group-error{font-weight:600;border-left:3px solid currentColor;padding-left:.5rem}

.hp-observe .hp-observe-tabs{display:flex;flex-wrap:wrap;gap:4px;background:none;margin:1.25rem 0 0;padding:0;border-bottom:1px solid color-mix(in srgb,currentColor 25%,transparent)}
.hp-observe .hp-observe-tabs>li{display:block;height:auto;max-width:none;margin:0;list-style:none;border-radius:4px 4px 0 0}
.hp-observe .hp-observe-tabs button.cbi-button{border:0!important;border-radius:4px 4px 0 0;background:transparent;color:inherit;box-shadow:none;padding:.5rem .85rem;min-height:34px;margin:0}
.hp-observe .hp-observe-tabs .cbi-tab{background:transparent;color:currentColor;border-bottom:3px solid currentColor;font-weight:600}
.hp-observe .hp-observe-tabs .cbi-tab-disabled{background:transparent;border-bottom:3px solid transparent}
.hp-observe button:focus-visible,.hp-observe input:focus-visible,.hp-observe select:focus-visible,.hp-observe summary:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.hp-observe-panel{padding:1.25rem!important;min-height:18rem;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-top:0}
.hp-observe-panel h3{margin-top:0}.hp-observe-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:32rem;overflow:auto;padding:1rem;background:color-mix(in srgb,currentColor 6%,transparent);border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:4px;line-height:1.6}
.hp-observe-toolbar{display:flex;gap:.75rem;align-items:flex-end;flex-wrap:wrap;margin:.75rem 0 1rem}
.hp-observe-field{display:flex;flex-direction:column;gap:.35rem;font-size:.9em}.hp-observe-field input{width:100%;min-width:0;box-sizing:border-box}.hp-observe-field{min-width:0}.hp-observe-toolbar .hp-observe-field:has(input){flex:1 1 20rem;max-width:40rem}.hp-observe-field select{width:11rem}.hp-observe-toolbar>.cbi-button{margin:0;min-height:30px;box-sizing:border-box}.hp-observe-panel>label.hp-observe-field{max-width:40rem}
.hp-observe-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:1rem;align-items:end;margin:1rem 0}.hp-observe-filters .hp-observe-field select{width:100%;box-sizing:border-box}.hp-observe-actions{display:flex;justify-content:flex-end;gap:.75rem;flex-wrap:wrap;margin:1rem 0}.hp-observe-filters button{justify-self:start;margin:0}.hp-observe-panel .hp-observe-scroll th{text-align:left}.hp-observe-panel .hp-observe-scroll td{text-align:left;overflow-wrap:anywhere}
.hp-observe-status{padding:.6rem .8rem;background:color-mix(in srgb,currentColor 6%,transparent);border-left:3px solid currentColor;margin:1rem 0}
.hp-observe-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin:1rem 0 1.5rem}
.hp-observe-metric{padding:1rem;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:4px;background:transparent}
.hp-observe-metric strong{display:block;font-size:1.7rem;line-height:1.5;margin:.4rem 0;overflow-wrap:anywhere}.hp-observe-muted{color:inherit;font-size:.9em}
.hp-observe-scroll{overflow-x:auto}.hp-observe-panel table{width:100%;min-width:620px}.hp-observe-panel .td{overflow-wrap:anywhere;max-width:28rem;vertical-align:middle}.hp-observe-panel details{margin:.6rem 0;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:4px;padding:.7rem}.hp-observe-panel summary{cursor:pointer;line-height:1.6}
.hp-tool-result{display:grid;grid-template-columns:minmax(8rem,1fr) 2fr;gap:.5rem 1rem}.hp-tool-result dt,.hp-tool-result dd{margin:0;overflow-wrap:anywhere}.hp-observe-empty{padding:2.5rem 1rem;text-align:center;color:inherit;background:color-mix(in srgb,currentColor 6%,transparent);border-radius:4px}.hp-observe-panel progress{width:100%;height:.6rem;accent-color:currentColor}
.hp-groups .hp-group{padding:0;margin:.75rem 0;overflow:hidden}
.hp-group-summary{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;padding:.8rem 1rem;list-style:none;background:color-mix(in srgb,currentColor 6%,transparent)}
.hp-group-summary::-webkit-details-marker{display:none}.hp-group-summary::before{content:'▸';flex:none}.hp-group[open]>.hp-group-summary::before{content:'▾'}
.hp-group-title{font-weight:600;overflow-wrap:anywhere}.hp-group-kind{font-size:.85em;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:3px;padding:.1rem .4rem}
.hp-group-current{flex:1 1 14rem;min-width:0;overflow-wrap:anywhere;color:inherit}
.hp-group-content{padding:0 1rem 1rem}.hp-group-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:.75rem;padding:.65rem 0;flex-wrap:wrap}.hp-group-feedback{flex:1 1 12rem;color:inherit;overflow-wrap:anywhere}.hp-group-error{color:inherit}.hp-group-toolbar button,.hp-group-action button{margin:0;min-height:30px}
.hp-group-member{display:grid;grid-template-columns:minmax(0,1fr) 7rem 6rem;gap:1rem;align-items:center;min-height:42px;padding:.4rem .6rem;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent)}
.hp-group-member-name{overflow-wrap:anywhere}.hp-group-head{font-weight:600;background:color-mix(in srgb,currentColor 6%,transparent)}.hp-group-latency{font-variant-numeric:tabular-nums;white-space:nowrap}.hp-group-action{display:flex;justify-content:flex-end}.hp-group-head>:last-child{text-align:right}
.hp-group-selected{background:color-mix(in srgb,currentColor 6%,transparent);box-shadow:inset 3px 0 currentColor}.hp-group-selected-label{color:currentColor;font-weight:600}
@media(max-width:600px){.hp-group-summary{padding:.7rem;gap:.5rem}.hp-group-current{flex-basis:100%;padding-left:1rem}.hp-group-content{padding:0 .5rem .5rem}.hp-group-member{grid-template-columns:minmax(0,1fr) 4.5rem 4.5rem;gap:.4rem;padding:.4rem}.hp-group-action button{padding:.3rem .5rem}}
@media(max-width:800px){.hp-observe-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.hp-observe-panel{padding:.8rem!important}.hp-observe .hp-observe-tabs button{padding:.6rem .7rem}}
@media(max-width:420px){.hp-observe-metric{padding:.7rem}.hp-observe-metric strong{font-size:1.35rem}.hp-observe .hp-observe-tabs{flex-wrap:nowrap;overflow-x:auto}.hp-observe .hp-observe-tabs>li{flex-shrink:0}.hp-observe-field,.hp-observe-field input{width:100%;min-width:0}.hp-observe-toolbar{align-items:stretch}}
`),
   E('h2', {}, _('HomeProxy observability')),
   E('div', { class: 'hp-observe-toolbar' }, [E('label', { class: 'hp-observe-field' }, [_('Instance'), instances]),
    button(_('Settings'), async () => { const settings = await L.require('view.homeproxy.observe-settings'); await settings.open(); }),
    button(_('Refresh'), async () => { stop(); runtime = await getRuntime(instance); show(active); })]),
   status, nav, panel
  ]);
  function stop() { generation++; diagnosticsCancelled = true; stops.forEach(fn => fn()); stops = []; }
  function subscribe(method, request, handler) {
   const current = generation;
   stops.push(client.subscribe(method, request, item => { if (current === generation) handler(item); }, (state, error) => {
    if (current !== generation) return;
    status.textContent = `${runtime.version} · ${instance} · ${state === 'connected' ? _('Connected') : state === 'connecting' ? _('Connecting') : error}`;
   }));
  }
  async function snapshot(method, request, handler) {
   const current = generation, controller = new AbortController(), cancel = () => controller.abort();
   stops.push(cancel);
   try {
    for await (const item of client.stream(method, request, controller.signal)) {
     if (current === generation) { status.textContent = runtime.version + ' · ' + instance + ' · ' + _('Connected'); handler(item); }
     break;
    }
   } catch (error) { if (!controller.signal.aborted && current === generation) status.textContent = error.message; }
   finally { controller.abort(); stops = stops.filter(fn => fn !== cancel); }
  }
  function name(tag) {
   const mapped = runtime.sources?.tags?.[tag];
   if (mapped) return `${mapped.label} (${tag})`;
   const section = String(tag || '').match(/^cfg-(.+)-(?:out|in|dns|rule)$/)?.[1];
   return section && runtime.names?.[section] ? `${runtime.names[section]} (${tag})` : tag || '—';
  }
  async function control(method, request) {
   try { await client.call(method, request); ui.addNotification(null, E('p', {}, _('Operation completed.')), 'info'); }
   catch (error) { ui.addNotification(null, E('p', {}, error.message), 'error'); }
  }
  function overview() {
   const values = Array.from({ length: 4 }, () => E('strong', {}, '—'));
   const metrics = E('div', { class: 'hp-observe-metrics' }, [
    [_('Memory'), _('Core memory usage')], [_('Connections'), _('Inbound / outbound')],
    [_('Upload'), _('Current transfer rate')], [_('Download'), _('Current transfer rate')]
   ].map(([title, hint], i) => E('div', { class: 'hp-observe-metric' }, [E('span', {}, title), values[i], E('span', { class: 'hp-observe-muted' }, hint)])));
   panel.append(E('h3', {}, _('Overview')), E('p', {}, `${_('Core')}: ${runtime.version} · ${_('Required')}: ${runtime.expected}`), metrics);
   if (runtime.sources?.paths) panel.append(E('details', {}, [E('summary', {}, _('Configuration sources')), E('pre', {}, JSON.stringify(runtime.sources.paths, null, 2))]));
   let previous, refreshing = false;
   const refresh = async () => {
    if (refreshing) return; refreshing = true;
    try { await snapshot('SubscribeStatus', {}, s => {
    const now = performance.now(), elapsed = previous ? (now - previous.time) / 1000 : 0;
    const up = Number(s.uplinkTotal), down = Number(s.downlinkTotal);
    const valid = elapsed > 0 && up >= previous.up && down >= previous.down;
    [bytes(s.memory), `${s.connectionsIn ?? 0} / ${s.connectionsOut ?? 0}`, valid ? bytes((up - previous.up) / elapsed) + '/s' : '—', valid ? bytes((down - previous.down) / elapsed) + '/s' : '—'].forEach((value,i) => { values[i].textContent = value; });
    previous = { time: now, up, down };
   }); } finally { refreshing = false; }
   };
   refresh(); poll.add(refresh, 1); stops.push(() => poll.remove(refresh));

  }
  function connections() {
   const rows = new Map(); let page = 0;
   const filter = E('input', { class: 'cbi-input-text', placeholder: _('Filter domain, source, rule or outbound'), 'aria-label': _('Filter connections'), input: () => { page = 0; draw(); } });
   const stateFilter = E('select', { class: 'cbi-input-select', 'aria-label': _('Connection state'), change: () => { page = 0; draw(); } }, [['active', _('Active')], ['all', _('All')], ['closed', _('Closed')]].map(([value,label]) => E('option', { value }, label)));
   const sort = E('select', { class: 'cbi-input-select', 'aria-label': _('Connection sorting'), change: () => { page = 0; draw(); } }, [['createdAt', _('Newest first')], ['uplinkTotal', _('Uploaded bytes')], ['downlinkTotal', _('Downloaded bytes')]].map(([value,label]) => E('option', { value }, label)));
   const closeAll = button(_('Close all connections'), () => ui.showModal(_('Close all connections'), [E('p', {}, _('This closes all connections in the selected core instance, including those hidden by filters.')), E('div', { class: 'right' }, [button(_('Cancel'), () => ui.hideModal()), button(_('Close all connections'), async () => { ui.hideModal(); await control('CloseAllConnections', {}); }, 'cbi-button-negative')])]));
   const summary = E('p'); const table = E('table', { class: 'table' });
   const previous = button(_('Previous'), () => { page = Math.max(0, page - 1); draw(); });
   const next = button(_('Next'), () => { page++; draw(); });
   const empty = E('p', { class: 'hp-observe-empty' }, _('Waiting for connections…'));
   panel.append(E('h3', {}, _('Connections')), E('p', { class: 'hp-observe-muted' }, _('Only traffic entering this core is listed. Internal node latency tests are not proxy connections. All includes closed connections retained by the core or this page.')), E('div', { class: 'hp-observe-filters' }, [E('label', { class: 'hp-observe-field' }, [_('Filter connections'), filter]), E('label', { class: 'hp-observe-field' }, [_('Connection state'), stateFilter]), E('label', { class: 'hp-observe-field' }, [_('Connection sorting'), sort])]), E('div', { class: 'hp-observe-actions' }, closeAll), summary,
    E('div', { class: 'hp-observe-scroll' }, table), empty, E('div', { class: 'hp-observe-toolbar' }, [previous, next]));
   previous.disabled = next.disabled = closeAll.disabled = true;
   function draw() {
    const query = filter.value.toLowerCase();
    const all = [...rows.values()].filter(c => (stateFilter.value === 'all' || (stateFilter.value === 'closed' ? Number(c.closedAt) > 0 : !Number(c.closedAt))) && [c.domain, c.source, c.destination, c.rule, c.outbound, name(c.outbound)].join(' ').toLowerCase().includes(query)).sort((a,b) => { const x = BigInt(a[sort.value] || 0), y = BigInt(b[sort.value] || 0); return x < y ? 1 : x > y ? -1 : 0; });
    page = Math.min(page, Math.max(0, Math.ceil(all.length / 100) - 1));
    summary.textContent = `${all.length} ${_('connections')} · ${_('Page')} ${page + 1} · ${_('Local list capped at 5000 connections')}`;
    previous.disabled = page === 0; next.disabled = (page + 1) * 100 >= all.length;
    closeAll.disabled = ![...rows.values()].some(c => !Number(c.closedAt));
    empty.hidden = all.length > 0;
    empty.textContent = query ? _('No connections match this filter.') : stateFilter.value === 'active' ? _('No active connections. New connections will appear here automatically.') : stateFilter.value === 'closed' ? _('No retained closed connections.') : _('No connections have been reported by this core. Send traffic through its proxy entry to verify.');
    setContent(table, [E('tr', { class: 'tr' }, [_('Destination'), _('Source'), _('Outbound'), _('Details')].map(v => E('th', { class: 'th', scope: 'col' }, v))),
     ...all.slice(page * 100, page * 100 + 100).map(c => E('tr', { class: 'tr' }, [
      E('td', { class: 'td' }, `${c.domain || c.destination} · ${c.network}`), E('td', { class: 'td' }, c.source), E('td', { class: 'td', title: c.outbound }, runtime.sources?.tags?.[c.outbound]?.label || runtime.names?.[String(c.outbound || '').match(/^cfg-(.+)-out$/)?.[1]] || c.outbound || '—'),
      E('td', { class: 'td' }, button(_('Inspect'), () => ui.showModal(_('Connection details'), [E('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto' }, JSON.stringify(c, null, 2)), E('div', { class: 'right' }, [button(_('Close connection'), async () => { await control('CloseConnection', { id: c.id }); }, 'cbi-button-negative'), ' ', button(_('Dismiss'), () => ui.hideModal())]) ])))
     ]))]);
   }
   subscribe('SubscribeConnections', { interval: '1000000000' }, message => {
    if (message.reset) rows.clear();
    for (const event of message.events || []) {
     if (event.type === 'CONNECTION_EVENT_CLOSED') { const c = rows.get(event.id); if (c) c.closedAt = String(event.closedAt || Date.now()); }
     else if (event.connection) {
      if (!rows.has(event.id) && rows.size >= 5000) rows.delete(rows.keys().next().value);
      rows.set(event.id, event.connection);
     } else if (rows.has(event.id)) {
      const c = rows.get(event.id);
      c.uplinkTotal = String(BigInt(c.uplinkTotal || 0) + BigInt(event.uplinkDelta || 0));
      c.downlinkTotal = String(BigInt(c.downlinkTotal || 0) + BigInt(event.downlinkDelta || 0));
     }
    }
    draw();
   });
  }
  function logs() {
   let entries = [], paused = false;
   const level = E('select', { class: 'cbi-input-select', 'aria-label': _('Log level'), change: draw }, ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].map(l => E('option', { value: l, selected: l === 'DEBUG' ? '' : null }, l)));
   const search = E('input', { class: 'cbi-input-text', placeholder: _('Filter logs'), 'aria-label': _('Filter logs'), input: draw });
   const output = E('pre', { tabindex: '0', 'aria-label': _('Live logs') }, _('Waiting for log messages…'));
   const logState = E('p', { class: 'hp-observe-muted', role: 'status' });
   const levels = ['PANIC', 'FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
   function draw() {
    logState.textContent = (paused ? _('Display paused; log subscription is stopped.') : _('Live display')) + ' · ' + entries.length + ' / 3000';
    if (paused) return;
    const max = levels.indexOf(level.value), query = search.value.toLowerCase();
    output.textContent = entries.filter(e => levels.indexOf(String(e.level).replace('LOG_LEVEL_', '')) <= max && e.message.toLowerCase().includes(query)).slice(-1000).map(e => e.message).join('\n') || _('No log messages match the current filters.');
   }
   let stopLog;
   const pause = button(_('Pause display'), () => { paused = !paused; pause.textContent = paused ? _('Resume display') : _('Pause display'); if (paused) stopLog?.(); else startLog(); draw(); });
   panel.append(E('h3', {}, _('Live logs')), E('p', {}, _('The core sends its buffered logs first, then live updates. This page keeps up to 3000 entries and displays up to 1000. Reconnecting replaces the view with the core buffer; file logs are separate.')), E('div', { class: 'hp-observe-filters' }, [E('label', { class: 'hp-observe-field' }, [_('Log level'), level]), E('label', { class: 'hp-observe-field' }, [_('Filter logs'), search]), pause]), logState, output);
   const logGeneration = generation;
   const startLog = () => { stopLog = client.subscribe('SubscribeLog', {}, m => { if (paused || logGeneration !== generation) return; if (m.reset) entries = []; entries.push(...(m.messages || []).map(e => ({ ...e, message: String(e.message || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') })));  entries = entries.slice(-3000); draw(); }, (state,error) => { if (logGeneration === generation && !paused) status.textContent = state === 'error' ? error : runtime.version + ' · ' + state; }); };
   startLog(); stops.push(() => stopLog?.());
  }
  function groups() {
   const list = E('div', { class: 'hp-groups' }), openGroups = new Map(), pending = new Set(), feedback = new Map(), feedbackTimers = new Map();
   stops.push(() => { feedbackTimers.forEach(timer => clearTimeout(timer)); feedbackTimers.clear(); });
   let groups = [], initialized = false;
   const label = tag => {
    const id = String(tag || '').match(/^cfg-(.+)-out$/)?.[1];
    return runtime.sources?.tags?.[tag]?.label || runtime.names?.[id] || tag || '—';
   };
   const search = E('input', { class: 'cbi-input-text', placeholder: _('Search groups or members'), 'aria-label': _('Search groups or members'), input: () => draw() });
   const count = E('p', { class: 'hp-observe-muted', role: 'status' });
   const expand = button(_('Expand all'), () => { groups.forEach(g => openGroups.set(g.tag,true)); draw(); });
   const collapse = button(_('Collapse all'), () => { groups.forEach(g => openGroups.set(g.tag,false)); draw(); });
   panel.append(E('h3', {}, _('Outbound groups')), E('div', { class: 'hp-observe-toolbar' }, [E('label', { class: 'hp-observe-field' }, [_('Search groups or members'), search]), expand, collapse]), count, list);
   async function act(key, method, request) {
    if (pending.has(key)) return;
    const groupTag = request.groupTag || request.outboundTag, current = generation;
    clearTimeout(feedbackTimers.get(groupTag)); feedback.delete(groupTag);
    const controller = new AbortController(), cancel = () => controller.abort(); stops.push(cancel);
    pending.add(key); draw();
    try {
     await client.call(method, request, controller.signal);
     if (current !== generation) return;
     await refreshGroups();
     if (method === 'URLTest') {
      for (const delay of [1000, 3000, 6000, 16000]) { const timer = setTimeout(() => { if (current === generation) refreshGroups(); }, delay); stops.push(() => clearTimeout(timer)); }
     }
     const message = { text: method === 'URLTest' ? _('Latency test requested. Results update automatically.') : _('Selection updated.'), error: false };
     feedback.set(groupTag, message);
     feedbackTimers.set(groupTag, setTimeout(() => {
      if (feedback.get(groupTag) === message) feedback.delete(groupTag);
      feedbackTimers.delete(groupTag);
      if (current === generation && list.isConnected) draw();
     }, 4000));
    } catch (error) {
     if (current === generation && !controller.signal.aborted) feedback.set(groupTag, { text: error.message, error: true });
    } finally {
     stops = stops.filter(fn => fn !== cancel); pending.delete(key);
     if (current === generation && list.isConnected) draw();
    }
   }
   function draw() {
    const query = search.value.trim().toLowerCase();
    const visible = groups.filter(g => [label(g.tag), ...(g.items || []).map(i => label(i.tag))].some(v => v.toLowerCase().includes(query)));
    count.textContent = _('Groups') + ': ' + visible.length + ' / ' + groups.length;
    expand.disabled = collapse.disabled = !groups.length;
    if (!visible.length) { setContent(list,E('p', { class: 'hp-observe-empty' }, query ? _('No matching groups or members.') : _('No outbound groups. A configuration using a single node may not create groups.'))); return; }
    setContent(list, visible.map(group => {
     const items = group.items || [], isOpen = openGroups.get(group.tag) || !!query;
     const summary = E('summary', { class: 'hp-group-summary' }, [
      E('span', { class: 'hp-group-title', title: group.tag }, label(group.tag)),
      E('span', { class: 'hp-group-kind' }, group.selectable ? _('Manual selection') : _('Automatic selection')),
      E('span', { class: 'hp-group-current', title: group.selected }, _('Selected') + ': ' + label(group.selected)),
      E('span', { class: 'hp-observe-muted' }, _('Members') + ': ' + items.length)
     ]);
     const test = button(pending.has(group.tag) ? _('Testing…') : _('Test latency'), () => act(group.tag,'URLTest',{outboundTag:group.tag}));
     test.disabled = pending.has(group.tag);
     const rows = items.filter(i => !query || label(group.tag).toLowerCase().includes(query) || label(i.tag).toLowerCase().includes(query)).map(item => {
      const selected = group.selected === item.tag;
      const choose = button(pending.has(group.tag + ':select') ? _('Switching…') : _('Select'), () => act(group.tag + ':select','SelectOutbound',{groupTag:group.tag,outboundTag:item.tag}));
      choose.disabled = selected || pending.has(group.tag + ':select');
      return E('div', { class: 'hp-group-member' + (selected ? ' hp-group-selected' : ''), role: 'row' }, [
       E('span', { class: 'hp-group-member-name', title: item.tag, role:'cell' }, label(item.tag)),
       E('span', { class: 'hp-group-latency', role:'cell' }, item.urlTestDelay > 0 ? item.urlTestDelay + ' ms' : _('Untested')),
       E('span', { class: 'hp-group-action', role:'cell' }, selected ? E('span', { class: 'hp-group-selected-label' }, _('Selected')) : group.selectable ? choose : '—')
      ]);
     });
     const table = E('div', { class:'hp-group-members',role:'table','aria-label':label(group.tag) }, [
      E('div',{class:'hp-group-member hp-group-head',role:'row'},[_('Node'),_('Latency'),_('Action')].map(t=>E('span',{role:'columnheader'},t))), ...rows
     ]);
     const details = E('details', { class:'hp-group', open:isOpen || null }, [summary,E('div',{class:'hp-group-content'},[E('div',{class:'hp-group-toolbar'},[E('span',{class:'hp-group-feedback' + (feedback.get(group.tag)?.error ? ' hp-group-error' : ''),role:'status','aria-live':'polite'},feedback.get(group.tag)?.text || ''),test]),table])]);
     details.addEventListener('toggle', () => { if(details.isConnected && !query)openGroups.set(group.tag,details.open); });
     return details;
    }));
   }
   const refreshGroups = () => snapshot('SubscribeGroups', {}, data => {
    groups = data.group || [];
    if (!initialized && groups.length) { openGroups.set((groups.find(g=>g.selectable) || groups[0]).tag,true); initialized = true; }
    draw();
   });
   refreshGroups();
  }
  function tools() {
   let toolBusy = false;
   const field = (title, input) => E('label', { class: 'hp-observe-field' }, [title, input]);
   const outbound = E('select', { class: 'cbi-input-select' }, E('option', { value: '' }, _('Core default')));
   panel.append(E('h3', {}, _('Tools')), field(_('Outbound'), outbound));
   const loadOutbounds = () => snapshot('SubscribeOutbounds', {}, data => {
    const selected = outbound.value;
    setContent(outbound, [E('option', { value: '' }, _('Core default')), ...(data.outbounds || []).map(o => E('option', { value: o.tag }, name(o.tag)))]);
    if ([...outbound.options].some(o => o.value === selected)) outbound.value = selected;
   });
   function testCard(title, method, input, request, explain) {
    let controller;
    const state = E('p', { role: 'status', 'aria-live': 'polite' });
    const result = E('dl', { class: 'hp-tool-result' });
    const cancel = button(_('Cancel'), () => controller?.abort()); cancel.disabled = true;
    const start = button(_('Start'), async () => {
     if (controller || !input.value.trim() || !input.reportValidity()) return;
     if (toolBusy) { state.textContent = _('Another test is running.'); return; }
     controller = new AbortController(); const abort = () => controller?.abort(); stops.push(abort);
     toolBusy = true; outbound.disabled = true;
     start.disabled = true; cancel.disabled = false; input.disabled = true;
     state.textContent = _('Running…'); setContent(result, []);
     let final = false;
     try {
      for await (const item of client.stream(method, { ...request(), outboundTag: outbound.value }, controller.signal)) {
       if (item.error) throw new Error(item.error);
       final = !!item.isFinal;
       const nat = value => ({ 2: _('Endpoint independent'), 3: _('Address dependent'), 4: _('Address and port dependent') })[value] || _('Unknown');
       const filtering = value => ({ 1: _('Endpoint independent'), 2: _('Address dependent'), 3: _('Address and port dependent') })[value] || _('Unknown');
       const entries = method === 'StartSTUNTest' ? [
        [_('External address'), item.externalAddr || '—'], [_('Latency'), item.latencyMs + ' ms'],
        [_('NAT mapping'), item.natTypeSupported ? nat(item.natMapping) : item.isFinal ? _('Server does not support NAT classification') : _('Running…')],
        [_('NAT filtering'), item.natTypeSupported ? filtering(item.natFiltering) : item.isFinal ? _('Server does not support NAT classification') : _('Running…')]
       ] : [[_('Elapsed'), (Number(item.elapsedMs) / 1000).toFixed(1) + ' s'], [_('Idle latency'), item.idleLatencyMs + ' ms'],
        [_('Download capacity'), (Number(item.downloadCapacity) / 1000000).toFixed(2) + ' Mbps'],
        [_('Upload capacity'), (Number(item.uploadCapacity) / 1000000).toFixed(2) + ' Mbps'],
        [_('Download responsiveness'), item.downloadRPM + ' RPM'], [_('Upload responsiveness'), item.uploadRPM + ' RPM']];
       setContent(result, entries.flatMap(([k,v]) => [E('dt', {}, k), E('dd', {}, v)]));
      }
      if (!final) throw new Error(_('Test ended without a final result.'));
      state.textContent = _('Completed');
     } catch (error) { state.textContent = controller.signal.aborted ? _('Cancelled') : error.message; }
     finally { stops = stops.filter(fn => fn !== abort); controller = null; toolBusy = false; outbound.disabled = false; start.disabled = false; cancel.disabled = true; input.disabled = false; }
    });
    panel.append(E('section', { class: 'cbi-section' }, [E('h4', {}, title), E('p', {}, explain),
     E('div', { class: 'hp-observe-toolbar' }, [field(_('Server / URL'), input), start, cancel]), state, result]));
   }
   const stun = E('input', { class: 'cbi-input-text', value: 'stun.voipgate.com:3478', required: true });
   testCard(_('STUN / NAT test'), 'StartSTUNTest', stun, () => ({ server: stun.value.trim() }), _('Probe UDP connectivity, external address and NAT behavior through the selected outbound. NAT classification requires server support.'));
   const quality = E('input', { class: 'cbi-input-text', type: 'url', value: 'https://mensura.cdn-apple.com/api/v1/gm/config', required: true });
   testCard(_('Network quality'), 'StartNetworkQualityTest', quality, () => ({ configURL: quality.value.trim(), maxRuntimeSeconds: 20, serial: false, http3: false }), _('This test generates download and upload traffic for up to 20 seconds. Start it only when you want to measure capacity and responsiveness under load.'));
   const tailscale = E('div', {}, E('p', {}, _('Waiting for Tailscale status…'))); panel.append(E('h4', {}, _('Tailscale')), tailscale);
   const loadTailscale = () => snapshot('SubscribeTailscaleStatus', {}, data => {
    setContent(tailscale, (data.endpoints || []).length ? data.endpoints.map(endpoint => {
     const details = E('details', {}, [E('summary', {}, name(endpoint.endpointTag) + ' · ' + endpoint.backendState), E('p', {}, endpoint.stateText)]);
     if (/^https:\/\//i.test(endpoint.authURL || '')) details.append(E('a', { href: endpoint.authURL, target: '_blank', rel: 'noopener noreferrer' }, _('Log in to Tailscale')));
     for (const peer of (endpoint.userGroups || []).flatMap(g => g.peers || [])) {
      const pingResult = E('span', { role: 'status' });
      details.append(E('p', {}, [peer.hostName + ' · ' + (peer.tailscaleIPs || []).join(', ') + ' · ' + (peer.online ? _('Online') : _('Offline')), ' ',
       button(_('Ping'), async () => {
        if (toolBusy) { pingResult.textContent = _('Another test is running.'); return; }
        toolBusy = true; outbound.disabled = true;
        const controller = new AbortController(), cancel = () => controller.abort(); stops.push(cancel);
        try { for await (const r of client.stream('StartTailscalePing', { endpointTag: endpoint.endpointTag, peerIP: peer.tailscaleIPs?.[0] }, controller.signal)) pingResult.textContent = r.error || r.latencyMs.toFixed(1) + ' ms · ' + (r.isDirect ? _('Direct') : _('Relay')); }
        catch (error) { pingResult.textContent = error.message; }
        finally { toolBusy = false; outbound.disabled = false; stops = stops.filter(fn => fn !== cancel); }
       }), ' ', pingResult]));
     }
     return details;
    }) : E('p', { class: 'hp-observe-muted' }, _('No running Tailscale endpoints.')));
   });
   const toolsGeneration = generation;
   loadOutbounds().then(() => { if (toolsGeneration === generation) return loadTailscale(); });
  }
  function diagnostics() {
   if (instance !== 'client') { panel.append(E('p', {}, _('Select the client instance for domain diagnostics.'))); return; }
   const target = E('input', { class: 'cbi-input-text', placeholder: 'https://example.com', 'aria-label': _('Domain or URL') });
   const results = E('div', {}, E('p', { class: 'hp-observe-empty' }, _('Enter a domain or URL to inspect DNS, HTTP connectivity and routing.')));
   const progress = E('progress', { max: 11, value: 0, hidden: '', 'aria-label': _('Diagnosis progress') });
   const progressText = E('p', { role: 'status', 'aria-live': 'polite' });
   const stageNames = { system: _('System environment'), config: _('Core configuration'), dns_system_A: _('System DNS · IPv4'), dns_system_AAAA: _('System DNS · IPv6'), dns_system_HTTPS: _('System DNS · HTTPS'), dns_core_A: _('Core DNS · IPv4'), dns_core_AAAA: _('Core DNS · IPv6'), dns_core_HTTPS: _('Core DNS · HTTPS'), router_http: _('Router HTTP connection'), proxy_http: _('Proxy HTTP connection'), routing: _('Routing configuration') };
   const stages = ['system', 'config', 'dns_system_A', 'dns_system_AAAA', 'dns_system_HTTPS', 'dns_core_A', 'dns_core_AAAA', 'dns_core_HTTPS', 'router_http', 'proxy_http', 'routing'];
   let busy = false;
   const start = button(_('Start diagnosis'), async () => {
    if (busy || !target.value.trim()) return;
    busy = true; start.disabled = true; cancel.disabled = false; target.disabled = true; diagnosticsCancelled = false; progress.hidden = false; progress.value = 0;
    const current = generation, requestedTarget = target.value.trim();
    // Paths and query strings may contain access tokens. Keep them out of exports.
    let publicTarget = '[invalid target]';
    try { publicTarget = new URL(/^https?:\/\//.test(requestedTarget) ? requestedTarget : 'https://' + requestedTarget).origin; } catch (_) {}
    const report = { started_at: new Date().toISOString(), instance, target: publicTarget, core: runtime.version, steps: [] };
    latestReport = report; setContent(results, []);
    for (const stage of stages) {
     if (diagnosticsCancelled || current !== generation) break;
     progressText.textContent = `${report.steps.length + 1} / ${stages.length} · ${stageNames[stage]} · ${_('Running…')}`;
     const row = E('details', {}, [E('summary', {}, stageNames[stage] + ' · ' + _('Running…'))]); results.append(row);
     try {
      const result = await runStage(stage, requestedTarget, instance);
      report.steps.push({ stage, ...result });
      progress.value = report.steps.length; row.open = result.status === 'error' || result.status === 'fail';
      if (current !== generation) break;
      setContent(row, [E('summary', {}, `${stageNames[stage]} · ${result.status} · ${result.message}`), E('pre', {}, JSON.stringify(result.details || {}, null, 2))]);
      if (result.status === 'error') break;
     } catch (error) { report.steps.push({ stage, status: 'error', message: error.message }); row.firstChild.textContent = stageNames[stage] + ' · ' + error.message; }
    }
    report.cancelled = diagnosticsCancelled; report.finished_at = new Date().toISOString();
    busy = false; start.disabled = false; cancel.disabled = true; target.disabled = false; exportButton.disabled = false;
    progressText.textContent = (report.cancelled ? _('Cancelled') : _('Diagnosis finished')) + ` · ${report.steps.length} / ${stages.length}`;
   }, 'cbi-button-action');
   const cancel = button(_('Cancel'), () => { diagnosticsCancelled = true; cancel.disabled = true; progressText.textContent = _('Cancelling after the current stage…'); });
   cancel.disabled = true;
   const exportButton = button(_('Export result'), () => {
    if (!latestReport) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(latestReport, null, 2)], { type: 'application/json' }));
    const a = E('a', { href: url, download: 'homeproxy-diagnostic.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
   });
   exportButton.disabled = !latestReport;
   panel.append(E('h3', {}, _('Domain diagnostics')), E('p', { class: 'cbi-section-descr' }, _('Tests run from the router and the explicit proxy. LAN transparent interception needs traffic from the LAN device. Cancel stops subsequent stages; the active stage has a short timeout.')),
    E('div', { class: 'hp-observe-toolbar' }, [E('label', { class: 'hp-observe-field' }, [_('Domain or URL'), target]), start, cancel, exportButton]), progress, progressText, results);
  }
  async function show(tab) {
   stop(); active = tab; setContent(panel, []); panel.setAttribute('aria-busy', 'false');
   for (const item of nav.children) {
    const selected = item.firstChild.dataset.tab === tab;
    item.setAttribute('class', selected ? 'cbi-tab' : 'cbi-tab-disabled');
    item.firstChild.setAttribute('aria-selected', String(selected));
    item.firstChild.setAttribute('tabindex', selected ? '0' : '-1');
   }
   panel.setAttribute('aria-labelledby', 'hp-tab-' + tab);
   client = new window.HomeProxyAPI.Client(instance);
   status.textContent = `${runtime.version} · ${instance} · ${runtime.running ? _('Running') : _('Not running')}`;
   if (tab === 'diagnostics') { diagnostics(); return; }
   if (!runtime.compatible || !runtime.api.enabled || !runtime.running) {
    panel.append(E('p', {}, _('The paired core must be running with API enabled. Check API settings and the HomeProxy startup log.'))); return;
   }
   const current = generation;
   panel.setAttribute('aria-busy', 'true');
   panel.append(E('p', { class: 'hp-observe-empty' }, _('Connecting to the core…')));
   try {
    const controller = new AbortController(); stops.push(() => controller.abort());
    const v = await client.call('GetVersion', {}, controller.signal);
    if (current !== generation) return;
    if (v.version !== runtime.expected || v.apiVersion !== runtime.api_version) throw new Error(_('Core/API version is outside the supported pairing.'));
    setContent(panel, []);
    ({ overview, connections, logs, groups, tools })[tab]();
   } catch (error) { if (current === generation) setContent(panel, E('p', { class: 'alert-message error', role: 'alert' }, error.message)); }
   finally { if (current === generation) panel.setAttribute('aria-busy', 'false'); }
  }
  for (const [tab, label] of [['overview', _('Overview')], ['connections', _('Connections')], ['logs', _('Logs')], ['groups', _('Groups')], ['diagnostics', _('Diagnostics')], ['tools', _('Tools')]]) {
   const b = button(label, () => show(tab)); b.dataset.tab = tab;
   b.setAttribute('id', 'hp-tab-' + tab); b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'hp-observe-panel');
   b.addEventListener?.('keydown', event => {
    const tabs = Array.from(nav.children).map(item => item.firstChild), index = tabs.indexOf(b);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault(); tabs[next].focus(); show(tabs[next].dataset.tab);
   });
   nav.append(E('li', { role: 'presentation' }, b));
  }
  const hidden = () => { if (document.hidden) stop(); else show(active); };
  document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', stop);
  const observer = new MutationObserver(() => { if (!root.isConnected) { stop(); observer.disconnect(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', stop); } });
  requestAnimationFrame(() => { observer.observe(document.body, { childList: true, subtree: true }); show(active); });
  return root;
 },
 handleSaveApply: null, handleSave: null, handleReset: null
});
