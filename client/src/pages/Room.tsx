import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { connectSocket, disconnectSocket, getSocket } from '../lib/socket';
import { nameToColor } from '../lib/colors';
import CodeEditor, { type RemoteCursor, type CursorPosition, type CursorSelection } from '../components/Editor';
import FileExplorer from '../components/FileExplorer';
import ActivityLog, { type ActivityEntry } from '../components/ActivityLog';
import TabBar from '../components/TabBar';
import OutputPanel, { type ExecutionResult } from '../components/OutputPanel';

const extensionToLanguageMap: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  html: 'html',
  cpp: 'cpp',
  c: 'c',
  java: 'java',
  go: 'go',
  rb: 'ruby',
  rs: 'rust',
};

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

  const userName = searchParams.get('name') || '';

  // Redirect to home if no name provided (e.g., user navigated directly to /room/xyz)
  useEffect(() => {
    if (!userName.trim()) {
      navigate(`/?room=${roomId ?? ''}`, { replace: true });
    }
  }, [userName, roomId, navigate]);

  // Color is deterministically derived from name — consistent across sessions
  const myColor = nameToColor(userName);

  // ─── State ────────────────────────────────────────────────────

  const [files, setFiles] = useState<FileMap>({});
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string>('');
  const [users, setUsers] = useState<RoomUser[]>([]);
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  /** True while the first room-state event hasn't arrived yet (loading skeleton) */
  const [hydrated, setHydrated] = useState(false);

  /** Append-only activity log — last 100 entries shown in the panel. */
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  /** Whether the activity panel is expanded. */
  const [isLogOpen, setIsLogOpen] = useState(true);

  /**
   * Remote cursor data from server: socketId → { fileName, position, selection }
   * Stored as a plain object (not Map) so React's === diffing works with useMemo.
   */
  const [remoteCursorData, setRemoteCursorData] = useState<Record<string, RawCursorData>>({});

  // ─── Sandboxed Execution State ──────────────────────────────
  const [isExecuting, setIsExecuting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [execResult, setExecResult] = useState<ExecutionResult | null>(null);
  const [isOutputOpen, setIsOutputOpen] = useState(false);
  const [toasts, setToasts] = useState<{ id: string; message: string }[]>([]);

  const clientTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cooldown countdown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    return () => {
      if (clientTimeoutRef.current) clearTimeout(clientTimeoutRef.current);
    };
  }, []);

  // ─── Stable refs ─────────────────────────────────────────────

  const activeFileRef = useRef(activeFile);
  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);

  // Prevents Monaco's onChange from re-emitting remote updates (feedback loop guard)
  const isRemoteUpdate = useRef(false);

  // Throttle: only emit a cursor-update at most once per CURSOR_THROTTLE_MS
  const lastCursorEmitRef = useRef(0);

  // ─── Socket lifecycle ─────────────────────────────────────────

  useEffect(() => {
    if (!roomId || !userName.trim()) return;

    const socket = connectSocket();

    /**
     * joinRoom is called both on initial connect AND on reconnect.
     * The server's join-room handler re-hydrates the client with full room state,
     * so reconnecting naturally resyncs all files, users, and activity history.
     */
    const joinRoom = () => {
      setConnected(true);
      socket.emit('join-room', { roomId, userName: userName.trim(), color: myColor });
    };

    const onConnect = () => joinRoom();
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
      setHydrated(true);
      queueMicrotask(() => { isRemoteUpdate.current = false; });
    };

    // Remote keystroke — update the right file, trigger Monaco re-render if active
    const onCodeChange = (payload: { code: string; fileName: string }) => {
      isRemoteUpdate.current = true;
      setFiles((prev) => ({ ...prev, [payload.fileName]: payload.code }));
      queueMicrotask(() => { isRemoteUpdate.current = false; });
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
    const onCursorUpdate = (payload: { socketId: string } & RawCursorData) => {
      const { socketId, fileName, position, selection } = payload;
      setRemoteCursorData((prev) => ({
        ...prev,
        [socketId]: { fileName, position, selection },
      }));
    };

    // ── Activity Log ─────────────────────────────────────────
    const onActivityHistory = (entries: ActivityEntry[]) => {
      setActivityLog(entries);
    };
    const onActivityLogEntry = (entry: ActivityEntry) => {
      setActivityLog((prev) => {
        const next = [...prev, entry];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
    };

    // ── File events ──────────────────────────────────────────

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

    const onRunResult = (result: ExecutionResult) => {
      if (clientTimeoutRef.current) {
        clearTimeout(clientTimeoutRef.current);
        clientTimeoutRef.current = null;
      }
      setIsExecuting(false);
      setExecResult(result);
      setIsOutputOpen(true);
    };

    const onRunNotification = (payload: { userName: string; fileName: string }) => {
      const id = Math.random().toString(36).substring(2);
      const message = `⚡ ${payload.userName} ran ${payload.fileName}`;
      setToasts((prev) => [...prev, { id, message }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3000);
    };

    const onError = (msg: string) => {
      if (clientTimeoutRef.current) {
        clearTimeout(clientTimeoutRef.current);
        clientTimeoutRef.current = null;
      }
      setIsExecuting(false);
      
      const id = Math.random().toString(36).substring(2);
      const message = `❌ Error: ${msg}`;
      setToasts((prev) => [...prev, { id, message }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
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
    socket.on('run-result', onRunResult);
    socket.on('run-notification', onRunNotification);
    socket.on('error', onError);

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
      socket.off('run-result', onRunResult);
      socket.off('run-notification', onRunNotification);
      socket.off('error', onError);
      disconnectSocket();
    };
  }, [roomId, userName, myColor, navigate]);

  // ─── Code Execution ───────────────────────────────────────────

  const activeFileExt = activeFile.split('.').pop()?.toLowerCase() ?? '';
  const isExecutable = activeFileExt in extensionToLanguageMap;

  const handleRun = useCallback(() => {
    if (isExecuting || cooldown > 0 || !activeFile) return;

    const ext = activeFile.split('.').pop()?.toLowerCase() ?? '';
    const mappedLang = extensionToLanguageMap[ext];
    if (!mappedLang) return;

    const codeSnapshot = files[activeFile] ?? '';
    setIsExecuting(true);
    setCooldown(5);

    if (clientTimeoutRef.current) clearTimeout(clientTimeoutRef.current);
    clientTimeoutRef.current = setTimeout(() => {
      setIsExecuting(false);
    }, 12000); // 12 seconds safety fallback

    getSocket().emit('run-code', {
      fileName: activeFile,
      code: codeSnapshot,
      language: mappedLang,
    });
  }, [activeFile, files, isExecuting, cooldown]);

  // ─── Local editor changes ─────────────────────────────────────

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (isRemoteUpdate.current) return;
    const code = value ?? '';
    const fileName = activeFileRef.current;
    if (!fileName) return;

    setFiles((prev) => ({ ...prev, [fileName]: code }));
    getSocket().emit('code-change', { code, fileName });
  }, []);

  // ─── Cursor change ────────────────────────────────────────────

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

  // Count of remote users on the active file (for TabBar indicator)
  const remoteCursorCount = remoteCursors.length;

  // ─── Utils ───────────────────────────────────────────────────

  const copyRoomCode = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const editorValue = files[activeFile] ?? '';

  if (!roomId || !userName.trim()) return null;

  return (
    <div className="room-container">

      {/* ─── Reconnect Banner ─────────────────────────────────── */}
      {!connected && hydrated && (
        <div className="reconnect-banner" role="status">
          <span className="reconnect-dot" />
          Connection lost — reconnecting… your work is safe
        </div>
      )}

      {/* ─── Header ───────────────────────────────────────────── */}
      <header className="room-header">
        <div className="room-header-left">
          <button
            className="btn-icon"
            onClick={() => navigate('/')}
            title="Leave room"
            aria-label="Leave room"
          >
            ←
          </button>
          <span className="room-logo" aria-hidden="true">⟨⟩</span>
          <span className="room-title">CodeTogether</span>
        </div>

        <div className="room-header-center">
          <button
            className="room-code-badge"
            onClick={copyRoomCode}
            title="Click to copy room code"
            aria-label={`Room code: ${roomId}. Click to copy.`}
          >
            <span className="room-code-label">Room</span>
            <span className="room-code-value">{roomId}</span>
            <span className="room-code-copy">{copied ? '✓' : '⎘'}</span>
          </button>
        </div>

        <div className="room-header-right">
          {/* Presence chips — color driven by user's assigned HSL color */}
          <div className="room-presence" aria-label="People in this room">
            {users.map((u) => (
              <div
                key={u.socketId}
                className="presence-chip"
                style={{ background: u.color }}
                title={u.name}
                aria-label={u.name}
              >
                {u.name.charAt(0).toUpperCase()}
              </div>
            ))}
          </div>
          <div
            className={`connection-status ${connected ? 'connected' : 'disconnected'}`}
            role="status"
            aria-live="polite"
          >
            <span className="status-dot" aria-hidden="true" />
            {connected ? 'Live' : 'Reconnecting…'}
          </div>
        </div>
      </header>

      {/* ─── Body: sidebar + editor ───────────────────────────── */}
      <div className="room-body">

        <aside className="room-sidebar" aria-label="File explorer">
          <FileExplorer
            files={fileNames}
            activeFile={activeFile}
            onFileSelect={handleFileSelect}
            onFileCreate={handleFileCreate}
            onFileDelete={handleFileDelete}
            onFileRename={handleFileRename}
            remoteCursorData={remoteCursorData}
          />
        </aside>

        <main className="room-editor">
          {/* Tab bar — visible when a file is active */}
          {activeFile && (
            <TabBar
              roomId={roomId}
              activeFile={activeFile}
              remoteCursorCount={remoteCursorCount}
              onRun={handleRun}
              isExecuting={isExecuting}
              cooldown={cooldown}
              isExecutable={isExecutable}
            />
          )}

          <div className="room-editor-inner">
            {!hydrated ? (
              /* Loading skeleton while waiting for first room-state event */
              <div className="editor-loading">
                <div className="editor-loading-spinner" />
                <span>Joining room…</span>
              </div>
            ) : activeFile ? (
              <CodeEditor
                key={activeFile}       // Remount Monaco on file switch → clean undo history + fresh decorations
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

          <OutputPanel
            result={execResult}
            isOpen={isOutputOpen}
            onToggle={() => setIsOutputOpen((v) => !v)}
            onClear={() => {
              setExecResult(null);
              setIsOutputOpen(false);
            }}
          />

          <ActivityLog
            entries={activityLog}
            isOpen={isLogOpen}
            onToggle={() => setIsLogOpen((v) => !v)}
          />
        </main>

      </div>

      {/* Toast container in top-right */}
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
