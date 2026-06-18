import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

// Generate a short random room code like "abc-1x4z"
function generateRoomCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const seg = (len: number) =>
    Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg(3)}-${seg(4)}`;
}

/** Validate a room code: 3–20 chars, only a-z 0-9 and hyphens. */
function isValidRoomCode(code: string): boolean {
  return /^[a-z0-9-]{3,20}$/.test(code);
}

/** Validate a display name: 2–30 chars after trim. */
function isValidName(name: string): boolean {
  return name.trim().length >= 2 && name.trim().length <= 30;
}

const FEATURES = [
  { icon: '⚡', label: 'Live Sync', desc: 'Changes appear for all users instantly' },
  { icon: '🖱️', label: 'Live Cursors', desc: 'See exactly where each teammate is' },
  { icon: '📁', label: 'Multi-File', desc: 'Create, rename, and switch files' },
  { icon: '📋', label: 'Activity Log', desc: 'A live feed of who did what' },
];

const HOW_IT_WORKS = [
  { step: '01', title: 'Enter your name', desc: 'No account needed — just a display name' },
  { step: '02', title: 'Create or join a room', desc: 'Share the room code with teammates' },
  { step: '03', title: 'Start coding together', desc: 'Edit, see cursors, build in real time' },
];

const TECH_STACK = ['React', 'TypeScript', 'Socket.IO', 'Monaco', 'PostgreSQL', 'Docker'];

export default function Home() {
  const [searchParams] = useSearchParams();
  const [roomCode, setRoomCode] = useState(searchParams.get('room') ?? '');
  const [userName, setUserName] = useState('');
  const [nameError, setNameError]     = useState('');
  const [roomError, setRoomError]     = useState('');
  const [copyToast, setCopyToast]     = useState('');
  const navigate = useNavigate();

  const validateName = (value: string): boolean => {
    if (!value.trim()) { setNameError('Enter your name to continue'); return false; }
    if (!isValidName(value)) { setNameError('Name must be 2–30 characters'); return false; }
    setNameError('');
    return true;
  };

  const validateRoom = (value: string): boolean => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) { setRoomError('Enter a room code or create a new room'); return false; }
    if (!isValidRoomCode(trimmed)) {
      setRoomError('Room code must be 3–20 lowercase letters, numbers, or hyphens');
      return false;
    }
    setRoomError('');
    return true;
  };

  const handleJoin = () => {
    const nameOk = validateName(userName);
    const roomOk = validateRoom(roomCode);
    if (!nameOk || !roomOk) return;

    navigate(`/room/${roomCode.trim().toLowerCase()}?name=${encodeURIComponent(userName.trim())}`);
  };

  const handleCreate = () => {
    if (!validateName(userName)) return;

    const code = generateRoomCode();
    const joinUrl = `${window.location.origin}/room/${code}?name=${encodeURIComponent(userName.trim())}`;

    // Copy the full join URL to clipboard automatically
    navigator.clipboard.writeText(joinUrl).then(() => {
      setCopyToast('✓ Join link copied!');
      setTimeout(() => setCopyToast(''), 3000);
    }).catch(() => {
      // Clipboard not available (e.g., non-HTTPS) — just navigate
    });

    navigate(`/room/${code}?name=${encodeURIComponent(userName.trim())}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleJoin();
  };

  return (
    <div className="home-container">
      <div className="home-glow" />
      <div className="home-glow home-glow-2" />

      {/* ─── Hero card ──────────────────────────────────────── */}
      <main className="home-card" role="main">
        <div className="home-logo">
          <span className="home-logo-icon">⟨⟩</span>
          <h1>CodeTogether</h1>
        </div>
        <p className="home-subtitle">
          Real-time collaborative code editing — open a room, share the code,<br />
          and start building together with live cursors and presence.
        </p>

        {/* Tech stack badges */}
        <div className="home-tech-badges" aria-label="Tech stack">
          {TECH_STACK.map(t => <span key={t} className="tech-badge">{t}</span>)}
        </div>

        <div className="home-form">
          {/* Name field */}
          <div className="input-group">
            <label htmlFor="userName">Your Name</label>
            <input
              id="userName"
              type="text"
              placeholder="e.g. Aayush"
              value={userName}
              onChange={(e) => { setUserName(e.target.value); if (nameError) validateName(e.target.value); }}
              onBlur={() => userName && validateName(userName)}
              onKeyDown={handleKeyDown}
              maxLength={30}
              autoFocus
              autoComplete="nickname"
              aria-describedby={nameError ? 'name-error' : undefined}
              aria-invalid={!!nameError}
            />
            {nameError && <span id="name-error" className="field-error" role="alert">{nameError}</span>}
          </div>

          {/* Room code field */}
          <div className="input-group">
            <label htmlFor="roomCode">Room Code</label>
            <input
              id="roomCode"
              type="text"
              placeholder="e.g. abc-1x4z"
              value={roomCode}
              onChange={(e) => { setRoomCode(e.target.value.toLowerCase()); if (roomError) validateRoom(e.target.value); }}
              onBlur={() => roomCode && validateRoom(roomCode)}
              onKeyDown={handleKeyDown}
              maxLength={20}
              autoComplete="off"
              aria-describedby={roomError ? 'room-error' : undefined}
              aria-invalid={!!roomError}
            />
            {roomError && <span id="room-error" className="field-error" role="alert">{roomError}</span>}
          </div>

          {copyToast && <div className="copy-toast" role="status">{copyToast}</div>}

          <div className="home-actions">
            <button className="btn btn-primary" onClick={handleJoin} id="join-room-btn">
              Join Room
            </button>
            <span className="home-divider">or</span>
            <button className="btn btn-secondary" onClick={handleCreate} id="create-room-btn">
              ✦ Create New
            </button>
          </div>
        </div>
      </main>

      {/* ─── Feature pills ───────────────────────────────────── */}
      <section className="home-features" aria-label="Features">
        {FEATURES.map(f => (
          <div key={f.label} className="feature-pill">
            <span className="feature-pill-icon">{f.icon}</span>
            <div className="feature-pill-text">
              <strong>{f.label}</strong>
              <span>{f.desc}</span>
            </div>
          </div>
        ))}
      </section>

      {/* ─── How it works ────────────────────────────────────── */}
      <section className="how-it-works" aria-label="How it works">
        {HOW_IT_WORKS.map((step, i) => (
          <div key={step.step} className="how-step">
            <div className="how-step-number">{step.step}</div>
            <div className="how-step-body">
              <strong>{step.title}</strong>
              <span>{step.desc}</span>
            </div>
            {i < HOW_IT_WORKS.length - 1 && <div className="how-step-arrow">→</div>}
          </div>
        ))}
      </section>

      <footer className="home-footer">
        Built with React · Monaco Editor · Socket.IO · PostgreSQL
      </footer>
    </div>
  );
}
