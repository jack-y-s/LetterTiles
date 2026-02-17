import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import fs from "fs";
import wordListPath from "word-list";

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
  submittedWords: Set<string>;
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
};

type SubmitAck = {
  ok: boolean;
  error?: string;
  word?: string;
};

const MIN_PLAYERS_TO_START = 2;
const MAX_PLAYERS = 7;
const LOBBY_COUNTDOWN_SECONDS = 10;
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

const app = express();
const server = http.createServer(app);
const allowedOrigins = [
  "http://localhost:5173",
  "https://lettertiles.onrender.com"
];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins
  }
});

app.use(cors({ origin: allowedOrigins }));

const endSession = (lobby: Lobby) => {
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
    lobby.submittedWords = new Set();
    lobby.hiddenBonusAwarded = new Set();
    lobby.sessionEndAt = null;
    lobby.state.timeLeft = SESSION_SECONDS;
    lobby.state.cards = [];
    lobby.state.players = lobby.state.players.map((player) => ({
      ...player,
      ready: false
    }));
    resetScores(lobby);
    stopLobbyCountdown(lobby);
    stopResetCountdown(lobby);
    if (lobby.state.players.length > 0) {
      broadcastState(lobby);
    } else {
      destroyLobby(lobby);
    }
  }, RESET_DELAY_SECONDS * 1000);
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
    submittedWords: new Set(),
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
  lobby.submittedWords = new Set();
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
  buildSession(lobby);
  resetScores(lobby);
  lobby.state.status = "active";
  lobby.state.lastAction = "New round started";
  lobby.state.winner = null;
  lobby.sessionEndAt = Date.now() + SESSION_SECONDS * 1000;
  broadcastState(lobby);
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
  lobbies.delete(lobby.id);
};

const broadcastState = (lobby: Lobby) => {
  lobby.state.lobbyId = lobby.id;
  lobby.state.letters = lobby.letters;
  lobby.state.timeLeft = getTimeLeft(lobby);
  lobby.state.players = lobby.state.players;
  lobby.state.players.forEach((player) => {
    const cards = buildCardsForPlayer(lobby, player.id);
    io.to(player.id).emit("state", { ...lobby.state, cards });
  });
};

const getPlayer = (lobby: Lobby, id: string) =>
  lobby.state.players.find((player) => player.id === id);

const addPlayer = (lobby: Lobby, id: string, name: string) => {
  const avatarColor = AVATAR_COLORS[lobby.state.players.length % AVATAR_COLORS.length];
  const player: Player = {
    id,
    name,
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
    if (leaving) {
      lobby.state.lastAction = `${leaving.name} left`;
    }
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
    
    // Send chat history to new player
    socket.emit("chatHistory", lobby.chatMessages);
    
    broadcastState(lobby);
    if (lobby.state.status === "lobby" && allPlayersReady(lobby)) {
      scheduleLobbyCountdown(lobby);
    }
  });

  socket.on("submitWord", ({ word }: { word: string }, callback?: (ack: SubmitAck) => void) => {
    const respond = (ack: SubmitAck) => {
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
      respond({ ok: false, error: message });
      applyInvalidPenalty(player);
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
    if (lobby.submittedWords.has(normalized)) {
      reject("Word already submitted.");
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
    lobby.submittedWords.add(normalized);
    const length = normalized.length;
    const basePoints = length * POINTS_PER_LETTER;
    const lengthBonus = getLengthBonus(length);
    const hiddenBonus = index !== undefined ? getHiddenBonus(length) : 0;
    const wordPoints = basePoints + lengthBonus + hiddenBonus;
    applyValidScore(player, wordPoints);
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
    respond({ ok: true, word: normalized.toUpperCase() });
    io.to(socket.id).emit("submissionAccepted", { word: normalized.toUpperCase() });
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

  socket.on("chatMessage", ({ message }: { message: string }) => {
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
    
    const chatMessage: ChatMessage = {
      id: `${Date.now()}-${socket.id}`,
      playerId: player.id,
      playerName: player.name,
      playerColor: player.avatarColor,
      message: trimmedMessage,
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
    
    if (lobby.state.status === "lobby" && !allPlayersReady(lobby)) {
      stopLobbyCountdown(lobby);
    }
    if (lobby.state.players.length === 0 && lobby.disconnectedPlayers.size === 0) {
      destroyLobby(lobby);
      return;
    }
    if (leaving) {
      lobby.state.lastAction = `${leaving.name} left`;
    }
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