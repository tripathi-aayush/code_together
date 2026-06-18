import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { connectSocket, disconnectSocket, getSocket } from '../lib/socket';
import { nameToColor } from '../lib/colors';
import CodeEditor from '../components/Editor';
import FileExplorer from '../components/FileExplorer';

interface RoomUser {
  socketId: string;
  name: string;
  color: string;
}

interface FileMap {
  [fileName: string]: string;
}

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const userName = searchParams.get('name') || 'Anonymous';
  // Color is deterministically derived from name — consistent across sessions
  const myColor = nameToColor(userName);

  // ─── State ────────────────────────────────────────────────────

  const [files, setFiles] = useState<FileMap>({});
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string>('');
  const [users, setUsers] = useState<RoomUser[]>([]);
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);

  // Ref-based tracking to avoid stale closures in stable callbacks
  const activeFileRef = useRef(activeFile);
  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);

  // Guard flag: prevents local Monaco onChange from re-emitting when we apply
  // a remote update. Without this, any remote keystroke would trigger a
  // code-change emit back to the server — causing an infinite feedback loop.
  const isRemoteUpdate = useRef(false);

  // ─── Socket lifecycle ─────────────────────────────────────────

  useEffect(() => {
    if (!roomId) { navigate('/'); return; }

    const socket = connectSocket();

    const onConnect = () => {
      setConnected(true);
      socket.emit('join-room', { roomId, userName, color: myColor });
    };

    const onDisconnect = () => setConnected(false);

    // Server sends full room state when we first join.
    // This is the "hydration" step — new joiners get all current files immediately.
    const onRoomState = (payload: {
      files: { name: string; content: string }[];
      activeFile: string;
      users: RoomUser[];
    }) => {
      const newFiles: FileMap = {};
      const newNames: string[] = [];
      for (const f of payload.files) {
        newFiles[f.name] = f.content;
        newNames.push(f.name);
      }

      isRemoteUpdate.current = true;
      setFiles(newFiles);
      setFileNames(newNames);
      setActiveFile(payload.activeFile);
      setUsers(payload.users);
      requestAnimationFrame(() => { isRemoteUpdate.current = false; });
    };

    // Another user typed — update the right file's content in our state.
    // Only affects Monaco if the changed file is the currently active one.
    const onCodeChange = (payload: { code: string; fileName: string }) => {
      isRemoteUpdate.current = true;
      setFiles((prev) => ({ ...prev, [payload.fileName]: payload.code }));
      requestAnimationFrame(() => { isRemoteUpdate.current = false; });
    };

    const onUserJoined = (user: RoomUser) => {
      setUsers((prev) => {
        if (prev.find((u) => u.socketId === user.socketId)) return prev;
        return [...prev, user];
      });
    };

    const onUserLeft = (payload: { socketId: string }) => {
      setUsers((prev) => prev.filter((u) => u.socketId !== payload.socketId));
    };

    // ── File events (server broadcasts to ALL including sender) ──

    const onFileCreated = (payload: { name: string; content: string }) => {
      setFiles((prev) => ({ ...prev, [payload.name]: payload.content }));
      setFileNames((prev) => prev.includes(payload.name) ? prev : [...prev, payload.name]);
    };

    const onFileDeleted = (payload: { fileName: string; newActiveFile: string }) => {
      setFiles((prev) => {
        const next = { ...prev };
        delete next[payload.fileName];
        return next;
      });
      setFileNames((prev) => prev.filter((n) => n !== payload.fileName));
      setActiveFile(payload.newActiveFile);
    };

    const onFileRenamed = (payload: { oldName: string; newName: string; newActiveFile: string }) => {
      setFiles((prev) => {
        const next = { ...prev };
        next[payload.newName] = next[payload.oldName] ?? '';
        delete next[payload.oldName];
        return next;
      });
      setFileNames((prev) =>
        prev.map((n) => (n === payload.oldName ? payload.newName : n))
      );
      setActiveFile(payload.newActiveFile);
    };

    // Shared active file: when any user switches files, everyone follows
    const onFileSwitched = (payload: { fileName: string }) => {
      setActiveFile(payload.fileName);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room-state', onRoomState);
    socket.on('code-change', onCodeChange);
    socket.on('user-joined', onUserJoined);
    socket.on('user-left', onUserLeft);
    socket.on('file-created', onFileCreated);
    socket.on('file-deleted', onFileDeleted);
    socket.on('file-renamed', onFileRenamed);
    socket.on('file-switched', onFileSwitched);

    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room-state', onRoomState);
      socket.off('code-change', onCodeChange);
      socket.off('user-joined', onUserJoined);
      socket.off('user-left', onUserLeft);
      socket.off('file-created', onFileCreated);
      socket.off('file-deleted', onFileDeleted);
      socket.off('file-renamed', onFileRenamed);
      socket.off('file-switched', onFileSwitched);
      disconnectSocket();
    };
  }, [roomId, userName, myColor, navigate]);

  // ─── Local editor changes ─────────────────────────────────────

  // Stable callback (via ref) so Monaco doesn't re-register onChange on every render
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (isRemoteUpdate.current) return;
    const code = value ?? '';
    const fileName = activeFileRef.current;
    if (!fileName) return;

    setFiles((prev) => ({ ...prev, [fileName]: code }));
    getSocket().emit('code-change', { code, fileName });
  }, []); // stable — uses refs, not state directly

  // ─── File operations ──────────────────────────────────────────

  const handleFileSelect = useCallback((name: string) => {
    // Optimistic: update locally immediately
    setActiveFile(name);
    // Then tell the server so everyone else switches too (shared active file model)
    getSocket().emit('file-switch', { fileName: name });
  }, []);

  const handleFileCreate = useCallback((fileName: string) => {
    getSocket().emit('file-create', { fileName });
    // Server will echo back 'file-created' to all, including us — no optimistic update needed
  }, []);

  const handleFileDelete = useCallback((fileName: string) => {
    getSocket().emit('file-delete', { fileName });
  }, []);

  const handleFileRename = useCallback((oldName: string, newName: string) => {
    getSocket().emit('file-rename', { oldName, newName });
  }, []);

  // ─── Utils ───────────────────────────────────────────────────

  const copyRoomCode = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const editorValue = files[activeFile] ?? '';

  if (!roomId) return null;

  return (
    <div className="room-container">

      {/* ─── Header ───────────────────────────────────────────── */}
      <header className="room-header">
        <div className="room-header-left">
          <button className="btn-icon" onClick={() => navigate('/')} title="Leave room">←</button>
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
              <div
                key={u.socketId}
                className="presence-chip"
                style={{ background: u.color }}
                title={u.name}
              >
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

      {/* ─── Body: sidebar + editor ───────────────────────────── */}
      <div className="room-body">

        {/* File explorer sidebar */}
        <aside className="room-sidebar">
          <FileExplorer
            files={fileNames}
            activeFile={activeFile}
            onFileSelect={handleFileSelect}
            onFileCreate={handleFileCreate}
            onFileDelete={handleFileDelete}
            onFileRename={handleFileRename}
          />
        </aside>

        {/* Monaco editor */}
        <main className="room-editor">
          {activeFile ? (
            <CodeEditor
              key={activeFile}  // Remount Monaco when switching files for clean undo history
              value={editorValue}
              onChange={handleEditorChange}
              fileName={activeFile}
            />
          ) : (
            <div className="editor-empty">
              <div className="editor-empty-icon">📂</div>
              <p>No file selected</p>
              <p className="editor-empty-sub">Create a file using the panel on the left</p>
            </div>
          )}
        </main>

      </div>
    </div>
  );
}
