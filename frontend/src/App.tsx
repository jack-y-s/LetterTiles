import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

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
  tone: "success" | "error";
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


const socketUrl = "http://localhost:3001";

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
};

const App = () => {
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
  const lastSuccessRef = useRef<{ word: string; at: number } | null>(null);
  const [recentValidWords, setRecentValidWords] = useState<string[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [lobbyCountdown, setLobbyCountdown] = useState<number | null>(null);
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

  const pushToast = (text: string, tone: "success" | "error") => {
    const id = toastIdRef.current++;
    setToasts((current) => [{ id, text, tone }, ...current]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 5000);
  };


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
      pushToast(message, "error");
    });

    socketInstance.on("submissionAccepted", ({ word }: { word: string }) => {
      pushSuccess(word);
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
  const wordData = useMemo(() => {
    if (game.cards.length === 0) {
      return { columns: [] as WordCard[][], pinnedSixId: null as number | null };
    }
    const sorted = [...game.cards].sort((a, b) => b.length - a.length);
    const sixCard = sorted.find((card) => card.length === 6) ?? null;
    const withoutSix = sixCard ? sorted.filter((card) => card.id !== sixCard.id) : sorted;
    const ordered = sixCard ? [sixCard, ...withoutSix] : withoutSix;
    const trimmed = ordered.slice(0, 30);
    const columns: WordCard[][] = [];
    for (let index = 0; index < trimmed.length; index += 6) {
      columns.push(trimmed.slice(index, index + 6));
    }
    return { columns, pinnedSixId: sixCard?.id ?? null };
  }, [game.cards]);

  const handleCreateAccount = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = accountNameInput.trim();
    if (!trimmed) {
      setError("Enter a name to create your account.");
      return;
    }
    setAccountName(trimmed);
    setAccountNameInput(trimmed);
    setError(null);
  };

  const handleJoin = () => {
    if (!socket || !hasAccount) {
      return;
    }
    
    if (joinMode === "create") {
      socket.emit("createPrivateLobby", { name: accountName.trim() }, (result: any) => {
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
      socket.emit("join", { name: accountName.trim(), lobbyId });
      socket.emit("setReady", { ready: true });
      setJoined(true);
      setError(null);
    } else {
      // Random join
      socket.emit("join", { name: accountName.trim() });
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
  };

  const handleSubmitWord = () => {
    if (!socket || displayWord.length === 0) {
      return;
    }
    socket.emit(
      "submitWord",
      { word: displayWord },
      (response?: { ok: boolean; word?: string }) => {
        if (response?.ok && response.word) {
          pushSuccess(response.word);
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

  return (
    <div className="page">
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
          <span className="timer-label">Time Left:</span>
          <span className="timer-value">{formatTime(game.timeLeft)}</span>
          {game.status === "lobby" && lobbyCountdown !== null && (
            <div className="lobby-countdown" aria-live="polite">
              {lobbyCountdown === 0 ? (
                <div className="star-burst" aria-label="Starting">
                  <span className="star star-1" />
                  <span className="star star-2" />
                  <span className="star star-3" />
                </div>
              ) : (
                <div className="countdown-badge">
                  <span className="countdown-number">{lobbyCountdown}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <section className="hero-row">
        <div className="side-panels side-left">
          {!hasAccount ? (
            <form className="card" onSubmit={handleCreateAccount}>
              <h2 className="section-title">Choose Display Name</h2>
              <p className="muted">Pick a display name for this session.</p>
              <input
                value={accountNameInput}
                onChange={(event) => setAccountNameInput(event.target.value)}
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
              <p className="muted">Display Name: {accountName}</p>
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
            <div className="panel-header">
              <h2 className="section-title">Players in Lobby</h2>
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
                <p className="muted">No players yet</p>
              ) : (
                <ul className="lobby-list">
                  {game.players.map((player) => (
                    <li key={player.id} className="lobby-item">
                      <span className="avatar" style={{ background: player.avatarColor }}>
                        {player.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span>{player.name}</span>
                      <span className={`lobby-ready ${player.ready ? "is-ready" : "is-not-ready"}`}>
                        {player.ready ? "Ready" : "Not ready"}
                      </span>
                      {player.id === me?.id && joined && game.status === "lobby" && (
                        <button
                          type="button"
                          className={`lobby-ready-toggle ${player.ready ? "is-not-ready" : "is-ready"}`}
                          onClick={handleToggleReady}
                        >
                          {player.ready ? "Not ready" : "Ready"}
                        </button>
                      )}
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
                  <div className="chat-messages">
                    {chatMessages.length === 0 ? (
                      <p className="muted">No messages yet</p>
                    ) : (
                      chatMessages.map((msg) => (
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
                      ))
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
            <div className="toast-lane toast-left">
              {toasts
                .filter((toast) => toast.tone === "error")
                .map((toast) => (
                  <div key={toast.id} className="toast toast-error">
                    {toast.text}
                  </div>
                ))}
            </div>
            <div className="letter-center-content">
              {game.letters.length === 0 ? (
                <p className="muted">Waiting for letters...</p>
              ) : (
                <div className={`letter-row${shufflePulse ? " shuffle-pulse" : ""}`}>
                  {letterOrder.map((letterIndex) => (
                    <button
                      key={`${game.letters[letterIndex]}-${letterIndex}`}
                      className={`letter-tile ${selectedIndices.includes(letterIndex) ? "selected" : ""}`}
                      onClick={() => handleLetterClick(letterIndex)}
                      disabled={!joined || game.status !== "active"}
                    >
                      {game.letters[letterIndex]}
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
            <div className="word-bank-header">
              <div className="word-bank-title">
                <h2 className="section-title">Hidden Words</h2>
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
                  <span>{player.name}</span>
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

          <div className="recent-words">
            <div className="panel-header">
              <div className="recent-words-label">Recent Valid Words</div>
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
              <div className={`recent-words-list${recentValidWords.length > 4 ? " two-columns" : ""}`}>
                {recentValidWords.length > 0 ? (
                  recentValidWords.map((word, index) => (
                    <div key={index} className="recent-word-item">
                      {word}
                    </div>
                  ))
                ) : (
                  <div className="recent-words-empty">-</div>
                )}
              </div>
            )}
          </div>
          <div className="hint-box">
            <div className="panel-header">
              <div className="recent-words-label">Hint</div>
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
                  <li><span className="score-hint-label">Base:</span> 100 points per letter.</li>
                  <li><span className="score-hint-label">Length Bonus:</span> +50 (4), +100 (5), +200 (6).</li>
                  <li><span className="score-hint-label">Hidden Word Bonus:</span> +150 (3), +300 (4), +750 (5), +1600 (6).</li>
                  <li><span className="score-hint-label">Streaks Bonus:</span> +10% / +20% / +35% / +50% (2/3/4/5+ in a row).</li>
                  <li><span className="score-hint-label">Invalid Word:</span> -50 points and reset streak.</li>
                  <li><span className="score-hint-label">All Hidden:</span> +3000 for revealing all hidden words.</li>
                  <li><span className="score-hint-label">Word Lengths:</span> Only 3 to 6 letters are possible.</li>
                </ul>
              </div>
            )}
          </div>
        </div>
      </section>

      {game.status === "ended" && game.winner && showWinnerOverlay && (
        <div className="winner-overlay">
          <div className="confetti" aria-hidden="true">
            {Array.from({ length: 12 }).map((_, index) => (
              <span key={`confetti-${index}`} className="confetti-piece" />
            ))}
          </div>
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
            <h2>{isDraw ? "Draw, good try!" : `${game.winner.name} wins`}</h2>
            {!isDraw && (
              <p className="winner-message">Congratulations! Great round.</p>
            )}
            <p className="muted">Score: {game.winner.score}</p>
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
    </div>
  );
};

export default App;