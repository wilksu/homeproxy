/* SPDX-License-Identifier: GPL-2.0-only */
/* Typed import into the existing node model. Unknown fields are reported, never dropped. */
import { md5 } from 'digest';
import { mkdir,writefile,chmod,unlink } from 'fs';
const scalar={server:'address',server_port:'port',username:'username',password:'password',uuid:'uuid',method:'shadowsocks_encrypt_method',plugin:'shadowsocks_plugin',plugin_opts:'shadowsocks_plugin_opts',server_ports:'hysteria_hopping_port',up_mbps:'hysteria_up_mbps',down_mbps:'hysteria_down_mbps',bbr_profile:'hysteria_bbr_profile',disable_chrome_parrot:'hysteria_disable_chrome_parrot',recv_window_conn:'hysteria_recv_window_conn',recv_window:'hysteria_revc_window',disable_mtu_discovery:'hysteria_disable_mtu_discovery',client_version:'ssh_client_version',host_key:'ssh_host_key',host_key_algorithms:'ssh_host_key_algo',private_key:'ssh_priv_key',private_key_passphrase:'ssh_priv_key_pp',user:'username',congestion_control:'tuic_congestion_control',udp_relay_mode:'tuic_udp_relay_mode',udp_over_stream:'tuic_udp_over_stream',zero_rtt_handshake:'tuic_enable_zero_rtt',flow:'vless_flow',alter_id:'vmess_alterid',security:'vmess_encrypt',global_padding:'vmess_global_padding',authenticated_length:'vmess_authenticated_length',packet_encoding:'packet_encoding',tcp_fast_open:'tcp_fast_open',tcp_multi_path:'tcp_multi_path',udp_fragment:'udp_fragment',proxy_protocol:'proxy_protocol'};
const times={idle_session_check_interval:'anytls_idle_session_check_interval',idle_session_timeout:'anytls_idle_session_timeout',hop_interval:'hysteria_hop_interval',hop_interval_max:'hysteria_hop_interval_max',heartbeat:'tuic_heartbeat'};
const tls={enabled:'tls',server_name:'tls_sni',insecure:'tls_insecure',alpn:'tls_alpn',min_version:'tls_min_version',max_version:'tls_max_version',cipher_suites:'tls_cipher_suites',certificate_path:'tls_cert_path',certificate_public_key_sha256:'tls_certificate_public_key_sha256'};
const supported=['anytls','http','hysteria','hysteria2','shadowsocks','shadowtls','socks','ssh','trojan','tuic','vless','vmess','direct','selector','urltest'];
function value(v) { if(type(v)==='bool')return v?'1':'0'; if(type(v)==='array')return map(v,x=>''+x); return ''+v; }
function seconds(v) {
 if(type(v)==='int' || type(v)==='double')return ''+v;
 const m=match(v || '',/^([0-9]+)(ms|s|m|h)$/);if(!m)die('Unsupported duration; use an integral duration in seconds, minutes or hours');
 const n=int(m[1])*(m[2]==='h'?3600:m[2]==='m'?60:1);if(m[2]==='ms'){if(n%1000)die('Subsecond duration is not supported by this node field');return ''+(n/1000);}return ''+n;
}
function fields(target, source, mapping, label) {
 for(let key in keys(source || {})){if(!mapping[key])die(label+'.'+key+': field is not supported by the node form yet');target[mapping[key]]=value(source[key]);}
}
export function nodeID(source, key) { return 'n'+md5(source+'\n'+key); };
export function importNode(input, resolve) {
 if (input.type === 'tailscale') die('Tailscale endpoints must be configured locally; subscriptions cannot manage router services');
 const n={type:input.type,label:input.tag,source_tag:input.tag};
 if(!(input.type in supported))die('Unsupported node type: '+input.type);
 for(let key in keys(input)) {
  const v=input[key];if(key in ['type','tag'])continue;
  if(key==='outbounds'){n.group_nodes=map(v,t=>resolve(t));continue;}
  if(key==='default'){n.group_default=resolve(v);continue;}
  if(key in ['url','interval','tolerance','idle_timeout','interrupt_exist_connections'] && input.type in ['selector','urltest']){n['group_'+key]=(key in ['interval','idle_timeout'])?seconds(v):value(v);continue;}
  if(key==='detour'){n.node_detour=resolve(v);continue;}
  if(key==='domain_resolver')die('Outbound '+input.tag+' has a DNS resolver dependency; select a local resolver before importing nodes only');
  if(key==='bind_interface' || key==='routing_mark'){n['node_'+key]=value(v);continue;}
  if(scalar[key]){n[scalar[key]]=value(v);continue;}
  if(times[key]){n[times[key]]=seconds(v);continue;}
  if(key==='min_idle_session'){n.anytls_min_idle_session=value(v);continue;}
  if(key==='version'){n[input.type==='shadowtls'?'shadowtls_version':'socks_version']=value(v);continue;}
  if(key==='auth' || key==='auth_str'){n.hysteria_auth_type=key==='auth'?'base64':'string';n.hysteria_auth_payload=value(v);continue;}
  if(key==='obfs'){
   if(type(v)==='string')n.hysteria_obfs_password=v;
   else fields(n,v,{type:'hysteria_obfs_type',password:'hysteria_obfs_password',min_packet_size:'hysteria_obfs_min_packet_size',max_packet_size:'hysteria_obfs_max_packet_size'},'obfs');continue;
  }
  if(key==='udp_over_tcp'){
   if(type(v)==='bool')n.udp_over_tcp=value(v);else fields(n,v,{enabled:'udp_over_tcp',version:'udp_over_tcp_version'},'udp_over_tcp');continue;
  }
  if(key==='tls'){
   for(let t in keys(v)){
    if(tls[t])n[tls[t]]=value(v[t]);
    else if(t==='handshake_timeout')n.tls_handshake_timeout=seconds(v[t]);
    else if(t==='utls'){if(v[t].enabled!==false)n.tls_utls=v[t].fingerprint || 'chrome';for(let k in keys(v[t]))if(!(k in ['enabled','fingerprint']))die('Unsupported TLS uTLS field: '+k);}
    else if(t==='reality')fields(n,v[t],{enabled:'tls_reality',public_key:'tls_reality_public_key',short_id:'tls_reality_short_id'},'tls.reality');
    else if(t==='ech')fields(n,v[t],{enabled:'tls_ech',config:'tls_ech_config',config_path:'tls_ech_config_path'},'tls.ech');
    else die('Unsupported TLS field: '+t);
   }continue;
  }
  if(key==='multiplex'){
   for(let k in keys(v)) {
    if(k==='brutal')fields(n,v[k],{enabled:'multiplex_brutal',up_mbps:'multiplex_brutal_up',down_mbps:'multiplex_brutal_down'},'multiplex.brutal');
    else fields(n,{[k]:v[k]},{enabled:'multiplex',protocol:'multiplex_protocol',max_connections:'multiplex_max_connections',min_streams:'multiplex_min_streams',max_streams:'multiplex_max_streams',padding:'multiplex_padding'},'multiplex');
   }continue;
  }
  if(key==='transport'){
   n.transport=v.type;
   for(let k in keys(v)){
    if(k==='type')continue;
    if(k==='headers'){if(length(keys(v[k]))!==1 || !v[k].Host)die('Transport headers other than Host need a supported form field');n.ws_host=v[k].Host;continue;}
    const mapping={host:v.type==='httpupgrade'?'httpupgrade_host':'http_host',path:v.type==='ws'?'ws_path':'http_path',method:'http_method',max_early_data:'websocket_early_data',early_data_header_name:'websocket_early_data_header',service_name:'grpc_servicename',permit_without_stream:'grpc_permit_without_stream'};
    if(k in ['idle_timeout','ping_timeout'])n['http_'+k]=seconds(v[k]);else fields(n,{[k]:v[k]},mapping,'transport');
   }continue;
  }
  die(input.type+'.'+key+': field is not supported by the node form yet');
 }
 return n;
};
export function importNodes(config, source) {
 const all=[...(config.outbounds || []),...(config.endpoints || [])], tags={}, seen={};
 for(let input in all){
  if(!input.tag || !input.type || seen[input.tag])die('Missing type/tag or duplicate outbound/endpoint tag');
  seen[input.tag]=true;
  tags[input.tag]=input.type in supported ? nodeID(source,input.tag) : null;
  if(input.type==='tailscale')die('Tailscale endpoints must be configured locally; subscriptions cannot manage router services');
 }
 const inputs=filter(all,input=>input.type in supported);
 const resolve=t=>{if(!tags[t])die('Missing group member or detour: '+t);return tags[t];};
 const nodes=map(inputs,input=>{const n=importNode(input,resolve);n.node_id=tags[input.tag];return n;});
 const byid={};for(let n in nodes)byid[n.node_id]=n;
 const visiting={},done={};
 function visit(id){if(visiting[id])die('Circular group/detour dependency');if(done[id])return;visiting[id]=true;const n=byid[id];for(let dep in [...(n.group_nodes || []),...(n.node_detour?[n.node_detour]:[])])visit(dep);delete visiting[id];done[id]=true;}
 for(let n in nodes){if(n.group_default && !(n.group_default in (n.group_nodes || [])))die('Default must be a group member');visit(n.node_id);}
 // Check the supported native objects with the paired installed core before storage.
 const directory=(getenv('HP_OUTPUT_DIR') || '/var/run/homeproxy')+'/node-import';
 mkdir(directory,0700);
 const file=directory+'/'+md5(source)+'.json';
 const outbounds=filter(config.outbounds || [],input=>input.type in supported);
 const endpoints=filter(config.endpoints || [],input=>input.type in supported);
 writefile(file,sprintf('%J',{outbounds,endpoints,dns:{servers:[{type:'local',tag:'hp-import-resolver'}]},route:{default_domain_resolver:'hp-import-resolver'}}));chmod(file,0600);
 const result=system('sing-box check -c '+file+' >/dev/null 2>&1');unlink(file);
 if(result)die('Native nodes failed core validation; check protocol options and core capabilities');
 return nodes;
};
