import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import initAdConsent from "./adConsent";
// CookieConsent removed; external CMP (CookieYes) now provides consent UI.

type Player = {
  id: string;
  name: string;
  score: number;
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
} | null;

type GameState = {
  players: Player[];
  status: "lobby" | "active" | "ended";
  lobbyId: string | null;
  letters: string[];
  timeLeft: number;
  lastAction: string | null;
  cards: WordCard[];
  winner: Winner;
};

type Toast = {
  id: number;
  text: string;
  tone: "success" | "error" | "minus" | "plus";
};

type ChatMessage = {
  id: string;
  playerId: string;
  playerName: string;
  playerColor: string;
  message: string;
  timestamp: number;
};


type JoinMode = "random" | "create" | "joinById";


// Resolve API base URL:
// 1) Prefer Vite `VITE_API_URL` when provided at build time
// 2) If running in a browser on `localhost`, default to the local backend
// 3) Otherwise fall back to the public production API
const envApi = (import.meta as any).env.VITE_API_URL;
const API_BASE = envApi || (typeof window !== 'undefined' && window.location && window.location.hostname === 'localhost' ? 'http://localhost:3001' : 'https://api.letter-tiles.com');
const socketUrl = API_BASE;

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
};

const App = () => {
      useEffect(() => {
        // Inject Ko-fi overlay widget script
        if (!document.getElementById('kofi-widget-script')) {
          const script = document.createElement('script');
          script.id = 'kofi-widget-script';
          script.src = 'https://storage.ko-fi.com/cdn/scripts/overlay-widget.js';
          script.async = true;
          script.onload = () => {
            const kofiWidgetOverlay = (window as any).kofiWidgetOverlay;
            if (typeof kofiWidgetOverlay?.draw === 'function') {
              kofiWidgetOverlay.draw('jacky1101', {
                'type': 'floating-chat',
                'floating-chat.donateButton.text': 'Support Me',
                'floating-chat.donateButton.background-color': '#ff5f5f',
                'floating-chat.donateButton.text-color': '#fff'
              });
            }
          };
          document.body.appendChild(script);
        }
      }, []);
    // Floating points badge state
    const [pointsBadge, setPointsBadge] = useState<{ value: number, key: number } | null>(null);
    const pointsBadgeTimeout = useRef<number | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  // Delay showing the socket-down banner to avoid a brief flash on initial load
  const [showSocketBanner, setShowSocketBanner] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [accountNameInput, setAccountNameInput] = useState("");
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [typedWord, setTypedWord] = useState("");
  const [showWinnerOverlay, setShowWinnerOverlay] = useState(true);
  const [rankChanges, setRankChanges] = useState<Record<string, "up" | "down" | "same">>({});
  const previousRanksRef = useRef<Map<string, number>>(new Map());
  const rankTimerRef = useRef<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(1);
  const lastToastAtRef = useRef<number>(0);
  const lastSuccessRef = useRef<{ word: string; at: number } | null>(null);
  const [recentValidWords, setRecentValidWords] = useState<string[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  // Auto-scroll chat only when a new message is added
  const chatMessagesEndRef = useRef<HTMLDivElement | null>(null);
  const prevChatLengthRef = useRef<number>(0);
  useEffect(() => {
    if (chatMessages.length > prevChatLengthRef.current) {
      if (chatMessagesEndRef.current) {
        chatMessagesEndRef.current.scrollIntoView({ behavior: "smooth" });
      }
    }
    prevChatLengthRef.current = chatMessages.length;
  }, [chatMessages]);
  const [chatInput, setChatInput] = useState("");
  // Chat spam throttling: track recent send timestamps (ms) and temporary block
  const chatTimestampsRef = useRef<number[]>([]);
  const [chatBlockedUntil, setChatBlockedUntil] = useState<number | null>(null);
  const chatBlockTimerRef = useRef<number | null>(null);

  // Refs for animating tiles into the input
  const tileRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const inputRef = useRef<HTMLDivElement | null>(null);
  // Track indices that are currently animating/being consumed to avoid
  // duplicate selection when the user types/clicks quickly.
  const pendingIndicesRef = useRef<Set<number>>(new Set());
  // Track which selected-word positions are currently animating back to
  // their source tiles (for fast backspace handling).
  const pendingBackPositionsRef = useRef<Set<number>>(new Set());
  // When we submit or clear while animations are in-flight, mark those
  // indices as aborted so their cleanup handlers don't re-add state.
  const abortedIndicesRef = useRef<Set<number>>(new Set());

  // Profanity filtering is enforced server-side (leo-profanity). Client-side hardcoded list removed.
  const [lobbyCountdown, setLobbyCountdown] = useState<number | null>(null);
  // For enhanced countdown animation: remember starting value and pulse per tick
  const startLobbyCountdownRef = useRef<number | null>(null);
  const lobbyCountdownRef = useRef<number | null>(null);
  const [tickPulse, setTickPulse] = useState(false);
  const prevCardsRef = useRef<WordCard[] | null>(null);
  const prevTimeLeftRef = useRef<number | null>(null);
  const roundFinalPlayedRef = useRef<boolean>(false);
  const [displayOrder, setDisplayOrder] = useState<number[]>([]);
  const [shufflePulse, setShufflePulse] = useState(false);
  const shuffleTimerRef = useRef<number | null>(null);
  const [resetCountdown, setResetCountdown] = useState<number | null>(null);
  const [winnerDismissed, setWinnerDismissed] = useState(false);
  const [showPlayersPanel, setShowPlayersPanel] = useState(true);
  const [showChatPanel, setShowChatPanel] = useState(true);
  const [showRecentPanel, setShowRecentPanel] = useState(true);
  const [showHintPanel, setShowHintPanel] = useState(true);
  const [showHiddenPanel, setShowHiddenPanel] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [confettiEnabled, setConfettiEnabled] = useState(false);
  const [muted, setMuted] = useState<boolean>(() => (localStorage.getItem('muted') === 'true'));

  // Unlock audio on first user gesture (some browsers require a user gesture)
  useEffect(() => {
    const handler = () => {
      import("./soundManager").then((m) => m.unlockAudio()).catch(() => {});
      window.removeEventListener("pointerdown", handler);
    };
    window.addEventListener("pointerdown", handler, { once: true });
    return () => window.removeEventListener("pointerdown", handler);
  }, []);
  const lastLettersKeyRef = useRef("");
  const [joinMode, setJoinMode] = useState<JoinMode>("random");
  const [lobbyIdInput, setLobbyIdInput] = useState("");
  const [game, setGame] = useState<GameState>({
    players: [],
    status: "lobby",
    lobbyId: null,
    letters: [],
    timeLeft: 120,
    lastAction: null,
    cards: [],
    winner: null
  });
  // Cache for last non-empty cards
  const lastNonEmptyCardsRef = useRef<WordCard[]>([]);

  // Determine which cards to display in the UI.
  // Do NOT show hidden words during lobby countdown (status === 'lobby'),
  // even if the backend has prepared `game.cards` early. Only display
  // when the round is active or ended. After the round ends, fall back
  // to cached cards so words persist during the reset delay.
  const displayCards = ((game.status === "active" || game.status === "ended") && game.cards.length > 0)
    ? game.cards
    : (game.status === "ended" && lastNonEmptyCardsRef.current.length > 0)
      ? lastNonEmptyCardsRef.current
      : [];

  // Store the initial sorted order of cards at round start
  const initialCardOrderRef = useRef<number[] | null>(null);
  useEffect(() => {
    // Prefer backend-provided sessionWords (prepared during countdown) to
    // compute the initial fixed order. If sessionWords are not available,
    // fall back to the actual displayCards.
    if (initialCardOrderRef.current === null) {
      const sessionWords: string[] | undefined = (game as any).sessionWords;
      if (sessionWords && sessionWords.length > 0) {
        const entries = sessionWords.map((w, idx) => ({ card: { id: idx, length: w.length, word: w.toUpperCase() } as WordCard, idx }));
        const sorted = entries.sort((a, b) => {
          if (b.card.length !== a.card.length) return b.card.length - a.card.length;
          const aWord = (a.card.word || "").toLowerCase();
          const bWord = (b.card.word || "").toLowerCase();
          return aWord.localeCompare(bWord);
        });
        initialCardOrderRef.current = sorted.map(x => x.idx);
      } else if (displayCards.length > 0) {
        const entries = displayCards.map((card, idx) => ({ card: { ...card, word: card.word ?? "" }, idx }));
        const sorted = entries.sort((a, b) => {
          if (b.card.length !== a.card.length) return b.card.length - a.card.length;
          const aWord = (a.card.word || "").toLowerCase();
          const bWord = (b.card.word || "").toLowerCase();
          return aWord.localeCompare(bWord);
        });
        initialCardOrderRef.current = sorted.map(x => x.idx);
      }
    }
    // Reset the initial order only when sessionWords and cards are cleared (lobby reset)
    const sessionWords: string[] | undefined = (game as any).sessionWords;
    if (game.status === "lobby" && (!sessionWords || sessionWords.length === 0) && displayCards.length === 0) {
      initialCardOrderRef.current = null;
    }
  }, [game, displayCards]);

  const sortedPlayers = useMemo(
    () => [...game.players].sort((a, b) => b.score - a.score),
    [game.players]
  );
  const topTwo = useMemo(() => sortedPlayers.slice(0, 2), [sortedPlayers]);
  const isDraw = useMemo(() => {
    if (game.status !== "ended") {
      return false;
    }
    if (sortedPlayers.length < 2) {
      return false;
    }
    return sortedPlayers[0].score === sortedPlayers[1].score;
  }, [game.status, sortedPlayers]);

  const pushToast = (text: string, tone: Toast["tone"]) => {
    const now = Date.now();
    // Throttle frequent toasts to avoid flooding, but allow points to always show
    if (tone !== "plus" && tone !== "minus") {
      if (now - (lastToastAtRef.current || 0) < 180) return;
      lastToastAtRef.current = now;
    }
    const id = toastIdRef.current++;
    setToasts((current) => [{ id, text, tone }, ...current]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 1000);
  };

  // Helpers must be defined at component scope
  const pushMinus = (amount: number) => {
    pushToast(`-${amount}`, "minus");
  };
  const pushPlus = (amount: number) => {
    pushToast(`+${amount}`, "plus");
  };

  // Enable confetti briefly when a winner overlay appears (but avoid on mobile)
  useEffect(() => {
    let t: number | undefined;
    if (game.status === "ended" && game.winner && showWinnerOverlay && !isMobile) {
      // lazy-load confetti CSS once
      if (!(window as any).__confetti_css_loaded) {
        import("./confetti.css");
        (window as any).__confetti_css_loaded = true;
      }
      setConfettiEnabled(true);
      t = window.setTimeout(() => setConfettiEnabled(false), 3600);
      // play end-game sound
      import("./soundManager").then((m) => m.playEndGame()).catch(() => {});
    }
    return () => {
      if (t) window.clearTimeout(t);
    };
  }, [game.status, game.winner, showWinnerOverlay, isMobile]);


  const pushSuccess = (word: string) => {
    const now = Date.now();
    const last = lastSuccessRef.current;
    if (last && last.word === word && now - last.at < 500) {
      return;
    }
    lastSuccessRef.current = { word, at: now };
    setRecentValidWords((prev) => [word, ...prev].slice(0, 10));
    pushToast(word, "success");
  };

  useEffect(() => {
    // Initialize ad consent manager (listens for CookieYes / TCF signals)
    try { initAdConsent(); } catch (e) {}

    // Ensure audio unlocked on first user gesture and apply persisted mute
    const handler = () => {
      import("./soundManager").then((m) => {
        m.unlockAudio();
        m.setMuted(localStorage.getItem('muted') === 'true');
        // register default sound files defined in the app
        import("./soundConfig").then((cfg) => {
          try { m.setSoundFiles(cfg.default || cfg); } catch (_) {}
        }).catch(() => {});
      }).catch(() => {});
      window.removeEventListener('pointerdown', handler);
    };
    window.addEventListener('pointerdown', handler);
    // Also register default sound files immediately (no need to wait for gesture)
    import("./soundManager").then((m) => {
      import("./soundConfig").then((cfg) => { try { m.setSoundFiles(cfg.default || cfg); } catch (_) {} });
    }).catch(() => {});

    const socketInstance = io(socketUrl, {
      // Allow polling fallback (don't force websocket) so initial handshake
      // can succeed in environments where WebSocket upgrade is blocked.
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    socketInstance.on("connect", () => {
      setError(null);
    });

    socketInstance.on("state", (state: GameState) => {
      setGame(state);
      try {
        const prev = prevCardsRef.current;
        if (prev && Array.isArray(prev) && Array.isArray(state.cards)) {
          for (const card of state.cards) {
            const was = prev.find((c) => c.id === card.id);
            if (card.revealed && (!was || !was.revealed) && card.length === 6) {
              import("./soundManager").then((m) => m.playFoundSix()).catch(() => {});
            }
          }
        }
      } catch (_) {}
      // Cache the last non-empty cards (for active/ended)
      if ((state.status === "active" || state.status === "ended") && state.cards && state.cards.length > 0) {
        lastNonEmptyCardsRef.current = state.cards;
      }
      if (state.status === "lobby") {
        const isPlayer = state.players.some((player) => player.id === socketInstance.id);
        if (!isPlayer) {
          setJoined(false);
        }
      }
      // store previous cards snapshot for next state diff
      prevCardsRef.current = state.cards;
    });

    socketInstance.on("tick", (timeLeft: number) => {
      setGame((current) => ({ ...current, timeLeft }));
    });

    socketInstance.on("submissionError", (message: string) => {
      setError(message);
    })

    socketInstance.on("submissionAccepted", ({ word }: { word: string }) => {
      // handled in submitWord callback
    });

    socketInstance.on("chatMessage", (message: ChatMessage) => {
      setChatMessages((prev) => [...prev, message]);
      try {
        // Play a small notification for incoming chat (ignore if from self)
        if (message.playerId !== socketInstance.id) {
          import("./soundManager").then((m) => m.playNewChat()).catch(() => {});
        }
      } catch (_) {}
    });

    socketInstance.on("chatHistory", (messages: ChatMessage[]) => {
      setChatMessages(messages);
    });

    socketInstance.on("lobbyCountdown", (seconds: number | null) => {
      // Play tick each second; when reaching 0 play the countdownStart (go) sound
      setLobbyCountdown(seconds);
      // Update the ref immediately to prevent duplicate sound when the
      // backend may emit the same value multiple times in quick succession.
      const prev = lobbyCountdownRef.current;
      lobbyCountdownRef.current = seconds;
      try {
        import("./soundManager").then((m) => {
          if (typeof seconds === 'number') {
            if (seconds === 0) {
              m.playCountdownStart();
            } else {
              // Only play a tick when the value actually changed.
              if (prev !== seconds) m.playCountdownTick();
            }
          }
        }).catch(() => {});
      } catch (_) {}
    });

    // keep start value in sync when countdown begins (handled by state effect)

    socketInstance.on("resetCountdown", (seconds: number | null) => {
      setResetCountdown(seconds);
    });

    socketInstance.on("lobbyFull", (message: string) => {
      setError(message);
    });

    socketInstance.on("joinError", (message: string) => {
      setError(message);
      pushToast(message, "error");
    });

    socketInstance.on("connect_error", (err) => {
      setError(err.message);
    });

    setSocket(socketInstance);

    return () => {
      socketInstance.disconnect();
    };
  }, []);

  // Show the backend unreachable banner only after a short delay to avoid
  // flashing the banner briefly on initial page load while socket connects.
  useEffect(() => {
    let timer: number | undefined;
    const DELAY_MS = 2500;
    if (!socket) {
      setShowSocketBanner(false);
      return;
    }
    // Hide immediately, then schedule showing if still disconnected
    setShowSocketBanner(false);
    timer = window.setTimeout(() => {
      if (socket && !socket.connected) setShowSocketBanner(true);
    }, DELAY_MS);

    const handleConnect = () => setShowSocketBanner(false);
    socket.on('connect', handleConnect);

    return () => {
      if (timer) window.clearTimeout(timer);
      socket.off('connect', handleConnect);
    };
  }, [socket]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const apply = (isMobile: boolean) => {
      setIsMobile(isMobile);
      setShowPlayersPanel(!isMobile);
      setShowChatPanel(!isMobile);
      setShowRecentPanel(!isMobile);
      setShowHintPanel(!isMobile);
      setShowHiddenPanel(!isMobile);
    };
    apply(mediaQuery.matches);
    const handleChange = (event: MediaQueryListEvent) => {
      apply(event.matches);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  // Track start-of-countdown and trigger a tick pulse animation on each second change
  useEffect(() => {
    if (lobbyCountdown === null) {
      startLobbyCountdownRef.current = null;
      return;
    }
    if (startLobbyCountdownRef.current === null) {
      startLobbyCountdownRef.current = lobbyCountdown;
    }
    // pulse animation on tick
    setTickPulse(true);
    const t = window.setTimeout(() => setTickPulse(false), 350);

    return () => {
      window.clearTimeout(t);
    };
  }, [lobbyCountdown]);

  // Play an urgent tick sound during the final 10 seconds of an active round.
  useEffect(() => {
    if (game.status !== 'active') {
      prevTimeLeftRef.current = null;
      return;
    }
    const prev = prevTimeLeftRef.current;
    const cur = typeof game.timeLeft === 'number' ? game.timeLeft : null;
    if (cur !== null && (prev === null || cur < (prev as number))) {
      // Trigger once when entering the final 9 seconds window
      if (cur <= 9 && cur >= 0 && !roundFinalPlayedRef.current) {
        try {
          const sm = (window as any).__soundManager;
          if (sm && typeof sm.playRoundFinalTick === 'function') {
            sm.playRoundFinalTick();
          } else {
            import("./soundManager").then((m) => m.playRoundFinalTick()).catch(() => {});
          }
        } catch (_) {}
        roundFinalPlayedRef.current = true;
      }
    }
    prevTimeLeftRef.current = cur;
  }, [game.timeLeft, game.status]);

  useEffect(() => {
    const nextKey = game.letters.join("");
    if (nextKey === lastLettersKeyRef.current) {
      return;
    }
    lastLettersKeyRef.current = nextKey;
    setSelectedIndices([]);
    setTypedWord("");
    setToasts([]);
    setDisplayOrder(game.letters.map((_, index) => index));
  }, [game.letters]);

  useEffect(() => {
    if (game.status === "ended" && game.winner && !winnerDismissed) {
      setShowWinnerOverlay(true);
    }
    if (game.status === "active") {
      setShowWinnerOverlay(false);
      setWinnerDismissed(false);
      // New round started - allow the final-round sound to play again
      roundFinalPlayedRef.current = false;
    }
    if (game.status === "lobby") {
      setShowWinnerOverlay(false);
      setWinnerDismissed(false);
      setRecentValidWords([]);
      setToasts([]);
      setSelectedIndices([]);
      setTypedWord("");
      setResetCountdown(null);
    }
    if (game.status !== "lobby") {
      setLobbyCountdown(null);
    }
  }, [game.status, game.winner, winnerDismissed]);

  useEffect(() => {
    const nextChanges: Record<string, "up" | "down" | "same"> = {};
    const nextRanks = new Map<string, number>();

    sortedPlayers.forEach((player, index) => {
      nextRanks.set(player.id, index);
      const previousRank = previousRanksRef.current.get(player.id);
      if (previousRank === undefined) {
        nextChanges[player.id] = "same";
        return;
      }
      if (index < previousRank) {
        nextChanges[player.id] = "up";
      } else if (index > previousRank) {
        nextChanges[player.id] = "down";
      } else {
        nextChanges[player.id] = "same";
      }
    });

    previousRanksRef.current = nextRanks;
    setRankChanges(nextChanges);

    if (rankTimerRef.current) {
      window.clearTimeout(rankTimerRef.current);
    }
    rankTimerRef.current = window.setTimeout(() => {
      setRankChanges({});
    }, 900);

    return () => {
      if (rankTimerRef.current) {
        window.clearTimeout(rankTimerRef.current);
      }
    };
  }, [sortedPlayers]);

  const me = useMemo(() => game.players.find((player) => player.id === socket?.id), [game, socket]);
  const hasAccount = accountName.trim().length > 0;
  const currentWord = useMemo(
    () => selectedIndices.map((index) => game.letters[index] ?? "").join(""),
    [game.letters, selectedIndices]
  );
  const displayWord = typedWord.trim().length > 0 ? typedWord.trim() : currentWord;
  const canSubmit = joined && game.status === "active" && displayWord.length > 0;
  const canClear = selectedIndices.length > 0 || typedWord.trim().length > 0;
  const letterOrder = displayOrder.length === game.letters.length
    ? displayOrder
    : game.letters.map((_, index) => index);

  // Do not render the six main letters during lobby/countdown. However,
  // allow preparation (displayOrder, clearing selections) to happen when
  // `game.letters` is provided by the server during countdown so the
  // board appears instantly when the round becomes active.
  const displayLetters = ((game.status === "active" || game.status === "ended") && game.letters.length > 0)
    ? game.letters
    : [];
 

  const wordData = useMemo(() => {
    if (displayCards.length === 0 || !initialCardOrderRef.current) {
      return { columns: [] as WordCard[][], pinnedSixId: null as number | null };
    }
    // Use the fixed initial order
    const ordered = initialCardOrderRef.current.map(idx => displayCards[idx]);
    // Always pin the first 6-letter card (if any) at the front
    const sixCard = ordered.find((card) => card.length === 6) ?? null;
    const withoutSix = sixCard ? ordered.filter((card) => card.id !== sixCard.id) : ordered;
    const finalOrder = sixCard ? [sixCard, ...withoutSix] : withoutSix;
    const trimmed = finalOrder.slice(0, 30);
    const columns: WordCard[][] = [];
    for (let index = 0; index < trimmed.length; index += 6) {
      columns.push(trimmed.slice(index, index + 6));
    }
    return { columns, pinnedSixId: sixCard?.id ?? null };
  }, [displayCards, initialCardOrderRef.current]);

  const handleCreateAccount = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = accountNameInput.trim();
    if (!trimmed) {
      setError("Enter a name to create your account.");
      return;
    }
    const normalized = trimmed.toUpperCase().slice(0, 8);
    setAccountName(normalized);
    setAccountNameInput(normalized);
    setError(null);
  };

  const handleJoin = () => {
    if (!socket || !hasAccount) {
      return;
    }
    
    if (joinMode === "create") {
      socket.emit("createPrivateLobby", { name: accountName.trim().toUpperCase() }, (result: any) => {
        if (result?.ok) {
          socket.emit("setReady", { ready: true });
          setJoined(true);
          setError(null);
          pushToast(`Private lobby created: ${result.lobbyId}`, "success");
        } else {
          setError(result?.error || "Failed to create lobby");
        }
      });
    } else if (joinMode === "joinById") {
      const lobbyId = lobbyIdInput.trim();
      if (!lobbyId) {
        setError("Please enter a lobby ID");
        return;
      }
      socket.emit("join", { name: accountName.trim().toUpperCase(), lobbyId });
      socket.emit("setReady", { ready: true });
      setJoined(true);
      setError(null);
    } else {
      // Random join
      socket.emit("join", { name: accountName.trim().toUpperCase() });
      socket.emit("setReady", { ready: true });
      setJoined(true);
      setError(null);
    }
  };

  const handleCopyLobbyId = async () => {
    if (!game.lobbyId) {
      return;
    }
    try {
      await navigator.clipboard.writeText(game.lobbyId);
      pushToast("Lobby ID copied", "success");
    } catch {
      pushToast("Unable to copy lobby ID", "error");
    }
  };

  const handleToggleReady = () => {
    if (!socket || !joined) {
      return;
    }
    socket.emit("setReady", { ready: !me?.ready });
  };

  const handleLetterClick = (index: number) => {
    if (!joined || game.status !== "active") return;
    // Prevent double-consume when a previous click is still animating
    if (selectedIndices.includes(index) || pendingIndicesRef.current.has(index)) return; // already used or pending
    pendingIndicesRef.current.add(index);
    const letter = (game.letters[index] ?? '').toUpperCase();
    // Instead of creating a floating DOM element and animating, commit the
    // selection immediately (but keep the pending guard to avoid races).
    // Use requestAnimationFrame so any layout changes settle before focus.
    requestAnimationFrame(() => {
      // If this index was aborted (submit/clear happened), don't add it.
      if (abortedIndicesRef.current.has(index)) {
        abortedIndicesRef.current.delete(index);
        pendingIndicesRef.current.delete(index);
        if (inputRef.current) inputRef.current.focus();
        return;
      }
      setSelectedIndices((cur) => (cur.includes(index) ? cur : [...cur, index]));
      setTypedWord((prev) => (prev + letter).toUpperCase());
      pendingIndicesRef.current.delete(index);
      if (inputRef.current) inputRef.current.focus();
      // typing sound
      import("./soundManager").then((m) => m.playType()).catch(() => {});
    });
  };

  const animateLastTileBack = () => {
    // Find the highest selected position that isn't already pending
    let pos = selectedIndices.length - 1;
    while (pos >= 0 && pendingBackPositionsRef.current.has(pos)) pos -= 1;
    if (pos < 0) return;
    animateTileBackAt(pos);
  };

  const animateTileBackAt = (pos: number) => {
    if (pos < 0 || pos >= selectedIndices.length) return;
    const idx = selectedIndices[pos];
    // Prevent duplicate back animations for the same position
    if (pendingBackPositionsRef.current.has(pos)) return;
    pendingBackPositionsRef.current.add(pos);
    const inputEl = inputRef.current;
    // Immediately update the logical selection by position so rapid backspaces
    // remove the intended character regardless of animation timing or index shifts.
    setSelectedIndices((cur) => {
      if (pos < 0 || pos >= cur.length) return cur;
      const next = cur.filter((_, i) => i !== pos);
      return next;
    });
    setTypedWord((prev) => {
      if (pos < 0 || pos >= prev.length) return prev;
      return prev.slice(0, pos) + prev.slice(pos + 1);
    });

    // play backspace/remove sound
    import("./soundManager").then((m) => m.playBackspace()).catch(() => {});

    // Clear guards on next frame.
    requestAnimationFrame(() => {
      pendingBackPositionsRef.current.delete(pos);
      pendingIndicesRef.current.delete(idx);
      if (inputEl) inputEl.focus();
    });
  };

  const handleSubmitWord = () => {
    if (!socket) return;
    // Build effective word from confirmed selections and any pending indices
    const confirmed = selectedIndices.map((i) => (game.letters[i] ?? '').toUpperCase()).join('');
    const pendingOrder = Array.from(pendingIndicesRef.current);
    const pendingLetters = pendingOrder.map((i) => (game.letters[i] ?? '').toUpperCase()).join('');
    const effectiveWord = (confirmed + pendingLetters).trim();
    if (effectiveWord.length === 0) return;
    // Do not submit words shorter than 3 letters — no penalty should be applied
    if (effectiveWord.length < 3) {
      pushToast("Words must be at least 3 letters.", "error");
      return;
    }

    // Mark any pending indices as aborted so their animation cleanup won't re-add state
    if (pendingOrder.length > 0) {
      abortedIndicesRef.current = new Set(pendingOrder);
      // clear pending immediately — we've incorporated them into the submission
      pendingIndicesRef.current.clear();
    }

    socket.emit(
      "submitWord",
      { word: effectiveWord },
      (response?: { ok: boolean; word?: string; points?: number; error?: string }) => {
        // Show result toast (valid/invalid)
        if (response?.ok && response.word) {
          pushSuccess(response.word);
          import("./soundManager").then((m) => m.playValid()).catch(() => {});
        } else if (response?.error) {
          pushToast(response.error, "error");
          import("./soundManager").then((m) => m.playInvalid()).catch(() => {});
        }
        // Show points toast (plus/minus) side by side
        if (typeof response?.points === "number" && response.points !== 0) {
          if (response.points > 0) {
            pushPlus(response.points);
          } else {
            pushMinus(Math.abs(response.points));
          }
        }
      }
    );
    setSelectedIndices([]);
    setTypedWord("");
  };

  const handleClearWord = () => {
    setSelectedIndices([]);
    setTypedWord("");
  };

  const handleSendChat = () => {
    const now = Date.now();
    const safe = chatInput.trim();
    if (!socket || !joined || !safe) {
      return;
    }
    // If currently blocked, inform user
    if (chatBlockedUntil && now < chatBlockedUntil) {
      const secs = Math.ceil((chatBlockedUntil - now) / 1000);
      pushToast(`You're sending messages too fast — try again in ${secs}s`, "error");
      // Still send this single message to the server so the user can see
      // any server-side error (profanity, length, etc.). The server will
      // enforce rate limits so this won't bypass protection.
      try {
        socket.emit("chatMessage", { message: safe });
      } catch (_) {}
      return;
    }
    // Record this send and prune old timestamps (window: 4s)
    const windowMs = 4000;
    const maxRapid = 4; // 4 very fast consecutive submissions
    chatTimestampsRef.current.push(now);
    chatTimestampsRef.current = chatTimestampsRef.current.filter((t) => now - t <= windowMs);
    if (chatTimestampsRef.current.length >= maxRapid) {
      // Block this player for a short cooldown
      const blockMs = 5000;
      setChatBlockedUntil(now + blockMs);
      if (chatBlockTimerRef.current) window.clearTimeout(chatBlockTimerRef.current);
      chatBlockTimerRef.current = window.setTimeout(() => setChatBlockedUntil(null), blockMs);
      pushToast("You're sending messages too quickly. Chat disabled briefly.", "error");
      // Send this one message to the server so the user sees server-side errors.
      try {
        socket.emit("chatMessage", { message: safe });
      } catch (_) {}
      return;
    }

    // Server will enforce profanity filtering; send trimmed message as-is
    socket.emit("chatMessage", { message: safe });
    setChatInput("");
  };

  const handleReturnToLobby = () => {
    if (socket) {
      socket.emit("returnToLobby");
    }
    setShowWinnerOverlay(false);
    setWinnerDismissed(true);
    setResetCountdown(null);
  };

  const handleLeaveLobby = () => {
    if (socket) {
      socket.emit("leaveLobby");
    }
    setShowWinnerOverlay(false);
    setWinnerDismissed(true);
    setJoined(false);
    setAccountName("");
    setAccountNameInput("");
    setResetCountdown(null);
    setGame((current) => ({
      ...current,
      players: [],
      status: "lobby",
      lobbyId: null,
      letters: [],
      cards: [],
      winner: null,
      lastAction: null,
      timeLeft: 120
    }));
  };

  const handleShuffleLetters = useCallback(() => {
    if (!joined || game.status !== "active" || game.letters.length === 0) {
      return;
    }
    setDisplayOrder((current) => {
      const base = current.length === game.letters.length
        ? [...current]
        : game.letters.map((_, index) => index);
      for (let index = base.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [base[index], base[swapIndex]] = [base[swapIndex], base[index]];
      }
      return base;
    });
    setShufflePulse(true);
    if (shuffleTimerRef.current) {
      window.clearTimeout(shuffleTimerRef.current);
    }
    shuffleTimerRef.current = window.setTimeout(() => {
      setShufflePulse(false);
    }, 220);
    // play shuffle sound
    import("./soundManager").then((m) => m.playShuffle()).catch(() => {});
  }, [game.letters, game.status, joined]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }
      // Only shuffle if not typing in an input or textarea
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        return;
      }
      event.preventDefault();
      handleShuffleLetters();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleShuffleLetters]);

  useEffect(() => {
    return () => {
      if (shuffleTimerRef.current) {
        window.clearTimeout(shuffleTimerRef.current);
      }
    };
  }, []);

  // Clean up chat block timer on unmount
  useEffect(() => {
    return () => {
      if (chatBlockTimerRef.current) {
        window.clearTimeout(chatBlockTimerRef.current);
      }
    };
  }, []);

  // Clean up points badge timeout on unmount
  useEffect(() => {
    return () => {
      if (pointsBadgeTimeout.current) {
        window.clearTimeout(pointsBadgeTimeout.current);
      }
    };
  }, []);

  return (
    <div className="page">
      {/* Backend connection banner - visible when socket exists but is disconnected */}
      {socket && !socket.connected && showSocketBanner && (() => {
        // Keep a passive check for a stored hide flag, but banner is now static text only.
        const hideUntilRaw = localStorage.getItem('hideSocketBannerUntil');
        const hideUntil = hideUntilRaw ? parseInt(hideUntilRaw, 10) : 0;
        if (Date.now() < hideUntil) return null;
        return (
          <div style={{ background: '#ffefe6', color: '#422', padding: '8px 12px', textAlign: 'center' }}>
            <span>Backend unreachable — some features may be disabled.</span>
          </div>
        );
      })()}
      {/* Toast notifications under Time Left */}
      <div className="toast-center-row">
        <div className="toast-lane toast-result">
          {toasts.filter(t => t.tone === "success" || t.tone === "error").map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.tone}`}>{toast.text}</div>
          ))}
        </div>
        <div className="toast-lane toast-points">
          {toasts.filter(t => t.tone === "plus" || t.tone === "minus").map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.tone}`}>{toast.text}</div>
          ))}
        </div>
      </div>
      <header className="topbar">
        <div className="brand">
          <div className="brand-row">
            <div className="brand-logo" aria-label="Letter Tiles" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <img src="/logo-128x128.png" alt="Letter Tiles logo" style={{ width: 48, height: 48, objectFit: 'contain' }} />
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1, textAlign: 'left' }}>
                <span style={{ fontWeight: 700, color: '#ef476f', fontSize: 18, letterSpacing: 1 }}>LETTER</span>
                <span style={{ fontWeight: 700, color: '#ef476f', fontSize: 18, letterSpacing: 1 }}>TILES</span>
              </div>
            </div>
            <span className={`live-pill ${game.status === "active" ? "is-live" : ""}`}>
              <span className="live-dot" />
              {game.status === "active" ? "Round live" : "In lobby"}
            </span>
          </div>
        </div>

        <div className="timer-block">
          <span className="timer-label">Time Left</span>
          <span className="timer-value">{formatTime(game.timeLeft)}</span>
          {game.status === "lobby" && lobbyCountdown !== null && (
            <div className="lobby-countdown" aria-live="polite">
              <div className="countdown-ring" role="img" aria-label={`Starting in ${lobbyCountdown}`}>
                  <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
                    <defs>
                      <linearGradient id="logoGradient" x1="0%" x2="100%" y1="0%" y2="100%">
                        <stop offset="0%" stopColor="#ef476f" />
                        <stop offset="100%" stopColor="#ffd166" />
                      </linearGradient>
                    </defs>
                    <circle className="ring-bg" cx="22" cy="22" r="18" fill="none" strokeWidth="4" />
                    {(() => {
                      const circ = 2 * Math.PI * 18;
                      const start = startLobbyCountdownRef.current ?? lobbyCountdown ?? 1;
                      return (
                        <circle
                          className={`ring-fg ${lobbyCountdown !== null ? "counting" : ""}`}
                          cx="22"
                          cy="22"
                          r="18"
                          fill="none"
                          strokeWidth="4"
                          stroke="url(#logoGradient)"
                          style={{
                            strokeDasharray: circ,
                            ["--circ" as any]: `${circ}px`,
                            ["--countdown-duration" as any]: `${start}s`
                          }}
                        />
                      );
                    })()}
                  </svg>
                  <span className={`countdown-number ${tickPulse ? "tick" : ""}`}>{lobbyCountdown}</span>
                </div>
            </div>
          )}
        </div>
      </header>

      <section className="hero-row">
        <div className="side-panels side-left">
            {!hasAccount ? (
              <form className="card" onSubmit={handleCreateAccount}>
                <div className="leaderboard-header">
                  <span>Choose Display Name</span>
                </div>
                <p className="muted">Pick a display name for this session (max 8 characters).</p>
                <input
                  value={accountNameInput}
                  onChange={(event) => setAccountNameInput(event.target.value.toUpperCase().slice(0, 8))}
                  placeholder="Your name"
                  maxLength={8}
                />
                <button type="submit">Pick Name</button>
              </form>
            ) : (
              <div className="card panel-box">
                <div className="lobby-id-line">
                  <h2 className="section-title">Lobby</h2>
                  <button
                    type="button"
                    className={`sound-toggle ${muted ? 'muted' : ''}`}
                    onClick={() => {
                      const next = !muted;
                      setMuted(next);
                      localStorage.setItem('muted', next ? 'true' : 'false');
                      import("./soundManager").then((m) => m.setMuted(next)).catch(() => {});
                    }}
                    aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
                  >
                    {muted ? (
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <path d="M18 9v6h-2V9h2zm-4-6v18l-6-6H4V9h4l6-6z" fill="#1f1c1a" />
                        <path d="M20 4L4 20" stroke="#1f1c1a" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <path d="M3 10v4h4l5 5V5L7 10H3z" fill="#1f1c1a" />
                        <path d="M16.5 12c0-1.77-.77-3.37-2-4.47v8.94c1.23-1.1 2-2.7 2-4.47z" fill="#1f1c1a" />
                      </svg>
                    )}
                  </button>
                  {game.lobbyId && (
                    <button
                      type="button"
                      className="lobby-id-badge-top"
                      onClick={handleCopyLobbyId}
                      aria-label="Copy lobby ID"
                    >
                      <span>{game.lobbyId}</span>
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H10V7h9v14z" />
                      </svg>
                    </button>
                  )}
                </div>
                <p className="muted">Display Name: {(me?.name ?? accountName).toUpperCase()}</p>
                {!joined && (
                  <>
                    <div className="join-mode-selector">
                      <label>
                        <input
                          type="radio"
                          name="joinMode"
                          value="random"
                          checked={joinMode === "random"}
                          onChange={() => setJoinMode("random")}
                        />
                        <span>Join Random</span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="joinMode"
                          value="create"
                          checked={joinMode === "create"}
                          onChange={() => setJoinMode("create")}
                        />
                        <span>Create Private</span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="joinMode"
                          value="joinById"
                          checked={joinMode === "joinById"}
                          onChange={() => setJoinMode("joinById")}
                        />
                        <span>Join by ID</span>
                      </label>
                    </div>
                    {joinMode === "joinById" && (
                      <input
                        value={lobbyIdInput.toUpperCase()}
                        onChange={(event) => setLobbyIdInput(event.target.value.toUpperCase())}
                        placeholder="Enter lobby ID"
                      />
                    )}
                  </>
                )}
                <button type="button" onClick={handleJoin} disabled={joined}>
                  {joined ? "Joined" : "Join lobby"}
                </button>
                {joined && game.status !== "active" && lobbyCountdown === null && !me?.ready && (
                  <button
                    type="button"
                    className="leave-button"
                    onClick={handleLeaveLobby}
                  >
                    Leave lobby
                  </button>
                )}
              </div>
            )}
          

          <div className="card panel-box">
            <div className="leaderboard-header">
              <span>Players in Lobby</span>
              {isMobile && game.status === 'active' && (
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={() => setShowPlayersPanel((prev) => !prev)}
                >
                  {showPlayersPanel ? "Hide" : "Show"}
                </button>
              )}
            </div>
            {(showPlayersPanel || game.status !== 'active') && (
              game.players.length === 0 ? (
                <p className="muted">No players yet.</p>
              ) : (
                <ul className="lobby-list">
                  {game.players.map((player) => (
                    <li key={player.id} className="lobby-item">
                      <span className="avatar" style={{ background: player.avatarColor }}>
                        {player.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span>{player.name.toUpperCase()}</span>
                      <span style={{ display: "flex", alignItems: "center", marginLeft: "auto", gap: 8 }}>
                        {player.id === me?.id && joined && game.status === "lobby" && (
                          <label className="ready-toggle" style={{ marginRight: 0 }}>
                            <input
                              type="checkbox"
                              checked={!!player.ready}
                              onChange={handleToggleReady}
                            />
                            <span className="ready-slider" />
                          </label>
                        )}
                        <span className={`lobby-ready ${player.ready ? "is-ready" : "is-not-ready"}`}>{player.ready ? "Ready" : "Not ready"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
          {joined && (
            <div className="chat-box">
              <div className="panel-header">
                <div className="recent-words-label">Chat</div>
                {isMobile && (
                  <button
                    type="button"
                    className="collapse-toggle"
                    onClick={() => setShowChatPanel((prev) => !prev)}
                  >
                    {showChatPanel ? "Hide" : "Show"}
                  </button>
                )}
              </div>
              {showChatPanel && (
                <>
                  <div className="chat-messages" style={{ overflowY: "auto", maxHeight: 200 }}>
                    {chatMessages.length === 0 ? (
                      <p className="muted">No messages yet.</p>
                    ) : (
                      <>
                        {chatMessages.map((msg) => (
                          <div key={msg.id} className="chat-message">
                            <span
                              className="chat-avatar"
                              style={{ background: msg.playerColor }}
                            >
                              {msg.playerName.slice(0, 1).toUpperCase()}
                            </span>
                            <div className="chat-content">
                              <span className="chat-name">{msg.playerName}</span>
                              <span className="chat-text">{msg.message}</span>
                            </div>
                          </div>
                        ))}
                        <div ref={chatMessagesEndRef} />
                      </>
                    )}
                  </div>
                  <div className="chat-input-row">
                    <input
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          handleSendChat();
                        }
                      }}
                      placeholder={chatBlockedUntil && Date.now() < chatBlockedUntil ? `Chat disabled for ${Math.ceil((chatBlockedUntil - Date.now())/1000)}s` : "Type a message..."}
                      maxLength={200}
                      disabled={!!chatBlockedUntil && Date.now() < chatBlockedUntil}
                    />
                    <button type="button" onClick={handleSendChat} disabled={!!chatBlockedUntil && Date.now() < chatBlockedUntil}>
                      {chatBlockedUntil && Date.now() < chatBlockedUntil ? "Disabled" : "Send"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="center-stack">
          <section className="letter-center">
            {/* Toasts moved to .page, nothing here */}
            <div className="letter-center-content">
                          {/* Floating points badge animation */}
                          {pointsBadge && (
                            <div key={pointsBadge.key} className={`points-badge ${pointsBadge.value > 0 ? "plus" : "minus"}`}>
                              {pointsBadge.value > 0 ? "+" : "-"}{Math.abs(pointsBadge.value)}
                            </div>
                          )}
              {displayLetters.length === 0 ? (
                <p className="muted">Waiting for round to start...</p>
              ) : (
                <div className={`letter-row${shufflePulse ? " shuffle-pulse" : ""}`}>
                  {letterOrder.map((letterIndex) => (
                    <button
                      id={`letter-tile-${letterIndex}`}
                      ref={(el) => { tileRefs.current[letterIndex] = el; }}
                      key={`${displayLetters[letterIndex]}-${letterIndex}`}
                      className={`letter-tile ${selectedIndices.includes(letterIndex) ? "used" : ""}`}
                      onClick={() => handleLetterClick(letterIndex)}
                      disabled={!joined || game.status !== "active" || selectedIndices.includes(letterIndex)}
                      aria-hidden={selectedIndices.includes(letterIndex)}
                    >
                      {selectedIndices.includes(letterIndex) ? '' : displayLetters[letterIndex]}
                    </button>
                  ))}
                </div>
              )}
              <div className="word-builder">
                <div
                  className="word-input"
                  ref={inputRef}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    const k = event.key;
                    if (k === "Enter") {
                      event.preventDefault();
                      handleSubmitWord();
                      return;
                    }
                    if (k === 'Backspace') {
                      event.preventDefault();
                      animateLastTileBack();
                      return;
                    }
                    if (/^[a-zA-Z]$/.test(k)) {
                      const upper = k.toUpperCase();
                      const avail = game.letters.findIndex((ch, idx) => ch === upper && !selectedIndices.includes(idx) && !pendingIndicesRef.current.has(idx));
                      if (avail !== -1) {
                        event.preventDefault();
                        handleLetterClick(avail);
                        return;
                      }
                    }
                  }}
                >
                  {typedWord.split("").map((ch, pos) => (
                    <button
                      key={`typed-${pos}`}
                      type="button"
                      className="typed-letter"
                      onClick={() => animateTileBackAt(pos)}
                    >
                      {ch}
                    </button>
                  ))}
                  {typedWord.length === 0 && (
                    <span className="word-input-placeholder">Pick or type letters and press Enter</span>
                  )}
                </div>
                <div className="word-actions">
                  <button type="button" onClick={handleClearWord} disabled={!canClear}>
                    Clear
                  </button>
                  <button type="button" onClick={handleShuffleLetters} disabled={!joined || game.status !== "active"}>
                    Shuffle
                  </button>
                  <button type="button" onClick={handleSubmitWord} disabled={!canSubmit}>
                    Enter
                  </button>
                </div>
              </div>
            </div>
            <div className="toast-lane toast-right">
            </div>
          </section>
          {game.status === 'active' && displayLetters.length > 0 && (
            <div id="ad-anchor" style={{ margin: '12px 0', textAlign: 'center' }}>
              <ins
                className="adsbygoogle"
                style={{ display: 'inline-block', width: 320, height: 50, background: '#f6f6f6', color: '#666', lineHeight: '50px', textAlign: 'center' }}
                data-ad-client={(import.meta as any).env.VITE_ADSENSE_CLIENT || 'ca-pub-3913612227802101'}
                data-ad-slot="8236587086"
                data-ad-format="auto"
                data-adtest={(import.meta as any).env.VITE_ADSENSE_TEST === 'on' ? 'on' : undefined}
              />
            </div>
          )}
          <section className="word-bank">
            <div className="leaderboard-header">
              <div className="word-bank-title">
                <span>Hidden Words</span>
                <span className="word-bank-revealed">
                  ({game.cards.filter((card) => card.revealed).length} revealed)
                </span>
              </div>
              {isMobile && (
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={() => setShowHiddenPanel((prev) => !prev)}
                >
                  {showHiddenPanel ? "Hide" : "Show"}
                </button>
              )}
            </div>
            {showHiddenPanel && (
              <>
                <p className="word-bank-note">More words not on the lists!</p>
                <div className="word-grid">
                  {wordData.columns.map((column, columnIndex) => (
                    <div key={`column-${columnIndex}`} className="word-column">
                      {column.map((card) => {
                        const letters = card.revealed && card.word
                          ? card.word.split("")
                          : Array.from({ length: card.length }, () => "?");
                        const isPinned = card.id === wordData.pinnedSixId && card.length === 6;
                        return (
                          <div
                            key={card.id}
                            className={`word-card ${card.revealed ? "revealed" : ""} ${isPinned ? "pinned" : ""}`}
                          >
                            {letters.map((letter, letterIndex) => (
                              <span key={`${card.id}-${letterIndex}`} className="word-tile">
                                {letter}
                              </span>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>

        <div className="side-panels side-right">
          <div className="leaderboard">
            <div className="leaderboard-header">
              <span>Live scoring</span>
            </div>
            <ul>
              {sortedPlayers.map((player, index) => (
                <li
                  key={player.id}
                  className={`rank-item ${
                    player.id === me?.id ? "active" : ""
                  } ${rankChanges[player.id] === "up" ? "rank-up" : ""} ${
                    rankChanges[player.id] === "down" ? "rank-down" : ""
                  }`}
                >
                  <span className={`avatar ${index === 0 ? "leader" : ""}`} style={{ background: player.avatarColor }}>
                    {player.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>{player.name.toUpperCase()}</span>
                  <span className="score">
                    {index === 0 && (
                      <svg className="crown" viewBox="0 0 24 24" aria-label="Leader" role="img">
                        <path d="M3 7l4 4 5-6 5 6 4-4v10H3z" />
                      </svg>
                    )}
                    {player.score}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="leaderboard recent-words">
            <div className="leaderboard-header">
              <span>Recent Valid Words</span>
              {isMobile && (
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={() => setShowRecentPanel((prev) => !prev)}
                >
                  {showRecentPanel ? "Hide" : "Show"}
                </button>
              )}
            </div>
            {showRecentPanel && (
              recentValidWords.length > 0 ? (
                <div className={`recent-words-list${recentValidWords.length > 4 ? " two-columns" : ""}${recentValidWords.length > 4 ? " scrollable" : ""}`}>
                  {recentValidWords.map((word, index) => (
                    <div key={index} className="recent-word-item">
                      {word}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No words yet.</p>
              )
            )}
          </div>
          <div className="hint-box">
            <div className="leaderboard-header">
              <span>Hint</span>
              {isMobile && (
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={() => setShowHintPanel((prev) => !prev)}
                >
                  {showHintPanel ? "Hide" : "Show"}
                </button>
              )}
            </div>
            {showHintPanel && (
              <div className="score-hint muted">
                <ul>
                  <li className="hint-item">
                    <span><strong className="score-hint-label">All Hidden Found:</strong> +3000 points for revealing all hidden words.</span>
                  </li>
                  <li className="hint-item">
                    <span><strong className="score-hint-label">Base:</strong> 100 points per letter.</span>
                  </li>
                  <li className="hint-item">
                    <span><strong className="score-hint-label">Hidden Word Bonus:</strong> +150 (3), +300 (4), +750 (5), +1600 (6).</span>
                  </li>
                  <li className="hint-item">
                    <span><strong className="score-hint-label">Invalid Word:</strong> -50 points and reset streak.</span>
                  </li>
                  <li className="hint-item">
                    <span><strong className="score-hint-label">Length Bonus:</strong> +50 (4), +100 (5), +200 (6).</span>
                  </li>
                  <li className="hint-item">
                    <span><strong className="score-hint-label">Streaks Bonus:</strong> +10% / +20% / +35% / +50% (2/3/4/5+ in a row).</span>
                  </li>
                  <li className="hint-item">
                    <span><strong className="score-hint-label">Word Lengths:</strong> Only 3 to 6 letter words are possible.</span>
                  </li>
                </ul>
              </div>
            )}
          </div>
        </div>
      </section>

      {game.status === "ended" && game.winner && showWinnerOverlay && (
        <div className={`winner-overlay ${confettiEnabled ? 'confetti-enabled' : ''}`}>
          {confettiEnabled && (
            <div className="confetti" aria-hidden="true">
              {Array.from({ length: 12 }).map((_, index) => (
                <span key={`confetti-${index}`} className="confetti-piece" />
              ))}
            </div>
          )}
          <div className="winner-card">
            {isDraw ? (
              <div className="winner-avatars">
                {topTwo.map((player) => (
                  <span
                    key={player.id}
                    className="avatar large"
                    style={{ background: player.avatarColor }}
                  >
                    {player.name.slice(0, 1).toUpperCase()}
                  </span>
                ))}
              </div>
            ) : (
              <span className="avatar large" style={{ background: game.winner.avatarColor }}>
                {game.winner.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <h2>{isDraw ? "Draw, good try!" : `${game.winner.name.toUpperCase()} wins!`}</h2>
            {!isDraw && (
              <p className="winner-message">Congratulations! Great round.</p>
            )}
            <p className="muted">Score: {game.winner.score}</p>
            {/* Final top-3 podium */}
            {sortedPlayers && sortedPlayers.length > 0 && (
              <div style={{ marginTop: 12, textAlign: "center", width: "100%" }}>
                <h3 style={{ margin: "6px 0" }}>Final Ranking</h3>
                <div className="podium">
                  {/* 3rd place - left */}
                  <div className="podium-slot third">
                    {sortedPlayers[2] ? (
                      <>
                        <div className="podium-riser third-riser">
                          <div className="podium-avatar" style={{ background: sortedPlayers[2].avatarColor }}>{sortedPlayers[2].name.slice(0,1).toUpperCase()}</div>
                          <div className="podium-name">{sortedPlayers[2].name.toUpperCase()}</div>
                          <div className="podium-score">{sortedPlayers[2].score}</div>
                        </div>
                      </>
                    ) : (
                      <div className="podium-riser third-riser empty">—</div>
                    )}
                  </div>

                  {/* 1st place - center */}
                  <div className="podium-slot first">
                    {sortedPlayers[0] ? (
                      <>
                        <div className="podium-riser first-riser">
                          <div className="podium-avatar large" style={{ background: sortedPlayers[0].avatarColor }}>{sortedPlayers[0].name.slice(0,1).toUpperCase()}</div>
                          <div className="podium-name">{sortedPlayers[0].name.toUpperCase()}</div>
                          <div className="podium-score">{sortedPlayers[0].score}</div>
                        </div>
                      </>
                    ) : (
                      <div className="podium-riser first-riser empty">—</div>
                    )}
                  </div>

                  {/* 2nd place - right */}
                  <div className="podium-slot second">
                    {sortedPlayers[1] ? (
                      <>
                        <div className="podium-riser second-riser">
                          <div className="podium-avatar" style={{ background: sortedPlayers[1].avatarColor }}>{sortedPlayers[1].name.slice(0,1).toUpperCase()}</div>
                          <div className="podium-name">{sortedPlayers[1].name.toUpperCase()}</div>
                          <div className="podium-score">{sortedPlayers[1].score}</div>
                        </div>
                      </>
                    ) : (
                      <div className="podium-riser second-riser empty">—</div>
                    )}
                  </div>
                </div>
              </div>
            )}
            {/* Show player's top submitted words (received in per-client state as playerTopWords) */}
            {me && (game as any).playerTopWords && (game as any).playerTopWords.length > 0 && (
              <div style={{ marginTop: 12, textAlign: "left", width: "100%" }}>
                <h3 style={{ margin: "6px 0" }}>Your Top Words</h3>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
                  {(game as any).playerTopWords.map((entry: any, idx: number) => (
                    <li key={idx} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span style={{ fontWeight: 700 }}>{entry.word}</span>
                      <span style={{ color: "#1f6b2c", fontWeight: 700 }}>+{entry.points}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {resetCountdown !== null && (
              <p className="reset-message">Resetting in {resetCountdown} seconds</p>
            )}
            <div className="word-actions">
              <button type="button" onClick={handleReturnToLobby}>
                Return To Lobby
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ko‑fi tip banner (above footer) */}
      {/* Ko-fi overlay widget */}
      <div id="kofi-widget"></div>

      <footer style={{ textAlign: "center", padding: 12, opacity: 0.9 }}>
        <div className="footer-links" style={{ marginBottom: 8 }}>
          <a href="/privacy.html">Privacy & Cookie Policy</a> &nbsp;·&nbsp; <a href="/contact.html">Contact</a>
        </div>
        {/* Ad placeholder removed below privacy/contact links to avoid serving ads on thin-content pages */}
      </footer>
      {/* CookieConsent removed; CookieYes handles the banner and consent */}
    </div>
  );
};

export default App;