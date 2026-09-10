import { importNodes,nodeID } from '/etc/homeproxy/scripts/node_import.uc';
function check(ok,message){if(!ok)die(message);print(message,': pass\n');}
const sample={outbounds:[{tag:'Proxy',type:'selector',outbounds:['auto']},{tag:'auto',type:'urltest',outbounds:['A'],interval:'5m'},{tag:'A',type:'shadowsocks',server:'192.0.2.1',server_port:443,method:'aes-128-gcm',password:'fixture'}]};
const a=importNodes(sample,'source-a'),b=importNodes(sample,'source-b');
check(a[0].node_id!==b[0].node_id,'source namespace isolation');
check(a[0].group_nodes[0]===a[1].node_id && a[1].group_nodes[0]===a[2].node_id,'group reference mapping');
check(a[1].group_interval==='300','typed duration mapping');
let failed=false;try{importNodes({outbounds:[{tag:'A',type:'selector',outbounds:['A']}]},'cycle');}catch(e){failed=true;}check(failed,'dependency cycle rejection');
failed=false;try{importNodes({outbounds:[{tag:'A',type:'direct',new_unknown_field:true}]},'unknown');}catch(e){failed=true;}check(failed,'unknown fields rejected without data loss');
failed=false;try{importNodes({endpoints:[{tag:'tailnet',type:'tailscale',auth_key:'fixture',ssh_server:true}]},'tailnet');}catch(e){failed=true;}check(failed,'remote Tailscale rejected');
