// Enhanced Backend with Anti-DDOS, Logging, and Full Game Endpoints
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { WebhookClient } = require('discord.js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ===== ANTI-DDOS SYSTEM =====
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 100;
const BLACKLIST = new Set();

function rateLimiter(req, res, next) {
  const identifier = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;

  if (BLACKLIST.has(identifier)) {
    return res.status(429).json({ success: false, message: 'Rate limit exceeded. IP temporarily blocked.' });
  }

  const now = Date.now();
  const record = rateLimitStore.get(identifier) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };

  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + RATE_LIMIT_WINDOW;
  }

  record.count++;
  rateLimitStore.set(identifier, record);

  if (record.count > MAX_REQUESTS_PER_WINDOW) {
    BLACKLIST.add(identifier);
    setTimeout(() => BLACKLIST.delete(identifier), 900000);
    console.warn(`⚠️ Rate limit exceeded for ${identifier} - Temporarily blocked`);
    return res.status(429).json({ success: false, message: 'Rate limit exceeded. Try again in 15 minutes.' });
  }

  res.setHeader('X-RateLimit-Limit', MAX_REQUESTS_PER_WINDOW);
  res.setHeader('X-RateLimit-Remaining', MAX_REQUESTS_PER_WINDOW - record.count);
  res.setHeader('X-RateLimit-Reset', record.resetTime);

  next();
}

app.use(rateLimiter);

// ===== LOGGING SYSTEM =====
const DB_DIR = path.join(__dirname, 'database');
const LOGS_DIR = path.join(__dirname, 'logs');
const COMMAND_LOGS_FILE = path.join(LOGS_DIR, 'command_logs.json');
const ARCHIVED_LOGS_DIR = path.join(LOGS_DIR, 'archived');

const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL;
let webhookClient = LOG_WEBHOOK_URL ? new WebhookClient({ url: LOG_WEBHOOK_URL }) : null;

async function initLogging() {
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
    await fs.mkdir(ARCHIVED_LOGS_DIR, { recursive: true });
    try { await fs.access(COMMAND_LOGS_FILE); } catch { await fs.writeFile(COMMAND_LOGS_FILE, JSON.stringify({ logs: [] })); }
    console.log('✅ Logging system initialized');
  } catch (error) {
    console.error('❌ Logging init error:', error);
  }
}

async function logCommand(apiKey, command, executor, target, details, success) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, apiKey, command, executor, target, details, success, id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}` };

  try {
    const data = await fs.readFile(COMMAND_LOGS_FILE, 'utf8');
    const logs = JSON.parse(data);
    logs.logs.push(logEntry);

    if (logs.logs.length > 1000) {
      await archiveLogs(logs.logs.slice(0, logs.logs.length - 1000));
      logs.logs = logs.logs.slice(-1000);
    }

    await fs.writeFile(COMMAND_LOGS_FILE, JSON.stringify(logs, null, 2));

    if (webhookClient) {
      const embed = {
        title: `Command: ${command}`,
        color: success ? 0x2ECC71 : 0xE74C3C,
        fields: [
          { name: 'Executor', value: executor, inline: true },
          { name: 'Target', value: target || 'N/A', inline: true },
          { name: 'Status', value: success ? '✅ Success' : '❌ Failed', inline: true },
          { name: 'Details', value: details || 'No details' }
        ],
        timestamp: new Date(),
        footer: { text: `API Key: ${apiKey.substring(0, 10)}...` }
      };
      await webhookClient.send({ embeds: [embed] }).catch(console.error);
    }

    console.log(`📝 Logged: ${command} by ${executor}`);
  } catch (error) {
    console.error('❌ Error logging command:', error);
  }
}

async function archiveLogs(oldLogs) {
  const archiveFile = path.join(ARCHIVED_LOGS_DIR, `logs_${Date.now()}.json`);
  await fs.writeFile(archiveFile, JSON.stringify({ logs: oldLogs }, null, 2));
  console.log(`📦 Archived ${oldLogs.length} old logs`);
}

// ===== DATABASE =====
const GAMES_DB = path.join(DB_DIR, 'games.json');
const BANS_DB = path.join(DB_DIR, 'bans.json');
const BLACKLIST_DB = path.join(DB_DIR, 'blacklist.json');
const WARNINGS_DB = path.join(DB_DIR, 'warnings.json');
const GAME_STATE_DB = path.join(DB_DIR, 'gamestate.json');
const ANTICHEAT_DB = path.join(DB_DIR, 'anticheat.json');

async function initDB() {
  try {
    await fs.mkdir(DB_DIR, { recursive: true });
    const files = [GAMES_DB, BANS_DB, BLACKLIST_DB, WARNINGS_DB, GAME_STATE_DB, ANTICHEAT_DB];
    for (const file of files) {
      try { await fs.access(file); } catch { await fs.writeFile(file, JSON.stringify({})); }
    }
    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Database init error:', error);
  }
}

async function readDB(file) {
  try { const data = await fs.readFile(file, 'utf8'); return JSON.parse(data); } catch { return {}; }
}
async function writeDB(file, data) { await fs.writeFile(file, JSON.stringify(data, null, 2)); }

// ===== API KEY VERIFY MIDDLEWARE =====
async function verifyAPIKey(req, res, next) {
  const apiKey = req.body.apiKey || req.query.apiKey || req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ success: false, message: 'No API key provided' });

  const games = await readDB(GAMES_DB);
  if (!games[apiKey]) return res.status(403).json({ success: false, message: 'Invalid API key' });

  req.apiKey = apiKey;
  req.gameData = games[apiKey];
  next();
}

// ===== HELPER FUNCTIONS =====
function generateAPIKey() { return 'GS_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15); }
function calculateExpiry(duration) {
  const now = new Date();
  const match = duration.match(/^(\d+)([mhd])$/);
  if (!match) return null;
  const [, amount, unit] = match;
  const ms = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[unit];
  return new Date(now.getTime() + parseInt(amount) * ms).toISOString();
}

// ===== ROUTES =====
app.get('/health', (req, res) => res.json({ status: 'ok', message: 'GridSyncV1 Backend is running' }));
app.get('/api/status', (req, res) => res.json({
  status: 'online',
  uptime: process.uptime(),
  rateLimits: { activeConnections: rateLimitStore.size, blacklistedIPs: BLACKLIST.size },
  timestamp: new Date().toISOString()
}));

// ---- LOGS ----
app.get('/api/logs', async (req, res) => {
  try {
    const apiKey = req.query.apiKey || req.headers['x-api-key'];
    const limit = parseInt(req.query.limit) || 50;
    const data = await fs.readFile(COMMAND_LOGS_FILE, 'utf8');
    const logs = JSON.parse(data);
    const filteredLogs = logs.logs.filter(log => log.apiKey === apiKey).slice(-limit).reverse();
    res.json({ success: true, logs: filteredLogs });
  } catch { res.status(500).json({ success: false, message: 'Error fetching logs' }); }
});

app.post('/api/logs/clear', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ success: false, message: 'Unauthorized' });
  try {
    const data = await fs.readFile(COMMAND_LOGS_FILE, 'utf8');
    const logs = JSON.parse(data);
    await archiveLogs(logs.logs);
    await fs.writeFile(COMMAND_LOGS_FILE, JSON.stringify({ logs: [] }));
    res.json({ success: true, message: 'Logs cleared and archived' });
  } catch { res.status(500).json({ success: false, message: 'Error clearing logs' }); }
});

// ---- GAME ENDPOINTS ----
// Game registration (for new customers)
app.post('/api/game/register', async (req, res) => {
  const { gameName, ownerId, adminKey } = req.body;
  
  // Verify admin key (you'll set this in .env - keeps registration secure)
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ success: false, message: 'Invalid admin key' });
  }
  
  const apiKey = generateAPIKey();
  const games = await readDB(GAMES_DB);
  
  games[apiKey] = {
    gameName,
    ownerId,
    createdAt: new Date().toISOString(),
    isActive: true
  };
  
  await writeDB(GAMES_DB, games);
  
  res.json({ success: true, apiKey, message: 'Game registered successfully' });
});

// Helper function (add at bottom of file, before app.listen)
function generateAPIKey() {
  return 'GS_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// ---- MODERATION ----
app.post('/api/moderation/kick', verifyAPIKey, async (req, res) => {
  const { player, kickedBy } = req.body;
  try {
    const gameState = await readDB(GAME_STATE_DB);
    if (!gameState[req.apiKey]) gameState[req.apiKey] = { pendingActions: [] };
    gameState[req.apiKey].pendingActions.push({ type: 'kick', player, kickedBy, timestamp: new Date().toISOString() });
    await writeDB(GAME_STATE_DB, gameState);
    await logCommand(req.apiKey, 'kick', kickedBy, player, 'Player kicked from game', true);
    res.json({ success: true, message: `Kick command queued for ${player}` });
  } catch (error) {
    await logCommand(req.apiKey, 'kick', kickedBy, player, `Error: ${error.message}`, false);
    res.status(500).json({ success: false, message: 'Error processing kick command' });
  }
});

app.post('/api/moderation/ban', verifyAPIKey, async (req, res) => {
  const { player, reason, duration, bannedBy, isTemp } = req.body;
  try {
    const bans = await readDB(BANS_DB);
    const banKey = `${req.apiKey}:${player}`;
    const expiresAt = isTemp ? calculateExpiry(duration) : null;
    bans[banKey] = { player, gameId: req.apiKey, reason, bannedBy, timestamp: new Date().toISOString(), isPermanent: !isTemp, expiresAt };
    await writeDB(BANS_DB, bans);
    const gameState = await readDB(GAME_STATE_DB);
    if (!gameState[req.apiKey]) gameState[req.apiKey] = { pendingActions: [] };
    gameState[req.apiKey].pendingActions.push({ type: 'kick', player, reason: 'Banned', timestamp: new Date().toISOString() });
    await writeDB(GAME_STATE_DB, gameState);
    await logCommand(req.apiKey, isTemp ? 'tempban' : 'ban', bannedBy, player, `Reason: ${reason}${isTemp ? ` | Duration: ${duration}` : ''}`, true);
    res.json({ success: true, message: `${player} has been banned` });
  } catch (error) {
    await logCommand(req.apiKey, 'ban', bannedBy, player, `Error: ${error.message}`, false);
    res.status(500).json({ success: false, message: 'Error processing ban' });
  }
});

// ===== START SERVER =====
Promise.all([initDB(), initLogging()]).then(() => {
  app.listen(PORT, () => {
    console.log(`✅ GridSyncV1 Backend running on port ${PORT}`);
    console.log(`🛡️ Anti-DDOS protection active`);
    console.log(`📝 Command logging enabled`);
  });
});
