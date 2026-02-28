import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

// __dirname replacement for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import wordListPath from "word-list";
import { RateLimiterMemory } from 'rate-limiter-flexible';

// Local profanity mask list (loaded from bad-words.json if available).
// Primary bad-words list is stored in `backend/bad-words.json`.
// Keep an empty fallback in code so the JSON file is authoritative and
// can be updated without modifying source.
let LOCAL_BAD_WORDS: string[] = [];
let LOCAL_BAD_PATTERN = /$^/; // matches nothing until we load the JSON

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const buildPattern = (words: string[]) => {
  if (!words || words.length === 0) return /$^/;
  return new RegExp(`\\b(${words.map(escapeRegex).join('|')})\\b`, 'gi');
};
const maskProfanity = (text: string) => text.replace(LOCAL_BAD_PATTERN, (m) => '*'.repeat(m.length));

const loadBadWords = (silent = false) => {
  const candidates = [
    path.join(process.cwd(), 'backend', 'bad-words.json'),
    path.resolve(__dirname, '..', 'bad-words.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          LOCAL_BAD_WORDS = parsed.slice();
          LOCAL_BAD_PATTERN = buildPattern(LOCAL_BAD_WORDS);
          if (!silent) console.log(`[server] loaded bad-words from ${p} (${LOCAL_BAD_WORDS.length} entries)`);
          return;
        }
      }
    } catch (e) {
      if (!silent) console.warn('[server] failed to load bad-words from', p, e);
    }
  }
  // Fallback: rebuild pattern from current array
  LOCAL_BAD_PATTERN = buildPattern(LOCAL_BAD_WORDS);
  if (!silent) console.log('[server] using embedded bad-words list');
};

// Attempt to load file at startup
loadBadWords(true);

type Player = {
  id: string;
  name: string;
  score: number;
  streakCount: number;
  streakPoints: number;
  streakBonusApplied: number;
  avatarColor: string;
  ready: boolean;
};

type WordCard = {
  id: number;
  revealed: boolean;
  length: number;
  word?: string;
};
type Winner = {
  name: string;
  score: number;
  avatarColor: string;
};

type GameState = {
  players: Player[];
  status: "lobby" | "active" | "ended";
  lobbyId: string;
  letters: string[];
  timeLeft: number;
  lastAction: string | null;
  cards: WordCard[];
  winner: Winner | null;
};

type DisconnectedPlayer = {
  player: Player;
  revealedWords: Set<number>;
  disconnectedAt: number;
  cleanupTimer: NodeJS.Timeout;
};

type ChatMessage = {
  id: string;
  playerId: string;
  playerName: string;
  playerColor: string;
  message: string;
  timestamp: number;
};

type Lobby = {
  id: string;
  state: GameState;
  letters: string[];
  sessionWords: string[];
  revealedByPlayer: Map<string, Set<number>>;
  wordIndex: Map<string, number>;
  submittedWords: Map<string, Set<string>>; // playerId -> Set of words
  hiddenBonusAwarded: Set<string>;
  sessionEndAt: number | null;
  resetTimer: NodeJS.Timeout | null;
  lobbyCountdownTimer: NodeJS.Timeout | null;
  lobbyCountdownEndAt: number | null;
  lobbyCountdownInterval: NodeJS.Timeout | null;
  lobbyCountdownLastValue: number | null;
  resetCountdownEndAt: number | null;
  resetCountdownInterval: NodeJS.Timeout | null;
  disconnectedPlayers: Map<string, DisconnectedPlayer>;
  chatMessages: ChatMessage[];
  botMeta?: Map<string, { difficulty: 'easy' | 'medium' | 'hard' | 'genius' }>;
  botTimers?: Map<string, NodeJS.Timeout[]>;
};

type SubmitAck = {
  ok: boolean;
  error?: string;
  word?: string;
};

const MIN_PLAYERS_TO_START = 2;
const MAX_PLAYERS = 7;
const LOBBY_COUNTDOWN_SECONDS = 5;
const SESSION_SECONDS = 120;
const LETTER_COUNT = 6;
const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 6;
const TARGET_WORD_MIN = 30;
const TARGET_WORD_MAX = 30;
const RESET_DELAY_SECONDS = 10;
const DISCONNECT_GRACE_PERIOD = 60000;
const POINTS_PER_LETTER = 100;
const INVALID_WORD_PENALTY = 50;
const ALL_HIDDEN_BONUS = 3000;

const VOWELS = ["A", "E", "I", "O", "U"];
const CONSONANTS = "BCDFGHJKLMNPQRSTVWXYZ".split("");
const AVATAR_COLORS = [
  "#ef476f",
  "#ffd166",
  "#06d6a0",
  "#118ab2",
  "#9b5de5",
  "#f3722c",
  "#43aa8b"
];

const rawWords = fs.readFileSync(wordListPath, "utf-8").split("\n");
const dictionary = rawWords
  .map((word) => word.trim().toLowerCase())
  .filter((word) => word.length >= MIN_WORD_LENGTH && word.length <= MAX_WORD_LENGTH);
const dictionarySet = new Set(dictionary);

// Chat rate limiter (per-socket id). Allows 4 messages per 4 seconds by default.
const chatLimiter = new RateLimiterMemory({ points: 4, duration: 4 });

const app = express();
// Trust proxies (Cloudflare) so Express derives client IPs properly
app.set("trust proxy", true);

// Expose the real client IP (prefer Cloudflare header) on the request for logging and rate-limiting
app.use((req, _res, next) => {
  (req as any).realIP = (req.headers["cf-connecting-ip"] as string) || req.ip;
  next();
});
const server = http.createServer(app);
const allowedOrigins = [
  "http://localhost:5173",
  "https://lettertiles.onrender.com"
];
// Add production origins (frontend) so socket.io and API requests are allowed
allowedOrigins.push("https://www.letter-tiles.com", "https://letter-tiles.com");

const io = new Server(server, {
  cors: {
    origin: allowedOrigins
  }
});

app.use(cors({ origin: allowedOrigins }));
// Parse JSON bodies for lightweight event logging
app.use(express.json());

// Lightweight endpoint for ad-related frontend events (injection, init, errors)
app.post("/ad-event", (req, res) => {
  try {
    const body = req.body || {};
    const client = body.client || "unknown";
    const event = body.event || "unknown";
    const info = body.info || null;
    console.log(`[ad-event] client=${client} event=${event} info=${JSON.stringify(info)}`);
  } catch (e) {
    console.warn("[ad-event] failed to parse body");
  }
  res.status(204).end();
});

// Admin endpoint to reload bad-words.json at runtime (no auth in this simple patch).
app.post('/admin/reload-bad-words', (_req, res) => {
  try {
    loadBadWords();
    res.json({ ok: true, count: LOCAL_BAD_WORDS.length });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

const endSession = (lobby: Lobby) => {
  // Clear any pending bot timers immediately to avoid stray submissions
  if (lobby.botTimers) {
    lobby.botTimers.forEach((timers) => timers.forEach((t) => clearTimeout(t)));
    lobby.botTimers.clear();
  }

  lobby.state.status = "ended";
  lobby.sessionEndAt = null;

  const sorted = [...lobby.state.players].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  lobby.state.winner = top
    ? {
        name: top.name,
        score: top.score,
        avatarColor: top.avatarColor
      }
    : null;
  lobby.state.lastAction = top ? `${top.name} wins the round` : "Round ended";
  broadcastState(lobby);
  startResetCountdown(lobby);
  // Increment global total rounds and persist/broadcast the new total.
  try {
    incrementTotalRoundsAtomic().then((newTotal) => {
      totalRounds = newTotal;
      io.emit('totalRoundsUpdated', totalRounds);
    }).catch((e) => {
      console.warn('[server] failed to update totalRounds in endSession', e);
    });
  } catch (e) {
    console.warn('[server] failed to update totalRounds in endSession', e);
  }
  if (lobby.resetTimer) {
    clearTimeout(lobby.resetTimer);
  }
  lobby.resetTimer = setTimeout(() => {
    lobby.state.status = "lobby";
    lobby.state.lastAction = "Lobby reset";
    lobby.state.winner = null;
    lobby.letters = [];
    lobby.sessionWords = [];
    lobby.revealedByPlayer = new Map();
    lobby.wordIndex = new Map();
    lobby.submittedWords = new Map();
    lobby.hiddenBonusAwarded = new Set();
    lobby.sessionEndAt = null;
    lobby.state.timeLeft = SESSION_SECONDS;
    lobby.state.cards = [];
    // Keep bots ready so bot-only lobbies automatically restart
    const botIds = new Set(lobby.botMeta ? Array.from(lobby.botMeta.keys()) : []);
    lobby.state.players = lobby.state.players.map((player) => ({
      ...player,
      ready: botIds.has(player.id) ? true : false
    }));
    resetScores(lobby);
    // Ensure no leftover bot timers remain
    if (lobby.botTimers) {
      lobby.botTimers.forEach((timers) => timers.forEach((t) => clearTimeout(t)));
      lobby.botTimers.clear();
    }
    stopLobbyCountdown(lobby);
    stopResetCountdown(lobby);
    if (lobby.state.players.length > 0) {
      broadcastState(lobby);
    } else {
      destroyLobby(lobby);
    }
  }, RESET_DELAY_SECONDS * 1000);
};

// Abort an active session without counting it towards global rounds.
// Used when the human player(s) leave during a bots-only match.
const abortSessionWithoutCounting = (lobby: Lobby) => {
  // Stop any timers and clear bot timers
  stopLobbyCountdown(lobby);
  stopResetCountdown(lobby);
  if (lobby.resetTimer) {
    clearTimeout(lobby.resetTimer);
    lobby.resetTimer = null;
  }
  if (lobby.botTimers) {
    lobby.botTimers.forEach((timers) => timers.forEach((t) => clearTimeout(t)));
    lobby.botTimers.clear();
  }
  // Reset session state without incrementing global counter
  lobby.state.status = "lobby";
  lobby.state.lastAction = "Session aborted (no players)";
  lobby.state.winner = null;
  lobby.letters = [];
  lobby.sessionWords = [];
  lobby.revealedByPlayer = new Map();
  lobby.wordIndex = new Map();
  lobby.submittedWords = new Map();
  lobby.hiddenBonusAwarded = new Set();
  lobby.sessionEndAt = null;
  lobby.state.timeLeft = SESSION_SECONDS;
  lobby.state.cards = [];
  // Keep bots ready so if a human rejoins we can auto-start as desired
  const botIds = new Set(lobby.botMeta ? Array.from(lobby.botMeta.keys()) : []);
  lobby.state.players = lobby.state.players.map((player) => ({
    ...player,
    ready: botIds.has(player.id) ? true : false
  }));
  resetScores(lobby);
  broadcastState(lobby);
};

const getTimeLeft = (lobby: Lobby) => {
  if (!lobby.sessionEndAt) {
    return SESSION_SECONDS;
  }
  const diff = Math.ceil((lobby.sessionEndAt - Date.now()) / 1000);
  return Math.max(0, diff);
};

const buildCardsForPlayer = (lobby: Lobby, playerId: string | null): WordCard[] => {
  const revealedForPlayer = playerId ? lobby.revealedByPlayer.get(playerId) : undefined;
  return lobby.sessionWords.map((word, index) => {
    const isRevealed =
      lobby.state.status === "ended" ||
      (revealedForPlayer ? revealedForPlayer.has(index) : false);
    return isRevealed
      ? {
          id: index,
          revealed: true,
          length: word.length,
          word: word.toUpperCase()
        }
      : {
          id: index,
          revealed: false,
          length: word.length
        };
  });
};

const LOBBY_COLORS = [
  "RED", "BLUE", "GREEN", "PURPLE", "ORANGE", "PINK", "YELLOW", "TEAL"
];

const LOBBY_ANIMALS = [
  "TIGER", "WOLF", "EAGLE", "LION", "BEAR", "SHARK", "HAWK", "DRAGON",
  "FALCON", "PANDA", "COBRA", "RAVEN", "FOX", "LYNX", "ORCA"
];

const lobbies = new Map<string, Lobby>();
const socketLobbyMap = new Map<string, string>();
let lobbyCounter = 1;

// Global total rounds counter (stored in DB when available)
let totalRounds = 0;
// Optional Postgres pool (Neon). If `DATABASE_URL` is set in the environment
// we'll attempt to use Postgres for durable, atomic updates.
let dbPool: Pool | null = null;
const DATABASE_URL = process.env.DATABASE_URL || null;

const initDb = async () => {
  if (!DATABASE_URL) return;
  try {
    dbPool = new Pool({ connectionString: DATABASE_URL, max: 5, ssl: { rejectUnauthorized: false } });
    // Ensure table exists and a row for totalRounds is present.
    await dbPool.query(`CREATE TABLE IF NOT EXISTS global_meta (key TEXT PRIMARY KEY, total BIGINT NOT NULL DEFAULT 0)`);
    await dbPool.query(`INSERT INTO global_meta(key, total) VALUES($1, $2) ON CONFLICT DO NOTHING`, ['totalRounds', 0]);
    const res = await dbPool.query(`SELECT total FROM global_meta WHERE key = $1 LIMIT 1`, ['totalRounds']);
    if (res.rows.length > 0) {
      totalRounds = Number(res.rows[0].total) || 0;
      console.log('[server] loaded totalRounds from database =', totalRounds);
    }
  } catch (e) {
    console.warn('[server] failed to initialize database for totalRounds, falling back to file', e);
    dbPool = null;
  }
};
// No file fallback — when DATABASE_URL is present we initialize from DB.
// Otherwise `totalRounds` defaults to 0 for in-memory counting.
// Initialize DB in background (if configured). File fallback already loaded above.
void initDb();

// Atomically increment total rounds using DB when available. Returns the new total.
const incrementTotalRoundsAtomic = async (): Promise<number> => {
  if (dbPool) {
    try {
      const res = await dbPool.query('UPDATE global_meta SET total = total + 1 WHERE key = $1 RETURNING total', ['totalRounds']);
      if (res.rowCount === 0) {
        await dbPool.query('INSERT INTO global_meta(key, total) VALUES($1, 1)', ['totalRounds']);
        return 1;
      }
      return Number(res.rows[0].total);
    } catch (e) {
      console.warn('[server] DB increment failed, falling back to file', e);
      // fall through to in-memory fallback
    }
  }
  totalRounds = (totalRounds || 0) + 1;
  return totalRounds;
};

// Bot helpers
const createBotForLobby = (lobby: Lobby, difficulty: 'easy' | 'medium' | 'hard' | 'genius', index: number) => {
  const botId = `bot-${lobby.id}-${index}-${Date.now()}`;
  const name = `Bot ${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)} #${index}`;
  const avatarColor = AVATAR_COLORS[(lobby.state.players.length) % AVATAR_COLORS.length];
  const bot: Player = {
    id: botId,
    name,
    score: 0,
    streakCount: 0,
    streakPoints: 0,
    streakBonusApplied: 0,
    avatarColor,
    ready: true
  };
  lobby.state.players.push(bot);
  lobby.revealedByPlayer.set(botId, new Set<number>());
  lobby.submittedWords.set(botId, new Set<string>());
  lobby.hiddenBonusAwarded = lobby.hiddenBonusAwarded || new Set();
  lobby.botMeta = lobby.botMeta || new Map();
  lobby.botMeta.set(botId, { difficulty });
  lobby.botTimers = lobby.botTimers || new Map();
  lobby.botTimers.set(botId, []);
};

const botSubmitWord = (lobby: Lobby, botId: string) => {
  const bot = getPlayer(lobby, botId);
  if (!bot || lobby.state.status !== 'active') return;
  const submitted = lobby.submittedWords.get(botId) ?? new Set<string>();
  // Build a global set of already-submitted words (by any player) so bots
  // prefer unique words instead of duplicating other players' submissions.
  const globalSubmitted = new Set<string>();
  lobby.submittedWords.forEach((set) => {
    for (const w of set) globalSubmitted.add(w.toLowerCase());
  });
  // pick an unsubmitted session word (not already submitted by anyone)
  let candidates = lobby.sessionWords.filter((w) => !globalSubmitted.has(w.toLowerCase()));
  // If there are no truly-unique candidates left, fall back to per-bot candidates
  if (candidates.length === 0) {
    candidates = lobby.sessionWords.filter((w) => !submitted.has(w.toLowerCase()));
  }
  if (candidates.length === 0) return;
  // Determine difficulty accuracy from lobby metadata (fallback to medium)
  const meta = lobby.botMeta?.get(botId);
  const difficulty = meta?.difficulty || 'medium';
  const accuracyMap: Record<string, number> = { easy: 0.2, medium: 0.3, hard: 0.5, genius: 0.8 };
  const accuracy = accuracyMap[difficulty] ?? 0.8;
  // mistakeChance: chance the bot intentionally picks a poor/short word instead of a high-scoring one
  const mistakeMap: Record<string, number> = { easy: 0.8, medium: 0.7, hard: 0.5, genius: 0.2 };
  const mistakeChance = mistakeMap[difficulty] ?? 0.2;
  // Prefer longer words with probability=accuracy, otherwise pick a random candidate
  let pick: string;
  if (Math.random() < accuracy) {
    candidates.sort((a, b) => b.length - a.length);
    // pick from top 3 longer words
    const topN = Math.min(3, candidates.length);
    pick = candidates[Math.floor(Math.random() * topN)];
  } else {
    // Mistake branch: either pick a short/low-scoring word with some chance, otherwise random
    if (Math.random() < mistakeChance) {
      candidates.sort((a, b) => a.length - b.length); // shortest first
      const bottomN = Math.min(3, candidates.length);
      pick = candidates[Math.floor(Math.random() * bottomN)];
    } else {
      pick = candidates[Math.floor(Math.random() * candidates.length)];
    }
  }
  const MAX_PICK_ATTEMPTS = 5;
  let normalized = pick.toLowerCase();
  // If another player has submitted this word since we built candidates (race),
  // try to pick a different candidate a few times before giving up.
  let attempt = 0;
  while (attempt < MAX_PICK_ATTEMPTS) {
    let conflict = false;
    for (const s of lobby.submittedWords.values()) {
      if (s.has(normalized)) { conflict = true; break; }
    }
    if (!conflict) break;
    // remove conflicted candidate and pick another
    candidates = candidates.filter((w) => w.toLowerCase() !== normalized);
    if (candidates.length === 0) break;
    pick = candidates[Math.floor(Math.random() * candidates.length)];
    normalized = pick.toLowerCase();
    attempt += 1;
  }
  const index = lobby.wordIndex.get(normalized);
  if (index !== undefined) {
    const revealedForPlayer = lobby.revealedByPlayer.get(botId) ?? new Set<number>();
    if (!revealedForPlayer.has(index)) {
      revealedForPlayer.add(index);
      lobby.revealedByPlayer.set(botId, revealedForPlayer);
    }
  }
  submitted.add(normalized);
  lobby.submittedWords.set(botId, submitted);
  const length = normalized.length;
  const basePoints = length * POINTS_PER_LETTER;
  const lengthBonus = getLengthBonus(length);
  const hiddenBonus = index !== undefined ? getHiddenBonus(length) : 0;
  const wordPoints = basePoints + lengthBonus + hiddenBonus;
  applyValidScore(bot, wordPoints);
  if (index !== undefined) {
    const revealedForPlayer = lobby.revealedByPlayer.get(botId);
    if (
      revealedForPlayer &&
      revealedForPlayer.size === lobby.sessionWords.length &&
      !lobby.hiddenBonusAwarded.has(botId)
    ) {
      lobby.hiddenBonusAwarded.add(botId);
      bot.score += ALL_HIDDEN_BONUS;
    }
  }
  lobby.state.lastAction = `${bot.name} submitted ${normalized.toUpperCase()}`;
  broadcastState(lobby);
};

const scheduleBotsForLobby = (lobby: Lobby) => {
  if (!lobby.botMeta || !lobby.botTimers) return;
  // Clear any existing timers
  lobby.botTimers.forEach((timers) => timers.forEach((t) => clearTimeout(t)));
  lobby.botTimers.clear();
  // For each bot, schedule submissions spaced across the session duration
  const sessionMs = SESSION_SECONDS * 1000;
  let botIndex = 0;
  for (const [botId, meta] of lobby.botMeta.entries()) {
    const timers: NodeJS.Timeout[] = [];
    const difficulty = meta.difficulty;
    // base attempts per difficulty, then add a small random delta so bots
    // don't all have identical counts
    let attempts = difficulty === 'easy' ? 4 : difficulty === 'medium' ? 6 : difficulty === 'hard' ? 9 : 12;
    attempts += Math.floor(Math.random() * 3) - 1; // -1,0 or +1
    // ensure attempts fit reasonably within session
    attempts = Math.max(1, Math.min(attempts, 20));
    // per-bot initial offset to de-synchronize bots
    const initialOffset = Math.floor(Math.random() * Math.min(3000, Math.max(500, Math.round(sessionMs / Math.max(1, attempts)))));
    for (let i = 0; i < attempts; i++) {
      // schedule roughly evenly, with larger jitter and a small index-based offset
      const base = (i + 1) * (sessionMs / (attempts + 1));
      const maxJitter = Math.min(8000, Math.round(sessionMs / Math.max(1, attempts)));
      const jitter = Math.floor((Math.random() - 0.5) * maxJitter);
      // slight staggering by bot index so multiple bots don't align
      const indexOffset = botIndex * 220;
      const delay = Math.max(500, Math.round(base + jitter + initialOffset + indexOffset));
      const t = setTimeout(() => {
        try { botSubmitWord(lobby, botId); } catch (_) {}
      }, delay);
      timers.push(t);
    }
    lobby.botTimers.set(botId, timers);
    botIndex += 1;
  }
};

const pickRandom = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

const shuffle = <T,>(items: T[]) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
};

const generateLobbyId = () => {
  const color = pickRandom(LOBBY_COLORS);
  const animal = pickRandom(LOBBY_ANIMALS);
  const number = lobbyCounter++;
  return `${color}-${animal}-${number}`;
};

const createLobby = () => {
  const lobbyId = generateLobbyId();
  const lobby: Lobby = {
    id: lobbyId,
    state: {
      players: [],
      status: "lobby",
      lobbyId,
      letters: [],
      timeLeft: SESSION_SECONDS,
      lastAction: null,
      cards: [],
      winner: null
    },
    letters: [],
    sessionWords: [],
    revealedByPlayer: new Map(),
    wordIndex: new Map(),
    submittedWords: new Map(),
    hiddenBonusAwarded: new Set(),
    sessionEndAt: null,
    resetTimer: null,
    lobbyCountdownTimer: null,
    lobbyCountdownEndAt: null,
    lobbyCountdownInterval: null,
    lobbyCountdownLastValue: null,
    resetCountdownEndAt: null,
    resetCountdownInterval: null,
    disconnectedPlayers: new Map(),
    chatMessages: []
    ,
    botMeta: new Map(),
    botTimers: new Map()
  };
  lobbies.set(lobbyId, lobby);
  return lobby;
};

const getLobbyForJoin = () => {
  for (const lobby of lobbies.values()) {
    if (lobby.state.status === "lobby" && lobby.state.players.length < MAX_PLAYERS) {
      return lobby;
    }
  }
  return createLobby();
};

const getLobbyForSocket = (socketId: string) => {
  const lobbyId = socketLobbyMap.get(socketId);
  return lobbyId ? lobbies.get(lobbyId) ?? null : null;
};

const getLobbyById = (lobbyId: string) => {
  return lobbies.get(lobbyId) ?? null;
};

const generateLetters = () => {
  const letterBag: string[] = [];
  letterBag.push(pickRandom(VOWELS));
  letterBag.push(pickRandom(VOWELS));
  while (letterBag.length < LETTER_COUNT) {
    letterBag.push(pickRandom(CONSONANTS));
  }
  return shuffle(letterBag);
};

const canFormWord = (lettersInput: string[], word: string) => {
  const counts = new Map<string, number>();
  lettersInput.forEach((letter) => {
    const key = letter.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  for (const char of word) {
    const remaining = counts.get(char);
    if (!remaining) {
      return false;
    }
    counts.set(char, remaining - 1);
  }
  return true;
};

const getLengthBonus = (length: number) => {
  switch (length) {
    case 4:
      return 50;
    case 5:
      return 100;
    case 6:
      return 200;
    default:
      return 0;
  }
};

const getHiddenBonus = (length: number) => {
  switch (length) {
    case 3:
      return 150;
    case 4:
      return 300;
    case 5:
      return 750;
    case 6:
      return 1600;
    default:
      return 0;
  }
};

const getStreakMultiplier = (streakCount: number) => {
  if (streakCount >= 5) {
    return 0.5;
  }
  if (streakCount === 4) {
    return 0.35;
  }
  if (streakCount === 3) {
    return 0.2;
  }
  if (streakCount === 2) {
    return 0.1;
  }
  return 0;
};

const resetStreak = (player: Player) => {
  player.streakCount = 0;
  player.streakPoints = 0;
  player.streakBonusApplied = 0;
};

const applyValidScore = (player: Player, wordPoints: number) => {
  player.streakCount += 1;
  player.streakPoints += wordPoints;
  const multiplier = getStreakMultiplier(player.streakCount);
  const streakBonusTotal = Math.round(player.streakPoints * multiplier);
  const streakBonusDelta = streakBonusTotal - player.streakBonusApplied;
  player.streakBonusApplied = streakBonusTotal;
  player.score += wordPoints + streakBonusDelta;
};

const applyInvalidPenalty = (player: Player) => {
  player.score = Math.max(0, player.score - INVALID_WORD_PENALTY);
  resetStreak(player);
};

const pickSessionWords = (lettersInput: string[]) => {
  const validWords = dictionary.filter((word) => canFormWord(lettersInput, word));
  const targetCount =
    TARGET_WORD_MIN + Math.floor(Math.random() * (TARGET_WORD_MAX - TARGET_WORD_MIN + 1));
  const shuffled = shuffle(validWords);
  return shuffled.slice(0, Math.min(targetCount, shuffled.length));
};

const MAX_SESSION_ATTEMPTS = 120;

const buildSession = (lobby: Lobby) => {
  let words: string[] = [];
  let bestLetters: string[] = [];
  let bestWords: string[] = [];

  for (let attempt = 0; attempt < MAX_SESSION_ATTEMPTS; attempt += 1) {
    const nextLetters = generateLetters();
    const candidateWords = pickSessionWords(nextLetters);
    const hasSixLetter = candidateWords.some((word) => word.length === LETTER_COUNT);
    if (candidateWords.length >= TARGET_WORD_MIN && hasSixLetter) {
      lobby.letters = nextLetters;
      words = candidateWords;
      break;
    }
    if (hasSixLetter && candidateWords.length > bestWords.length) {
      bestLetters = nextLetters;
      bestWords = candidateWords;
    }
  }

  if (words.length === 0 && bestWords.length > 0) {
    lobby.letters = bestLetters;
    words = bestWords;
  }

  if (words.length === 0) {
    for (let attempt = 0; attempt < MAX_SESSION_ATTEMPTS; attempt += 1) {
      const nextLetters = generateLetters();
      const candidateWords = pickSessionWords(nextLetters);
      if (candidateWords.some((word) => word.length === LETTER_COUNT)) {
        lobby.letters = nextLetters;
        words = candidateWords;
        break;
      }
    }
  }

  if (words.length === 0) {
    let forcedWords: string[] = [];
    let forcedLetters: string[] = [];
    while (forcedWords.length === 0) {
      const nextLetters = generateLetters();
      const candidateWords = pickSessionWords(nextLetters);
      if (candidateWords.some((word) => word.length === LETTER_COUNT)) {
        forcedLetters = nextLetters;
        forcedWords = candidateWords;
      }
    }
    lobby.letters = forcedLetters;
    words = forcedWords;
  }

  lobby.sessionWords = words;
  lobby.revealedByPlayer = new Map();
  lobby.wordIndex = new Map(lobby.sessionWords.map((word, index) => [word, index]));
  lobby.submittedWords = new Map();
  lobby.hiddenBonusAwarded = new Set();
};

const resetScores = (lobby: Lobby) => {
  lobby.state.players = lobby.state.players.map((player) => ({
    ...player,
    score: 0,
    streakCount: 0,
    streakPoints: 0,
    streakBonusApplied: 0
  }));
};

const startSession = (lobby: Lobby) => {
  stopLobbyCountdown(lobby);
  // If a session was pre-built during the countdown, reuse it.
  if (!lobby.sessionWords || lobby.sessionWords.length === 0) {
    buildSession(lobby);
  }
  resetScores(lobby);
  lobby.state.status = "active";
  lobby.state.lastAction = "New round started";
  lobby.state.winner = null;
  lobby.sessionEndAt = Date.now() + SESSION_SECONDS * 1000;
  broadcastState(lobby);
  // Schedule bot behavior if this lobby contains bots
  scheduleBotsForLobby(lobby);
};

const emitLobbyCountdown = (lobby: Lobby, seconds: number | null) => {
  io.to(lobby.id).emit("lobbyCountdown", seconds);
};

const emitResetCountdown = (lobby: Lobby, seconds: number | null) => {
  io.to(lobby.id).emit("resetCountdown", seconds);
};

const stopResetCountdown = (lobby: Lobby) => {
  if (lobby.resetCountdownInterval) {
    clearInterval(lobby.resetCountdownInterval);
    lobby.resetCountdownInterval = null;
  }
  lobby.resetCountdownEndAt = null;
  emitResetCountdown(lobby, null);
};

const startResetCountdown = (lobby: Lobby) => {
  stopResetCountdown(lobby);
  lobby.resetCountdownEndAt = Date.now() + RESET_DELAY_SECONDS * 1000;
  emitResetCountdown(lobby, RESET_DELAY_SECONDS);
  lobby.resetCountdownInterval = setInterval(() => {
    if (!lobby.resetCountdownEndAt) {
      return;
    }
    const remaining = Math.max(0, Math.ceil((lobby.resetCountdownEndAt - Date.now()) / 1000));
    emitResetCountdown(lobby, remaining);
  }, 250);
};

const stopLobbyCountdown = (lobby: Lobby) => {
  if (lobby.lobbyCountdownTimer) {
    clearTimeout(lobby.lobbyCountdownTimer);
    lobby.lobbyCountdownTimer = null;
  }
  if (lobby.lobbyCountdownInterval) {
    clearInterval(lobby.lobbyCountdownInterval);
    lobby.lobbyCountdownInterval = null;
  }
  lobby.lobbyCountdownEndAt = null;
  lobby.lobbyCountdownLastValue = null;
  emitLobbyCountdown(lobby, null);
};

const scheduleLobbyCountdown = (lobby: Lobby) => {
  if (lobby.lobbyCountdownTimer) {
    clearTimeout(lobby.lobbyCountdownTimer);
  }
  if (lobby.lobbyCountdownInterval) {
    clearInterval(lobby.lobbyCountdownInterval);
  }
  // Prepare session words early so letters and hidden words can be
  // displayed during the countdown. Only build once per countdown period.
  if (!lobby.sessionWords || lobby.sessionWords.length === 0) {
    buildSession(lobby);
  }
  lobby.lobbyCountdownEndAt = Date.now() + LOBBY_COUNTDOWN_SECONDS * 1000;
  lobby.lobbyCountdownLastValue = null;
  emitLobbyCountdown(lobby, LOBBY_COUNTDOWN_SECONDS);
  lobby.lobbyCountdownInterval = setInterval(() => {
    if (!lobby.lobbyCountdownEndAt) {
      return;
    }
    const remaining = Math.max(0, Math.ceil((lobby.lobbyCountdownEndAt - Date.now()) / 1000));
    if (remaining !== lobby.lobbyCountdownLastValue) {
      lobby.lobbyCountdownLastValue = remaining;
      emitLobbyCountdown(lobby, remaining);
    }
    if (remaining <= 0) {
      if (lobby.lobbyCountdownInterval) {
        clearInterval(lobby.lobbyCountdownInterval);
        lobby.lobbyCountdownInterval = null;
      }
      lobby.lobbyCountdownEndAt = null;
      emitLobbyCountdown(lobby, 0);
      lobby.lobbyCountdownTimer = setTimeout(() => {
        lobby.lobbyCountdownTimer = null;
        if (lobby.state.status === "lobby" && allPlayersReady(lobby)) {
          startSession(lobby);
        }
      }, 1000);
    }
  }, 250);
};

const destroyLobby = (lobby: Lobby) => {
  stopLobbyCountdown(lobby);
  stopResetCountdown(lobby);
  if (lobby.resetTimer) {
    clearTimeout(lobby.resetTimer);
    lobby.resetTimer = null;
  }
  // Clear all disconnected player timers
  lobby.disconnectedPlayers.forEach((disconnected) => {
    clearTimeout(disconnected.cleanupTimer);
  });
  lobby.disconnectedPlayers.clear();
  // Clear bot timers
  if (lobby.botTimers) {
    lobby.botTimers.forEach((timers) => timers.forEach((t) => clearTimeout(t)));
    lobby.botTimers.clear();
  }
  lobbies.delete(lobby.id);
};

const broadcastState = (lobby: Lobby) => {
  lobby.state.lobbyId = lobby.id;
  lobby.state.letters = lobby.letters;
  lobby.state.timeLeft = getTimeLeft(lobby);
  lobby.state.players = lobby.state.players;
  lobby.state.players.forEach((player) => {
    const cards = buildCardsForPlayer(lobby, player.id);
    // Compute top 5 submitted words for this player (by points)
    const submitted = lobby.submittedWords.get(player.id) ?? new Set<string>();
    const topWords = Array.from(submitted).map((w) => {
      const normalized = w.toLowerCase();
      const length = normalized.length;
      const basePoints = length * POINTS_PER_LETTER;
      const lengthBonus = getLengthBonus(length);
      const index = lobby.wordIndex.get(normalized);
      const hiddenBonus = index !== undefined ? getHiddenBonus(length) : 0;
      const points = basePoints + lengthBonus + hiddenBonus;
      return { word: normalized.toUpperCase(), points };
    }).sort((a, b) => b.points - a.points).slice(0, 3);
    // Include sessionWords so clients can sort by full words at round start
    io.to(player.id).emit("state", { ...lobby.state, cards, sessionWords: lobby.sessionWords, playerTopWords: topWords });
  });
};

const getPlayer = (lobby: Lobby, id: string) =>
  lobby.state.players.find((player) => player.id === id);

const addPlayer = (lobby: Lobby, id: string, name: string) => {
  const avatarColor = AVATAR_COLORS[lobby.state.players.length % AVATAR_COLORS.length];
  // Sanitize player name to prevent profanity in UI
  const safeName = maskProfanity(name || "Player");
  const player: Player = {
    id,
    name: safeName,
    score: 0,
    streakCount: 0,
    streakPoints: 0,
    streakBonusApplied: 0,
    avatarColor,
    ready: true
  };
  lobby.state.players.push(player);
  return player;
};

const allPlayersReady = (lobby: Lobby) =>
  lobby.state.players.length >= MIN_PLAYERS_TO_START &&
  lobby.state.players.every((player) => player.ready);

const sendError = (socketId: string, message: string) => {
  io.to(socketId).emit("submissionError", message);
};

setInterval(() => {
  lobbies.forEach((lobby) => {
    if (lobby.state.status !== "active") {
      return;
    }
    const timeLeft = getTimeLeft(lobby);
    if (timeLeft <= 0) {
      endSession(lobby);
      return;
    }
    lobby.state.timeLeft = timeLeft;
    io.to(lobby.id).emit("tick", timeLeft);
  });
}, 1000);

io.on("connection", (socket) => {
  const clientIP = (socket.handshake.headers["cf-connecting-ip"] as string) || socket.conn.remoteAddress;
  console.log(`socket connected ${socket.id} ip=${clientIP}`);
  // Send current global rounds counter to the newly connected client
  try {
    socket.emit('totalRounds', totalRounds);
  } catch (_) {}

  // Socket handlers to read/increment the global counter.
  socket.on('getTotalRounds', (ack?: (value: number) => void) => {
    if (typeof ack === 'function') return ack(totalRounds);
    try { socket.emit('totalRounds', totalRounds); } catch (_) {}
  });

  socket.on('incrementTotalRounds', (ack?: (value: number) => void) => {
    try {
      incrementTotalRoundsAtomic().then((newTotal) => {
        totalRounds = newTotal;
        io.emit('totalRoundsUpdated', totalRounds);
        if (typeof ack === 'function') ack(totalRounds);
      }).catch((e) => {
        console.warn('[server] failed to increment totalRounds via socket', e);
        if (typeof ack === 'function') ack(totalRounds);
      });
    } catch (e) {
      console.warn('[server] failed to increment totalRounds via socket', e);
      if (typeof ack === 'function') ack(totalRounds);
    }
  });
  const handleLeaveLobby = () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) {
      return;
    }
    const leaving = getPlayer(lobby, socket.id);
    lobby.state.players = lobby.state.players.filter((player) => player.id !== socket.id);
    lobby.revealedByPlayer.delete(socket.id);
    socket.leave(lobby.id);
    socketLobbyMap.delete(socket.id);
    if (lobby.state.players.length === 0) {
      destroyLobby(lobby);
      return;
    }
    // If no human players remain (this is a bot-only lobby), abort immediately
    const humanRemaining = lobby.state.players.some((p) => !(lobby.botMeta && lobby.botMeta.has(p.id)));
    if (!humanRemaining) {
      abortSessionWithoutCounting(lobby);
      return;
    }
    if (leaving) {
      lobby.state.lastAction = `${leaving.name} left`;
      // If game is active, clarify action
      if (lobby.state.status === "active") {
        lobby.state.lastAction = `${leaving.name} left during game`;
      }
    }
    // Always broadcast state after player leaves
    broadcastState(lobby);
  };
  const handleReturnToLobby = () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) {
      return;
    }
    const player = getPlayer(lobby, socket.id);
    if (!player) {
      return;
    }
    player.ready = false;
    if (lobby.state.status === "lobby") {
      stopLobbyCountdown(lobby);
    }
    lobby.state.lastAction = `${player.name} returned to lobby`;
    broadcastState(lobby);
  };
  socket.on("createPrivateLobby", ({ name }: { name: string }, callback?: (result: any) => void) => {
    if (socketLobbyMap.has(socket.id)) {
      callback?.({ ok: false, error: "Already in a lobby" });
      return;
    }
    const safeName = name?.trim() || "Player";
    const lobby = createLobby();
    
    socket.join(lobby.id);
    socketLobbyMap.set(socket.id, lobby.id);
    const player = addPlayer(lobby, socket.id, safeName);
    lobby.state.lastAction = `${player.name} created lobby`;
    broadcastState(lobby);
    
    callback?.({ ok: true, lobbyId: lobby.id });
  });

  // Play with bots: create a lobby and populate with bots of selected difficulty.
  socket.on('playWithBots', ({ name, difficulty, botCount }: { name: string; difficulty?: string; botCount?: number }, callback?: (result: any) => void) => {
    try {
      // If this socket is already in a lobby, return existing lobby id instead
      if (socketLobbyMap.has(socket.id)) {
        const existing = getLobbyForSocket(socket.id);
        if (existing) {
          return callback?.({ ok: true, lobbyId: existing.id });
        }
      }
      const safeName = (name?.trim() || 'Player').toUpperCase();
      const lobby = createLobby();
      socket.join(lobby.id);
      socketLobbyMap.set(socket.id, lobby.id);
      const player = addPlayer(lobby, socket.id, safeName);
      // Determine difficulty (default 'easy')
      const diff = (['easy','medium','hard','genius'].includes((difficulty || '').toLowerCase()) ? (difficulty || 'easy').toLowerCase() : 'easy') as 'easy' | 'medium' | 'hard' | 'genius';
      // Determine how many bots to create. Prefer explicit `botCount`, fallback to filling to MAX_PLAYERS-1.
      let createCount = typeof botCount === 'number' ? Math.max(0, Math.min(botCount, MAX_PLAYERS - 1)) : (MAX_PLAYERS - 1);
      // Backwards compatibility: if difficulty looks like 'hard:3', parse count
      if (typeof difficulty === 'string' && difficulty.includes(':')) {
        const parts = difficulty.split(':');
        const maybeCount = Number(parts[1]);
        if (!Number.isNaN(maybeCount) && maybeCount >= 0 && maybeCount <= (MAX_PLAYERS - 1)) createCount = maybeCount;
      }
      for (let i = 1; i <= createCount; i++) {
        createBotForLobby(lobby, diff, i);
      }
      lobby.state.lastAction = `${player.name} started a bots game (${diff})`;
      // Schedule lobby countdown so clients see the round-start timer
      // (bots are created ready=true, so `allPlayersReady` will pass).
      scheduleLobbyCountdown(lobby);
      broadcastState(lobby);
      callback?.({ ok: true, lobbyId: lobby.id });
    } catch (e) {
      console.warn('[server] failed to create bots lobby', e);
      callback?.({ ok: false, error: 'failed' });
    }
  });

  socket.on("join", ({ name, lobbyId }: { name: string; lobbyId?: string }) => {
    if (socketLobbyMap.has(socket.id)) {
      return;
    }
    const safeName = name?.trim() || "Player";
    
    let lobby: Lobby | null = null;
    
    // Try to find lobby by ID if provided
    if (lobbyId) {
      lobby = getLobbyById(lobbyId);
      if (!lobby) {
        socket.emit("joinError", "Lobby not found.");
        return;
      }
      if (lobby.state.status !== "lobby") {
        socket.emit("joinError", "Lobby is not accepting new players.");
        return;
      }
      if (lobby.state.players.length >= MAX_PLAYERS) {
        socket.emit("joinError", "Lobby is full.");
        return;
      }
    } else {
      // Auto-assign to available lobby
      lobby = getLobbyForJoin();
    }
    
    // Check for reconnection
    const disconnectedPlayer = lobby.disconnectedPlayers.get(safeName);
    if (disconnectedPlayer) {
      // Reconnect existing player
      clearTimeout(disconnectedPlayer.cleanupTimer);
      lobby.disconnectedPlayers.delete(safeName);
      
      // Update socket ID
      const player = disconnectedPlayer.player;
      player.id = socket.id;
      lobby.state.players.push(player);
      lobby.revealedByPlayer.set(socket.id, disconnectedPlayer.revealedWords);
      
      socket.join(lobby.id);
      socketLobbyMap.set(socket.id, lobby.id);
      lobby.state.lastAction = `${player.name} reconnected`;
      broadcastState(lobby);
      return;
    }
    
    // New player join
    socket.join(lobby.id);
    socketLobbyMap.set(socket.id, lobby.id);
    const player = addPlayer(lobby, socket.id, safeName);
    lobby.state.lastAction = `${player.name} joined`;
    
    // Send sanitized chat history to new player (mask any legacy profanity)
    try {
      const sanitized = lobby.chatMessages.map((m) => ({
        ...m,
        message: maskProfanity(m.message),
        playerName: maskProfanity(m.playerName)
      }));
      socket.emit("chatHistory", sanitized);
    } catch (e) {
      socket.emit("chatHistory", lobby.chatMessages);
    }
    
    broadcastState(lobby);
    if (lobby.state.status === "lobby" && allPlayersReady(lobby)) {
      scheduleLobbyCountdown(lobby);
    }
  });

  socket.on("submitWord", ({ word }: { word: string }, callback?: (ack: SubmitAck) => void) => {
    const respond = (ack: SubmitAck & { points?: number }) => {
      if (typeof callback === "function") {
        callback(ack);
      }
    };
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) {
      respond({ ok: false, error: "Lobby not found." });
      return;
    }
    if (lobby.state.status !== "active") {
      sendError(socket.id, "Round is not active.");
      respond({ ok: false, error: "Round is not active." });
      return;
    }
    const player = getPlayer(lobby, socket.id);
    if (!player) {
      respond({ ok: false, error: "Player not found." });
      return;
    }
    const reject = (message: string) => {
      sendError(socket.id, message);
      applyInvalidPenalty(player);
      // Always send points as negative for penalty
      respond({ ok: false, error: message, points: -INVALID_WORD_PENALTY });
      broadcastState(lobby);
    };
    const normalized = word?.trim().toLowerCase() || "";
    if (normalized.length < MIN_WORD_LENGTH) {
      reject("Word is too short.");
      return;
    }
    if (!dictionarySet.has(normalized)) {
      reject("Not a valid word.");
      return;
    }
    if (!canFormWord(lobby.letters, normalized)) {
      reject("Word uses unavailable letters.");
      return;
    }

    // Check if this player already submitted this word
    const playerWords = lobby.submittedWords.get(player.id) ?? new Set<string>();
    if (playerWords.has(normalized)) {
      // Previously this used `reject(...)` which applied an invalid-word penalty.
      // Change: do NOT apply a penalty for resubmitting your own word —
      // only send an error message back to the client.
      const message = "You already submitted this word.";
      sendError(socket.id, message);
      respond({ ok: false, error: message });
      return;
    }

    const index = lobby.wordIndex.get(normalized);
    if (index !== undefined) {
      const revealedForPlayer = lobby.revealedByPlayer.get(socket.id) ?? new Set<number>();
      if (revealedForPlayer.has(index)) {
        reject("Word already revealed.");
        return;
      }
      revealedForPlayer.add(index);
      lobby.revealedByPlayer.set(socket.id, revealedForPlayer);
    }
    playerWords.add(normalized);
    lobby.submittedWords.set(player.id, playerWords);
    const length = normalized.length;
    const basePoints = length * POINTS_PER_LETTER;
    const lengthBonus = getLengthBonus(length);
    const hiddenBonus = index !== undefined ? getHiddenBonus(length) : 0;
    const wordPoints = basePoints + lengthBonus + hiddenBonus;
    // Calculate score delta before and after
    const scoreBefore = player.score;
    applyValidScore(player, wordPoints);
    let scoreDelta = player.score - scoreBefore;
    if (index !== undefined) {
      const revealedForPlayer = lobby.revealedByPlayer.get(socket.id);
      if (
        revealedForPlayer &&
        revealedForPlayer.size === lobby.sessionWords.length &&
        !lobby.hiddenBonusAwarded.has(player.id)
      ) {
        lobby.hiddenBonusAwarded.add(player.id);
        player.score += ALL_HIDDEN_BONUS;
        scoreDelta += ALL_HIDDEN_BONUS;
      }
    }
    if (index !== undefined) {
      const revealedForPlayer = lobby.revealedByPlayer.get(socket.id);
      if (
        revealedForPlayer &&
        revealedForPlayer.size === lobby.sessionWords.length &&
        !lobby.hiddenBonusAwarded.has(player.id)
      ) {
        lobby.hiddenBonusAwarded.add(player.id);
        player.score += ALL_HIDDEN_BONUS;
      }
    }
    lobby.state.lastAction =
      index !== undefined
        ? `${player.name} found ${normalized.toUpperCase()}`
        : `${player.name} submitted ${normalized.toUpperCase()}`;
    respond({ ok: true, word: normalized.toUpperCase(), points: scoreDelta });
    io.to(socket.id).emit("submissionAccepted", { word: normalized.toUpperCase(), points: scoreDelta });
    broadcastState(lobby);
  });

  socket.on("setReady", ({ ready }: { ready: boolean }) => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) {
      return;
    }
    const player = getPlayer(lobby, socket.id);
    if (!player) {
      return;
    }
    player.ready = ready;
    broadcastState(lobby);
    if (lobby.state.status === "lobby") {
      if (allPlayersReady(lobby)) {
        scheduleLobbyCountdown(lobby);
      } else {
        stopLobbyCountdown(lobby);
      }
    }
  });

  socket.on("returnToLobby", handleReturnToLobby);
  socket.on("leaveLobby", handleLeaveLobby);

  socket.on("chatMessage", async ({ message }: { message: string }) => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) {
      return;
    }
    const player = getPlayer(lobby, socket.id);
    if (!player) {
      return;
    }
    
    const trimmedMessage = message?.trim();
    if (!trimmedMessage || trimmedMessage.length > 200) {
      return;
    }

    // server-side rate limiting per socket
    try {
      await chatLimiter.consume(socket.id);
    } catch (rateErr) {
      // Exceeded rate: inform client and ignore message
      const blockMs = 5000;
      socket.emit('chatBlocked', { until: Date.now() + blockMs, seconds: Math.ceil(blockMs / 1000) });
      return;
    }

    // server-side profanity masking using local list
    const cleaned = maskProfanity(trimmedMessage);
    const cleanedPlayerName = maskProfanity(player.name);
    const chatMessage: ChatMessage = {
      id: `${Date.now()}-${socket.id}`,
      playerId: player.id,
      playerName: cleanedPlayerName,
      playerColor: player.avatarColor,
      message: cleaned,
      timestamp: Date.now()
    };
    
    lobby.chatMessages.push(chatMessage);
    // Keep only last 50 messages
    if (lobby.chatMessages.length > 50) {
      lobby.chatMessages.shift();
    }
    
    io.to(lobby.id).emit("chatMessage", chatMessage);
  });

  socket.on("disconnect", () => {
    const lobby = getLobbyForSocket(socket.id);
    if (!lobby) {
      return;
    }
    const leaving = getPlayer(lobby, socket.id);
    if (!leaving) {
      return;
    }
    
    // Move player to disconnected state with grace period
    lobby.state.players = lobby.state.players.filter((player) => player.id !== socket.id);
    const revealedWords = lobby.revealedByPlayer.get(socket.id) || new Set();
    lobby.revealedByPlayer.delete(socket.id);
    socket.leave(lobby.id);
    socketLobbyMap.delete(socket.id);
    
    // If no human players remain (bot-only lobby), abort immediately
    const humanRemaining = lobby.state.players.some((p) => !(lobby.botMeta && lobby.botMeta.has(p.id)));
    if (!humanRemaining) {
      abortSessionWithoutCounting(lobby);
      return;
    }

    const cleanupTimer = setTimeout(() => {
      lobby.disconnectedPlayers.delete(leaving.name);
      if (lobby.state.players.length === 0 && lobby.disconnectedPlayers.size === 0) {
        destroyLobby(lobby);
      }
    }, DISCONNECT_GRACE_PERIOD);
    
    lobby.disconnectedPlayers.set(leaving.name, {
      player: leaving,
      revealedWords,
      disconnectedAt: Date.now(),
      cleanupTimer
    });
    
    lobby.state.lastAction = `${leaving.name} disconnected`;
    // If game is active, clarify action
    if (lobby.state.status === "active") {
      lobby.state.lastAction = `${leaving.name} disconnected during game`;
    }
    
    if (lobby.state.status === "lobby" && !allPlayersReady(lobby)) {
      stopLobbyCountdown(lobby);
    }
    if (lobby.state.players.length === 0 && lobby.disconnectedPlayers.size === 0) {
      destroyLobby(lobby);
      return;
    }
    // Always broadcast state after disconnect
    broadcastState(lobby);
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Provide a simple REST API to read and increment the global rounds counter.
app.get('/totalRounds', (_req, res) => {
  res.json({ total: totalRounds });
});

app.post('/totalRounds/increment', (_req, res) => {
  (async () => {
    try {
      const newTotal = await incrementTotalRoundsAtomic();
      totalRounds = newTotal;
      io.emit('totalRoundsUpdated', totalRounds);
      res.json({ total: totalRounds });
    } catch (e) {
      console.warn('[server] failed to increment totalRounds via REST', e);
      res.status(500).json({ error: 'failed' });
    }
  })();
});