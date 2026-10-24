import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'i18n', 'locales');
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const locales = ['en-US','zh-CN','ja-JP','zh-TW'];
const source = 'en-US';
if (!existsSync(root)) throw new Error(`Cannot find locales: ${root}`);
const files = readdirSync(resolve(root,source)).filter(x=>x.endsWith('.json')).sort();
let checked = 0;
const failures=[];
const hardcoded = [];
const variables = str => [...str.matchAll(/{{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*}}/g)].map(m=>m[1]).sort().join(',');
const flatten = (object,prefix='') => Object.entries(object).flatMap(([k,v])=> {
 const name=prefix?`${prefix}.${k}`:k;
 if (typeof v === 'string') return [[name,v]];
 if(v && typeof v === 'object' && !Array.isArray(v)) return flatten(v,name);
 throw new Error(`Expected string or nested translation object at ${name}`);
});
for(const locale of locales){
 const actualFiles=readdirSync(resolve(root,locale)).filter(x=>x.endsWith('.json')).sort();
 if(actualFiles.join('|')!==files.join('|')) failures.push(`${locale}: namespace files differ`);
 for (const file of files){
  const path=resolve(root,locale,file);
  if(!existsSync(path)){failures.push(`${locale}/${file}: missing`);continue;}
  const origin=JSON.parse(readFileSync(resolve(root,source,file),'utf8'));
  const translated=JSON.parse(readFileSync(path,'utf8'));
  const base=Object.fromEntries(flatten(origin));
  const target=Object.fromEntries(flatten(translated));
  for(const k of Object.keys(base)){
    if(!(k in target)) {failures.push(`${locale}/${file}: missing ${k}`);continue;}
    if(!target[k].trim())failures.push(`${locale}/${file}: empty ${k}`);
    if(variables(base[k])!==variables(target[k])) failures.push(`${locale}/${file}: interpolation mismatch ${k} (${variables(base[k])} != ${variables(target[k])})`);
    checked++;
  }
  for(const k of Object.keys(target))if(!(k in base)) failures.push(`${locale}/${file}: extra key ${k}`);
 }
}
if(failures.length){console.error('i18n validation failed:\n'+failures.join('\n'));process.exit(1)}

function scanTsx(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) scanTsx(path);
    else if (path.endsWith('.tsx')) {
      const source = readFileSync(path, 'utf8');
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node) {
        const value = ts.isJsxText(node)
          ? node.getText(ast).replace(/\s+/g, ' ').trim()
          : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
            ? node.text
            : '';
        if (/[\p{Script=Han}]/u.test(value) && !['未设置'].includes(value)) {
          const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          hardcoded.push(`${path}:${line + 1}: ${value.slice(0, 90)}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
}
scanTsx(sourceRoot);
console.log(`i18n resources validated: ${locales.length} locales, ${files.length} namespaces, ${checked / locales.length} keys per locale.`);
console.log(`Han-script literals remaining in TSX source (review required): ${hardcoded.length}`);
for (const item of hardcoded.slice(0, 20)) console.log(`  ${item}`);
