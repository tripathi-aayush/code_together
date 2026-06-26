import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import crypto from 'crypto';

dotenv.config();

const ONLINECOMPILER_API_KEY = process.env.ONLINECOMPILER_API_KEY;
if (!ONLINECOMPILER_API_KEY) {
  console.warn('[Execution] WARNING: ONLINECOMPILER_API_KEY not set — code execution will fail');
}

const app = express();
const httpServer = createServer(app);

// Prisma 7 requires a driver adapter. We use pg (node-postgres).
// If DATABASE_URL is not set, prisma is null and all DB ops are skipped gracefully.
let prisma: PrismaClient | null = null;
try {
  if (process.env.DATABASE_URL) {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    prisma = new PrismaClient({ adapter } as any);
    console.log('[DB] Prisma client initialized');
  } else {
    console.warn('[DB] DATABASE_URL not set — running without persistence');
  }
} catch (e) {
  console.warn('[DB] Could not initialize Prisma:', (e as Error).message);
}

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

const io = new Server(httpServer, {
  cors: { origin: CLIENT_URL, methods: ['GET', 'POST'], credentials: true },
});

// ─── Types ────────────────────────────────────────────────────

interface RoomUser {
  socketId: string;
  name: string;
  color: string; // HSL color string, computed client-side from name hash
}

/** A single activity log entry (identical shape on client and server). */
export interface ActivityEntry {
  id: string;
  userName: string;
  color: string;
  action: string;   // "joined the room" | "left the room" | "created" | "deleted" | "renamed …→…" | "edited"
  target?: string;  // file name if applicable
  timestamp: string; // ISO string
}

interface RoomState {
  files: Map<string, string>;   // fileName → content
  activeFile: string;           // DESIGN DECISION: shared active file model.
                                // All users in a room view the same file.
                                // When any user switches files, all users switch.
                                // Simpler than per-user active file; feels like true pair-programming.
  users: Map<string, RoomUser>; // socketId → user
  dbSyncTimer: ReturnType<typeof setTimeout> | null;
  /** Circular buffer of last 100 activity entries — delivered to new joiners. */
  activityLog: ActivityEntry[];
  /** Debounce timer for "X edited Y" — prevents a log entry per keystroke. */
  editActivityTimer: ReturnType<typeof setTimeout> | null;
  /** Info for the pending debounced edit entry. */
  lastEditInfo: { userName: string; color: string; fileName: string } | null;
}

const DEFAULT_FILE_NAME = 'main.js';
const DEFAULT_FILE_CONTENT = `// Welcome to CodeTogether! 🚀
// Share the room code to invite collaborators.

function greet(name) {
  return \`Hello, \${name}!\`;
}

console.log(greet('World'));
`;

const DB_SYNC_DEBOUNCE_MS = 3000;  // Debounce DB saves — don't hit DB on every keystroke
const EDIT_LOG_DEBOUNCE_MS = 2000; // One "edited" log entry per 2-second burst of keystrokes
const ACTIVITY_BUFFER_SIZE = 100;  // Max entries kept in memory per room

// ─── OnlineCompiler.io Mapping ──────────────────────────────────
const LANGUAGE_COMPILER_MAP: Record<string, string> = {
  py: 'python-3.14',
  cpp: 'cpp-g++-15',
  c: 'c-gcc-15',
  java: 'java-openjdk-25',
  cs: 'csharp-dotnet-9',
  go: 'go-1.26',
  rs: 'rust-1.93',
  php: 'php-8.5',
  rb: 'ruby-4.0',
  ts: 'typescript-deno',
  js: 'typescript-deno',
};

// ─── In-memory rooms ──────────────────────────────────────────

const rooms = new Map<string, RoomState>();

function createDefaultRoom(): RoomState {
  const files = new Map<string, string>();
  files.set(DEFAULT_FILE_NAME, DEFAULT_FILE_CONTENT);
  return {
    files,
    activeFile: DEFAULT_FILE_NAME,
    users: new Map(),
    dbSyncTimer: null,
    activityLog: [],
    editActivityTimer: null,
    lastEditInfo: null,
  };
}

/** Deterministically maps a user's display name to a consistent HSL color. */
function nameToColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash; // 32-bit int
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 70%, 62%)`;
}

// ─── DB helpers ───────────────────────────────────────────────

async function loadRoomFromDB(roomCode: string): Promise<RoomState | null> {
  if (!prisma) return null;
  try {
    const dbRoom = await prisma.room.findUnique({
      where: { code: roomCode },
      include: {
        files: { orderBy: { createdAt: 'asc' } },
        activityLog: { orderBy: { timestamp: 'asc' }, take: ACTIVITY_BUFFER_SIZE },
      },
    });
    if (!dbRoom || dbRoom.files.length === 0) return null;

    const files = new Map<string, string>();
    for (const f of dbRoom.files) files.set(f.name, f.content);

    // Restore the in-memory activity buffer from DB
    const activityLog: ActivityEntry[] = dbRoom.activityLog.map((e) => ({
      id: e.id,
      userName: e.userName,
      color: nameToColor(e.userName),
      action: e.action,
      target: e.target ?? undefined,
      timestamp: e.timestamp.toISOString(),
    }));

    console.log(`[DB] Loaded room ${roomCode} from DB (${files.size} files, ${activityLog.length} log entries)`);
    return {
      files,
      activeFile: dbRoom.files[0].name,
      users: new Map(),
      dbSyncTimer: null,
      activityLog,
      editActivityTimer: null,
      lastEditInfo: null,
    };
  } catch (err) {
    console.warn('[DB] Could not load room (DB may be unavailable):', (err as Error).message);
    return null;
  }
}

async function saveRoomToDB(roomCode: string, room: RoomState): Promise<void> {
  if (!prisma) return;
  try {
    const dbRoom = await prisma.room.upsert({
      where: { code: roomCode },
      create: { code: roomCode },
      update: { updatedAt: new Date() },
    });

    for (const [name, content] of room.files) {
      await prisma.file.upsert({
        where: { roomId_name: { roomId: dbRoom.id, name } },
        create: { roomId: dbRoom.id, name, content },
        update: { content, updatedAt: new Date() },
      });
    }

    const fileNames = Array.from(room.files.keys());
    await prisma.file.deleteMany({
      where: { roomId: dbRoom.id, name: { notIn: fileNames } },
    });

    console.log(`[DB] Saved room ${roomCode} (${room.files.size} files)`);
  } catch (err) {
    console.warn('[DB] Could not save room (DB may be unavailable):', (err as Error).message);
  }
}

function scheduleDebouncedDBSync(roomCode: string, room: RoomState): void {
  if (room.dbSyncTimer) clearTimeout(room.dbSyncTimer);
  room.dbSyncTimer = setTimeout(() => {
    room.dbSyncTimer = null;
    saveRoomToDB(roomCode, room);
  }, DB_SYNC_DEBOUNCE_MS);
}

async function getOrCreateRoom(roomCode: string): Promise<RoomState> {
  const existing = rooms.get(roomCode);
  if (existing) return existing;

  const fromDB = await loadRoomFromDB(roomCode);
  if (fromDB) {
    rooms.set(roomCode, fromDB);
    return fromDB;
  }

  const newRoom = createDefaultRoom();
  rooms.set(roomCode, newRoom);
  console.log(`[Room] Created new room: ${roomCode}`);
  return newRoom;
}

// ─── Activity Logging ─────────────────────────────────────────

/**
 * Append an activity entry to the room's in-memory buffer, broadcast it to all
 * connected clients, and persist it to the DB asynchronously.
 */
async function logActivity(
  roomId: string,
  room: RoomState,
  entry: Omit<ActivityEntry, 'id' | 'timestamp'>,
): Promise<void> {
  const full: ActivityEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };

  // Circular buffer — keep last ACTIVITY_BUFFER_SIZE entries
  room.activityLog.push(full);
  if (room.activityLog.length > ACTIVITY_BUFFER_SIZE) room.activityLog.shift();

  // Broadcast to everyone in the room (including the actor — they see their own actions)
  io.to(roomId).emit('activity-log', full);

  // Persist asynchronously — fire-and-forget, no await (keeps event loop free)
  if (prisma) {
    (async () => {
      try {
        const dbRoom = await prisma!.room.findUnique({ where: { code: roomId } });
        if (dbRoom) {
          await prisma!.activityLog.create({
            data: {
              roomId: dbRoom.id,
              userName: full.userName,
              action: full.action,
              target: full.target ?? null,
              timestamp: new Date(full.timestamp),
            },
          });
        }
      } catch {
        // DB not available — in-memory only
      }
    })();
  }
}

function scheduleEditActivityLog(roomId: string, room: RoomState, userName: string, color: string, fileName: string): void {
  // Update who's editing what (latest user to touch the file wins the log entry)
  room.lastEditInfo = { userName, color, fileName };

  if (room.editActivityTimer) {
    clearTimeout(room.editActivityTimer);
  }
  room.editActivityTimer = setTimeout(() => {
    room.editActivityTimer = null;
    const info = room.lastEditInfo;
    room.lastEditInfo = null;
    if (info) {
      logActivity(roomId, room, {
        userName: info.userName,
        color: info.color,
        action: 'edited',
        target: info.fileName,
      });
    }
  }, EDIT_LOG_DEBOUNCE_MS);
}

// ─── REST ─────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, timestamp: new Date().toISOString() });
});

// ─── Socket.IO ────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  let currentRoomId: string | null = null;

  // ── Join Room ────────────────────────────────────────────────
  socket.on('join-room', async (payload: { roomId: string; userName: string; color: string }) => {
    const { roomId, userName } = payload;
    const trimmedRoomId = roomId ? roomId.trim() : '';

    if (!/^[a-z0-9-]{3,40}$/.test(trimmedRoomId)) {
      socket.emit('error', 'Invalid Room ID. It must be between 3 and 40 characters and only contain lowercase letters, numbers, and hyphens.');
      return;
    }

    const derivedColor = nameToColor(userName);

    if (currentRoomId && currentRoomId !== trimmedRoomId) {
      socket.leave(currentRoomId);
      const prev = rooms.get(currentRoomId);
      if (prev) {
        prev.users.delete(socket.id);
        io.to(currentRoomId).emit('user-left', { socketId: socket.id });
      }
    }

    const room = await getOrCreateRoom(trimmedRoomId);

    socket.join(trimmedRoomId);
    currentRoomId = trimmedRoomId;
    room.users.set(socket.id, { socketId: socket.id, name: userName, color: derivedColor });

    console.log(`[Room] ${userName} joined ${trimmedRoomId} (${room.users.size} users)`);

    // Hydrate the new joiner with full room state + activity history
    socket.emit('room-state', {
      files: Array.from(room.files.entries()).map(([name, content]) => ({ name, content })),
      activeFile: room.activeFile,
      users: Array.from(room.users.values()),
    });

    // Deliver the activity history buffer to the new joiner
    socket.emit('activity-history', room.activityLog);

    // Notify others of the join
    socket.to(trimmedRoomId).emit('user-joined', { socketId: socket.id, name: userName, color: derivedColor });

    // Log the join event
    await logActivity(trimmedRoomId, room, { userName, color: derivedColor, action: 'joined the room' });
  });

  // ── Code Change ──────────────────────────────────────────────
  socket.on('code-change', (payload: { code: string; fileName: string }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.files.set(payload.fileName, payload.code);
    socket.to(currentRoomId).emit('code-change', { code: payload.code, fileName: payload.fileName });

    scheduleDebouncedDBSync(currentRoomId, room);

    // Debounced edit log — one entry per burst of keystrokes, not per keystroke
    const user = room.users.get(socket.id);
    if (user) {
      scheduleEditActivityLog(currentRoomId, room, user.name, user.color, payload.fileName);
    }
  });

  // ── Run Code ─────────────────────────────────────────────────
  socket.on('run-code', async (payload: { fileName: string; code: string; language: string }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const { fileName, code } = payload;

    // 1. Validation
    if (!room.files.has(fileName)) {
      socket.emit('error', 'File does not exist in this room.');
      return;
    }

    if (!code || code.trim() === '') {
      socket.emit('error', 'Code cannot be empty.');
      return;
    }

    if (code.length > 50000) {
      socket.emit('error', 'Code exceeds 50,000 character limit.');
      return;
    }

    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const compiler = LANGUAGE_COMPILER_MAP[ext];
    if (!compiler) {
      socket.emit('error', 'Language not allowed or supported.');
      return;
    }

    if (!ONLINECOMPILER_API_KEY) {
      socket.emit('error', 'Code execution is currently unavailable (API key not configured).');
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const startTime = Date.now();

    try {
      const response = await fetch('https://api.onlinecompiler.io/api/run-code-sync/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': ONLINECOMPILER_API_KEY,
        },
        body: JSON.stringify({
          compiler,
          code,
          input: '',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const executionTime = Date.now() - startTime;

      if (!response.ok) {
        let errMsg = `API returned status ${response.status}`;
        try {
          const errData = await response.json() as any;
          if (errData && errData.error) {
            errMsg = errData.error;
          }
        } catch (_) {}
        throw new Error(errMsg);
      }

      const resData = (await response.json()) as any;
      const stdout = resData.output ?? '';
      const stderr = resData.error ?? '';
      const exitCode = typeof resData.exit_code === 'number' ? resData.exit_code : 0;

      socket.emit('run-result', {
        stdout,
        stderr,
        exitCode,
        language: compiler,
        fileName,
        executionTime,
      });

      const user = room.users.get(socket.id);
      const userName = user ? user.name : 'A user';
      socket.to(currentRoomId).emit('run-notification', {
        userName,
        fileName,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const executionTime = Date.now() - startTime;
      const errMsg = (err as Error).name === 'AbortError'
        ? 'Code execution timed out (exceeded 10 seconds).'
        : `Execution failed: ${(err as Error).message}`;

      socket.emit('run-result', {
        stdout: '',
        stderr: errMsg,
        exitCode: -1,
        language: compiler,
        fileName,
        executionTime,
      });
    }
  });

  // ── File Create ──────────────────────────────────────────────
  socket.on('file-create', async (payload: { fileName: string }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const name = payload.fileName.trim();
    if (!name || room.files.has(name)) return;

    room.files.set(name, '');
    io.to(currentRoomId).emit('file-created', { name, content: '' });
    await saveRoomToDB(currentRoomId, room);

    const user = room.users.get(socket.id);
    if (user) {
      await logActivity(currentRoomId, room, { userName: user.name, color: user.color, action: 'created', target: name });
    }
  });

  // ── File Delete ──────────────────────────────────────────────
  socket.on('file-delete', async (payload: { fileName: string }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.files.has(payload.fileName)) return;

    room.files.delete(payload.fileName);

    let newActiveFile = room.activeFile;
    if (room.activeFile === payload.fileName) {
      newActiveFile = room.files.size > 0 ? room.files.keys().next().value! : '';
      room.activeFile = newActiveFile;
    }

    io.to(currentRoomId).emit('file-deleted', { fileName: payload.fileName, newActiveFile });
    await saveRoomToDB(currentRoomId, room);

    const user = room.users.get(socket.id);
    if (user) {
      await logActivity(currentRoomId, room, { userName: user.name, color: user.color, action: 'deleted', target: payload.fileName });
    }
  });

  // ── File Rename ──────────────────────────────────────────────
  socket.on('file-rename', async (payload: { oldName: string; newName: string }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const { oldName, newName } = payload;
    const trimmedNew = newName.trim();
    if (!trimmedNew || !room.files.has(oldName) || room.files.has(trimmedNew)) return;

    const content = room.files.get(oldName)!;
    room.files.delete(oldName);
    room.files.set(trimmedNew, content);
    if (room.activeFile === oldName) room.activeFile = trimmedNew;

    io.to(currentRoomId).emit('file-renamed', { oldName, newName: trimmedNew, newActiveFile: room.activeFile });
    await saveRoomToDB(currentRoomId, room);

    const user = room.users.get(socket.id);
    if (user) {
      // Pack both names into target so the client can display "oldName → newName"
      await logActivity(currentRoomId, room, {
        userName: user.name,
        color: user.color,
        action: 'renamed',
        target: `${oldName} → ${trimmedNew}`,
      });
    }
  });

  // ── File Switch ──────────────────────────────────────────────
  socket.on('file-switch', (payload: { fileName: string }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.files.has(payload.fileName)) return;

    room.activeFile = payload.fileName;
    socket.to(currentRoomId).emit('file-switched', { fileName: payload.fileName });
  });

  // ── Cursor Update ────────────────────────────────────────────
  socket.on('cursor-update', (payload: {
    fileName: string;
    position: { lineNumber: number; column: number };
    selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null;
  }) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('cursor-update', { socketId: socket.id, ...payload });
  });

  // ── Disconnect ───────────────────────────────────────────────

  socket.on('disconnect', async () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users.get(socket.id);
    room.users.delete(socket.id);
    io.to(currentRoomId).emit('user-left', { socketId: socket.id });

    console.log(`[Socket] ${user?.name ?? 'Unknown'} disconnected from ${currentRoomId} (${room.users.size} remaining)`);

    // Log the leave event before potentially evicting the room
    if (user) {
      await logActivity(currentRoomId, room, { userName: user.name, color: user.color, action: 'left the room' });
    }

    if (room.dbSyncTimer) {
      clearTimeout(room.dbSyncTimer);
      room.dbSyncTimer = null;
      saveRoomToDB(currentRoomId, room);
    }

    if (room.users.size === 0) {
      // Flush pending edit log entry if it exists, then clear timer
      if (room.lastEditInfo) {
        await logActivity(currentRoomId, room, {
          userName: room.lastEditInfo.userName,
          color: room.lastEditInfo.color,
          action: 'edited',
          target: room.lastEditInfo.fileName,
        });
        room.lastEditInfo = null;
      }
      // Clear edit debounce before evicting
      if (room.editActivityTimer) {
        clearTimeout(room.editActivityTimer);
        room.editActivityTimer = null;
      }
      rooms.delete(currentRoomId);
      console.log(`[Room] Evicted empty room from memory: ${currentRoomId}`);
    }
  });
});

// ─── Start ────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Accepting connections from: ${CLIENT_URL}`);
});
