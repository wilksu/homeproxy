import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';
import { build } from 'esbuild';
const root = new protobuf.Root();
root.addJSON(protobuf.common['google/protobuf/empty.proto'].nested);
protobuf.parse(fs.readFileSync('frontend/proto/started_service.proto', 'utf8'), root, { keepCase: true });
root.resolveAll();
const service = root.lookupService('daemon.StartedService');
const methods = ['GetVersion','SubscribeServiceStatus','SubscribeLog','GetDefaultLogLevel','SubscribeStatus',
 'SubscribeGroups','SubscribeConnections','GetStartedAt','SubscribeOutbounds','GetDeprecatedWarnings',
 'GetClashModeStatus','SubscribeClashMode','SetClashMode','URLTest','SelectOutbound','SetGroupExpand',
 'CloseConnection','CloseAllConnections','ClearLogs','StartSTUNTest','StartNetworkQualityTest','SubscribeTailscaleStatus','StartTailscalePing'];
for (const name of Object.keys(service.methods)) if (!methods.includes(name)) service.remove(service.methods[name]);
const used = new Set();
function visit(type) {
 if (used.has(type)) return;
 used.add(type);
 if (type.fieldsArray) for (const field of type.fieldsArray) if (field.resolvedType) visit(field.resolvedType);
}
for (const method of service.methodsArray) { visit(method.resolvedRequestType); visit(method.resolvedResponseType); }
const schema = { nested: { daemon: { nested: {} }, google: { nested: { protobuf: { nested: {} } } } } };
for (const type of used) {
 // Nested enums/messages travel with their parent message.
 let top = type;
 while (top.parent instanceof protobuf.Type) top = top.parent;
 const dest = top.fullName.startsWith('.google.protobuf.') ? schema.nested.google.nested.protobuf.nested : schema.nested.daemon.nested;
 dest[top.name] = top.toJSON();
}
schema.nested.daemon.nested.StartedService = service.toJSON();
fs.writeFileSync('frontend/schema.json', JSON.stringify(schema));
await build({ entryPoints: ['frontend/api.js'], bundle: true, minify: true, format: 'iife', globalName: 'HomeProxyAPI', target: ['es2020'], outfile: 'htdocs/luci-static/resources/homeproxy-api.js', legalComments: 'inline' });
console.log('API bundle:', fs.statSync('htdocs/luci-static/resources/homeproxy-api.js').size, 'bytes');
