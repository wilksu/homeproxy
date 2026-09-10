/* SPDX-License-Identifier: GPL-2.0-only */
import { strToBool, strToInt, strToTime } from 'homeproxy';
export function tailscaleEndpoint(node, mark) {
 const endpoint={type:'tailscale',tag:'cfg-'+node['.name']+'-out',state_directory:node.tailscale_state_directory || '/etc/homeproxy/tailscale/'+node['.name'],routing_mark:strToInt(node.node_routing_mark || mark),bind_interface:node.node_bind_interface,detour:node.node_detour ? 'cfg-'+node.node_detour+'-out' : null};
 for(let key in ['auth_key','control_url','hostname','exit_node','system_interface_name','taildrop_directory']) endpoint[key]=node['tailscale_'+key];
 for(let key in ['ephemeral','accept_routes','exit_node_allow_lan_access','advertise_exit_node','system_interface']) endpoint[key]=strToBool(node['tailscale_'+key]);
 for(let key in ['advertise_routes','advertise_tags','relay_server_static_endpoints']) endpoint[key]=node['tailscale_'+key];
 for(let key in ['listen_port','relay_server_port','system_interface_mtu']) endpoint[key]=strToInt(node['tailscale_'+key]);
 endpoint.taildrop_directory=node.tailscale_taildrop_directory || endpoint.state_directory+'/taildrop';
 for(let key in ['tcp_fast_open','tcp_multi_path','udp_fragment'])endpoint[key]=strToBool(node[key]);
 endpoint.udp_timeout=strToTime(node.tailscale_udp_timeout);
 if(node.tailscale_ssh_server === '1') endpoint.ssh_server={enabled:true,disable_pty:strToBool(node.tailscale_ssh_disable_pty),disable_sftp:strToBool(node.tailscale_ssh_disable_sftp),disable_forwarding:strToBool(node.tailscale_ssh_disable_forwarding)};
 return endpoint;
};
