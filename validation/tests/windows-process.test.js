const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, awaitExit, stopApplication, stopDatabase } = require('../../windows/controller.cjs');
test('managed process tracks completion even when exitCode stays null after a signal', async () => {
  const child = launch(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio:['ignore','pipe','pipe'] });
  child.stderr.resume();
  await new Promise((resolve,reject)=>{ child.stdout.once('data',resolve);child.once('error',reject); });
  child.kill('SIGTERM');
  await awaitExit(child, 5000);
  assert.equal(child.finished,true);
  if (process.platform !== 'win32') { assert.equal(child.exitCode,null); assert.equal(child.signalCode,'SIGTERM'); }
});
test('Mongo shutdown waits for index builds and never forces or retries other errors', async () => {
  const conflict = () => Object.assign(new Error('Index builds in progress while processing shutdown command without {force: true}: 1'), { code:117, name:'MongoServerError' });
  let calls=0, closed=0, waits=0;
  const child={finished:false,failure:null,done:Promise.resolve(0)};
  const db={child,onIndexWait:()=>waits++,client:{db:()=>({command:async options=>{assert.equal(options.force,false);if(++calls<3) throw conflict();child.finished=true;}}),close:async()=>closed++}};
  await stopDatabase(db,{indexWaitMS:1000,indexRetryMS:1});
  assert.equal(calls,3);assert.equal(waits,2);assert.equal(closed,1);
  const forbidden=Object.assign(new Error('Forbidden fixture'),{code:13,name:'MongoServerError'});
  calls=0;
  db.child={finished:false,failure:null,done:Promise.resolve(0)};
  db.client.db=()=>({command:async()=>{calls++;throw forbidden;}});
  await assert.rejects(stopDatabase(db,{indexWaitMS:1000,indexRetryMS:1}),/Forbidden fixture/);
  assert.equal(calls,1);
  db.client.db=()=>({command:async options=>{assert.equal(options.force,false);throw conflict();}});
  await assert.rejects(stopDatabase(db,{indexWaitMS:0,indexRetryMS:1}),/no snapshot was accepted/);
  assert.equal(db.child.finished,false);
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
