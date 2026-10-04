const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, awaitExit } = require('../../windows/controller.cjs');
test('managed process tracks completion even when exitCode stays null after a signal', async () => {
  const child = launch(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio:['ignore','pipe','pipe'] });
  child.stderr.resume();
  await new Promise((resolve,reject)=>{ child.stdout.once('data',resolve);child.once('error',reject); });
  child.kill('SIGTERM');
  await awaitExit(child, 5000);
  assert.equal(child.finished,true);
  if (process.platform !== 'win32') { assert.equal(child.exitCode,null); assert.equal(child.signalCode,'SIGTERM'); }
});
