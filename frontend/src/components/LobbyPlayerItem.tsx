import React from 'react';

type Player = {
  id: string;
  name: string;
  avatarColor: string;
  ready?: boolean;
};

type Props = {
  player: Player;
  isMe: boolean;
  joined: boolean;
  gameStatus: string;
  onToggleReady: () => void;
  onCopyLobbyId?: () => void;
};

const LobbyPlayerItem = ({ player, isMe, joined, gameStatus, onToggleReady }: Props) => {
  return (
    <li key={player.id} className="lobby-item">
      <span className="avatar" style={{ background: player.avatarColor }}>
        {player.name.slice(0, 1).toUpperCase()}
      </span>
      <span>{player.name.toUpperCase()}</span>
      <span style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto', gap: 8 }}>
        {isMe && joined && gameStatus === 'lobby' && (
          <label className="ready-toggle" style={{ marginRight: 0 }}>
            <input
              type="checkbox"
              checked={!!player.ready}
              onChange={onToggleReady}
            />
            <span className="ready-slider" />
          </label>
        )}
        <span className={`lobby-ready ${player.ready ? 'is-ready' : 'is-not-ready'}`}>{player.ready ? 'Ready' : 'Not ready'}</span>
      </span>
    </li>
  );
};

export default React.memo(LobbyPlayerItem);
