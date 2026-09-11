/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
'require baseclass';
'require form';
'require uci';
'require ui';
'require rpc';
const getSecret = rpc.declare({ object: 'luci.homeproxy', method: 'api_secret', expect: { '': {} } });
return baseclass.extend({
 async open() {
  await uci.load('homeproxy');
  const created = !uci.get('homeproxy', 'observability');
  if (created) {
   uci.add('homeproxy', 'homeproxy', 'observability');
   uci.set('homeproxy', 'observability', 'enabled', '1');
   uci.set('homeproxy', 'observability', 'external', '0');
   uci.set('homeproxy', 'observability', 'client_port', '5334');
   uci.set('homeproxy', 'observability', 'server_port', '5335');
  }
  const m = new form.Map('homeproxy', null, _('Local monitoring uses an internal API automatically. Applying connection settings restarts HomeProxy.'));
  const s = m.section(form.NamedSection, 'observability', 'homeproxy');
  let o = s.option(form.Flag, 'external', _('Allow LAN Dashboard connections'), _('Off: only this router can access the core API. On: trusted browsers on your LAN can connect directly.'));
  o.default = '0'; o.rmempty = false;
  o = s.option(form.Value, 'listen', _('LAN listen address'), _('Leave empty to use the LAN IPv4 address. This does not open WAN firewall access.'));
  o.datatype = 'ipaddr'; o.depends('external', '1'); o.retain = true;
  o = s.option(form.DynamicList, 'allowed_origins', _('Allowed Dashboard origins'), _('Enter trusted Dashboard origins, for example https://sing-box-dashboard.sagernet.org. Browser HTTPS and local-network permissions still apply.'));
  o.depends('external', '1'); o.retain = true;
  o.validate = (sid,v) => !v || /^https?:\/\/[^/?#\s]+$/.test(v) || _('Enter an HTTP(S) origin without a path.');
  o = s.option(form.DummyValue, '_secret', _('Connection secret')); o.depends('external', '1');
  o.renderWidget = () => {
   const input = E('input', { class: 'cbi-input-text', readonly: true, hidden: true, 'aria-label': _('API secret') });
   const reveal = E('button', { type: 'button', class: 'btn cbi-button cbi-button-action', click: ui.createHandlerFn(this, async () => {
    const result = await getSecret(); input.value = result.secret || ''; input.hidden = false;
   }) }, _('Show secret'));
   return E('div', {}, [reveal, input]);
  };
  o = s.option(form.Flag, '_advanced', _('Advanced connection settings')); o.depends('external', '1'); o.write = () => {}; o.remove = () => {};
  for (const [key,label,port] of [['client_port', _('Client API port'), '5334'], ['server_port', _('Server API port'), '5335']]) {
   if (key === 'server_port' && uci.get('homeproxy','server','enabled') !== '1') continue;
   o = s.option(form.Value, key, label); o.default = port; o.datatype = 'port'; o.retain = true; o.depends({ external: '1', _advanced: '1' });
   o.validate = function(sid,value) {
    const otherKey = key === 'client_port' ? 'server_port' : 'client_port';
    const other = m.lookupOption(otherKey,sid)?.[0];
    return value !== (other?.formvalue(sid) || uci.get('homeproxy',sid,otherKey) || (otherKey==='client_port'?'5334':'5335')) || _('Client and server API ports must differ.');
   };
  }
  for (const [key,label] of [['tls_cert', _('API TLS certificate path')], ['tls_key', _('API TLS private key path')]]) {
   o = s.option(form.Value,key,label); o.datatype = 'file'; o.retain = true; o.depends({ external:'1', _advanced:'1' });
   o.validate = function(sid,value) {
    const peer = m.lookupOption(key === 'tls_cert' ? 'tls_key' : 'tls_cert',sid)?.[0];
    return !!value === !!peer?.formvalue(sid) || _('Provide both TLS certificate and private key, or leave both empty.');
   };
  }
  o = s.option(form.Value, 'tls_server_name', _('API TLS server name'), _('Certificate DNS name used by the internal relay; connects to the configured listen address. Leave empty for an IP certificate.'));
  o.datatype = 'hostname'; o.retain = true; o.depends({ external: '1', _advanced: '1' });
  const content = await m.render();
  ui.showModal(_('Observability settings'), [content, E('div', { class: 'right' }, [
   E('button', { class: 'btn', click: () => { if (created) uci.remove('homeproxy', 'observability'); ui.hideModal(); } }, _('Cancel')), ' ',
   E('button', { class: 'btn cbi-button-positive', click: ui.createHandlerFn(this, async () => {
    await m.save();
    uci.set('homeproxy','observability','enabled','1');
    uci.unset('homeproxy','observability','dashboard');
    await uci.save(); ui.hideModal(); await ui.changes.apply(true);
   }) }, _('Save & Apply'))
  ])]);
 }
});
