// GridSyncV1 Backend Server - COMPLETE WORKING VERSION
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database paths
const DB_DIR = path.join(__dirname, 'database');
const GAMES_DB = path.join(DB_DIR, 'games.json');
const BANS_DB = path.join(DB_DIR, 'bans.json');
const BLACKLIST_DB = path.join(DB_DIR, 'blacklist.json');
const WARNINGS_DB = path.join(DB_DIR, 'warnings.json');
const GAME_STATE_DB = path.join(DB_DIR, 'gamestate.json');
const ANTICHEAT_DB = path.join(DB_DIR, 'anticheat.json');

// Initialize database
async function initDB() {
  try {
    await fs.mkdir(DB_DIR, { recursive: true });
    
    const files = [GAMES_DB, BANS_DB, BLACKLIST_DB, WARNINGS_DB, GAME_STATE_DB, ANTICHEAT_DB];
    for (const file of files) {
      try {
        await fs.access(file);
      } catch {
        await fs.writeFile(file, JSON.stringify({}));
      }
    }
    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Database init error:', error);
  }
}

// Helper functions
async function readDB(file) {
  try {
    const data = await fs.readFile(file, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeDB(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

// Middleware to verify API key
async function verifyAPIKey(req, res, next) {
  const apiKey = req.body.apiKey || req.query.apiKey || req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ success: false, message: 'No API key provided' });
  }
  
  const games = await readDB(GAMES_DB);
  if (!games[apiKey]) {
    return res.status(403).json({ success: false, message: 'Invalid API key' });
  }
  
  req.apiKey = apiKey;
  req.gameData = games[apiKey];
  next();
}

// ===== ROUTES =====

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'GridSyncV1 Backend is running' });
});

// Game registration
app.post('/api/game/register', async (req, res) => {
  const { gameName, ownerId, adminKey } = req.body;
  
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

// Moderation - Kick
app.post('/api/moderation/kick', verifyAPIKey, async (req, res) => {
  const { player, kickedBy } = req.body;
  
  const gameState = await readDB(GAME_STATE_DB);
  if (!gameState[req.apiKey]) gameState[req.apiKey] = { pendingActions: [] };
  
  gameState[req.apiKey].pendingActions.push({
    type: 'kick',
    player,
    kickedBy,
    timestamp: new Date().toISOString()
  });
  
  await writeDB(GAME_STATE_DB, gameState);
  
  res.json({ success: true, message: `Kick command queued for ${player}` });
});

// Moderation - Ban
app.post('/api/moderation/ban', verifyAPIKey, async (req, res) => {
  const { player, reason, duration, bannedBy, isTemp } = req.body;
  
  const bans = await readDB(BANS_DB);
  const banKey = `${req.apiKey}:${player}`;
  
  const expiresAt = isTemp ? calculateExpiry(duration) : null;
  
  bans[banKey] = {
    player,
    gameId: req.apiKey,
    reason,
    bannedBy,
    timestamp: new Date().toISOString(),
    isPermanent: !isTemp,
    expiresAt
  };
  
  await writeDB(BANS_DB, bans);
  
  const gameState = await readDB(GAME_STATE_DB);
  if (!gameState[req.apiKey]) gameState[req.apiKey] = { pendingActions: [] };
  
  gameState[req.apiKey].pendingActions.push({
    type: 'kick',
    player,
    reason: 'Banned',
    timestamp: new Date().toISOString()
  });
  
  await writeDB(GAME_STATE_DB, gameState);
  
  res.json({ success: true, message: `${player} has been banned` });
});

// Moderation - Unban
app.post('/api/moderation/unban', verifyAPIKey, async (req, res) => {
  const { player } = req.body;
  
  const bans = await readDB(BANS_DB);
  const banKey = `${req.apiKey}:${player}`;
  
  if (bans[banKey]) {
    delete bans[banKey];
    await writeDB(BANS_DB, bans);
    res.json({ success: true, message: `${player} has been unbanned` });
  } else {
    res.json({ success: false, message: `${player} is not banned` });
  }
});

// Moderation - Check Ban
app.get('/api/moderation/checkban/:player', verifyAPIKey, async (req, res) => {
  const player = req.params.player;
  const bans = await readDB(BANS_DB);
  const banKey = `${req.apiKey}:${player}`;
  
  const ban = bans[banKey];
  
  if (!ban) {
    return res.json({ success: true, isBanned: false });
  }
  
  if (!ban.isPermanent && ban.expiresAt) {
    if (new Date(ban.expiresAt) < new Date()) {
      delete bans[banKey];
      await writeDB(BANS_DB, bans);
      return res.json({ success: true, isBanned: false });
    }
  }
  
  res.json({ success: true, isBanned: true, ban });
});

// Moderation - Warn
app.post('/api/moderation/warn', verifyAPIKey, async (req, res) => {
  const { player, reason, warnedBy, warnedByRole } = req.body;
  
  const warnings = await readDB(WARNINGS_DB);
  const warnKey = `${req.apiKey}:${player}:${Date.now()}`;
  
  warnings[warnKey] = {
    player,
    gameId: req.apiKey,
    reason,
    warnedBy,
    warnedByRole,
    timestamp: new Date().toISOString()
  };
  
  await writeDB(WARNINGS_DB, warnings);
  
  const gameState = await readDB(GAME_STATE_DB);
  if (!gameState[req.apiKey]) gameState[req.apiKey] = { pendingActions: [] };
  
  gameState[req.apiKey].pendingActions.push({
    type: 'warn',
    player,
    reason,
    warnedBy,
    warnedByRole,
    timestamp: new Date().toISOString()
  });
  
  await writeDB(GAME_STATE_DB, gameState);
  
  res.json({ success: true, message: `Warning sent to ${player}` });
});

// Team Management
app.post('/api/teams/manage', verifyAPIKey, async (req, res) => {
  const { team, player, action } = req.body;
  
  const gameState = await readDB(GAME_STATE_DB);
  if (!gameState[req.apiKey]) gameState[req.apiKey] = { pendingActions: [], teams: { home: [], away: [], fans: [] } };
  
  gameState[req.apiKey].pendingActions.push({
    type: 'teamManage',
    team,
    player,
    action,
    timestamp: new Date().toISOString()
  });
  
  await writeDB(GAME_STATE_DB, gameState);
  
  res.json({ success: true, message: 'Team management command queued' });
});

app.post('/api/teams/clear', verifyAPIKey, async (req, res) => {
  const gameState = await readDB(GAME_STATE_DB);
  if (!gameState[req.apiKey]) gameState[req.apiKey] = { pendingActions: [] };
  
  gameState[req.apiKey].pendingActions.push({
    type: 'clearTeams',
    timestamp: new Date().toISOString()
  });
  
  await writeDB(GAME_STATE_DB, gameState);
  
  res.json({ success: true, message: 'Clear teams command queued' });
});

app.get('/api/teams/list', verifyAPIKey, async (req, res) => {
  const gameState = await readDB(GAME_STATE_DB);
  const teams = gameState[req.apiKey]?.teams || { home: [], away: [], fans: [] };
  
  res.json({ 
    success: true, 
    data: {
      homeTeam: teams.home,
      awayTeam: teams.away,
      fans: teams.fans
    }
  });
});

// Blacklist
app.post('/api/blacklist/add', verifyAPIKey, async (req, res) => {
  const { player, managedBy } = req.body;
  
  const blacklist = await readDB(BLACKLIST_DB);
  const key = `${req.apiKey}:${player}`;
  
  blacklist[key] = {
    player,
    gameId: req.apiKey,
    addedBy: managedBy,
    timestamp: new Date().toISOString()
  };
  
  await writeDB(BLACKLIST_DB, blacklist);
  
  res.json({ success: true, message: `${player} added to blacklist` });
});

app.post('/api/blacklist/remove', verifyAPIKey, async (req, res) => {
  const { player } = req.body;
  
  const blacklist = await readDB(BLACKLIST_DB);
  const key = `${req.apiKey}:${player}`;
  
  if (blacklist[key]) {
    delete blacklist[key];
    await writeDB(BLACKLIST_DB, blacklist);
    res.json({ success: true, message: `${player} removed from blacklist` });
  } else {
    res.json({ success: false, message: `${player} not in blacklist` });
  }
});

app.post('/api/blacklist/check', verifyAPIKey, async (req, res) => {
  const { player } = req.body;
  
  const blacklist = await readDB(BLACKLIST_DB);
  const key = `${req.apiKey}:${player}`;
  
  res.json({ success: true, isBlacklisted: !!blacklist[key] });
});

app.post('/api/blacklist/list', verifyAPIKey, async (req, res) => {
  const blacklist = await readDB(BLACKLIST_DB);
  const players = Object.values(blacklist)
    .filter(b => b.gameId === req.apiKey)
    .map(b => b.player);
  
  res.json({ success: true, players });
});

app.get('/api/blacklist/check/:player', verifyAPIKey, async (req, res) => {
  const player = req.params.player;
  const blacklist = await readDB(BLACKLIST_DB);
  const key = `${req.apiKey}:${player}`;
  
  res.json({ success: true, isBlacklisted: !!blacklist[key] });
});

// Lineup
app.post('/api/lineup/set', verifyAPIKey, async (req, res) => {
  const { homeManager, awayManager, format, music, animation } = req.body;
  
  const gameState = await readDB(GAME_STATE_DB);
  if (!gameState[req.apiKey]) gameState[req.apiKey] = { pendingActions: [] };
  
  gameState[req.apiKey].lineup = {
    homeManager,
    awayManager,
    format,
    music,
    animation,
    setAt: new Date().toISOString()
  };
  
  gameState[req.apiKey].pendingActions.push({
    type: 'setLineup',
    homeManager,
    awayManager,
    format,
    music,
    animation,
    timestamp: new Date().toISOString()
  });
  
  await writeDB(GAME_STATE_DB, gameState);
  
  res.json({ success: true, message: 'Lineup configured successfully' });
});

// Game state
app.post('/api/game/update', verifyAPIKey, async (req, res) => {
  const { players, teams, serverInfo } = req.body;
  
  const gameState = await readDB(GAME_STATE_DB);
  if (!gameState[req.apiKey]) gameState[req.apiKey] = { pendingActions: [] };
  
  gameState[req.apiKey].currentPlayers = players || [];
  gameState[req.apiKey].teams = teams || { home: [], away: [], fans: [] };
  gameState[req.apiKey].serverInfo = serverInfo || {};
  gameState[req.apiKey].lastUpdated = new Date().toISOString();
  
  await writeDB(GAME_STATE_DB, gameState);
  
  res.json({ success: true });
});

app.get('/api/game/poll', verifyAPIKey, async (req, res) => {
  const gameState = await readDB(GAME_STATE_DB);
  const actions = gameState[req.apiKey]?.pendingActions || [];
  
  if (gameState[req.apiKey]) {
    gameState[req.apiKey].pendingActions = [];
    await writeDB(GAME_STATE_DB, gameState);
  }
  
  res.json({ success: true, actions });
});

app.get('/api/game/players', verifyAPIKey, async (req, res) => {
  const gameState = await readDB(GAME_STATE_DB);
  const players = gameState[req.apiKey]?.currentPlayers || [];
  
  res.json({ success: true, players });
});

app.get('/api/game/info', verifyAPIKey, async (req, res) => {
  const gameState = await readDB(GAME_STATE_DB);
  const info = gameState[req.apiKey]?.serverInfo || {
    playerCount: 0,
    maxPlayers: 0,
    serverId: "Not connected",
    uptime: "0s"
  };
  
  res.json({ success: true, data: info });
});

// Anti-cheat
app.post('/api/anticheat/report', verifyAPIKey, async (req, res) => {
  const { player, violation, details } = req.body;
  
  const anticheat = await readDB(ANTICHEAT_DB);
  if (!anticheat[req.apiKey]) anticheat[req.apiKey] = { logs: [] };
  
  anticheat[req.apiKey].logs.push({
    player,
    violation,
    details,
    timestamp: new Date().toISOString()
  });
  
  if (anticheat[req.apiKey].logs.length > 100) {
    anticheat[req.apiKey].logs = anticheat[req.apiKey].logs.slice(-100);
  }
  
  await writeDB(ANTICHEAT_DB, anticheat);
  
  res.json({ success: true });
});

app.get('/api/anticheat/status', verifyAPIKey, async (req, res) => {
  const anticheat = await readDB(ANTICHEAT_DB);
  const logs = anticheat[req.apiKey]?.logs || [];
  
  const today = new Date().toDateString();
  const todayViolations = logs.filter(l => new Date(l.timestamp).toDateString() === today).length;
  
  res.json({ 
    success: true, 
    enabled: true,
    violations: todayViolations
  });
});

app.get('/api/anticheat/logs', verifyAPIKey, async (req, res) => {
  const anticheat = await readDB(ANTICHEAT_DB);
  const logs = anticheat[req.apiKey]?.logs || [];
  
  const recentLogs = logs.slice(-20).reverse().map(l => ({
    player: l.player,
    violation: l.violation,
    time: new Date(l.timestamp).toLocaleString()
  }));
  
  res.json({ success: true, logs: recentLogs });
});

// Helper functions
function generateAPIKey() {
  return 'GS_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function calculateExpiry(duration) {
  const now = new Date();
  const match = duration.match(/^(\d+)([mhd])$/);
  
  if (!match) return null;
  
  const [, amount, unit] = match;
  const ms = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  }[unit];
  
  return new Date(now.getTime() + (parseInt(amount) * ms)).toISOString();
}

// Start server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ GridSyncV1 Backend running on port ${PORT}`);
  });
});