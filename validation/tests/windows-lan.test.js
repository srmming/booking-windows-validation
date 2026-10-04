const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, deploymentConfig, privateIPv4 } = require('../app');
const lanEnv = { NODE_ENV: 'production', APP_MODE: 'windows-lan', MONGODB_URI: 'mongodb://127.0.0.1:17881/labellotita_booking_local' };

test('LAN opt-in is explicit and refuses external databases, demo and inherited cloud credentials', () => {
  assert.equal(deploymentConfig(lanEnv).lan, true);
  assert.throws(() => deploymentConfig({ ...lanEnv, APP_MODE: 'lan' }), /Unknown/);
  for (const uri of ['mongodb://localhost:17881/labellotita_booking_local','mongodb://192.168.1.2:17881/labellotita_booking_local','mongodb://127.0.0.1:17881/other','mongodb://127.0.0.1:17881/labellotita_booking_local?replicaSet=x','mongodb://user:placeholder@127.0.0.1:17881/labellotita_booking_local','mongodb://127.0.0.1:99999/labellotita_booking_local']) {
    assert.throws(() => deploymentConfig({ ...lanEnv, MONGODB_URI: uri }));
  }
  for (const changes of [{ DEMO_MODE: 'true' }, { NODE_ENV: 'development' }, { APP_USERNAME: 'unused' }, { APP_PASSWORD: 'unused' }]) assert.throws(() => deploymentConfig({ ...lanEnv, ...changes }));
  assert.throws(() => deploymentConfig({ NODE_ENV: 'production' }), /APP_USERNAME/);
});

test('LAN recognizes only loopback and RFC1918 IPv4 peers', () => {
  for (const ip of ['127.0.0.1','10.2.3.4','172.16.0.1','172.31.255.254','192.168.1.2','::ffff:192.168.1.2']) assert.equal(privateIPv4(ip), true);
  for (const ip of ['8.8.8.8','172.15.0.1','172.32.0.1','169.254.1.2','0.0.0.0','::1','192.168.1.300','192.168.1.2.example']) assert.equal(privateIPv4(ip), false);
});

test('LAN permits passwordless local access and rejects DNS rebinding and cross-origin writes', async t => {
  const server = createApp(deploymentConfig(lanEnv)).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('www-authenticate'), null);
  assert.deepEqual(await res.json(), { readOnly: false, demo: false });
  const invalidHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/config', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await fetch(base + '/api/config', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(base + '/api/customers', { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
});
