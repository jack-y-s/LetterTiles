// Default sound file paths. Replace these with real .mp3 files placed
// under `public/sounds/` (or update paths to your CDN). Players cannot
// upload files; these are app-defined defaults.
const soundFiles: Record<string, string> = {
  type: '/sounds/type.mp3',
  shuffle: '/sounds/shuffle.mp3',
  valid: '/sounds/valid.mp3',
  invalid: '/sounds/invalid.mp3',
  countdownStart: '/sounds/countdownStart.mp3',
  countdownTick: '/sounds/countdownTick.mp3',
  endGame: '/sounds/endGame.mp3',
  newChat: '/sounds/newChat.mp3',
  foundSix: '/sounds/foundSix.mp3',
};

export default soundFiles;
