import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { connectSocket, disconnectSocket, getSocket } from '../lib/socket';
import { nameToColor } from '../lib/colors';
import CodeEditor, { type RemoteCursor, type CursorPosition, type CursorSelection } from '../components/Editor';
import FileExplorer from '../components/FileExplorer';
import ActivityLog, { type ActivityEntry } from '../components/ActivityLog';

// ─── Types ────────────────────────────────────────────────────

interface RoomUser {
  socketId: string;
  name: string;
  color: string;
}

interface FileMap {
  [fileName: string]: string;
}

interface RawCursorData {
  fileName: string;
  position: CursorPosition;
  selection: CursorSelection | null;
}

// ─── Constants ────────────────────────────────────────────────

/** Throttle cursor emit — don't flood the server on every keystroke */
const CURSOR_THROTTLE_MS = 50;

// ─── Component ────────────────────────────────────────────────

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

  /** Append-only activity log — last 100 entries shown in the panel. */
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  /** Whether the activity panel is expanded. */
  const [isLogOpen, setIsLogOpen] = useState(true);

  /**
   * Remote cursor data from server: socketId → { fileName, position, selection }
   * Stored as a plain object (not Map) so React's === diffing works with useMemo.
   */
  const [remoteCursorData, setRemoteCursorData] = useState<Record<string, RawCursorData>>({});

  // ─── Stable refs ─────────────────────────────────────────────

  const activeFileRef = useRef(activeFile);
  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);

  // Prevents Monaco's onChange from re-emitting remote updates (feedback loop guard)
  const isRemoteUpdate = useRef(false);

  // Throttle: only emit a cursor-update at most once per CURSOR_THROTTLE_MS
  const lastCursorEmitRef = useRef(0);

  // ─── Socket lifecycle ─────────────────────────────────────────

  useEffect(() => {
    if (!roomId) { navigate('/'); return; }

    const socket = connectSocket();

    const onConnect = () => {
      setConnected(true);
      socket.emit('join-room', { roomId, userName, color: myColor });
    };

    const onDisconnect = () => setConnected(false);

    // Full hydration on join — populates files, activeFile, and all present users
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

    // Remote keystroke — update the right file, trigger Monaco re-render if active
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

    // Remove user from presence list AND clear their cursor widget
    const onUserLeft = (payload: { socketId: string }) => {
      setUsers((prev) => prev.filter((u) => u.socketId !== payload.socketId));
      setRemoteCursorData((prev) => {
        const next = { ...prev };
        delete next[payload.socketId];
        return next;
      });
    };

    // ── Cursor Update ─────────────────────────────────────────
    // Server attaches socketId before broadcasting; we store it by socketId.
    const onCursorUpdate = (payload: { socketId: string } & RawCursorData) => {
      const { socketId, fileName, position, selection } = payload;
      setRemoteCursorData((prev) => ({
        ...prev,
        [socketId]: { fileName, position, selection },
      }));
    };

    // ── Activity Log ─────────────────────────────────────────
    // Server sends full history buffer to the joining user.
    const onActivityHistory = (entries: ActivityEntry[]) => {
      setActivityLog(entries);
    };
    // Server broadcasts one new entry at a time.
    const onActivityLogEntry = (entry: ActivityEntry) => {
      setActivityLog((prev) => {
        // Keep last 100 entries in the UI too
        const next = [...prev, entry];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
    };

    // ── File events ──────────────────────────────────────────
    // All file operations broadcast to ALL in room (including sender) — state stays consistent.

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
      // Also clear any cursors that were on the deleted file
      setRemoteCursorData((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((id) => {
          if (next[id].fileName === payload.fileName) delete next[id];
        });
        return next;
      });
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

    // Shared active file: when any user switches, everyone follows
    const onFileSwitched = (payload: { fileName: string }) => {
      setActiveFile(payload.fileName);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room-state', onRoomState);
    socket.on('code-change', onCodeChange);
    socket.on('user-joined', onUserJoined);
    socket.on('user-left', onUserLeft);
    socket.on('cursor-update', onCursorUpdate);
    socket.on('activity-history', onActivityHistory);
    socket.on('activity-log', onActivityLogEntry);
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
      socket.off('cursor-update', onCursorUpdate);
      socket.off('activity-history', onActivityHistory);
      socket.off('activity-log', onActivityLogEntry);
      socket.off('file-created', onFileCreated);
      socket.off('file-deleted', onFileDeleted);
      socket.off('file-renamed', onFileRenamed);
      socket.off('file-switched', onFileSwitched);
      disconnectSocket();
    };
  }, [roomId, userName, myColor, navigate]);

  // ─── Local editor changes ─────────────────────────────────────

  // Stable callback — reads activeFile via ref to avoid re-creating on every render
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (isRemoteUpdate.current) return;
    const code = value ?? '';
    const fileName = activeFileRef.current;
    if (!fileName) return;

    setFiles((prev) => ({ ...prev, [fileName]: code }));
    getSocket().emit('code-change', { code, fileName });
  }, []);

  // ─── Cursor change ────────────────────────────────────────────

  // Editor calls this on every cursor/selection change.
  // We throttle the actual socket.emit here to avoid flooding the server.
  const handleCursorChange = useCallback((
    position: CursorPosition,
    selection: CursorSelection | null,
  ) => {
    const now = Date.now();
    if (now - lastCursorEmitRef.current < CURSOR_THROTTLE_MS) return;
    lastCursorEmitRef.current = now;

    getSocket().emit('cursor-update', {
      fileName: activeFileRef.current,
      position,
      selection,
    });
  }, []);

  // ─── File operations ──────────────────────────────────────────

  const handleFileSelect = useCallback((name: string) => {
    setActiveFile(name);
    getSocket().emit('file-switch', { fileName: name });
  }, []);

  const handleFileCreate = useCallback((fileName: string) => {
    getSocket().emit('file-create', { fileName });
  }, []);

  const handleFileDelete = useCallback((fileName: string) => {
    getSocket().emit('file-delete', { fileName });
  }, []);

  const handleFileRename = useCallback((oldName: string, newName: string) => {
    getSocket().emit('file-rename', { oldName, newName });
  }, []);

  // ─── Computed: remote cursors for Editor ──────────────────────

  /**
   * Merge cursor positions (from socket) with user metadata (name/color from presence).
   * Filter to only users whose cursor is on the currently visible file.
   * Memoised so Editor only re-runs the decoration effect when data actually changes.
   */
  const remoteCursors: RemoteCursor[] = useMemo(() =>
    users
      .filter((u) => {
        const c = remoteCursorData[u.socketId];
        return c && c.fileName === activeFile;
      })
      .map((u) => {
        const c = remoteCursorData[u.socketId];
        return {
          socketId: u.socketId,
          name: u.name,
          color: u.color,
          position: c.position,
          selection: c.selection,
        };
      }),
    [users, remoteCursorData, activeFile],
  );

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
          {/* Presence chips — color driven by user's assigned HSL color */}
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

        <main className="room-editor">
          <div className="room-editor-inner">
            {activeFile ? (
              <CodeEditor
                key={activeFile}          // Remount Monaco on file switch → clean undo history + fresh decorations
                value={editorValue}
                onChange={handleEditorChange}
                fileName={activeFile}
                remoteCursors={remoteCursors}
                onCursorChange={handleCursorChange}
              />
            ) : (
              <div className="editor-empty">
                <div className="editor-empty-icon">📂</div>
                <p>No file selected</p>
                <p className="editor-empty-sub">Create a file using the panel on the left</p>
              </div>
            )}
          </div>

          <ActivityLog
            entries={activityLog}
            isOpen={isLogOpen}
            onToggle={() => setIsLogOpen((v) => !v)}
          />
        </main>

      </div>
    </div>
  );
}
