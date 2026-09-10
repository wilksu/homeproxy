/* SPDX-License-Identifier: GPL-2.0-only */
/* Shared router-owned ingress for custom routing. */
import { strToTime } from 'homeproxy';
import { natOptions } from 'config114';
export function routerInbounds(uci) {
 const get=(section,key,fallback)=>uci.get('homeproxy',section,key) || fallback;
 const infra=(key,fallback)=>get('infra',key,fallback);
 const mode=get('config','proxy_mode','redirect_tproxy');
 const routing=uci.get_all('homeproxy','routing') || {};
 const c={};
 c.inbounds = [
  { type:'direct',tag:'dns-in',listen:'::',listen_port:int(infra('dns_port','5333')) },
  { type:'mixed',tag:'mixed-in',listen:'::',listen_port:int(infra('mixed_port','5330')),set_system_proxy:false }
 ];
 if (match(mode,/redirect/)) push(c.inbounds,{type:'redirect',tag:'redirect-in',listen:'::',listen_port:int(infra('redirect_port','5331'))});
 if (match(mode,/tproxy/)) push(c.inbounds,{type:'tproxy',tag:'tproxy-in',listen:'::',listen_port:int(infra('tproxy_port','5332')),network:'udp',...natOptions(routing)});
 if (match(mode,/tun/)) push(c.inbounds,{type:'tun',tag:'tun-in',interface_name:infra('tun_name','singtun0'),address:get('config','ipv6_support','0') === '1' ? [infra('tun_addr4','172.19.0.1/30'),infra('tun_addr6','fdfe:dcba:9876::1/126')] : [infra('tun_addr4','172.19.0.1/30')],mtu:int(infra('tun_mtu','9000')),auto_route:false,dns_mode:'disabled',stack:routing.tcpip_stack || 'system',...natOptions(routing)});
 const timeout=routing.udp_timeout || infra('udp_timeout','300');
 for(let inbound in c.inbounds) if(inbound.tag !== 'dns-in') inbound.udp_timeout=strToTime(timeout);
 return c.inbounds;
};
export function routerRules(sniff) {
 const rules=[{inbound:'dns-in',action:'hijack-dns'}];
 if(sniff)push(rules,{inbound:['mixed-in','redirect-in','tproxy-in','tun-in'],action:'sniff'});
 return rules;
};
