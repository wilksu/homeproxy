#!/usr/bin/env python3
"""Fetch verified, precompiled development assets. Never builds software."""
import hashlib, json, pathlib, secrets, shutil, tarfile, urllib.request, zipfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
ASSETS = ROOT / '.dev/assets'
ASSETS.mkdir(parents=True, exist_ok=True)
compat = json.loads((ROOT / 'root/usr/share/homeproxy/compat.json').read_text())

def fetch(url, digest, destination):
 def valid():
  return destination.exists() and hashlib.file_digest(destination.open('rb'), 'sha256').hexdigest() == digest
 if not valid():
  partial = destination.with_suffix('.partial')
  print('Downloading', destination.name, flush=True)
  with urllib.request.urlopen(url, timeout=60) as source, partial.open('wb') as output:
   shutil.copyfileobj(source, output)
  partial.replace(destination)
 if not valid():
  raise SystemExit('Checksum mismatch: ' + str(destination))

version = compat['core_version']
if version != '1.14.0':
 raise SystemExit('Update the pinned musl release checksum before changing the development core version.')
fetch(f'https://github.com/SagerNet/sing-box/releases/download/v{version}/sing-box-{version}-linux-amd64-musl.tar.gz',
      'd2d6b4543d850269214ced70ffe41b13b1595baa1b6f9c016466abfba162c4d4', ASSETS / 'sing-box.tar.gz')
(ASSETS / 'core').mkdir(exist_ok=True)
with tarfile.open(ASSETS / 'sing-box.tar.gz') as archive:
 for member in archive.getmembers():
  name = pathlib.PurePosixPath(member.name).name
  if member.isfile() and name in ('sing-box', 'LICENSE'):
   with archive.extractfile(member) as source, (ASSETS / 'core' / name).open('wb') as output:
    shutil.copyfileobj(source, output)
(ASSETS / 'core/sing-box').chmod(0o755)
password = ROOT / '.dev/root-password'
if not password.exists():
 with password.open('x') as output:
  password.chmod(0o600)
  output.write(secrets.token_urlsafe(24))
print('Verified development assets ready. Password: .dev/root-password (not printed).')
