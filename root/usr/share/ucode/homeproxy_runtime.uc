/* SPDX-License-Identifier: GPL-2.0-only */
import { access, lstat, open, readfile, writefile, mkstemp, mkdtemp, chmod, rename, unlink, rmdir } from 'fs';
import { cursor } from 'uci';
import { connect } from 'ubus';
import { urlencode } from 'luci.http';

const RUN_DIR = '/var/run/homeproxy';

export function readLog(kind) {
	if (!(kind in ['homeproxy', 'sing-box-c', 'sing-box-s'])) return { error: 'Illegal log type' };
	const path = RUN_DIR + '/' + kind + '.log';
	const info = lstat(path);
	if (!info) return { missing: true };
	const file = info.type === 'file' ? open(path, 'r') : null;
	if (!file) return { error: 'Unable to read the log' };
	const limit = 262144;
	let text = null;
	if (file.seek(0, 2)) {
		const start = max(0, file.tell() - limit);
		if (file.seek(start ? start - 1 : 0)) {
			text = file.read(limit + (start ? 1 : 0));
			if (start && text !== null) {
				const newline = index(text, '\n');
				text = newline < 0 ? '' : substr(text, newline + 1);
			}
		}
	}
	file.close();
	return text === null ? { error: 'Unable to read the log' } : { text };
};

function quote(s) { return "'" + replace(s, "'", "'\\''") + "'"; }

export function execute(args, timeout) {
	const out = mkstemp(), err = mkstemp();
	// dash only accepts single-digit descriptor duplication; rpcd may hold more.
	const code = system(join(' ', map(args, quote)) + ' >/proc/self/fd/' + out.fileno() + ' 2>/proc/self/fd/' + err.fileno(), timeout || 6500);
	out.seek(0); err.seek(0);
	const result = { code, stdout: out.read(16384) || '', stderr: err.read(4096) || '' };
	out.close(); err.close();
	return result;
};

function parseController(addr) {
	const m = match(addr || '', /^(\[([^\]]+)\]|([^:]*)):([0-9]+)$/);
	if (!m) return null;
	return { listen: m[2] || m[3] || '127.0.0.1', port: int(m[4]) };
}

function instanceConfig(instance) {
	const filename = RUN_DIR + '/sing-box-' + (instance === 'client' ? 'c' : 's') + '.json';
	try { return json(readfile(filename)); } catch (e) { return null; }
}

function nativeService(config) {
	return filter(config?.services || [], s => s.type === 'api' && s.tag === 'homeproxy-grpc')[0];
}

function nativeURL(grpc) {
	const host = index(grpc.listen, ':') >= 0 ? '[' + grpc.listen + ']' : grpc.listen;
	return (grpc.tls?.enabled ? 'https://' : 'http://') + host + ':' + grpc.listen_port;
}

export function runtime(instance) {
	if (!(instance in ['client', 'server'])) return { error: 'Invalid instance' };
	const compat = json(readfile('/usr/share/homeproxy/compat.json'));
	const version = execute(['/usr/bin/sing-box', 'version'], 3000);
	const actual = match(version.stdout, /^sing-box version ([^\n]+)/)?.[1];
	const prefix = join('.', slice(split(compat.core_version, '.'), 0, 2)) + '.';
	const compatible = !!match(actual || '', /^[0-9]+\.[0-9]+\.[0-9]+(\+[^\n]+)?$/) && index(actual, prefix) === 0;
	const config = instanceConfig(instance);
	const clash = config?.experimental?.clash_api;
	const ctrl = clash ? parseController(clash.external_controller) : null;
	const grpc = nativeService(config);
	const uci = cursor(), names = {};
	for (let kind in ['node', 'routing_node', 'ruleset', 'dns_server', 'routing_rule', 'dns_rule', 'server'])
		uci.foreach('homeproxy', kind, (s) => { names[s['.name']] = s.label || s['.name']; });
	names['main-out'] = names[uci.get('homeproxy', 'config', 'main_node')];
	names['main-udp-out'] = names[uci.get('homeproxy', 'config', 'main_udp_node')];
	const service = connect().call('service', 'list', { name: 'homeproxy' });
	return {
		expected: compat.core_version,
		version: actual || 'unavailable',
		compatible,
		build: version.stdout,
		running: service?.homeproxy?.instances?.[instance === 'client' ? 'sing-box-c' : 'sing-box-s']?.running || false,
		log_level: config?.log?.level || uci.get('homeproxy', instance === 'client' ? 'config' : 'server', 'log_level') || 'warn',
		api: clash && ctrl ? { enabled: true, listen: ctrl.listen, port: ctrl.port, controller: clash.external_controller } : { enabled: false },
		grpc_url: grpc ? nativeURL(grpc) : null,
		grpc_dashboard: grpc?.dashboard?.enabled === true,
		names
	};
};

function clashEndpoint(instance) {
	if (!(instance in ['client', 'server']))
		return { error: 'Invalid instance' };
	const config = instanceConfig(instance);
	if (!config)
		return { error: 'No running configuration' };
	const clash = config?.experimental?.clash_api;
	if (!clash || !clash.external_controller)
		return { error: 'Clash API is disabled' };
	const ctrl = parseController(clash.external_controller);
	if (!ctrl)
		return { error: 'Invalid Clash API controller address' };
	let host = ctrl.listen;
	if (host === '0.0.0.0' || host === '::' || host === '')
		host = '127.0.0.1';
	if (index(host, ':') >= 0)
		host = '[' + host + ']';
	return { baseUrl: 'http://' + host + ':' + ctrl.port, secret: clash.secret || '' };
}

function clashRequest(endpoint, method, path, body) {
	const dir = mkdtemp('/tmp/hp-api.XXXXXX');
	if (!dir)
		return { error: 'Unable to allocate API request directory' };
	chmod(dir, 0700);
	const cfgPath = dir + '/curl.cfg';
	const bodyPath = dir + '/body.json';
	let cfg = 'silent\nshow-error\nnoproxy = "*"\nconnect-timeout = 2\nmax-time = 8\nmax-filesize = 4194304\n' +
		'request = "' + method + '"\n' +
		'url = "' + endpoint.baseUrl + path + '"\n' +
		'write-out = "\\n%{http_code}"\n';
	if (endpoint.secret)
		cfg += 'header = "Authorization: Bearer ' + replace(endpoint.secret, /["\\\r\n]/g, '') + '"\n';
	if (body != null) {
		writefile(bodyPath, body);
		chmod(bodyPath, 0600);
		cfg += 'header = "Content-Type: application/json"\n';
		cfg += 'data-binary = "@' + bodyPath + '"\n';
	}
	writefile(cfgPath, cfg);
	chmod(cfgPath, 0600);
	const out = mkstemp(), err = mkstemp();
	const code = system('/usr/bin/curl -K ' + quote(cfgPath) +
		' >/proc/self/fd/' + out.fileno() + ' 2>/proc/self/fd/' + err.fileno(), 9000);
	unlink(cfgPath);
	unlink(bodyPath);
	rmdir(dir);
	out.seek(0); err.seek(0);
	let raw = '';
	for (let chunk = out.read(65536); length(chunk); chunk = out.read(65536)) {
		raw += chunk;
		if (length(raw) > 4 * 1024 * 1024) break;
	}
	const stderr = err.read(4096) || '';
	out.close(); err.close();
	if (code !== 0)
		return { error: trim(stderr) || ('curl failed with exit code ' + code) };
	const m = match(raw, /\n([0-9]{3})$/);
	const httpCode = m ? int(m[1]) : 0;
	const payload = m ? substr(raw, 0, length(raw) - length(m[0])) : raw;
	let parsed = null;
	if (length(trim(payload))) {
		try { parsed = json(payload); } catch (e) {}
	}
	if (httpCode < 200 || httpCode >= 300)
		return { error: parsed?.message || ('HTTP ' + httpCode), status: httpCode };
	if (httpCode !== 204 && type(parsed) !== 'object')
		return { error: 'Invalid Clash API response' };
	return { ok: true, data: parsed };
}

export function apiRead(instance, resource) {
	const endpoint = clashEndpoint(instance || 'client');
	if (endpoint.error) return endpoint;
	const kind = resource || 'snapshot';
	if (kind === 'snapshot') {
		const conns = clashRequest(endpoint, 'GET', '/connections');
		if (!conns.ok) return { error: conns.error };
		const proxies = clashRequest(endpoint, 'GET', '/proxies');
		if (!proxies.ok) return { error: proxies.error };
		return { connections: conns.data, proxies: proxies.data };
	}
	if (kind in ['connections', 'proxies', 'version']) {
		const res = clashRequest(endpoint, 'GET', '/' + kind);
		return res.ok ? { [kind]: res.data } : { error: res.error };
	}
	return { error: 'Unknown API resource' };
};

export function apiControl(instance, action, target, value) {
	const endpoint = clashEndpoint(instance || 'client');
	if (endpoint.error) return endpoint;
	switch (action) {
	case 'select':
		if (!target || !value) return { error: 'Group and outbound name required' };
		const sel = clashRequest(endpoint, 'PUT', '/proxies/' + urlencode(target), sprintf('%J', { name: value }));
		return sel.ok ? { result: true } : { error: sel.error };
	case 'delay': {
		if (!target) return { error: 'Proxy or group name required' };
		const query = urlencode(target) + '/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000';
		const delay = clashRequest(endpoint, 'GET', (value === 'group' ? '/group/' : '/proxies/') + query);
		return delay.ok ? { result: true, data: delay.data } : { error: delay.error };
	}
	case 'close':
		if (!target) return { error: 'Connection ID required' };
		const closed = clashRequest(endpoint, 'DELETE', '/connections/' + urlencode(target));
		return closed.ok ? { result: true } : { error: closed.error };
	case 'close_all':
		const cleared = clashRequest(endpoint, 'DELETE', '/connections');
		return cleared.ok ? { result: true } : { error: cleared.error };
	default:
		return { error: 'Unknown API action' };
	}
};

export function apiSecret() {
	return { secret: trim(readfile('/etc/homeproxy/api.secret') || '') };
};

export function dashboardLaunch(instance) {
	if (!(instance in ['client', 'server'])) return { error: 'Invalid instance' };
	const grpc = nativeService(instanceConfig(instance));
	const dir = '/etc/homeproxy/dashboard/' + instance;
	if (!grpc?.dashboard?.enabled || grpc.dashboard.path !== dir || !match(grpc.secret || '', /^[a-f0-9]{64}$/))
		return { error: 'Enable the local sing-box Dashboard and apply settings first.' };
	if (!access(dir + '/index.html'))
		return { error: 'Dashboard files are not ready. Check the core log for download errors.' };

	const html = readfile('/usr/share/homeproxy/dashboard-connect.html');
	const stage = html ? mkdtemp(dir + '/.launch.XXXXXX') : null;
	if (!stage) return { error: 'Unable to prepare the Dashboard launcher.' };
	const file = stage + '/connect.html';
	const installed = writefile(file, html) === length(html) && chmod(file, 0644) && rename(file, dir + '/homeproxy-connect.html');
	unlink(file);
	rmdir(stage);
	if (!installed) return { error: 'Unable to install the Dashboard launcher.' };
	return { url: nativeURL(grpc) + '/dashboard/homeproxy-connect.html', secret: grpc.secret };
};
