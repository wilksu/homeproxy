// Portable percent encoding for the fixtures; production uses LuCI's module.
export function urldecode(s) {
 return replace(s || '', /%([0-9a-fA-F]{2})/g, (_, byte)=>chr(int(byte,16)));
};
export function urlencode(s) {
 return replace(s || '', /[^A-Za-z0-9_.~-]/g, byte=>sprintf('%%%02X',ord(byte)));
};
export function urldecode_params(s) {
 const result={};for(let pair in split(s || '', '&')){
  const parts=split(pair,'=',2);
  result[urldecode(parts[0])]=urldecode(replace(parts[1] || '', '+', ' '));
 }
 return result;
};
