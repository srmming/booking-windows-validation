const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicJSON, readJSON, acquireLock, generation, inventory, validateSnapshot } = require('../../windows/storage.cjs');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-storage-')); t.after(() => fs.rmSync(dir, { force: true, recursive: true })); return dir; }
async function snapshot(dir) {
  fs.mkdirSync(path.join(dir, 'db')); fs.writeFileSync(path.join(dir, 'db', 'WiredTiger'), 'fixture');
  const manifest = { format: 'booking-cold-v1', mongoVersion: 'test', collections: [], files: await inventory(path.join(dir, 'db')) };
  atomicJSON(path.join(dir, 'manifest.json'), manifest); return manifest;
}
test('atomic pointers preserve old generations and reject unsafe pointer names', t => {
  const root = temp(t); const first = generation(root);
  assert.equal(generation(root), first);
  atomicJSON(path.join(root, 'active.json'), { generation: '../../outside' });
  assert.throws(() => generation(root), /Invalid/); assert.equal(fs.existsSync(first), true);
});
test('single instance lock blocks concurrent maintenance and releases only its owner', t => {
  const root = temp(t); const lock = acquireLock(root);
  assert.throws(() => acquireLock(root), /already running/);
  lock.release(); const second = acquireLock(root); second.release();
  atomicJSON(path.join(root, 'operation.lock'), { pid: -1 });
  assert.throws(() => acquireLock(root), /Invalid/);
});
test('snapshot validation rejects tampered, missing, extra, traversal and version mismatched files', async t => {
  const root = temp(t); const original = await snapshot(root);
  assert.deepEqual(await validateSnapshot(root, 'test'), original);
  await assert.rejects(validateSnapshot(root, 'other'), /version/);
  fs.writeFileSync(path.join(root, 'db', 'WiredTiger'), 'changed');
  await assert.rejects(validateSnapshot(root, 'test'), /modified/);
  fs.writeFileSync(path.join(root, 'db', 'WiredTiger'), 'fixture');
  fs.writeFileSync(path.join(root, 'db', 'extra'), 'extra');
  await assert.rejects(validateSnapshot(root, 'test'), /unexpected/);
  fs.rmSync(path.join(root, 'db', 'extra'));
  atomicJSON(path.join(root, 'manifest.json'), { ...original, files: [...original.files, { path: '../outside', size: 0, sha256: 'a'.repeat(64) }] });
  await assert.rejects(validateSnapshot(root, 'test'), /Unsafe/);
});
test('snapshot inventory refuses symbolic links', async t => {
  const root = temp(t); fs.writeFileSync(path.join(root, 'target'), 'data');
  try { fs.symlinkSync(path.join(root, 'target'), path.join(root, 'link')); } catch (e) { if (e.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw e; }
  await assert.rejects(inventory(root), /Links/);
});

test('concurrent dead-owner recovery permits only one live owner', async t => {
  const { spawn } = require('node:child_process');
  const root = temp(t);
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise(resolve => dead.once('exit', resolve));
  atomicJSON(path.join(root, 'operation.lock'), { pid: dead.pid, instance: 'stale' });
  const modulePath = path.resolve(__dirname, '../../windows/storage.cjs');
  const script = `const s=require(process.argv[1]);try{const lock=s.acquireLock(process.argv[2]);process.on('message',()=>{lock.release();process.exit(0)});process.send('owned')}catch(e){process.send('blocked',()=>process.exit(2))}`;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ['-e', script, modulePath, root], { stdio:['ignore','pipe','pipe','ipc'] }));
  const exits = children.map(child => { child.stdout.resume();child.stderr.resume();return new Promise(resolve => child.once('exit', resolve)); });
  const owners = await Promise.all(children.map(child => new Promise((resolve,reject)=>{ child.once('message',resolve);child.once('error',reject); })));
  const owned = children.filter((child,index)=>owners[index]==='owned');
  for (const child of owned) child.send('release');
  const codes=await Promise.all(exits);
  assert.equal(owned.length,1,JSON.stringify(owners));
  assert.equal(codes.filter(code => code === 0).length, 1, JSON.stringify(codes));
  assert.equal(fs.existsSync(path.join(root, 'operation.lock')), false);
  assert.equal(fs.existsSync(path.join(root, 'operation-claim')), false);
});

test('abandoned reclamation gate never automatically deletes another claimant', t => {
  const root = temp(t); fs.mkdirSync(path.join(root,'operation-claim'));
  assert.throws(() => acquireLock(root), /operation-claim/);
  assert.equal(fs.existsSync(path.join(root,'operation-claim')),true);
});
