#!/usr/bin/ucode
/* SPDX-License-Identifier: GPL-2.0-only */
import { readfile, popen } from 'fs';
import { shellQuote } from 'homeproxy';

const compat = json(readfile('/usr/share/homeproxy/compat.json'));
const core = '/usr/bin/sing-box';
const pipe = popen(core + ' version');
const version = pipe ? pipe.read('all') : '';
if (pipe) pipe.close();
const actual = match(version, /^sing-box version ([0-9]+\.[0-9]+\.[0-9]+)(\+[^\n]+)?(\n|$)/)?.[1];
const prefix = join('.', slice(split(compat.core_version, '.'), 0, 2)) + '.';
if (!actual || index(actual, prefix) !== 0)
	die('HomeProxy requires sing-box ' + prefix + 'x; installed: ' + split(version, '\n')[0]);

function parseController(addr) {
	const m = match(addr || '', /^(\[([^\]]+)\]|([^:]*)):([0-9]+)$/);
	if (!m) return null;
	return { type: 'api', tag: 'clash-api', listen: m[2] || m[3] || '::', listen_port: int(m[4]) };
}

const hasTags = match(version, /(^|\n)Tags: /);
const listeners = [];
for (let filename in ARGV) {
	const config = json(readfile(filename));
	const controller = parseController(config.experimental?.clash_api?.external_controller);
	if (config.experimental?.clash_api && hasTags && index(version, 'with_clash_api') < 0)
		die('clash-api: core build lacks with_clash_api');
	for (let listener in [...(config.inbounds || []), ...(config.services || []), ...(controller ? [controller] : [])]) {
		if (!listener.listen_port || listener.network === 'udp') continue;
		for (let other in listeners) {
			if (listener.type !== 'api' && other.type !== 'api') continue;
			if (listener.listen_port === other.listen_port &&
				(listener.listen === other.listen || listener.listen in ['::', '0.0.0.0'] || other.listen in ['::', '0.0.0.0']))
				die('API listener conflicts with ' + other.tag + ' on port ' + listener.listen_port);
		}
		push(listeners, listener);
	}
	for (let node in [...(config.inbounds || []), ...(config.outbounds || []), ...(config.endpoints || [])]) {
		const tags = [];
		if (node.type in ['hysteria', 'hysteria2', 'tuic']) push(tags, 'with_quic');
		if (node.type === 'wireguard') push(tags, 'with_wireguard');
		if (node.type === 'tailscale') push(tags, 'with_tailscale');
		if (node.tls?.utls?.enabled) push(tags, 'with_utls');
		for (let tag in tags)
			if (index(version, tag) < 0) die(node.tag + ': core build lacks ' + tag);
	}
	if (system(core + ' check --config ' + shellQuote(filename)) !== 0)
		exit(1);
}
