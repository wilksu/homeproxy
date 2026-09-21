/**
 * Boot view/homeproxy/client.js far enough to inspect the form it builds.
 *
 * render() only assembles a form.Map, so a recording Map reveals which
 * choices each selector ends up with and lets the real option callbacks run -
 * the parts of the client page that decide whether a stored value is still
 * representable in the UI.
 */
import fs from 'node:fs';

import { createElement } from './luci-form.mjs';

/* LuCI installs these on String.prototype from luci.js. */
if (!String.prototype.format) {
	Object.defineProperty(String.prototype, 'format', {
		writable: true,
		configurable: true,
		value(...args) {
			let index = 0;
			return String(this).replace(/%([a-z%])/gi, (match, token) => {
				if (token === '%')
					return '%';
				if (token === 's')
					return String(args[index++]);
				return match;
			});
		}
	});
	if (!String.format) {
		String.format = (template, ...args) => String.prototype.format.apply(template, args);
	}
}

/** Stand-in for any form element: records children and option values. */
export class Recorder {
	static instances = [];

	constructor(name) {
		this.name = name;
		this.keylist = [];
		this.vallist = [];
		this.children = [];
		this.tabs = {};
		this.tab_names = [];
		this.parent = null;
		Recorder.instances.push(this);
	}

	static extend(definition) {
		return class extends Recorder {
			constructor(...args) {
				super(...args);
				Object.assign(this, definition);
			}
		};
	}

	static get __name__() { return 'CBI.Recorder'; }

	value(key, label) {
		/* LuCI appends through concat so a deleted keylist revives itself. */
		this.keylist = (this.keylist || []).concat(key);
		this.vallist = (this.vallist || []).concat(label == null ? key : label);
	}

	section(...args) {
		return this.child(`section:${typeof args[0] === 'string' ? args[0] : (args[1] ?? 'anonymous')}`);
	}

	taboption(tab, widget, option, title) {
		return this.option(widget, option, title);
	}

	option(widget, option, title) {
		const created = this.child(typeof option === 'string' ? option : `field:${title}`);

		/* Section flavoured options expose the subsection the view configures. */
		created.subsection = created.child(`subsection:${option ?? title}`);
		return created;
	}

	child(name) {
		const created = new Recorder(`${this.name}#${name}`);
		created.parent = this;
		this.children.push(created);
		return created;
	}

	tab(name, title) {
		if (this.tab_names.includes(name))
			throw new Error(`Tab already declared: ${name}`);
		this.tab_names.push(name);
		this.tabs[name] = title;
	}

	/** LuCI classes expose super() to option callbacks. */
	super(method, ...args) {
		if (method === 'load')
			return this.loaded_value ?? null;
		if (method === 'renderWidget')
			return createElement('div', { class: 'cbi-value-field' });
		return undefined;
	}

	render() { return Promise.resolve(createElement('div', { class: 'cbi-section' })); }
	renderUCISection() { return Promise.resolve(createElement('div')); }
	checkDepends() {}

	/** Every element the view assigns callbacks or flags onto. */
	depends() {}
	addremove() {}

	find(needle) {
		for (const child of this.children) {
			if (child.name === needle || child.name.endsWith(`#${needle}`))
				return child;
			const found = child.find(needle);
			if (found)
				return found;
		}
		return null;
	}

}

/** A uci stand-in backed by a list of sections, as views see them. */
export function uciFixture(sections) {
	const byID = new Map(sections.map(section => [section['.name'], section]));

	return {
		get(config, section_id, option) {
			const section = byID.get(section_id);

			if (option == null)
				return section ?? null;

			return section && Object.prototype.hasOwnProperty.call(section, option) ? section[option] : null;
		},
		sections(config, type, callback) {
			const matching = sections.filter(section => !type || section['.type'] === type);

			if (typeof callback === 'function')
				matching.forEach(section => callback(section));

			return matching;
		},
		get_first(config, type, option) {
			const section = sections.find(entry => entry['.type'] === type);
			return section ? (option == null ? section['.name'] : section[option]) : null;
		},
		set() {},
		unset() {},
		add() { return 'new000000'; },
		remove() {},
		load: () => Promise.resolve([]),
		unload() {},
		save: () => Promise.resolve(),
		commit: () => Promise.resolve(),
		state: { values: {}, changes: {}, creates: {}, deletes: {} }
	};
}

export function loadClientView({ hp, uci, features, hosts = {} } = {}) {
	const source = fs.readFileSync('htdocs/luci-static/resources/view/homeproxy/client.js', 'utf8');
	const classes = {
		Map: Recorder,
		NamedSection: Recorder,
		TypedSection: Recorder,
		GridSection: Recorder,
		TableSection: Recorder,
		JSONSection: Recorder,
		AbstractSection: Recorder,
		Value: Recorder,
		ListValue: Recorder,
		DynamicList: Recorder,
		MultiValue: Recorder,
		Flag: Recorder,
		TextValue: Recorder,
		DummyValue: Recorder,
		Button: Recorder,
		SectionValue: Recorder,
		NetworkValue: Recorder,
		JSONValue: Recorder
	};
	const scope = {
		baseclass: { extend: definition => definition },
		form: new Proxy(classes, { get: (target, key) => target[key] ?? Recorder }),
		fs: { read: () => Promise.resolve(''), list: () => Promise.resolve([]), lines: () => Promise.resolve('') },
		network: { getHostHints: () => Promise.resolve({ hosts }), list: () => Promise.resolve([]), getCMask: () => 24 },
		poll: { add: () => {} },
		rpc: { declare: () => () => Promise.resolve({}) },
		uci,
		ui: {
			addNotification: () => {},
			changes: { apply: () => {} },
			showModal: () => {},
			hideModal: () => {},
			createHandlerFn: (self, name, ...pre) => (...args) => self[name]?.(...pre, ...args),
			inputConfirm: () => true
		},
		validation: { types: new Proxy({}, { get: () => () => true }) },
		view: { extend: definition => definition },
		fwtool: {
			addIPOption: (section, name, title) => section.option(null, name ?? title),
			addMACOption: (section, name, title) => section.option(null, name ?? title),
			hintExpirePolicy: () => {},
			renderSystemRulesHelp: () => createElement('div')
		},
		widgets: new Proxy({}, { get: () => Recorder }),
		hp,
		L: {
			toArray: value => value == null ? [] : (Array.isArray(value) ? value : [value]),
			bind: (fn, self, ...pre) => (...args) => fn.apply(self, [...pre, ...args]),
			error: (...args) => { throw new Error(args.join(' ')); },
			naturalCompare: new Intl.Collator(undefined, { numeric: true }).compare
		},
		E: (...args) => createElement(...args),
		_: value => value,
		feature: () => false,
		document: null,
		window: { addEventListener: () => {} },
		confirm: () => true
	};
	const names = Object.keys(scope);
	const definition = new Function(...names, source)(...names.map(name => scope[name]));

	return { definition, features };
}

/** Build the client page form and return its recording root map element. */
export async function renderClientForm({ definition, features }, config, hosts = {}) {
	Recorder.instances.length = 0;
	await definition.render([config, features, { hosts }]);

	const map = Recorder.instances.find(instance => instance.name === 'homeproxy');

	if (!map)
		throw new Error('the client view did not build a map named homeproxy');

	return map;
}
