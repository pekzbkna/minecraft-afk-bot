/**
 * Mock mineflayer — simulates a Minecraft bot without a real server.
 * Emits the same events as the real mineflayer bot so we can test
 * the web dashboard, reconnect logic, and auth flow.
 *
 * Behavior depends on whether a cached profile file exists:
 * - If profilesFolder has a .json file for the username → connects directly (no onMsaCode)
 * - If no cached file → calls onMsaCode first, then connects after delay
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

function createBot(options) {
  const bot = new EventEmitter();

  bot.username = options.username;
  bot.version = '1.21.4';
  bot.entity = null;
  bot.physics = { enabled: true };

  // Check if a cached session exists (same logic as real mineflayer)
  const profileFile = path.join(options.profilesFolder, `${options.username}.json`);
  const hasCachedSession = fs.existsSync(profileFile);

  if (hasCachedSession) {
    // Cached session: connect directly without asking for auth code
    setTimeout(() => {
      bot.emit('login');
      bot.entity = { position: { x: 0, y: 64, z: 0 } };
    }, 1000);

    setTimeout(() => {
      bot.emit('spawn');
    }, 1500);
  } else {
    // No cached session: request auth code first
    setTimeout(() => {
      if (options.onMsaCode) {
        options.onMsaCode({
          user_code: 'ABCD1234',
          verification_uri: 'https://www.microsoft.com/link',
        });
      }
    }, 500);

    // Simulate user completing the auth flow after 6s
    setTimeout(() => {
      bot.emit('login');
      bot.entity = { position: { x: 0, y: 64, z: 0 } };

      // Save a mock profile file so next connect uses cached session
      fs.writeFileSync(profileFile, JSON.stringify({
        username: options.username,
        msToken: 'mock-token',
      }));
    }, 6000);

    setTimeout(() => {
      bot.emit('spawn');
    }, 6500);
  }

  // Simulate a chat message after 8s
  setTimeout(() => {
    if (bot.entity) {
      bot.emit('chat', 'Notch', 'Hello world!');
    }
  }, 8000);

  // Simulate a server message after 9s
  setTimeout(() => {
    if (bot.entity) {
      bot.emit('message', { toString: () => 'Server: Welcome to DonutSMP!' });
    }
  }, 9000);

  // Methods
  bot.chat = (msg) => {
    console.log(`[Mock Chat] ${msg}`);
  };

  bot.quit = (reason) => {
    bot.emit('end', reason || 'quit');
    bot.entity = null;
  };

  return bot;
}

module.exports = { createBot };
