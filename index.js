require('dotenv').config();
const dns = require('dns');
const mineflayer = require('mineflayer');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Fix DNS resolution — use Google DNS if the default resolver is broken
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config ───────────────────────────────────────────────────────────────────
const MC_USERNAME = process.env.MC_USERNAME;
const MC_IGN = process.env.MC_IGN; // In-game name (may differ from email). Falls back to bot.username after login.

if (!MC_USERNAME) {
  console.error('[Config] ERROR: MC_USERNAME environment variable is not set. Add it in Railway Variables. Retrying in 30s...');
  setTimeout(() => { process.exit(1); }, 30000);
  return;
}

// ─── Silence protodef chunk-size noise ────────────────────────────────────────
// protodef logs "Chunk size is X but Y was read" via console.log (not stderr)
// when 1.21.11 sends 2 extra bytes in update_hat player_info packets.
// The bytes are safely discarded by FullPacketParser; this is cosmetic only.
const _origLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Chunk size is')) return;
  _origLog(...args);
};

// Persistent folder so the Microsoft token is saved and reused on restarts
const AUTH_CACHE_DIR = path.join(__dirname, '.auth-cache');
fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true });

// ─── Bot State ────────────────────────────────────────────────────────────────
let bot = null;
let isReconnecting = false;
let botEnabled = true;
let statusMessage = 'Starting...';
let authCode = null;
let authUrl = null;
let reconnectTimer = null;
let hasCachedSession = false; // true if a saved Microsoft token exists
const cmdLog = []; // {time, dir, text} dir='in'=from server, 'out'=sent by us

// ─── AFK Focus ────────────────────────────────────────────────────────────────
// Periodically sends /findplayer <IGN>. If the server says the bot is in
// spawn/overworld (displaced), sends /afk 16 to return to the AFK zone.
// Handles Unicode Small Caps (ᴏᴠᴇʀᴡᴏʀʟᴅ), reconnection, and duplicate messages.
let afkFocusEnabled = false;
let afkCheckInterval = null;
let findplayerTimeout = null;
let waitingForFindplayer = false;
let needsAfkReturn = false;   // persists across reconnects — bot knows it's displaced
let lastAfk16Time = 0;        // cooldown to prevent spamming /afk 16

function getIGN() {
  return MC_IGN || (bot ? bot.username : MC_USERNAME);
}

// Convert ANY Unicode lookalike → ASCII so server messages always match.
// Handles Small Caps, Cyrillic homoglyphs, IPA, superscript, fullwidth, etc.
// "ѕᴘᴀᴡɴ" → "spawn", "ᴏᴠᴇʀᴡᴏʀʟᴅ" → "overworld", "ᴀꜰᴋ" → "afk"
function toAscii(str) {
  // Step 1: NFKC normalization handles many compatibility characters
  let out = str.normalize('NFKC');
  // Step 2: Map remaining non-ASCII lookalikes to ASCII
  out = out.replace(/[^\x00-\x7f]/g, (ch) => {
    const cp = ch.codePointAt(0);
    // ── Small Caps U+1D00-U+1D7F ──
    if (cp >= 0x1d00 && cp <= 0x1d7f) {
      const sc = 'abcd\u0000ef\u0000\u0000\u0000ghijklmnopqrstuvwxyz';
      const i = cp - 0x1d00;
      if (i < sc.length && sc[i] !== '\0') return sc[i];
    }
    // ── Small Caps U+A730-U+A7AF ──
    const a7 = { 0xa730:'f', 0xa731:'s', 0xa732:'f', 0xa733:'s', 0xa734:'f', 0xa735:'s' };
    if (cp >= 0xa730 && cp <= 0xa7af && a7[cp]) return a7[cp];
    // ── IPA Extensions U+0250-U+02AF ──
    const ipa = {
      0x0250:'a',0x0251:'a',0x0252:'a',0x0253:'b',0x0254:'o',0x0255:'c',
      0x0256:'d',0x0257:'d',0x0259:'e',0x025a:'e',0x025b:'e',0x025c:'e',
      0x025f:'j',0x0260:'g',0x0261:'g',0x0262:'g',0x0263:'g',0x0264:'r',
      0x0265:'h',0x0266:'h',0x0267:'h',0x0268:'i',0x0269:'i',0x026a:'i',
      0x026b:'l',0x026c:'l',0x026d:'l',0x026e:'l',0x026f:'m',
      0x0270:'m',0x0271:'m',0x0272:'n',0x0273:'n',0x0274:'n',0x0275:'o',
      0x0276:'o',0x0277:'o',0x0278:'o',0x0279:'r',0x027a:'r',0x027b:'r',
      0x027c:'r',0x027d:'r',0x027e:'r',0x027f:'r',
      0x0280:'r',0x0281:'r',0x0282:'s',0x0283:'s',0x0284:'j',
      0x0287:'t',0x0288:'t',0x0289:'u',0x028a:'u',0x028b:'v',
      0x028c:'v',0x028d:'w',0x028e:'y',0x028f:'y',
      0x0290:'z',0x0291:'z',0x0292:'z',0x0294:'?',0x0295:'o',
      0x0298:'o',0x0299:'b',0x029a:'e',0x029b:'g',0x029c:'h',
      0x029d:'j',0x029e:'k',0x029f:'l',0x02a0:'q',
    };
    if (cp >= 0x0250 && cp <= 0x02a0 && ipa[cp]) return ipa[cp];
    // ── Cyrillic homoglyphs U+0400-U+052F ──
    const cyr = {
      0x0430:'a',0x0432:'b',0x0435:'e',0x043a:'k',0x043c:'m',
      0x043d:'h',0x043e:'o',0x043f:'n',0x0440:'p',0x0441:'c',
      0x0442:'t',0x0443:'y',0x0445:'x',0x0454:'e',0x0455:'s',
      0x0456:'i',0x0458:'j',0x0475:'v',0x0493:'g',0x0497:'z',
      0x04ab:'c',0x04bb:'h',0x051b:'q',0x0501:'d',
    };
    if (cyr[cp]) return cyr[cp];
    // ── Fullwidth Latin U+FF00-U+FFEF ──
    if (cp >= 0xff41 && cp <= 0xff5a) return String.fromCodePoint(cp - 0xff21 + 0x41).toLowerCase();
    if (cp >= 0xff21 && cp <= 0xff3a) return String.fromCodePoint(cp - 0xff21 + 0x41).toLowerCase();
    // ── Superscript modifiers U+1D43-U+1DBF ──
    const sup = {
      0x1d43:'a',0x1d47:'b',0x1d9c:'c',0x1d30:'d',0x1d49:'e',
      0x1da0:'f',0x1da4:'g',0x1da6:'h',0x1da8:'i',0x1db2:'j',
      0x1db4:'k',0x1db6:'l',0x1db8:'m',0x1dba:'n',0x1dbe:'o',
      0x1dc0:'p',0x1dc2:'r',0x1dc4:'s',0x1dc6:'t',0x1dc8:'u',
      0x1dca:'v',0x1dcc:'w',0x1dce:'x',0x1dd0:'y',0x1dd2:'z',
    };
    if (sup[cp]) return sup[cp];
    // Unknown — keep as-is
    return ch;
  });
  return out;
}

function sendAfk16(source) {
  const now = Date.now();
  if (now - lastAfk16Time < 15000) {
    console.log(`[AFK Focus] /afk 16 on cooldown (${Math.ceil((15000 - (now - lastAfk16Time)) / 1000)}s left) — ${source}`);
    return false;
  }
  if (!bot || !bot.entity) {
    console.log(`[AFK Focus] Bot not available — marking needsAfkReturn=true (${source})`);
    needsAfkReturn = true;
    return false;
  }
  lastAfk16Time = now;
  needsAfkReturn = true;
  bot.chat('/afk 16');
  statusMessage = 'AFK Focus — Sent /afk 16';
  cmdLog.push({ time: now, dir: 'out', text: '/afk 16' });
  if (cmdLog.length > 200) cmdLog.splice(0, cmdLog.length - 200);
  console.log(`[AFK Focus] >>> /afk 16 sent (${source})`);
  return true;
}

function enableAfkFocus() {
  if (!bot || !bot.entity) return false;
  afkFocusEnabled = true;
  waitingForFindplayer = false;
  needsAfkReturn = false;
  lastAfk16Time = 0;
  statusMessage = 'Online — AFK Focus ON';
  console.log(`[AFK Focus] Enabled for ${getIGN()}`);
  // First check after 3s (give server time to settle), then every 60s
  setTimeout(() => { if (afkFocusEnabled && bot && bot.entity) doFindplayerCheck(); }, 3000);
  afkCheckInterval = setInterval(doFindplayerCheck, 60000);
  return true;
}

function disableAfkFocus() {
  afkFocusEnabled = false;
  waitingForFindplayer = false;
  needsAfkReturn = false;
  lastAfk16Time = 0;
  if (afkCheckInterval) { clearInterval(afkCheckInterval); afkCheckInterval = null; }
  if (findplayerTimeout) { clearTimeout(findplayerTimeout); findplayerTimeout = null; }
  if (bot && bot.entity && botEnabled) statusMessage = 'Online — AFK';
  console.log('[AFK Focus] Disabled.');
}

function doFindplayerCheck() {
  if (!afkFocusEnabled || !bot || !bot.entity || waitingForFindplayer) return;
  const ign = getIGN();
  waitingForFindplayer = true;
  bot.chat(`/findplayer ${ign}`);
  console.log(`[AFK Focus] Sent /findplayer ${ign}`);
  findplayerTimeout = setTimeout(() => {
    if (waitingForFindplayer) {
      console.log('[AFK Focus] No /findplayer response in 30s — resetting');
      waitingForFindplayer = false;
    }
    findplayerTimeout = null;
  }, 30000);
}

function handleServerMessage(text) {
  if (!afkFocusEnabled) return;
  const ascii = toAscii(text.toLowerCase());
  const ign = getIGN().toLowerCase();
  const ignStrip = ign.replace(/_+$/, '');

  // Must contain the IGN to be a /findplayer response
  if (!ascii.includes(ign) && !ascii.includes(ignStrip)) return;

  // Must contain a location keyword
  const isAfk = ascii.includes('afk');
  const isDisplaced = ascii.includes('spawn') || ascii.includes('overworld');
  if (!isAfk && !isDisplaced) return;

  // Only process if we were waiting (prevents false triggers from random chat)
  if (!waitingForFindplayer) {
    console.log(`[AFK Focus] Ignoring non-requested findplayer message: ${text}`);
    return;
  }

  waitingForFindplayer = false;
  if (findplayerTimeout) { clearTimeout(findplayerTimeout); findplayerTimeout = null; }

  if (isAfk) {
    needsAfkReturn = false;
    const match = text.match(/(?:afk|[ᴀꜰᴋ]+)\s*\d*/i) || text.match(/afk\s*\d*/i);
    const zone = match ? match[0].trim() : 'AFK';
    statusMessage = `Online — AFK Focus ON (${zone})`;
    console.log(`[AFK Focus] In AFK zone: ${zone}. Staying.`);
  } else if (isDisplaced) {
    console.log(`[AFK Focus] Displaced! (msg: ${text})`);
    sendAfk16('findplayer');
  }
}

// ─── Reconnect ────────────────────────────────────────────────────────────────
function scheduleReconnect(delaySec = 12) {
  if (!botEnabled || isReconnecting) return;
  isReconnecting = true;
  if (!statusMessage.includes('waiting')) {
    statusMessage = `Disconnected — reconnecting in ${delaySec}s...`;
  }
  console.log(`[Bot] Reconnecting in ${delaySec} seconds...`);
  reconnectTimer = setTimeout(() => {
    isReconnecting = false;
    createBot();
  }, delaySec * 1000);
}

// ─── Bot Creation ─────────────────────────────────────────────────────────────
function createBot() {
  if (!botEnabled || isReconnecting) return;

  authCode = null;
  authUrl = null;

  // Check if a cached Microsoft session exists
  const profileFile = path.join(AUTH_CACHE_DIR, `${MC_USERNAME}.json`);
  hasCachedSession = fs.existsSync(profileFile);

  if (hasCachedSession) {
    statusMessage = 'Connecting with saved session...';
    console.log(`[Bot] Connecting as ${MC_USERNAME} (using saved session)...`);
  } else {
    statusMessage = 'Connecting — will need Microsoft login...';
    console.log(`[Bot] Connecting as ${MC_USERNAME} (no saved session, will request auth code)...`);
  }

  bot = mineflayer.createBot({
    host: 'play.donutsmp.net',
    username: MC_USERNAME,
    version: false,
    auth: 'microsoft',
    profilesFolder: AUTH_CACHE_DIR,
    checkTimeoutInterval: 120000,
    keepAlive: true,
    physicsEnabled: false,
    onMsaCode: (data) => {
      // This is ONLY called when the saved session is missing or expired
      hasCachedSession = false;
      authCode = data.user_code;
      authUrl = 'https://www.microsoft.com/link';
      statusMessage = `Session expired — go to microsoft.com/link and enter code: ${authCode}`;
      console.log(`[Auth] Saved session not found or expired. Open https://www.microsoft.com/link and enter code: ${authCode}`);
    },
  });

  bot.on('login', () => {
    authCode = null;
    authUrl = null;
    isReconnecting = false;
    hasCachedSession = true; // login success means session is now saved
    statusMessage = `Connected as ${bot.username}`;
    console.log(`[Bot] Logged in as ${bot.username} (MC version: ${bot.version})`);
  });

  bot.on('spawn', () => {
    bot.physicsEnabled = false;
    if (afkFocusEnabled) {
      if (needsAfkReturn) {
        // Bot was displaced before disconnect — send /afk 16 first
        console.log('[AFK Focus] Spawned while displaced — sending /afk 16');
        sendAfk16('spawn-reconnect');
      }
      // Always restart the check cycle after spawn
      if (!afkCheckInterval) {
        setTimeout(() => { if (afkFocusEnabled && bot && bot.entity) doFindplayerCheck(); }, 5000);
        afkCheckInterval = setInterval(doFindplayerCheck, 60000);
      }
      if (!needsAfkReturn) statusMessage = 'Online — AFK Focus ON';
    } else {
      statusMessage = 'Online — AFK';
    }
    console.log('[Bot] Spawned. Physics disabled — standing still.');
  });

  let lastKickReason = null;

  bot.on('kicked', (reason) => {
    let msg;
    if (typeof reason === 'object' && reason !== null) {
      msg = reason.text || reason.translate || reason.value
        || reason.extra?.[0]?.text || JSON.stringify(reason);
    } else {
      try {
        const p = JSON.parse(reason);
        msg = p.text || p.translate || p.value || reason;
      } catch (_) {
        msg = String(reason);
      }
    }
    if (typeof msg === 'object') msg = JSON.stringify(msg);
    lastKickReason = msg;
    console.log(`[Bot] Kicked: ${msg}`);
    statusMessage = `Kicked: ${msg}`;
  });

  bot.on('end', (reason) => {
    console.log(`[Bot] Disconnected: ${reason || 'unknown'}`);
    bot = null;
    // Stop AFK focus interval while disconnected (will restart on spawn if enabled)
    if (afkCheckInterval) { clearInterval(afkCheckInterval); afkCheckInterval = null; }
    waitingForFindplayer = false;
    if (findplayerTimeout) { clearTimeout(findplayerTimeout); findplayerTimeout = null; }
    // Keep needsAfkReturn — if bot was displaced, it must /afk 16 after reconnect
    // But reset cooldown so /afk 16 can be sent immediately on next spawn
    lastAfk16Time = 0;

    const kick = (lastKickReason || '').toLowerCase();
    lastKickReason = null;

    let delay;
    if (kick.includes('max') && kick.includes('account')) {
      delay = 60;
      statusMessage = 'Too many sessions — waiting 60s before retry...';
      console.log('[Bot] Max accounts hit — waiting 60s for session to expire.');
    } else if (kick.includes('already online')) {
      delay = 30;
    } else {
      delay = 12;
    }
    scheduleReconnect(delay);
  });

  bot.on('error', (err) => {
    const msg = err.message || String(err);
    const code = err.code || '';
    console.log(`[Bot] Error: ${msg} (code: ${code})`);
    // Reconnect on network errors (AggregateError/ETIMEDOUT/ECONNREFUSED/ENOTFOUND)
    // and auth errors. The 'end' event also reconnects but may not fire for all errors.
    if (msg.includes('expired_token') || msg.includes('expired')) {
      statusMessage = 'Auth code expired — retrying...';
      authCode = null;
      bot = null;
      scheduleReconnect(5);
    } else if (msg.includes('Failed to obtain profile data') || msg.includes('does the account own minecraft')) {
      statusMessage = 'No Minecraft license — clearing cache and retrying...';
      console.log('[Bot] Profile data error — deleting cached token and retrying.');
      // Delete the corrupted/invalid cached token so next attempt does fresh auth
      try {
        const profileFile = path.join(AUTH_CACHE_DIR, `${MC_USERNAME}.json`);
        if (fs.existsSync(profileFile)) fs.unlinkSync(profileFile);
      } catch (_) {}
      bot = null;
      scheduleReconnect(10);
    } else if (msg.includes('403') || msg.includes('Forbidden')) {
      statusMessage = 'Auth forbidden — clearing cache and retrying...';
      console.log('[Bot] 403 Forbidden — deleting cached token.');
      try {
        const profileFile = path.join(AUTH_CACHE_DIR, `${MC_USERNAME}.json`);
        if (fs.existsSync(profileFile)) fs.unlinkSync(profileFile);
      } catch (_) {}
      bot = null;
      scheduleReconnect(15);
    } else if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'AggregateError' || msg.includes('AggregateError') || msg.includes('fetch failed')) {
      statusMessage = `Network error (${code || msg.slice(0, 30)}) — reconnecting...`;
      bot = null;
      scheduleReconnect(15);
    } else {
      statusMessage = `Error: ${msg.slice(0, 80)}`;
    }
  });

  // Log every visible server message so we can diagnose kicks
  bot.on('chat', (username, message) => {
    const fullText = `<${username}> ${message}`;
    console.log(`[Chat] ${fullText}`);
    cmdLog.push({ time: Date.now(), dir: 'in', text: fullText });
    if (cmdLog.length > 200) cmdLog.splice(0, cmdLog.length - 200);
    handleServerMessage(message);
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().trim();
    if (text) {
      console.log(`[Server] ${text}`);
      cmdLog.push({ time: Date.now(), dir: 'in', text });
      if (cmdLog.length > 200) cmdLog.splice(0, cmdLog.length - 200);
      handleServerMessage(text);
    }
  });
}

// ─── Unhandled rejection guard (auth flow) ────────────────────────────────────
process.on('unhandledRejection', (err) => {
  const msg = (err && err.message) ? err.message : String(err);
  console.log(`[Process] Unhandled rejection: ${msg}`);
  if (msg.includes('expired_token') || msg.includes('expired')) {
    statusMessage = 'Auth code expired — retrying in 5s...';
    authCode = null;
    bot = null;
    scheduleReconnect(5);
  } else if (msg.includes('Failed to obtain profile data') || msg.includes('does the account own minecraft')) {
    statusMessage = 'No Minecraft license — clearing cache and retrying...';
    try {
      const profileFile = path.join(AUTH_CACHE_DIR, `${MC_USERNAME}.json`);
      if (fs.existsSync(profileFile)) fs.unlinkSync(profileFile);
    } catch (_) {}
    bot = null;
    scheduleReconnect(10);
  } else if (msg.includes('403') || msg.includes('Forbidden')) {
    statusMessage = 'Auth forbidden — clearing cache and retrying...';
    try {
      const profileFile = path.join(AUTH_CACHE_DIR, `${MC_USERNAME}.json`);
      if (fs.existsSync(profileFile)) fs.unlinkSync(profileFile);
    } catch (_) {}
    bot = null;
    scheduleReconnect(15);
  }
});

// ─── Controls ─────────────────────────────────────────────────────────────────
function stopBot() {
  botEnabled = false;
  isReconnecting = false;
  authCode = null;
  authUrl = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  disableAfkFocus();
  statusMessage = 'Stopped';
  if (bot) { try { bot.quit('Stopped by user'); } catch (_) {} bot = null; }
  console.log('[Bot] Stopped by user.');
}

function startBot() {
  if (botEnabled && (bot || isReconnecting)) return;
  botEnabled = true;
  isReconnecting = false;
  statusMessage = 'Starting...';
  console.log('[Bot] Started by user.');
  createBot();
}

// ─── Web Dashboard ────────────────────────────────────────────────────────────
app.use(express.json());

function renderDashboard() {
  const needsAuth = authCode !== null;
  const isOnline = !!(bot && bot.entity);
  const usingSavedSession = hasCachedSession && !needsAuth && !isOnline;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Minecraft Bot Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #1e293b; border-radius: 16px; padding: 32px; max-width: 520px; width: 90%; box-shadow: 0 25px 50px rgba(0,0,0,0.4); }
  h1 { font-size: 22px; margin-bottom: 8px; }
  .subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
  .status-box { background: #0f172a; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .status-row { display: flex; align-items: center; gap: 10px; font-size: 16px; margin-bottom: 8px; }
  .status-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .status-dot.online { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
  .status-dot.auth { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }
  .status-dot.offline { background: #6b7280; }
  .auth-box { background: #1c1917; border: 2px solid #f59e0b; border-radius: 12px; padding: 24px; margin-bottom: 20px; text-align: center; }
  .auth-box h2 { color: #f59e0b; font-size: 18px; margin-bottom: 12px; }
  .auth-code { font-size: 36px; font-weight: 800; letter-spacing: 6px; color: #fff; background: #292524; padding: 16px; border-radius: 8px; margin: 12px 0; user-select: all; }
  .auth-link { display: inline-block; background: #2563eb; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; margin-top: 8px; }
  .auth-link:hover { background: #1d4ed8; }
  .auth-hint { color: #a8a29e; font-size: 13px; margin-top: 12px; }
  .cmd-section { margin-top: 20px; }
  .cmd-section h3 { font-size: 14px; color: #94a3b8; margin-bottom: 8px; }
  .quick-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .quick-btn { padding: 6px 12px; border: 1px solid #334155; border-radius: 6px; background: #1e293b; color: #e2e8f0; font-size: 13px; cursor: pointer; transition: all 0.15s; }
  .quick-btn:hover { background: #334155; border-color: #3b82f6; }
  .quick-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .quick-btn.buy { border-color: #22c55e; color: #22c55e; }
  .quick-btn.buy:hover { background: #22c55e22; }
  .quick-btn.check { border-color: #3b82f6; color: #3b82f6; }
  .quick-btn.check:hover { background: #3b82f622; }
  .cmd-box { display: flex; gap: 8px; }
  .cmd-input { flex: 1; padding: 12px 14px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 15px; outline: none; font-family: monospace; }
  .cmd-input:focus { border-color: #3b82f6; }
  .cmd-input::placeholder { color: #64748b; }
  .cmd-btn { padding: 12px 24px; border: none; border-radius: 8px; background: #7c3aed; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .cmd-btn:hover { background: #6d28d9; }
  .cmd-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .log-box { background: #0f172a; border-radius: 8px; padding: 12px; margin-top: 8px; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 13px; line-height: 1.6; }
  .log-box:empty::before { content: 'No commands yet'; color: #475569; }
  .log-out { color: #a78bfa; }
  .log-in { color: #94a3b8; }
  .log-time { color: #475569; font-size: 11px; margin-right: 6px; }
  .controls { display: flex; gap: 12px; margin-top: 12px; }
  .btn { flex: 1; padding: 12px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
  .btn:hover { opacity: 0.85; }
  .btn-stop { background: #dc2626; color: #fff; }
  .btn-start { background: #16a34a; color: #fff; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .afk-focus-box { background: #0f172a; border-radius: 12px; padding: 16px; margin-top: 12px; display: flex; align-items: center; justify-content: space-between; }
  .afk-focus-label { font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .afk-focus-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .afk-focus-dot.on { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
  .afk-focus-dot.off { background: #6b7280; }
  .afk-focus-btn { padding: 8px 16px; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .afk-focus-btn.enable { background: #22c55e; color: #fff; }
  .afk-focus-btn.enable:hover { background: #16a34a; }
  .afk-focus-btn.disable { background: #dc2626; color: #fff; }
  .afk-focus-btn.disable:hover { background: #b91c1c; }
  .afk-focus-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .info { color: #64748b; font-size: 12px; margin-top: 16px; text-align: center; }
  .refresh { color: #3b82f6; cursor: pointer; text-decoration: underline; font-size: 13px; }
</style>
</head>
<body>
<div class="card">
  <h1>\u26cf Minecraft Bot</h1>
  <p class="subtitle">play.donutsmp.net &mdash; AFK Bot</p>

  <div class="status-box">
    <div class="status-row">
      <span class="status-dot ${isOnline ? 'online' : needsAuth ? 'auth' : 'offline'}"></span>
      <span>${statusMessage}</span>
    </div>
    <div class="status-row" style="color:#64748b; font-size:13px;">
      Uptime: ${Math.floor(process.uptime())}s &bull; Running: ${botEnabled ? 'Yes' : 'No'}
    </div>
  </div>

  ${usingSavedSession ? `
  <div class="auth-box" style="border-color:#22c55e;">
    <h2 style="color:#22c55e;">\u2713 Saved Session Found</h2>
    <p style="color:#d6d3d1;">A Microsoft login session is saved. The bot will connect automatically without needing a new code.</p>
  </div>
  ` : ''}
  ${needsAuth ? `
  <div class="auth-box">
    <h2>\u26a0 Link Your Microsoft Account</h2>
    <p style="color:#d6d3d1; margin-bottom:8px;">Your saved session expired or doesn't exist. Link your account to connect.</p>
    <div class="auth-code">${authCode}</div>
    <a href="https://www.microsoft.com/link" target="_blank" class="auth-link">Open microsoft.com/link</a>
    <p class="auth-hint">Enter the code above at microsoft.com/link to link your account.</p>
  </div>
  ` : ''}

  <div class="cmd-section">
    <h3>Quick Commands</h3>
    <div class="quick-btns">
      <button class="quick-btn check" onclick="quickCmd('/shards')" ${!isOnline ? 'disabled' : ''}>\u2728 /shards</button>
      <button class="quick-btn check" onclick="quickCmd('/shardshop')" ${!isOnline ? 'disabled' : ''}>\ud83d\uded2 /shardshop</button>
      <button class="quick-btn buy" onclick="quickCmd('/buy spawner')" ${!isOnline ? 'disabled' : ''}>\ud83d\udc3e Buy Spawner</button>
      <button class="quick-btn buy" onclick="quickCmd('/buy key')" ${!isOnline ? 'disabled' : ''}>\ud83d\udd11 Buy Key</button>
      <button class="quick-btn buy" onclick="quickCmd('/buy crate')" ${!isOnline ? 'disabled' : ''}>\ud83d\udce6 Buy Crate</button>
      <button class="quick-btn" onclick="quickCmd('/bal')" ${!isOnline ? 'disabled' : ''}>\ud83d\udcb0 /bal</button>
      <button class="quick-btn" onclick="quickCmd('/hub')" ${!isOnline ? 'disabled' : ''}>\ud83c\udfe0 /hub</button>
    </div>
    <h3>Custom Command</h3>
    <div class="cmd-box">
      <input class="cmd-input" id="cmdInput" type="text" placeholder="Type any command... e.g. /shards" ${!isOnline ? 'disabled' : ''} onkeydown="if(event.key==='Enter')sendCmd()" autofocus>
      <button class="cmd-btn" id="cmdBtn" onclick="sendCmd()" ${!isOnline ? 'disabled' : ''}>Send</button>
    </div>
    <div class="log-box" id="logBox">${cmdLog.map(e => {
      const t = new Date(e.time).toLocaleTimeString();
      const cls = e.dir === 'out' ? 'log-out' : 'log-in';
      const prefix = e.dir === 'out' ? '\u25b8' : '\u25c2';
      return `<div class="${cls}"><span class="log-time">${t}</span>${prefix} ${e.text.replace(/</g,'&lt;')}</div>`;
    }).join('')}</div>
  </div>
  <div class="afk-focus-box">
    <span class="afk-focus-label"><span class="afk-focus-dot ${afkFocusEnabled ? 'on' : 'off'}"></span>AFK Focus ${afkFocusEnabled ? 'ON' : 'OFF'}</span>
    ${afkFocusEnabled
      ? '<button class="afk-focus-btn disable" onclick="fetch(\'/afk-focus\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({enabled:false})}).then(()=>location.reload())">Disable</button>'
      : `<button class="afk-focus-btn enable" onclick="fetch('/afk-focus',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})}).then(()=>location.reload())" ${!isOnline ? 'disabled' : ''}>Enable</button>`}
  </div>
  <div class="controls">
    <button class="btn btn-stop" onclick="fetch('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'stop'})}).then(()=>location.reload())" ${!botEnabled ? 'disabled' : ''}>Stop</button>
    <button class="btn btn-start" onclick="fetch('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start'})}).then(()=>location.reload())" ${botEnabled && (bot || isReconnecting) ? 'disabled' : ''}>Start</button>
  </div>

  <p class="info">Auto-refreshes every 5s &bull; <span class="refresh" onclick="location.reload()">Refresh now</span></p>
</div>

<script>
function quickCmd(cmd){
  fetch('/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:cmd})}).then(r=>r.json()).then(d=>{
    if(d.ok){
      const b=document.getElementById('logBox'),t=new Date().toLocaleTimeString();
      const row=document.createElement('div');row.className='log-out';
      row.innerHTML='<span class="log-time">'+t+'</span>▸ '+cmd.replace(/</g,'&lt;');
      b.appendChild(row);b.scrollTop=b.scrollHeight;
    }
  });
}
function sendCmd(){
  const i=document.getElementById('cmdInput'),v=i.value.trim();if(!v)return;
  fetch('/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:v})}).then(r=>r.json()).then(d=>{
    if(d.ok){
      const b=document.getElementById('logBox'),t=new Date().toLocaleTimeString();
      const row=document.createElement('div');row.className='log-out';
      row.innerHTML='<span class="log-time">'+t+'</span>▸ '+v.replace(/</g,'&lt;');
      b.appendChild(row);b.scrollTop=b.scrollHeight;i.value='';
    }
  });
}
function pollLog(){
  fetch('/log').then(r=>r.json()).then(d=>{
    const b=document.getElementById('logBox');
    let html='';
    for(const e of d){
      const t=new Date(e.time).toLocaleTimeString();
      const c=e.dir==='out'?'log-out':'log-in';
      const p=e.dir==='out'?'▸':'◂';
      html+='<div class="'+c+'"><span class="log-time">'+t+'</span>'+p+' '+e.text.replace(/</g,'&lt;')+'</div>';
    }
    b.innerHTML=html;b.scrollTop=b.scrollHeight;
  });
}
setInterval(pollLog,3000);
setTimeout(()=>location.reload(), 60000);
</script>
</body>
</html>`;
}

app.get('/', (_req, res) => {
  res.send(renderDashboard());
});

app.get('/status', (_req, res) => {
  res.json({
    running: botEnabled,
    online: !!(bot && bot.entity),
    status: statusMessage,
    authCode,
    authUrl,
    hasCachedSession,
    afkFocusEnabled,
    uptime: process.uptime(),
  });
});

app.post('/control', (req, res) => {
  const { action } = req.body;
  if (action === 'stop') stopBot();
  else if (action === 'start') startBot();
  res.json({ ok: true, status: statusMessage });
});

app.post('/afk-focus', (req, res) => {
  const { enabled } = req.body;
  if (enabled) {
    const ok = enableAfkFocus();
    res.json({ ok, afkFocusEnabled: true, status: statusMessage });
  } else {
    disableAfkFocus();
    res.json({ ok: true, afkFocusEnabled: false, status: statusMessage });
  }
});

app.post('/command', (req, res) => {
  const { cmd } = req.body;
  if (!cmd || typeof cmd !== 'string') return res.json({ ok: false, error: 'No command' });
  if (!bot || !bot.entity) return res.json({ ok: false, error: 'Bot not online' });
  bot.chat(cmd);
  cmdLog.push({ time: Date.now(), dir: 'out', text: cmd });
  if (cmdLog.length > 200) cmdLog.splice(0, cmdLog.length - 200);
  console.log(`[Cmd] Sent: ${cmd}`);
  res.json({ ok: true, sent: cmd });
});

app.get('/log', (_req, res) => {
  res.json(cmdLog.slice(-50));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Web] Control server on port ${PORT}`);
  createBot();
});
