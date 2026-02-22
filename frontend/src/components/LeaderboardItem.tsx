import React from 'react';

type Player = {
  id: string;
  name: string;
  avatarColor: string;
  score: number;
};

type Props = {
  player: Player;
  index: number;
  isMe: boolean;
  rankChange?: "up" | "down" | "same" | undefined;
};

const LeaderboardItem = ({ player, index, isMe, rankChange }: Props) => {
  return (
    <li
      className={`rank-item ${isMe ? 'active' : ''} ${rankChange === 'up' ? 'rank-up' : ''} ${rankChange === 'down' ? 'rank-down' : ''}`}
    >
      <span className={`avatar ${index === 0 ? 'leader' : ''}`} style={{ background: player.avatarColor }}>
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
  );
};

export default React.memo(LeaderboardItem);
