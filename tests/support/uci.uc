import { readfile, writefile } from 'fs';
export function cursor() {
 const sections = json(readfile(getenv('HP_TEST_UCI')));
 return {
  load: () => true,
  get: (config, name, key) => key ? sections[name]?.[key] : sections[name]?.['.type'],
  get_all: (config, name) => sections[name] ? { ...sections[name], '.name': name } : null,
  foreach: (config, kind, fn) => { for (let name in keys(sections)) if (sections[name]['.type'] === kind) fn({ ...sections[name], '.name': name }); },
  set: (config, name, key, value) => { if (!sections[name]) sections[name] = {}; if (value == null) sections[name]['.type'] = key; else sections[name][key] = value; },
  delete: (config, name, key) => { if (key) delete sections[name][key]; else delete sections[name]; },
  rename: (config, name, old, key) => { sections[name][key] = sections[name][old]; delete sections[name][old]; },
  changes: () => ({ homeproxy: true }),
  commit: () => { if (getenv('HP_TEST_UCI_SAVE')) writefile(getenv('HP_TEST_UCI_SAVE'), sprintf('%J', sections)); return true; }
 };
}
