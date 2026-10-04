const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, deploymentConfig } = require('../app');

const testCredentials = { APP_USERNAME: 'local-test-only', APP_PASSWORD: 'ephemeral-test-only-password' };
const businessEnv = { NODE_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1/not-connected', ...testCredentials };

async function serve(t, config, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-deployment-test-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Preview fixture</title>');
  fs.writeFileSync(path.join(dir, 'logo.png'), 'test asset');
  const server = createApp(config, { buildDir: dir, ...options }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('production cannot start with missing access controls or an implicit database', () => {
  assert.throws(() => deploymentConfig({ NODE_ENV: 'production' }), /APP_USERNAME/);
  assert.throws(() => deploymentConfig({ ...businessEnv, APP_PASSWORD: 'short' }), /APP_PASSWORD/);
  assert.throws(() => deploymentConfig({ NODE_ENV: 'production', ...testCredentials }), /MONGODB_URI/);
});

test('demo refuses all database connections, including an accidentally inherited URI', () => {
  assert.throws(() => deploymentConfig({ NODE_ENV: 'production', DEMO_MODE: 'true', MONGODB_URI: businessEnv.MONGODB_URI }), /must not/);
});

test('demo loads the SPA, empty data, and routing fallbacks without a database', async t => {
  const base = await serve(t, deploymentConfig({ NODE_ENV: 'production', DEMO_MODE: 'true' }));
  for (const route of ['/', '/dashboard', '/customers', '/orders/new', '/products', '/production', '/combo-targets']) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  for (const route of ['customers', 'products', 'orders', 'shipments', 'stock-orders', 'stock-shipments', 'production/plan']) {
    const res = await fetch(`${base}/api/${route}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  }
  assert.deepEqual(await (await fetch(base + '/api/config')).json(), { readOnly: true, demo: true });
  assert.equal((await (await fetch(base + '/api/orders/stats')).json()).totalOrders, 0);
  assert.equal((await fetch(base + '/api/unknown')).status, 404);
  assert.equal((await fetch(base + '/missing.js')).status, 404);
});

test('demo blocks API mutations and keeps all customer data empty', async t => {
  const base = await serve(t, deploymentConfig({ NODE_ENV: 'production', DEMO_MODE: 'true' }));
  for (const route of ['customers', 'orders', 'shipments', 'products/any/inventory', 'stock-orders', 'stock-shipments', 'config']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'local-test' }) });
      assert.equal(res.status, 403, `${method} ${route}`);
    }
  }
  assert.deepEqual(await (await fetch(base + '/api/customers')).json(), []);
});

test('business protects the SPA, assets, API reads and writes; valid local auth works', async t => {
  const base = await serve(t, deploymentConfig(businessEnv));
  for (const route of ['/dashboard', '/logo.png', '/api/config', '/api/customers']) {
    const res = await fetch(base + route);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /Basic/);
  }
  assert.equal((await fetch(base + '/api/customers', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/api/config', { headers: { Authorization: 'Basic invalid' } })).status, 401);
  const authorization = 'Basic ' + Buffer.from(`${testCredentials.APP_USERNAME}:${testCredentials.APP_PASSWORD}`).toString('base64');
  const res = await fetch(base + '/api/config', { headers: { Authorization: authorization } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { readOnly: false, demo: false });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/api/customers', { method: 'POST', headers: { Authorization: authorization, Origin: 'https://unrelated.example' }, body: '{}' })).status, 403);
});

test('health responds as not ready when a deployment dependency is unavailable', async t => {
  const base = await serve(t, deploymentConfig(businessEnv), { isReady: () => false });
  const res = await fetch(base + '/health');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, 'NOT_READY');
});
