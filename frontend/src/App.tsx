import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import CookieConsent from "./CookieConsent";

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


// Use the custom API hostname for production. Prefer Vite `VITE_API_URL`,
// fall back to older `REACT_APP_API_URL` if present, then localhost for dev.
const socketUrl = (import.meta as any).env.VITE_API_URL || "http://localhost:3001";

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
};

const App = () => {
    // Floating points badge state
    const [pointsBadge, setPointsBadge] = useState<{ value: number, key: number } | null>(null);
    const pointsBadgeTimeout = useRef<number | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
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
  const [lobbyCountdown, setLobbyCountdown] = useState<number | null>(null);
  // For enhanced countdown animation: remember starting value and pulse per tick
  const startLobbyCountdownRef = useRef<number | null>(null);
  const [tickPulse, setTickPulse] = useState(false);
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
    const socketInstance = io(socketUrl, { transports: ["websocket"] });

    socketInstance.on("connect", () => {
      setError(null);
    });

    socketInstance.on("state", (state: GameState) => {
      setGame(state);
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
    });

    socketInstance.on("chatHistory", (messages: ChatMessage[]) => {
      setChatMessages(messages);
    });

    socketInstance.on("lobbyCountdown", (seconds: number | null) => {
      setLobbyCountdown(seconds);
    });

    // keep start value in sync when countdown begins
    socketInstance.on("lobbyCountdown", (seconds: number | null) => {
      // no-op here, handled in effect below
    });

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
    const normalized = trimmed.toUpperCase();
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
    if (!joined || game.status !== "active") {
      return;
    }
    setSelectedIndices((current) => {
      if (current.includes(index)) {
        return current.filter((value) => value !== index);
      }
      return [...current, index];
    });
    setTypedWord((prev) => (prev + (game.letters[index] ?? "")).toUpperCase());
  };

  const handleSubmitWord = () => {
    if (!socket || displayWord.length === 0) {
      return;
    }
    socket.emit(
      "submitWord",
      { word: displayWord },
      (response?: { ok: boolean; word?: string; points?: number; error?: string }) => {
        // Show result toast (valid/invalid)
        if (response?.ok && response.word) {
          pushSuccess(response.word);
        } else if (response?.error) {
          pushToast(response.error, "error");
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
    if (!socket || !joined || !chatInput.trim()) {
      return;
    }
    socket.emit("chatMessage", { message: chatInput.trim() });
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
            <div className="brand-tiles" aria-label="Letter Tiles">
              <div className="brand-tiles-row">
                {"LETTER".split("").map((char, index) => (
                  <span key={`letter-${index}`} className="brand-tile">
                    [ {char} ]
                  </span>
                ))}
              </div>
              <div className="brand-tiles-row">
                {"TILES".split("").map((char, index) => (
                  <span key={`tiles-${index}`} className="brand-tile">
                    [ {char} ]
                  </span>
                ))}
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
                    <circle className="ring-bg" cx="22" cy="22" r="18" fill="none" strokeWidth="4" />
                    <circle
                      className="ring-fg"
                      cx="22"
                      cy="22"
                      r="18"
                      fill="none"
                      strokeWidth="4"
                      style={{
                        strokeDasharray: 2 * Math.PI * 18,
                          strokeDashoffset: (() => {
                            const start = startLobbyCountdownRef.current ?? lobbyCountdown;
                            const frac = start > 0 ? Math.max(0, Math.min(1, lobbyCountdown / start)) : 0;
                            const circ = 2 * Math.PI * 18;
                            // Use a negative offset so the stroke "empties" in the
                            // opposite direction (anticlockwise) starting from the top.
                            return String(-circ * (1 - frac));
                          })(),
                        transition: "stroke-dashoffset 0.28s linear"
                      }}
                    />
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
                <p className="muted">Pick a display name for this session.</p>
                <input
                  value={accountNameInput}
                  onChange={(event) => setAccountNameInput(event.target.value.toUpperCase())}
                  placeholder="Your name"
                />
                <button type="submit">Pick Name</button>
              </form>
            ) : (
              <div className="card panel-box">
                <div className="lobby-id-line">
                  <h2 className="section-title">Lobby</h2>
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
                <p className="muted">Display Name: {accountName.toUpperCase()}</p>
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
                        value={lobbyIdInput}
                        onChange={(event) => setLobbyIdInput(event.target.value)}
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
              {isMobile && (
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={() => setShowPlayersPanel((prev) => !prev)}
                >
                  {showPlayersPanel ? "Hide" : "Show"}
                </button>
              )}
            </div>
            {showPlayersPanel && (
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
                      placeholder="Type a message..."
                      maxLength={200}
                    />
                    <button type="button" onClick={handleSendChat}>
                      Send
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
                      key={`${displayLetters[letterIndex]}-${letterIndex}`}
                      className={`letter-tile ${selectedIndices.includes(letterIndex) ? "selected" : ""}`}
                      onClick={() => handleLetterClick(letterIndex)}
                      disabled={!joined || game.status !== "active"}
                    >
                      {displayLetters[letterIndex]}
                    </button>
                  ))}
                </div>
              )}
              <div className="word-builder">
                <input
                  className="word-input"
                  value={typedWord}
                  onChange={(event) => setTypedWord(event.target.value.toUpperCase())}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleSubmitWord();
                    }
                  }}
                  placeholder="Pick or type letters and press Enter"
                  disabled={!joined || game.status !== "active"}
                />
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
            {/* Final top-3 ranking with medals */}
            {sortedPlayers && sortedPlayers.length > 0 && (
              <div style={{ marginTop: 12, textAlign: "left", width: "100%" }}>
                <h3 style={{ margin: "6px 0" }}>Final Ranking</h3>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
                  {sortedPlayers.slice(0, 3).map((p, idx) => (
                    <li key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 20 }}>{["🥇", "🥈", "🥉"][idx]}</span>
                        <span style={{ fontWeight: 700 }}>{p.name.toUpperCase()}</span>
                      </span>
                      <span style={{ fontWeight: 700 }}>{p.score}</span>
                    </li>
                  ))}
                </ul>
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
        <footer style={{ textAlign: "center", padding: 12, opacity: 0.9 }}>
          <a href="/privacy.html">Privacy & Cookie Policy</a> &nbsp;·&nbsp; <a href="/contact.html">Contact</a>
        </footer>
        <CookieConsent />
    </div>
  );
};

export default App;