import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Generate a short random room code like "abc-1x4z"
function generateRoomCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const seg = (len: number) =>
    Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg(3)}-${seg(4)}`;
}

export default function Home() {
  const [roomCode, setRoomCode] = useState('');
  const [userName, setUserName] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleJoin = () => {
    const trimmedRoom = roomCode.trim().toLowerCase();
    const trimmedName = userName.trim();

    if (!trimmedName) {
      setError('Enter your name to continue');
      return;
    }
    if (!trimmedRoom) {
      setError('Enter a room code or create a new room');
      return;
    }

    setError('');
    navigate(`/room/${trimmedRoom}?name=${encodeURIComponent(trimmedName)}`);
  };

  const handleCreate = () => {
    const trimmedName = userName.trim();
    if (!trimmedName) {
      setError('Enter your name to continue');
      return;
    }
    setError('');
    const code = generateRoomCode();
    navigate(`/room/${code}?name=${encodeURIComponent(trimmedName)}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleJoin();
  };

  return (
    <div className="home-container">
      <div className="home-glow" />

      <main className="home-card">
        <div className="home-logo">
          <span className="home-logo-icon">⟨⟩</span>
          <h1>CodeTogether</h1>
        </div>
        <p className="home-subtitle">
          Real-time collaborative code editing. Open a room, share the code, start building together.
        </p>

        <div className="home-form">
          <div className="input-group">
            <label htmlFor="userName">Your Name</label>
            <input
              id="userName"
              type="text"
              placeholder="e.g. Aayush"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              onKeyDown={handleKeyDown}
              maxLength={30}
              autoFocus
            />
          </div>

          <div className="input-group">
            <label htmlFor="roomCode">Room Code</label>
            <input
              id="roomCode"
              type="text"
              placeholder="e.g. abc-1x4z"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value)}
              onKeyDown={handleKeyDown}
              maxLength={20}
            />
          </div>

          {error && <div className="home-error">{error}</div>}

          <div className="home-actions">
            <button className="btn btn-primary" onClick={handleJoin}>
              Join Room
            </button>
            <span className="home-divider">or</span>
            <button className="btn btn-secondary" onClick={handleCreate}>
              Create New Room
            </button>
          </div>
        </div>
      </main>

      <footer className="home-footer">
        Built with React · Monaco Editor · Socket.IO · PostgreSQL
      </footer>
    </div>
  );
}
