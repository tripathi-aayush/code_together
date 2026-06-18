import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { connectSocket, disconnectSocket, getSocket } from '../lib/socket';
import CodeEditor from '../components/Editor';

interface RoomUser {
  socketId: string;
  name: string;
}

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const userName = searchParams.get('name') || 'Anonymous';

  const [code, setCode] = useState<string>('');
  const [users, setUsers] = useState<RoomUser[]>([]);
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);

  // Guard flag: when true, incoming remote changes should NOT re-emit to server.
  // This is the standard pattern to prevent feedback loops and cursor-jump bugs:
  // without this guard the editor will infinite-loop or jump the user's cursor on every keystroke.
  const isRemoteUpdate = useRef(false);

  // Connect socket and join room on mount
  useEffect(() => {
    if (!roomId) {
      navigate('/');
      return;
    }

    const socket = connectSocket();

    const handleConnect = () => {
      setConnected(true);
      socket.emit('join-room', { roomId, userName });
    };

    const handleDisconnect = () => {
      setConnected(false);
    };

    // Server sends full room state when we first join
    const handleRoomState = (payload: { code: string; users: RoomUser[] }) => {
      isRemoteUpdate.current = true;
      setCode(payload.code);
      setUsers(payload.users);
      // Reset flag after React has a chance to apply the state update
      requestAnimationFrame(() => {
        isRemoteUpdate.current = false;
      });
    };

    // Another user's code change — update our editor
    const handleCodeChange = (payload: { code: string }) => {
      isRemoteUpdate.current = true;
      setCode(payload.code);
      requestAnimationFrame(() => {
        isRemoteUpdate.current = false;
      });
    };

    const handleUserJoined = (user: RoomUser) => {
      setUsers((prev) => {
        if (prev.find((u) => u.socketId === user.socketId)) return prev;
        return [...prev, user];
      });
    };

    const handleUserLeft = (payload: { socketId: string }) => {
      setUsers((prev) => prev.filter((u) => u.socketId !== payload.socketId));
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('room-state', handleRoomState);
    socket.on('code-change', handleCodeChange);
    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);

    // If already connected (reconnection scenario), join immediately
    if (socket.connected) {
      handleConnect();
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('room-state', handleRoomState);
      socket.off('code-change', handleCodeChange);
      socket.off('user-joined', handleUserJoined);
      socket.off('user-left', handleUserLeft);
      disconnectSocket();
    };
  }, [roomId, userName, navigate]);

  // Handle local edits — emit to server only if NOT a remote update
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (isRemoteUpdate.current) return;
    const newCode = value ?? '';
    setCode(newCode);
    getSocket().emit('code-change', { code: newCode });
  }, []);

  const copyRoomCode = () => {
    if (roomId) {
      navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!roomId) return null;

  return (
    <div className="room-container">
      {/* ─── Top Bar ─────────────────────────────────────────── */}
      <header className="room-header">
        <div className="room-header-left">
          <button className="btn-icon" onClick={() => navigate('/')} title="Leave room">
            ← 
          </button>
          <span className="room-logo">⟨⟩</span>
          <span className="room-title">CodeTogether</span>
        </div>

        <div className="room-header-center">
          <div className="room-code-badge" onClick={copyRoomCode} title="Click to copy room code">
            <span className="room-code-label">Room</span>
            <span className="room-code-value">{roomId}</span>
            <span className="room-code-copy">{copied ? '✓' : '⎘'}</span>
          </div>
        </div>

        <div className="room-header-right">
          <div className="room-presence">
            {users.map((u) => (
              <div key={u.socketId} className="presence-chip" title={u.name}>
                {u.name.charAt(0).toUpperCase()}
              </div>
            ))}
          </div>
          <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
            <span className="status-dot" />
            {connected ? 'Live' : 'Reconnecting…'}
          </div>
        </div>
      </header>

      {/* ─── Editor ──────────────────────────────────────────── */}
      <main className="room-editor">
        <CodeEditor value={code} onChange={handleEditorChange} />
      </main>
    </div>
  );
}
