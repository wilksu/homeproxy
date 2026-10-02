/* SPDX-License-Identifier: GPL-2.0-only */
import { access, chmod, chown, lstat, mkdir, mkdtemp, readfile, rename, rmdir, unlink, writefile } from 'fs';
import { execute } from 'homeproxy_runtime';

// ECHConfigList uses TLS length-prefixed vectors, not ASN.1. sing-box check
// defers parsing these bytes until a handshake, so it cannot validate uploads.
// Wire format: RFC 9849 section 4; supported algorithms: paired Go 1.25 core.
function reader(data) {
 let offset = 0;
 return {
  take: (size) => {
   if (offset + size > length(data)) die('Truncated ECH config');
   const value = substr(data, offset, size); offset += size; return value;
  },
  number: function(size) { let value = 0; for (let i = 0; i < size; i++) value = value * 256 + ord(this.take(1)); return value; },
  vector: function(size) { return this.take(this.number(size)); },
  empty: () => offset === length(data)
 };
}
function validECH(content) {
 const pem = match(trim(content), /^-----BEGIN ECH CONFIGS-----\n([A-Za-z0-9+\/=\n]+)\n-----END ECH CONFIGS-----$/);
 if (!pem) return false;
 const encoded = replace(pem[1], /\n/g, ''), decoded = b64dec(encoded);
 if (!decoded || b64enc(decoded) !== encoded) return false;
 const input = reader(decoded), configs = reader(input.vector(2));
 if (!input.empty()) return false;
 let usable = false;
 while (!configs.empty()) {
  const version = configs.number(2), config = reader(configs.vector(2));
  if (version !== 0xfe0d) continue;
  config.number(1); // config_id
  const kem = config.number(2), key = config.vector(2), suites = reader(config.vector(2));
  let supported = false;
  while (!suites.empty()) {
   const kdf = suites.number(2), aead = suites.number(2);
   if (kdf === 1 && aead in [1, 2, 3]) supported = true;
  }
  config.number(1); // maximum_name_length
  const name = config.vector(1), extensions = reader(config.vector(2));
  let mandatory = false;
  while (!extensions.empty()) {
   if (extensions.number(2) & 0x8000) mandatory = true;
   extensions.vector(2);
  }
  if (!config.empty()) return false;
  const labels = split(name, '.');
  const hostname = length(name) > 0 && length(name) <= 253 &&
   !length(filter(labels, label => !match(label, /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/)));
  if (kem === 0x20 && length(key) === 32 && supported && hostname && !mandatory) usable = true;
 }
 return usable;
}

// Options are for isolated tests; the RPC only passes the whitelisted name.
export function installCertificate(name, options) {
 const kinds = { client_ca: 'certificate', server_publickey: 'certificate', server_privatekey: 'key', client_ech_conf: 'ech' };
 const kind = kinds[name];
 if (!kind) return { result: false, error: 'Illegal certificate filename' };
 const upload = options?.upload || '/tmp/homeproxy_certificate.tmp';
 const directory = options?.directory || '/etc/homeproxy/certs';
 let work, candidate, result;
 try {
  const stat = lstat(upload);
  if (stat?.type !== 'file' || stat.size <= 0 || stat.size > 1048576) die('Upload must be a non-empty PEM file smaller than 1 MiB');
  const raw = readfile(upload); unlink(upload);
  if (raw === null) die('Unable to read uploaded file');
  const content = trim(replace(raw, /\r\n?/g, '\n')) + '\n';
  if (!lstat(directory) && !mkdir(directory)) die('Unable to create certificate directory');
  work = mkdtemp(directory + '/.upload.XXXXXX');
  if (!work) die('Unable to stage uploaded file');
  candidate = work + '/certificate.pem';
  if (writefile(candidate, content) !== length(content) || !chmod(candidate, 0600)) die('Unable to stage uploaded file');
  if (kind === 'ech') {
   if (!validECH(content)) die('Invalid or unsupported ECH config');
  } else {
   if (!access('/usr/bin/openssl')) die('OpenSSL is unavailable; install openssl-util');
   const args = kind === 'key' ? ['pkey', '-inform', 'PEM', '-in', candidate, '-passin', 'pass:', '-check', '-noout'] :
    ['crl2pkcs7', '-nocrl', '-certfile', candidate, '-out', '/dev/null'];
   if (!match(content, kind === 'key' ? /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ : /-----BEGIN CERTIFICATE-----/) ||
       execute(['/usr/bin/openssl', ...args], 5000).code !== 0) die('Invalid ' + kind + ' PEM file');
  }
  if (!chown(candidate, options?.owner ?? 'sing-box', options?.group ?? 'sing-box') ||
      !rename(candidate, directory + '/' + name + '.pem')) die('Unable to install uploaded file');
  result = { result: true };
 } catch (e) { result = { result: false, error: '' + e }; }
 if (candidate) unlink(candidate);
 if (work) rmdir(work);
 return result;
};
