/* SPDX-License-Identifier: GPL-2.0-only */
/* Resolve library nodes and validate their group and detour dependencies. */
export function nodeModel(uci) {
	const config = 'homeproxy';
	// One model belongs to one immutable generation snapshot, never a UCI write.
	const resolved = {}, validated = {}, visiting = {};
	function resolve(id) {
		if (resolved[id]) return { ...resolved[id] };
		const record = uci.get_all(config, id);
		if (!record || record['.type'] !== 'node')
			die('Referenced node is missing: ' + id);
		if (record.type === 'tailscale' && record.grouphash)
			die('Subscribed Tailscale endpoint is not permitted; configure it locally: ' + id);
		resolved[id] = { ...record };
		return { ...resolved[id] };
	}
	function validate(id, path) {
		path = path || [];
		if (visiting[id])
			die('Circular node dependency: ' + join(' -> ', [...path, id]));
		if (validated[id])
			return { ...validated[id] };
		visiting[id] = true;
		let node;
		try {
			node = resolve(id);
			if (node.type in ['selector', 'urltest']) {
				if (!length(node.group_nodes || []))
					die('Group has no members: ' + id);
				if (node.group_default && !(node.group_default in node.group_nodes))
					die('Default is not a group member: ' + id);
			}
			for (let dep in [...(node.group_nodes || []), ...(node.node_detour ? [node.node_detour] : [])])
				validate(dep, [...path, id]);
		} catch (e) {
			delete visiting[id];
			die(e);
		}
		delete visiting[id];
		validated[id] = node;
		return { ...node };
	}
	return { resolve, validate };
};
