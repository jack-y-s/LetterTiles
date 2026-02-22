import React, { useMemo } from 'react';

type Props<T> = {
  items: T[];
  height: number;
  itemHeight: number;
  width?: number | string;
  renderItem: (item: T, index: number) => React.ReactNode;
};

// Lightweight fallback virtualization: render a windowed slice of items
// based on the visible height. This avoids adding a dependency while
// reducing DOM nodes for long lists.
export default function VirtualizedList<T>({ items, height, itemHeight, width = '100%', renderItem }: Props<T>) {
  const visibleCount = Math.max(1, Math.min(items.length, Math.ceil(height / itemHeight) + 8));
  const visible = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);

  return (
    <div style={{ width }}>
      {visible.map((it, idx) => (
        <div key={(it as any)?.id ?? idx} style={{ height: itemHeight }}>
          {renderItem(it, idx)}
        </div>
      ))}
      {items.length > visibleCount && (
        <div className="virtualized-omitted" style={{ padding: '8px', fontSize: '0.9em', color: '#666' }}>
          {items.length - visibleCount} more items omitted for performance
        </div>
      )}
    </div>
  );
}
