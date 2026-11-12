// Validates this app against the JSON schemas Make's VS Code extension (integromat/vscode-apps-sdk)
// applies to local app files, using the extension's own file-name associations.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const commit = '6ff5f3dd9960ccbeb24de3beb1cca935de89eaa0';
const raw = `https://raw.githubusercontent.com/integromat/vscode-apps-sdk/${commit}/syntaxes`;
const imlSchemas = ['api', 'base', 'common', 'enums', 'parameters', 'response', 'samples', 'sources'];
// Suffix => schema, from the extension's package.json "jsonValidation" contributions.
const associations = [
  ['.params.iml.json', 'parameters'],
  ['.mappable-params.iml.json', 'parameters'],
  ['.interface.iml.json', 'parameters'],
  ['.communication.iml.json', 'api'],
  ['.attach.iml.json', 'api'],
  ['.detach.iml.json', 'api'],
  ['.samples.iml.json', 'samples'],
  ['base.iml.json', 'base'],
];

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};

// The schemas use escapes such as \- that are invalid under the u flag.
const ajv = new Ajv({ strict: false, allErrors: true, unicodeRegExp: false });
addFormats(ajv);
for (const name of imlSchemas) {
  const schema = await fetchJson(`${raw}/imljson/schemas/${name}.json`);
  ajv.addSchema({ ...schema, $id: `https://make.local/${name}.json` });
}
ajv.addSchema({ ...(await fetchJson(`${raw}/local-development/schemas/makecomapp.schema.json`)), $id: 'makecomapp' });

const root = new URL('.', import.meta.url).pathname;
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (['node_modules', '.secrets'].includes(entry.name)) return [];
  const path = join(dir, entry.name);
  return entry.isDirectory() ? files(path) : [path];
});

let failures = 0;
const check = (path, schemaId) => {
  const validate = ajv.getSchema(schemaId);
  const ok = validate(JSON.parse(readFileSync(path, 'utf8')));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${relative(root, path)} (${schemaId.replace('https://make.local/', '')})`);
  if (!ok) {
    failures += 1;
    for (const error of validate.errors) console.log(`     ${error.instancePath || '/'} ${error.message}`);
  }
};

check(join(root, 'makecomapp.json'), 'makecomapp');
const manifest = JSON.parse(readFileSync(join(root, 'makecomapp.json'), 'utf8'));
const referenced = new Set([
  ...Object.values(manifest.generalCodeFiles),
  ...Object.values(manifest.components).flatMap((group) =>
    Object.values(group).flatMap((component) => Object.values(component.codeFiles ?? {}))),
].filter(Boolean).map((path) => join(root, path)));
for (const path of files(root).filter((file) => file.endsWith('.iml.json'))) {
  const association = associations.find(([suffix]) => path.endsWith(suffix));
  if (!association) throw new Error(`No schema association for ${path}`);
  if (!referenced.delete(path)) {
    failures += 1;
    console.log(`FAIL ${relative(root, path)} is not referenced from makecomapp.json`);
  }
  check(path, `https://make.local/${association[1]}.json`);
}
for (const missing of referenced) {
  failures += 1;
  console.log(`FAIL ${relative(root, missing)} is referenced from makecomapp.json but missing`);
}
if (failures > 0) process.exit(1);
console.log('All Make app files match the Make SDK schemas.');
