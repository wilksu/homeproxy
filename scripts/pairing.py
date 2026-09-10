#!/usr/bin/env python3
"""Single source for SDK recipes, standalone package metadata and CI."""
import json,pathlib,sys
root=pathlib.Path(__file__).resolve().parents[1]
data=json.loads((root/'root/usr/share/homeproxy/compat.json').read_text())
if len(sys.argv)==2:
 print(data[sys.argv[1]])
else:
 for name,key in [('HP_CORE_VERSION','core_version'),('HP_CORE_PACKAGE_VERSION','core_package_version'),('HP_CORE_SHA256','core_source_sha256'),('HP_DASHBOARD_COMMIT','dashboard_commit'),('HP_DASHBOARD_SHA256','dashboard_sha256'),('HP_DASHBOARD_PACKAGE_VERSION','dashboard_package_version')]: print(f'{name}:={data[key]}')
 print('HP_CORE_RELEASE:='+data['core_package_version'].split('-r')[-1])
