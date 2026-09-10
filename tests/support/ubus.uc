export function connect() { return { call: (object, method, args) => ({ 'dns-server': ['192.0.2.53'], 'ipv4-address': [{ address: '127.0.0.1' }] }) }; }
