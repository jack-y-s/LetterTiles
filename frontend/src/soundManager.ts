// Simple WebAudio-based sound manager for game events.
// Supports synthesized tones, mute control, and optional external file overrides.
let ctx: AudioContext | null = null;
const ensureCtx = () => {
  if (!ctx) {
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return ctx;
};

let muted = false;
const soundFiles: Record<string, string> = {};
const preloaded: Record<string, HTMLAudioElement | null> = {};
const buffers: Record<string, AudioBuffer | null> = {};

export const setMuted = (v: boolean) => { muted = !!v; };
export const isMuted = () => !!muted;

export const setSoundFiles = (files: Record<string, string>) => {
  Object.assign(soundFiles, files);
  try {
    // Preload provided files to avoid first-play network/decoding delay.
    Object.keys(files).forEach((k) => {
      try {
        const url = files[k];
        if (!url) return;
        const a = new Audio();
        a.preload = 'auto';
        a.src = url;
        try { a.load(); } catch (_) {}
        preloaded[k] = a;
        // Attempt to fetch and decode into an AudioBuffer for lowest-latency playback.
        try {
          const audio = ensureCtx();
          // Fetch and decode asynchronously; failures are ignored and fallback to HTMLAudio remains.
          fetch(url).then((res) => res.arrayBuffer()).then((buf) => {
            audio.decodeAudioData(buf).then((decoded) => {
              buffers[k] = decoded;
            }).catch(() => {
              buffers[k] = null;
            });
          }).catch(() => { buffers[k] = null; });
        } catch (_) {
          buffers[k] = null;
        }
      } catch (_) {
        preloaded[k] = null;
      }
    });
  } catch (_) {}
};

const playFileIfPresent = (key: string) => {
  try {
    const url = soundFiles[key];
    if (!url) return false;
    // Prefer AudioBuffer playback when available for lowest latency
    const buf = buffers[key];
    if (buf) {
      try {
        const audio = ensureCtx();
        const src = audio.createBufferSource();
        src.buffer = buf;
        const gain = audio.createGain();
        gain.gain.value = 1;
        src.connect(gain).connect(audio.destination);
        src.start(audio.currentTime + 0);
        return true;
      } catch (_) {
        // fall back to HTMLAudio below
      }
    }
    const pre = preloaded[key];
    if (pre instanceof HTMLAudioElement) {
      try {
        const clone = pre.cloneNode(true) as HTMLAudioElement;
        clone.currentTime = 0;
        clone.play().catch(() => {});
        return true;
      } catch (_) {}
    }
    const a = new Audio(url);
    a.play().catch(() => {});
    return true;
  } catch (_) {}
  return false;
};

const playTone = (freq: number, type = 'sine', duration = 0.12, volume = 0.25) => {
  try {
    const audio = ensureCtx();
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type as OscillatorType;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.value = 0.0001;
    gain.gain.linearRampToValueAtTime(volume, now + 0.01);
    osc.connect(gain).connect(audio.destination);
    osc.start(now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.stop(now + duration + 0.02);
  } catch (_) {}
};

export const playType = () => {
  if (muted) return;
  if (playFileIfPresent('type')) return;
  playTone(900, 'square', 0.06, 0.18);
};
export const playShuffle = () => {
  if (muted) return;
  if (playFileIfPresent('shuffle')) return;
  playTone(520, 'sawtooth', 0.18, 0.18);
  setTimeout(() => playTone(620, 'sine', 0.08, 0.12), 80);
};
export const playValid = () => {
  if (muted) return;
  if (playFileIfPresent('valid')) return;
  playTone(880, 'sine', 0.18, 0.28);
  setTimeout(() => playTone(1100, 'sine', 0.12, 0.18), 140);
};
export const playInvalid = () => {
  if (muted) return;
  if (playFileIfPresent('invalid')) return;
  playTone(220, 'sawtooth', 0.22, 0.28);
};
export const playCountdownStart = () => {
  if (muted) return;
  if (playFileIfPresent('countdownStart')) return;
  playTone(440, 'sine', 0.12, 0.18);
  setTimeout(() => playTone(660, 'sine', 0.12, 0.16), 120);
};
export const playCountdownTick = () => {
  if (muted) return;
  if (playFileIfPresent('countdownTick')) return;
  playTone(660, 'sine', 0.06, 0.14);
};
export const playBackspace = () => {
  if (muted) return;
  if (playFileIfPresent('backspace')) return;
  // short, subtle click for removal
  playTone(520, 'square', 0.04, 0.14);
};
export const playEndGame = () => {
  if (muted) return;
  if (playFileIfPresent('endGame')) return;
  playTone(320, 'sine', 0.26, 0.28);
  setTimeout(() => playTone(480, 'sine', 0.22, 0.22), 180);
};
export const playNewChat = () => {
  if (muted) return;
  if (playFileIfPresent('newChat')) return;
  playTone(780, 'triangle', 0.12, 0.16);
};
export const playFoundSix = () => {
  if (muted) return;
  if (playFileIfPresent('foundSix')) return;
  playTone(980, 'sine', 0.18, 0.32);
  setTimeout(() => playTone(1240, 'sine', 0.12, 0.22), 140);
};

export const unlockAudio = async () => {
  try {
    const a = ensureCtx();
    if (a.state === 'suspended') await a.resume();
    // After unlocking, attempt to decode any sound files that haven't been
    // decoded yet. Do this opportunistically; failures fall back to
    // HTMLAudio playback.
    try {
      Object.keys(soundFiles).forEach(async (k) => {
        try {
          if (buffers[k] === undefined || buffers[k] === null) {
            const url = soundFiles[k];
            if (!url) { buffers[k] = null; return; }
            const res = await fetch(url).catch(() => null);
            if (!res) { buffers[k] = null; return; }
            const arr = await res.arrayBuffer().catch(() => null);
            if (!arr) { buffers[k] = null; return; }
            try {
              const decoded = await a.decodeAudioData(arr.slice(0));
              buffers[k] = decoded;
            } catch (_err) {
              buffers[k] = null;
            }
          }
        } catch (_) { buffers[k] = null; }
      });
    } catch (_) {}
  } catch (e) {
    // ignore
  }
};

const api = {
  playType,
  playShuffle,
  playValid,
  playInvalid,
  playCountdownStart,
  playCountdownTick,
  playBackspace,
  playEndGame,
  playNewChat,
  playFoundSix,
  unlockAudio,
  setMuted,
  isMuted,
  setSoundFiles,
};

try {
  // Expose a synchronous reference to avoid dynamic-import overhead in
  // hot paths (clicks/typing). Consumers can call window.__soundManager.playType()
  // after the module is imported once.
  (window as any).__soundManager = api;
} catch (_) {}

export default api;
