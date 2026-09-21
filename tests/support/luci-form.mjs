/**
 * Faithful-enough stand-ins for the LuCI pieces the homeproxy views touch.
 *
 * The shapes below mirror the shipped LuCI resources in the development
 * container, because the widgets under test depend on them:
 *
 * - CBIListValue.renderWidget() builds `new ui.Select(...)` and returns
 *   `widget.render()`, which is a `<div>` frame wrapping a `<select>`;
 * - ui.Select marks options `selected` from the current value and
 *   `getValue()` reads `frame.firstChild.value`, i.e. the browser falls back
 *   to the first option when no option matches the value;
 * - CBIAbstractValue.parse() writes the form value back whenever it differs
 *   from the cached configuration value, which is how a value missing from a
 *   select silently overwrites retained configuration.
 */
import fs from 'node:fs';

class Klass {
	static extend(definition) {
		const child = function(...args) {
			if (typeof child.__init__ === 'function')
				child.__init__.apply(this, args);
		};
		Object.setPrototypeOf(child, Klass);
		child.prototype = Object.create(Klass.prototype);
		Object.assign(child.prototype, definition);
		child.extend = Klass.extend;
		return child;
	}

	super(name, ...args) {
		let proto = Object.getPrototypeOf(this);
		while (proto) {
			if (Object.prototype.hasOwnProperty.call(proto, name) && typeof proto[name] === 'function')
				return proto[name].apply(this, args);
			proto = Object.getPrototypeOf(proto);
		}
		throw new Error(`no such method: ${name}`);
	}
}

/** A tiny DOM with the browser semantics the widgets rely on. */
export function createElement(tag, attrs, children) {
	const node = {
		tag,
		children: [],
		attributes: {},
		dataset: {},
		style: {},
		listeners: {},
		parentNode: null,
		isConnected: false,
		matches: selector => tag === selector,
		querySelector: selector => node.all().find(child => child.matches(selector)) ?? null,
		querySelectorAll: selector => node.all().filter(child => child.matches(selector)),
		addEventListener(name, callback) { (node.listeners[name] ??= []).push(callback); },
		all() {
			const walk = current => current.children.flatMap(child => [child, ...walk(child)]);
			return walk(node);
		},
		appendChild(child) {
			for (const item of Array.isArray(child) ? child : (child ? [child] : [])) {
				if (typeof item === 'string' || typeof item === 'number') {
					node.children.push({ tag: '#text', text: String(item), children: [], attributes: {}, dataset: {}, matches: () => false, all: () => [] });
					continue;
				}
				if (item.isDocumentFragment) {
					node.appendChild(item.children);
					continue;
				}
				item.parentNode = node;
				node.children.push(item);
			}
			return child;
		},
		insertBefore(child, reference) {
			if (reference == null)
				return node.appendChild(child);
			const index = node.children.indexOf(reference);
			if (index < 0)
				throw new Error('reference is not a child');
			child.parentNode = node;
			node.children.splice(index, 0, child);
			return child;
		},
		remove() {
			const siblings = node.parentNode?.children;
			if (siblings)
				siblings.splice(siblings.indexOf(node), 1);
		},
		click() { return (node.listeners.click ?? []).forEach(callback => callback({ currentTarget: node })); }
	};

	Object.defineProperties(node, {
		options: { get: () => node.children.filter(child => child.tag === 'option') },
		firstChild: { get: () => node.children[0] ?? null },
		lastChild: { get: () => node.children[node.children.length - 1] ?? null },
		/* A <select> reports its selected option, falling back to the first one
		 * when nothing matches - exactly what a browser does. */
		value: {
			get: () => tag === 'select' ? (node.options.find(isSelected) ?? node.options[0])?.attributes.value ?? ''
				: node.attributes.value ?? '',
			set: value => { node.attributes.value = value; }
		}
	});

	function isSelected(option) {
		return option.attributes.selected != null;
	}

	for (const [name, value] of Object.entries(attrs || {})) {
		if (value == null)
			continue;
		node.attributes[name] = value;
	}

	node.appendChild(children);
	return node;
}

/** The document members the widgets use: option fragments built off-DOM. */
export function createDocument() {
	return {
		createDocumentFragment: () => ({ isDocumentFragment: true, children: [], appendChild(child) { this.children.push(child); } })
	};
}

/** LuCI's CBIAbstractValue.parse() decision for the single value case. */
export function parseValue(option, section_id) {
	const cval = option.cfgvalue(section_id);
	const fval = option.formvalue(section_id);

	if (fval == null || fval === '' ||
	    (fval === option.default && (option.optional || option.rmempty))) {
		if (option.rmempty || option.optional)
			return { writes: [], removed: [option.option] };
		throw new TypeError(`Option "${option.option}" must not be empty.`);
	}

	if (option.forcewrite || JSON.stringify(cval) !== JSON.stringify(fval))
		return { writes: [[option.option, fval]], removed: [] };

	return { writes: [], removed: [] };
}

/**
 * Load htdocs/luci-static/resources/homeproxy.js with the form classes above,
 * mirroring how LuCI wires ListValue: renderWidget returns the ui.Select frame.
 */
export function loadHomeproxy({ document = null, uci = { sections: () => [], get: () => null } } = {}) {
	const source = fs.readFileSync('htdocs/luci-static/resources/homeproxy.js', 'utf8');
	const form = {
		DynamicList: Klass.extend({ __name__: 'CBI.DynamicList' }),
		ListValue: Klass.extend({
			__name__: 'CBI.ListValue',

			renderWidget(section_id, option_index, cfgvalue) {
				const select = createElement('select', { class: 'cbi-input-select' });

				for (const key of this.keylist) {
					if (key == null || key === '')
						continue;
					select.appendChild(createElement('option', {
						value: key,
						selected: L.toArray(cfgvalue).indexOf(key) > -1 ? '' : null
					}, [this.vallist[this.keylist.indexOf(key)]]));
				}

				return createElement('div', { class: 'cbi-dropdown' }, [select]);
			}
		}),
		NamedSection: Klass.extend({ __name__: 'CBI.NamedSection' })
	};
	const E = (...args) => createElement(...args);
	const L = {
		toArray: value => value == null ? [] : (Array.isArray(value) ? value : [value]),
		bind: (fn, self, ...pre) => (...args) => fn.apply(self, [...pre, ...args])
	};
	const module = new Function('baseclass', 'form', 'fs', 'rpc', 'uci', 'ui', 'L', 'E', 'document', '_',
		source)(
		{ extend: definition => Klass.extend(definition) }, form, {}, {}, uci, {}, L, E, document, value => value);

	return { module, hp: new module(), form, E, L, uci, document };
}

export { Klass };
