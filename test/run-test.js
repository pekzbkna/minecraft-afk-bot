/**
 * Test runner — starts the bot with mock mineflayer and runs automated tests
 * against the web API and dashboard.
 */

// Override mineflayer before index.js is loaded
require.cache[require.resolve('mineflayer')] = {
  id: require.resolve('mineflayer'),
  filename: require.resolve('mineflayer'),
  loaded: true,
  exports: require('./mock-mineflayer'),
};

// Set required env vars
process.env.MC_USERNAME = 'TestPlayer';
process.env.PORT = '3001';

// Clean auth cache so tests always start fresh (no saved session)
const fs = require('fs');
const path = require('path');
const cacheDir = path.join(__dirname, '..', '.auth-cache');
if (fs.existsSync(cacheDir)) {
  for (const f of fs.readdirSync(cacheDir)) {
    fs.unlinkSync(path.join(cacheDir, f));
  }
}

// Load the app
require('../index.js');

// ─── Tests ──────────────────────────────────────────────────────────────────
const http = require('http');

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method || 'GET', ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.jsonBody) {
      req.setHeader('Content-Type', 'application/json');
      req.write(JSON.stringify(options.jsonBody));
    }
    req.end();
  });
}

async function runTests() {
  const BASE = 'http://localhost:3001';
  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } else {
      console.log(`  ❌ FAIL: ${name}`);
      failed++;
    }
  }

  console.log('\n🧪 Running Minecraft Bot Tests\n');

  // Wait for server to start
  await new Promise((r) => setTimeout(r, 1000));

  // ── Test 1: GET /status returns valid JSON ──
  console.log('Test 1: GET /status');
  try {
    const res = await fetchJSON(`${BASE}/status`);
    assert(res.status === 200, 'status code is 200');
    assert(typeof res.body.running === 'boolean', 'running is boolean');
    assert(typeof res.body.online === 'boolean', 'online is boolean');
    assert(typeof res.body.status === 'string', 'status is string');
    assert(typeof res.body.uptime === 'number', 'uptime is number');
  } catch (e) {
    assert(false, `request failed: ${e.message}`);
  }

  // ── Test 2: GET / returns HTML dashboard ──
  console.log('\nTest 2: GET / (dashboard)');
  try {
    const res = await fetchJSON(`${BASE}/`);
    assert(res.status === 200, 'status code is 200');
    assert(typeof res.body === 'string', 'returns HTML string');
    assert(res.body.includes('Minecraft Bot'), 'contains title');
    assert(res.body.includes('donutsmp.net'), 'contains server name');
    assert(res.body.includes('microsoft.com/link'), 'contains Microsoft link');
  } catch (e) {
    assert(false, `request failed: ${e.message}`);
  }

  // ── Test 3: Auth code appears after 1s ──
  console.log('\nTest 3: Auth code in /status after mock auth flow');
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const res = await fetchJSON(`${BASE}/status`);
    assert(res.body.authCode === 'ABCD1234', 'authCode is ABCD1234');
    assert(res.body.authUrl === 'https://www.microsoft.com/link', 'authUrl is microsoft.com/link');
  } catch (e) {
    assert(false, `request failed: ${e.message}`);
  }

  // ── Test 4: Bot goes online after login ──
  console.log('\nTest 4: Bot goes online after mock login');
  await new Promise((r) => setTimeout(r, 6000));
  try {
    const res = await fetchJSON(`${BASE}/status`);
    assert(res.body.online === true, 'bot is online');
    assert(res.body.status.includes('Connected') || res.body.status.includes('AFK'), `status is "${res.body.status}"`);
  } catch (e) {
    assert(false, `request failed: ${e.message}`);
  }

  // ── Test 5: POST /control stop ──
  console.log('\nTest 5: POST /control { action: "stop" }');
  try {
    const res = await fetchJSON(`${BASE}/control`, {
      method: 'POST',
      jsonBody: { action: 'stop' },
    });
    assert(res.status === 200, 'status code is 200');
    assert(res.body.ok === true, 'response ok is true');
    assert(res.body.status === 'Stopped', 'status is Stopped');
  } catch (e) {
    assert(false, `request failed: ${e.message}`);
  }

  // Verify stopped
  try {
    const res = await fetchJSON(`${BASE}/status`);
    assert(res.body.running === false, 'running is false after stop');
  } catch (e) {
    assert(false, `request failed: ${e.message}`);
  }

  // ── Test 6: POST /control start ──
  console.log('\nTest 6: POST /control { action: "start" }');
  try {
    const res = await fetchJSON(`${BASE}/control`, {
      method: 'POST',
      jsonBody: { action: 'start' },
    });
    assert(res.status === 200, 'status code is 200');
    assert(res.body.ok === true, 'response ok is true');
  } catch (e) {
    assert(false, `request failed: ${e.message}`);
  }

  // Verify started
  await new Promise((r) => setTimeout(r, 500));
  try {
    const res = await fetchJSON(`${BASE}/status`);
    assert(res.body.running === true, 'running is true after start');
  } catch (e) {
    assert(false, `request failed: ${e.message}`);
  }

  // ── Test 7: Invalid action is ignored ──
  console.log('\nTest 7: POST /control with invalid action');
  try {
    const res = await fetchJSON(`${BASE}/control`, {
      method: 'POST',
      jsonBody: { action: 'invalid' },
    });
    assert(res.status === 200, 'status code is 200');
    assert(res.body.ok === true, 'response ok is true (graceful)');
  } catch (e) {
    assert(false, `request failed: ${e.message}`);
  }

  // ── Results ──
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

// Give the server a moment to start, then run tests
setTimeout(runTests, 500);
