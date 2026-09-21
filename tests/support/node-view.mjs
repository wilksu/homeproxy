/**
 * Evaluate the module-level helpers of view/homeproxy/node.js in isolation.
 *
 * The helpers are plain functions in the view source, so they can be lifted
 * out and exercised with the same dependency names the view passes them.
 */
import fs from 'node:fs';

const source = fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/node.js', 'utf8');
const start = source.indexOf('function nodeReferences');
const end = source.indexOf('\nfunction allowInsecureConfirm', start);

if (start < 0 || end < 0)
	throw new Error('the node view helper block moved; update tests/support/node-view.mjs');

const body = source.slice(start, end);

export function loadNodeHelpers(deps = {}) {
	const names = ['uci', 'ui', 'E', '_', 'requestAnimationFrame'];
	const values = [
		{ sections: () => [] },
		{ addNotification: () => {} },
		(tag, attrs, children) => ({ tag, attrs, children, closest: () => null, querySelectorAll: () => [] }),
		value => value,
		callback => callback()
	];

	names.forEach((name, index) => {
		if (deps[name])
			values[index] = deps[name];
	});

	const load = new Function(...names, `${body}\nreturn { nodeReferences, subscriptionMatchesNode, isSubscriptionNode, subscriptionNodeIDs, validateSubscriptionURLs, applySubscriptionURLChange, rollbackSubscriptionWrite, queueSubscriptionURLChange, configureSubscriptionURLWrites, saveNodeMap, removeNode, indexMapFieldsDuringDependencyCheck };`);
	return load(...values);
}

export { source as nodeViewSource };
