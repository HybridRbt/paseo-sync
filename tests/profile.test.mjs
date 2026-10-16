import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProfile, validateProfile, snapshotPlugin, validateSettings } from '../server/core/profile.mjs';
import { safeFile } from '../server/core/files.mjs';

export const profile = () => ({ schemaVersion: 1, plugins: [{ id: 'skills', source: 'npm:@gpambrozio/paseo-skills', revision: '0.4.0', enabled: true }], settings: [], patches: [] });

test('rejects ambiguous or unrecognized manifest inputs', () => {
  const variants = [p => p.plugins.push(p.plugins[0]), p => p.schemaVersion = 2,
    p => p.plugins[0].revision = 'latest', p => p.plugins[0].enabled = 'yes',
    p => p.plugins[0].source = '/Users/person/plugin', p => p.plugins[0].unknown = true,
    p => p.plugins[0].source = 'git:https://x.invalid/repo?token=secret',
    p => { p.plugins[0].source = 'git:https://github.com/x/y'; p.plugins[0].revision = 'main'; }];
  for (const change of variants) { const p = profile(); change(p); assert.throws(() => validateProfile(p)); }
  assert.doesNotThrow(() => validateProfile(profile()));
});

test('source snapshot pins npm and git without machine paths', () => {
  const row = { id: 'skills', enabled: false, installation: { identity: { kind: 'npm', packageName: '@gpambrozio/paseo-skills', pluginPath: '.' }, currentRevision: '0.4.0' } };
  assert.deepEqual(snapshotPlugin(row), { id: 'skills', enabled: false, source: 'npm:@gpambrozio/paseo-skills', revision: '0.4.0' });
  assert.throws(() => snapshotPlugin({ id: 'unmanaged', path: '/tmp/x', enabled: true }));
});

test('setting allowlist rejects credential-shaped and newly introduced fields', () => {
  assert.doesNotThrow(() => validateSettings('better-paseo', 'presentation', { version: 1, values: { accent: 'host', previewWrap: true } }));
  for (const values of [{ token: 'secret' }, { previewWrap: 'yes' }, { language: 'invalid' }, { customMonoFont: '/Users/person/font' }]) {
    assert.throws(() => validateSettings('better-paseo', 'presentation', { version: 1, values }));
  }
  assert.throws(() => validateSettings('linear', 'credentials', { version: 1, values: {} }));
});

test('rejects traversal, Windows drive paths, and symlink escape before reading', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paseo-path-'));
  await mkdir(path.join(root, 'settings'));
  for (const value of ['../secret', 'C:\\secret', '/tmp/secret', 'settings/../secret', 'settings\\secret']) {
    await assert.rejects(safeFile(root, value));
  }
  await symlink(tmpdir(), path.join(root, 'settings', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(safeFile(root, 'settings/link/secret'));
});

test('loads only approved documents, rejects malformed setting files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paseo-manifest-'));
  const p = profile(); p.plugins.push({ id: 'better-paseo', source: 'git:https://github.com/RoundRedDot/better-paseo', revision: 'a'.repeat(40), enabled: true });
  p.settings.push({ plugin: 'better-paseo', document: 'presentation', file: 'settings/better-paseo/presentation.json' });
  await mkdir(path.join(root, 'settings/better-paseo'), { recursive: true });
  await writeFile(path.join(root, 'profile.json'), JSON.stringify(p));
  const f = path.join(root, p.settings[0].file);
  await writeFile(f, JSON.stringify({ version: 1, values: { previewWrap: true } }));
  assert.equal((await loadProfile(root)).settings[0].data.values.previewWrap, true);
  await writeFile(f, JSON.stringify({ version: 1, values: { password: 'never-share' } }));
  await assert.rejects(loadProfile(root));
});
