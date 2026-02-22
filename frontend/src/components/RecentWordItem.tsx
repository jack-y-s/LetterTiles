import React from 'react';

type Props = {
  word: string;
};

const RecentWordItem = ({ word }: Props) => {
  return (
    <div className="recent-word-item">
      {word}
    </div>
  );
};

export default React.memo(RecentWordItem);
