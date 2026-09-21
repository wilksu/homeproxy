import test from 'node:test';
import assert from 'node:assert/strict';

import { loadNodeHelpers } from './support/node-view.mjs';

test('dependency checks index fields once per pass and refresh after edits', () => {
	const { indexMapFieldsDuringDependencyCheck } = loadNodeHelpers();
	const first = { dataset: { field: 'cbid.homeproxy.node.type' } };
	const duplicate = { dataset: { field: first.dataset.field } };
	const second = { dataset: { field: first.dataset.field } };
	let fields = [first, duplicate];
	let scans = 0;
	let fallbackCalls = 0;
	let nested = false;
	const map = {
		root: { querySelectorAll(selector) {
			assert.equal(selector, '[data-field]');
			scans++;
			return fields;
		} },
		findElement(name, value) {
			fallbackCalls++;
			return `${name}:${value}`;
		},
		checkDepends() {
			const found = this.findElement('data-field', first.dataset.field);
			assert.equal(this.findElement('data-field', 'missing'), null);
			assert.equal(this.findElement('id', 'other'), 'id:other');
			if (!nested) {
				nested = true;
				assert.equal(this.checkDepends(), found);
			}
			return found;
		}
	};

	indexMapFieldsDuringDependencyCheck(map);
	assert.equal(map.checkDepends(), first, 'the first duplicate matches LuCI querySelectorAll');
	assert.equal(scans, 1, 'recursive dependency checks reuse the index');
	fields = [second];
	assert.equal(map.checkDepends(), second, 'a later pass uses current DOM fields');
	assert.equal(scans, 2);
	assert.equal(fallbackCalls, 3, 'non-field lookups retain LuCI behavior');
	assert.equal(map.findElement('data-field', first.dataset.field), 'data-field:cbid.homeproxy.node.type',
		'lookups outside dependency checks retain LuCI behavior');
});
