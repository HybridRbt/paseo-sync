import { readFile } from 'node:fs/promises';
import { safeFile, relativeName, objectHash, digest } from './files.mjs';

const ID = /^[a-z][a-z0-9_-]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA = /^[a-f0-9]{64}$/;
function check(ok, message) { if (!ok) throw new Error(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed, required = allowed) {
  check(object(value), 'Expected an object');
  check(Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k)), `Invalid fields; expected ${allowed.join(', ')}`);
}
export function validatePlugin(p) {
  keys(p, ['id', 'source', 'revision', 'enabled', 'pluginPath', 'registry'], ['id', 'source', 'revision', 'enabled']);
  check(ID.test(p.id) && typeof p.enabled === 'boolean', 'Invalid plugin ID/enabled state');
  check(typeof p.source === 'string' && typeof p.revision === 'string', 'Invalid source/revision');
  if (p.source.startsWith('npm:')) {
    check(/^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(p.source), 'Invalid npm package');
    check(SEMVER.test(p.revision), 'npm revision must be an exact semantic version');
  } else {
    check(p.source.startsWith('git:'), 'Only portable npm: and git: sources are supported');
    const u = new URL(p.source.slice(4));
    check(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname !== '/' && !/[\s"<>|^%&!]/.test(p.source), 'Git source must be a plain HTTPS URL without credentials');
    check(/^[a-f0-9]{40}$/.test(p.revision), 'Git revision must be a complete 40-character SHA');
  }
  if (p.pluginPath !== undefined) check(p.pluginPath === '.' || !!relativeName(p.pluginPath), 'Invalid plugin subdirectory');
  if (p.registry !== undefined) {
    keys(p.registry, ['url', 'id']);
    check(p.registry.url === 'https://plugins.paseo.sh' && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(p.registry.id), 'Unsupported registry provenance');
  }
  return p;
}
export function validateProfile(p) {
  keys(p, ['schemaVersion', 'plugins', 'settings', 'patches']);
  check(p.schemaVersion === 1, 'Unsupported profile schemaVersion');
  for (const name of ['plugins', 'settings', 'patches']) check(Array.isArray(p[name]), `${name} must be an array`);
  const ids = new Set();
  for (const plugin of p.plugins) { validatePlugin(plugin); check(!ids.has(plugin.id), 'Duplicate plugin ID'); ids.add(plugin.id); }
  const docs = new Set();
  for (const s of p.settings) {
    keys(s, ['plugin', 'document', 'file']);
    check(ids.has(s.plugin) && ID.test(s.document), 'Setting plugin/document invalid');
    check(s.file === `settings/${s.plugin}/${s.document}.json`, 'Settings must use their canonical relative path');
    relativeName(s.file);
    check(!docs.has(s.file), 'Duplicate settings document'); docs.add(s.file);
    check(s.plugin === 'better-paseo' && s.document === 'presentation', 'Settings document is not allowlisted');
  }
  const patchIds = new Set();
  for (const s of p.patches) {
    keys(s, ['plugin', 'file']);
    check(ids.has(s.plugin), 'Patch plugin invalid');
    relativeName(s.file); check(s.file.startsWith('patches/') && s.file.endsWith('.json'), 'Invalid patch path');
    check(!patchIds.has(s.plugin), 'Only one patch bundle per plugin'); patchIds.add(s.plugin);
  }
  return p;
}

const choices = {
  accent: ['host','jade','violet','amber','rose'], uiFont: ['host','inter','system'],
  inlineCodeColor: ['grey','blue','violet','green','coral'], monoFont: ['host','custom'],
  toolDetail: ['collapsed','expand-failed'], pathDisplay: ['relative','absolute'],
  markdownVariant: ['document','compact','terminal'], rowLabelStyle: ['icon','label','both'], language: ['system','en','zh'],
};
const flags = ['hoverPreview','previewWrap','previewLineNumbers','previewStripes','enhancedUserBubble','selectionActions','assistantMarkdown','compactRowSpacing','compactReplySpacing'];
export function validateSettings(plugin, document, d) {
  check(plugin === 'better-paseo' && document === 'presentation', 'Settings document is not allowlisted');
  keys(d, ['version', 'values']); check(d.version === 1 && object(d.values), 'Unsupported settings version or values');
  const allowed = [...Object.keys(choices), ...flags, 'customMonoFont', 'codeFontSize', 'blockFontSize', 'hoverDelaySeconds'];
  keys(d.values, allowed, []);
  for (const [key, value] of Object.entries(d.values)) {
    if (choices[key]) check(choices[key].includes(value), `Invalid setting ${key}`);
    else if (flags.includes(key)) check(typeof value === 'boolean', `Invalid setting ${key}`);
    else if (key === 'customMonoFont') check(typeof value === 'string' && value.length <= 200 && !/[\\/\x00-\x1f]/.test(value), 'Invalid custom font name');
    else if (key === 'codeFontSize') check(value === null || (Number.isInteger(value) && value >= 10 && value <= 22), 'Invalid code font size');
    else if (key === 'blockFontSize') check(Number.isInteger(value) && value >= 9 && value <= 20, 'Invalid block font size');
    else if (key === 'hoverDelaySeconds') check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10, 'Invalid hover delay');
  }
  return d;
}
export function validatePatch(d, plugin) {
  keys(d, ['schemaVersion','plugin','revision','files']);
  check(d.schemaVersion === 1 && d.plugin === plugin.id && d.revision === plugin.revision && Array.isArray(d.files) && d.files.length > 0, 'Patch does not match plugin revision');
  const seen = new Set();
  for (const f of d.files) {
    keys(f, ['path','beforeSha256','afterSha256','find','replace','count']); relativeName(f.path);
    check(!seen.has(f.path), 'Duplicate patch target'); seen.add(f.path);
    check(SHA.test(f.beforeSha256) && SHA.test(f.afterSha256) && f.beforeSha256 !== f.afterSha256, 'Invalid patch SHA256');
    check(typeof f.find === 'string' && f.find.length > 0 && typeof f.replace === 'string' && Number.isSafeInteger(f.count) && f.count > 0, 'Invalid patch replacement');
  }
  return d;
}
export function patchText(raw, spec) {
  const hash = digest(raw);
  if (hash === spec.afterSha256) return raw;
  check(hash === spec.beforeSha256, `Patch target changed: ${spec.path}`);
  const text = raw.toString('utf8');
  check(text.split(spec.find).length - 1 === spec.count, `Patch count mismatch: ${spec.path}`);
  const out = Buffer.from(text.split(spec.find).join(spec.replace));
  check(digest(out) === spec.afterSha256, `Patch result hash mismatch: ${spec.path}`);
  return out;
}
export function snapshotPlugin(row) {
  const i = row.installation;
  check(i?.identity && i.currentRevision, `Cannot export untracked plugin: ${row.id}`);
  const identity = i.identity;
  const p = { id: row.id, source: identity.kind === 'npm' ? `npm:${identity.packageName}` : `git:${identity.remote}`, revision: i.currentRevision, enabled: row.enabled };
  if (identity.pluginPath && identity.pluginPath !== '.') p.pluginPath = identity.pluginPath;
  if (identity.registry) p.registry = identity.registry;
  return validatePlugin(p);
}
export function pluginIdentity(p) {
  if (!p) return null;
  return { id: p.id, source: p.source, revision: p.revision, enabled: p.enabled, pluginPath: p.pluginPath ?? '.' };
}
export async function loadProfile(root) {
  const manifest = validateProfile(JSON.parse(await readFile(await safeFile(root, 'profile.json'), 'utf8')));
  const settings = [];
  for (const s of manifest.settings) {
    const data = validateSettings(s.plugin, s.document, JSON.parse(await readFile(await safeFile(root, s.file), 'utf8')));
    settings.push({ ...s, data });
  }
  const patches = [];
  for (const p of manifest.patches) {
    const plugin = manifest.plugins.find(x => x.id === p.plugin);
    patches.push({ ...p, data: validatePatch(JSON.parse(await readFile(await safeFile(root, p.file), 'utf8')), plugin) });
  }
  return { manifest, settings, patches, hash: objectHash({ manifest, settings, patches }) };
}
