"""Test-only adapters for ucode modules; production files are never edited."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'root/etc/homeproxy/scripts'
UCODE = os.environ.get('UCODE')

def modules(directory):
 """Keep the parser verbatim; isolate the external OpenWrt validator.

 The portable validator supports our fixture addresses, not the complete
 validate_data schema. These tests make no claims about native IP validation.
 Only the copy's validation function changes; URL/command logic stays real.
 """
 destination = pathlib.Path(directory)/'modules'; destination.mkdir()
 source = (SCRIPTS/'homeproxy.uc').read_text()
 start = source.index('export function validation(')
 end = source.index('\n};', start)+3
 source = source[:start]+'''export function validation(kind, value) {
 if(value===null)return false;value=''+value;
 if(kind==='ip4addr')return !!match(value,/^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$/);
 if(kind==='ip6addr')return !!match(value,/^[0-9a-fA-F:]+:[0-9a-fA-F:]+$/);
 if(kind==='hostname')return !!validateHostname(value);
 if(kind==='host')return validation('ip4addr',value) || validation('ip6addr',value) || validation('hostname',value);
 if(kind==='port')return !!match(value,/^[0-9]+$/) && int(value)>0 && int(value)<=65535;
 return false;
};'''+source[end:]
 (destination/'homeproxy.uc').write_text(source)
 shutil.copy(SCRIPTS/'share_links.uc', destination/'share_links.uc')
 return destination


class ShareLinkProbe:
 def parse(self, links, rpc=False, features=None):
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp); mods=modules(path)
   content='\n'.join(links); (path/'input').write_text(content)
   features=features if features is not None else {'with_quic':True,'with_utls':True}
   prefix="import {readfile} from 'fs';\n"
   if rpc:
    source=(ROOT/'root/usr/share/rpcd/ucode/luci.homeproxy').read_text().replace(
     "'/etc/homeproxy/scripts/share_links.uc'",json.dumps(str(mods/'share_links.uc')))
    source=source.removeprefix('#!/usr/bin/ucode\n');prefix=''
    source=source.replace("return { 'luci.homeproxy': methods };",'')
    code=source+"\nbuiltinFeatures=()=>("+json.dumps(features)+");\nprint(sprintf('%J',methods.share_links_parse.call({args:{content:readfile("+json.dumps(str(path/'input'))+")}})));"
   else:
    code="import {parseShareLink,parseShareLinks} from 'share_links';\nconst input=readfile("+json.dumps(str(path/'input'))+");const features="+json.dumps(features)+";print(sprintf('%J',{batch:parseShareLinks(input,features),individual:map(split(input,'\\n'),link=>parseShareLink(link,features))}));"
   script=path/'probe.uc'; script.write_text(prefix+code)
   result=subprocess.run([UCODE,'-L',str(mods/'*.uc'),'-L',str(ROOT/'tests/support/*.uc'),
    '-L',str(ROOT/'root/usr/share/ucode/*.uc'),str(script)],capture_output=True,text=True,timeout=10)
   if result.returncode: raise RuntimeError(result.stderr)
   return json.loads(result.stdout)
