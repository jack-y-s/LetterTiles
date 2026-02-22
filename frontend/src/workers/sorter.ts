self.addEventListener('message', (ev: MessageEvent) => {
  const data = ev.data;
  if (data && data.type === 'sortSessionWords' && Array.isArray(data.sessionWords)) {
    try {
      const words: string[] = data.sessionWords.map((w: string) => (w || '').toUpperCase());
      const entries = words.map((w, idx) => ({ word: w, idx, length: w.length }));
      entries.sort((a, b) => {
        if (b.length !== a.length) return b.length - a.length;
        return a.word.localeCompare(b.word);
      });
      const order = entries.map(e => e.idx);
      (self as any).postMessage({ type: 'sorted', order });
    } catch (e) {
      (self as any).postMessage({ type: 'error' });
    }
  }
});
