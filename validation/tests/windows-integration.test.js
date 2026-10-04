const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readJSON } = require('../../windows/storage.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const controller = path.resolve(__dirname, '../../windows/controller.cjs');
const executable = process.env.BOOKING_TEST_MONGOD;

test('real local CRUD, restart persistence, shipment, clean snapshot and non-overwriting restore', { skip: !executable, timeout: 180000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'booking 中文 path '));
  const appPort = Number(process.env.BOOKING_TEST_APP_PORT || 23880);
  const dbPort = Number(process.env.BOOKING_TEST_DB_PORT || 23881);
  const env = { ...process.env, BOOKING_TEST_MODE: '1', BOOKING_TEST_ROOT: root, BOOKING_TEST_APP_PORT: String(appPort), BOOKING_TEST_DB_PORT: String(dbPort), BOOKING_TEST_MONGOD: executable };
  const base = `http://127.0.0.1:${appPort}`;
  let running;
  async function cli(...args) {
    const child = spawn(process.execPath, [controller, ...args], { env, stdio: ['ignore','pipe','pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    if (code !== 0) {
      t.diagnostic('Controller command failed: '+args.join(' ')+'; running output: '+(running?.output || ''));
      for (const name of ['state.json','operation.lock','stop.json','logs/lifecycle.log','logs/application.log','logs/database-console.log','logs/database.log']) {
        const file=path.join(root,name);
        if (fs.existsSync(file)) t.diagnostic(name+': '+fs.readFileSync(file,'utf8').split(/\r?\n/).slice(-30).join('\n'));
      }
    }
    assert.equal(code, 0, output); return output.trim();
  }
  async function start() {
    running = spawn(process.execPath, [controller, 'run'], { env, stdio: ['ignore','pipe','pipe'] });
    running.output = ''; running.stdout.on('data', b => running.output += b); running.stderr.on('data', b => running.output += b);
    for (let i=0; i<160; i++) {
      if (running.exitCode !== null) assert.fail(running.output);
      try { if (readJSON(path.join(root, 'state.json')).phase === 'running') return; } catch (_) {}
      await sleep(250);
    }
    assert.fail('readiness timeout: '+running.output);
  }
  async function api(route, method='GET', body) {
    const res = await fetch(base+'/api/'+route, { method, headers: { 'Content-Type':'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await res.json(); assert.ok(res.ok, JSON.stringify(value)); return value;
  }
  t.after(async () => { try { await cli('stop'); } finally { if (running?.exitCode === null) running.kill('SIGTERM'); fs.rmSync(root, { recursive:true, force:true }); } });
  await start();
  assert.deepEqual(await api('customers'), []);
  const customer = await api('customers', 'POST', { name:'Temporary fixture customer', phone:'000' });
  await api('customers/'+customer._id, 'PUT', { name:'Persisted fixture customer' });
  const disposable = await api('customers','POST',{ name:'Delete fixture' });
  await api('customers/'+disposable._id, 'DELETE');
  const product = await api('products','POST',{ name:'Fixture base',type:'base',inventory:{current:20} });
  const combo = await api('products','POST',{ name:'Fixture combo',type:'combo',components:[{productId:product._id,quantity:2}] });
  const order = await api('orders','POST',{ customerId:customer._id,items:[{productId:combo._id,quantity:3}],totalAmount:30 });
  const shipment = await api('shipments','POST',{orderId:order._id,shippedItems:[{productId:combo._id,quantity:1}]});
  assert.ok(shipment._id);
  assert.equal((await api('products/'+product._id)).inventory.current,18);
  await cli('stop');
  await start();
  assert.equal((await api('customers/'+customer._id)).customer.name,'Persisted fixture customer');
  assert.equal((await api('orders/'+order._id)).shipments.length,1);
  // Double start must reject instead of creating a second server/database.
  const duplicate = spawn(process.execPath,[controller,'run'],{env,stdio:['ignore','pipe','pipe']});
  let duplicateOut='';duplicate.stderr.on('data',b=>duplicateOut+=b);
  assert.equal(await new Promise(resolve=>duplicate.on('exit',resolve)),1);
  assert.match(duplicateOut,/already running/);
  const original = readJSON(path.join(root,'active.json'));
  const backupDir = await cli('backup');
  assert.equal(readJSON(path.join(root,'state.json')).phase,'stopped');
  await start();
  await api('customers/'+customer._id,'PUT',{name:'Changed after backup'});
  await cli('stop');
  const manifestPath=path.join(backupDir,'manifest.json');
  const manifest=fs.readFileSync(manifestPath);
  const m=JSON.parse(manifest); m.files[0].sha256='f'.repeat(64);fs.writeFileSync(manifestPath,JSON.stringify(m));
  const bad = spawn(process.execPath,[controller,'restore',backupDir,'--confirmed'],{env,stdio:['ignore','pipe','pipe']});
  bad.stdout.resume();bad.stderr.resume();assert.equal(await new Promise(resolve=>bad.on('exit',resolve)),1);
  assert.deepEqual(readJSON(path.join(root,'active.json')),original);
  fs.writeFileSync(manifestPath,manifest);
  await cli('restore',backupDir,'--confirmed');
  assert.notDeepEqual(readJSON(path.join(root,'active.json')),original);
  assert.equal(fs.existsSync(path.join(root,'generations',original.generation,'WiredTiger')),true);
  await start();
  assert.equal((await api('customers/'+customer._id)).customer.name,'Persisted fixture customer');
  assert.equal((await api('orders/'+order._id)).shipments.length,1);
  await cli('stop');
  // Conflict check does not terminate or take over an unrelated listener.
  const server=require('node:net').createServer().listen(appPort,'0.0.0.0');
  await new Promise(resolve=>server.once('listening',resolve));
  const conflict=spawn(process.execPath,[controller,'run'],{env,stdio:['ignore','pipe','pipe']});
  let conflictOut='';conflict.stderr.on('data',b=>conflictOut+=b);
  assert.equal(await new Promise(resolve=>conflict.on('exit',resolve)),1);
  assert.match(conflictOut,/occupied/);
  await new Promise(resolve=>server.close(resolve));
});

test('state write failure during stop does not abandon owned application or database', { skip: !executable, timeout: 60000 }, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'booking-stop-metadata-'));
  const preload=path.join(root,'inject.cjs');
  const storage=path.resolve(__dirname,'../../windows/storage.cjs');
  fs.writeFileSync(preload,`const s=require(${JSON.stringify(storage)});const original=s.atomicJSON;let once=true;s.atomicJSON=(file,value)=>{if(once&&file.endsWith('state.json')&&value.phase==='stopping'){once=false;const e=new Error('Injected state rename EPERM');e.code='EPERM';throw e;}return original(file,value)};`);
  const env={...process.env,BOOKING_TEST_MODE:'1',BOOKING_TEST_ROOT:root,BOOKING_TEST_APP_PORT:'23993',BOOKING_TEST_DB_PORT:'23994',BOOKING_TEST_MONGOD:executable};
  const child=spawn(process.execPath,['--require',preload,controller,'run'],{env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  async function stop() {
    const stopper=spawn(process.execPath,[controller,'stop'],{env,stdio:['ignore','pipe','pipe']});
    let text='';stopper.stdout.on('data',b=>text+=b);stopper.stderr.on('data',b=>text+=b);
    const code=await new Promise((resolve,reject)=>{stopper.once('exit',resolve);stopper.once('error',reject)});
    assert.equal(code,0,text+'\n'+output);
  }
  t.after(async()=>{
    try { await stop(); }
    finally {
      if(child.exitCode===null) child.kill('SIGTERM');
      if(!fs.existsSync(path.join(root,'operation.lock'))) fs.rmSync(root,{recursive:true,force:true});
    }
  });
  let ready=false;
  for(let i=0;i<160;i++) {
    if(child.exitCode!==null) assert.fail(output);
    try{if(readJSON(path.join(root,'state.json')).phase==='running'){ready=true;break}}catch(_){}
    await sleep(250);
  }
  assert.equal(ready,true,output);
  await stop();
  assert.equal(readJSON(path.join(root,'state.json')).phase,'stopped');
  assert.equal(fs.existsSync(path.join(root,'operation.lock')),false);
  const {assertPortFree}=require('../../windows/controller.cjs');
  await assertPortFree(23993);await assertPortFree(23994);
  const journal=fs.readFileSync(path.join(root,'logs/lifecycle.log'),'utf8');
  assert.match(journal,/state-stop-warning.*Injected state rename EPERM/);
  assert.match(journal,/http-child-exited/);assert.match(journal,/mongo-child-exited/);assert.match(journal,/lease-released/);
});

test('stop reports matching-instance cleanup errors without the generic two-minute timeout', { timeout: 3000 }, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'booking-stop-error-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {atomicJSON}=require('../../windows/storage.cjs');
  const {stop}=require('../../windows/controller.cjs');
  atomicJSON(path.join(root,'operation.lock'),{pid:process.pid,instance:'fixture'});
  atomicJSON(path.join(root,'state.json'),{phase:'running',instance:'fixture'});
  const timer=setTimeout(()=>atomicJSON(path.join(root,'state.json'),{phase:'error',instance:'fixture',error:'Fixture HTTP drain failure'}),50);
  t.after(()=>clearTimeout(timer));
  await assert.rejects(stop({root}),/Fixture HTTP drain failure/);
  assert.equal(fs.existsSync(path.join(root,'operation.lock')),true);
});

test('readiness failure retains the lease until the owned database cleanly exits', { skip: !executable, timeout: 60000 }, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'booking-readiness-'));
  fs.mkdirSync(path.join(root,'logs'));
  const { acquireLock, generation } = require('../../windows/storage.cjs');
  const { startDatabase, assertPortFree } = require('../../windows/controller.cjs');
  const lock=acquireLock(root);
  let pending=false, lockBlocked=false;
  try {
    await assert.rejects(startDatabase({ root, dbPort:23991, uri:'mongodb://127.0.0.1:23991/labellotita_booking_local', mongod:executable, readinessAttempts:0, onPendingCleanup:() => {
      pending=true;
      try { acquireLock(root); } catch (error) { lockBlocked=/already running/.test(error.message); }
    } }, generation(root)), /readiness timed out/);
    assert.equal(pending,true);
    assert.equal(lockBlocked,true);
    await assertPortFree(23991);
    assert.equal(readJSON(path.join(root,'operation.lock')).instance,lock.instance);
  } finally { lock.release();fs.rmSync(root,{recursive:true,force:true}); }
});

test('readiness cleanup releases a signaled database child rather than polling forever', { skip: !executable || process.platform === 'win32', timeout: 10000 }, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'booking-signaled-'));
  fs.mkdirSync(path.join(root,'logs'));
  const { startDatabase } = require('../../windows/controller.cjs');
  const { acquireLock, generation } = require('../../windows/storage.cjs');
  const lock=acquireLock(root);
  let child;
  try {
    await assert.rejects(startDatabase({root,dbPort:23992,uri:'mongodb://127.0.0.1:23992/labellotita_booking_local',mongod:executable,readinessAttempts:0,onPendingCleanup:(error,owned)=>{child=owned;owned.kill('SIGTERM');}},generation(root)),/readiness timed out/);
    assert.equal(child.finished,true);
    assert.equal(child.exitCode,null);
    assert.equal(child.signalCode,'SIGTERM');
  } finally { lock.release();fs.rmSync(root,{recursive:true,force:true}); }
});
