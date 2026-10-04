const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, awaitExit, stopApplication } = require('../../windows/controller.cjs');
test('managed process tracks completion even when exitCode stays null after a signal', async () => {
  const child = launch(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio:['ignore','pipe','pipe'] });
  child.stderr.resume();
  await new Promise((resolve,reject)=>{ child.stdout.once('data',resolve);child.once('error',reject); });
  child.kill('SIGTERM');
  await awaitExit(child, 5000);
  assert.equal(child.finished,true);
  if (process.platform !== 'win32') { assert.equal(child.exitCode,null); assert.equal(child.signalCode,'SIGTERM'); }
});
test('nonzero application exit is rejected before and during requested shutdown', async () => {
  const child = launch(process.execPath, ['-e', "process.on('message',()=>process.exit(7));process.stdout.write('ready');"], { stdio:['ignore','pipe','pipe','ipc'] });
  child.stderr.resume();
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject)});
  await assert.rejects(stopApplication(child),/did not stop cleanly/);
  assert.equal(child.finished,true);assert.equal(child.exitCode,7);
  const alreadyExited=launch(process.execPath,['-e','process.exit(7)'],{stdio:'ignore'});
  await awaitExit(alreadyExited);
  await assert.rejects(stopApplication(alreadyExited),/did not stop cleanly/);
});
