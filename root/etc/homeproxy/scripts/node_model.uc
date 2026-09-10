/* SPDX-License-Identifier: GPL-2.0-only */
/* UI references are materialized as ordinary core outbounds, never a new protocol. */
export function nodeModel(uci) {
 const config='homeproxy';
 function resolve(id, path) {
  path=path || [];
  if(id in path)die('Circular node reference: '+join(' -> ',[...path,id]));
  const record=uci.get_all(config,id);
  if(!record || record['.type'] !== 'node')die('Referenced node is missing: '+id);
  if(record.type === 'tailscale' && (record.grouphash || record.source_id))die('Subscribed Tailscale endpoint is not permitted; configure it locally: '+id);
  let node={...record};
  if(record.node_mode === 'reference') {
   const base=resolve(record.node_base,[...path,id]);
   if(base.type in ['selector','urltest','tailscale','wireguard'])die('Base node must be a proxy outbound: '+id);
   node={...base,'.name':id,'.type':'node',label:record.label};
   // Empty overrides inherit; explicit _direct bypasses an inherited detour.
  }
  for(let key in ['detour','bind_interface','domain_resolver','domain_strategy']) {
   const value=record['local_'+key];
   if(value)node['node_'+key]=value === '_direct' || value === '_default' ? null : value;
  }
  return node;
 }
 function validate(id,path) {
  path=path || [];
  if(id in path)die('Circular node dependency: '+join(' -> ',[...path,id]));
  const node=resolve(id);
  if(node.type in ['selector','urltest']) {
   if(!length(node.group_nodes || []))die('Group has no members: '+id);
   if(node.group_default && !(node.group_default in node.group_nodes))die('Default is not a group member: '+id);
  }
  for(let dep in [...(node.group_nodes || []),...(node.node_detour?[node.node_detour]:[])])validate(dep,[...path,id]);
  return node;
 }
 return {resolve,validate};
};
