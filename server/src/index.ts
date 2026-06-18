import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from './generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

dotenv.config();

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
      color: '#9090a8', // color not stored in DB — use a neutral fallback
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
    id: Math.random().toString(36).slice(2),
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

/** Schedule (or re-schedule) a debounced "X edited Y" activity entry. */
function scheduleEditActivityLog(roomId: string, room: RoomState, userName: string, color: string, fileName: string): void {
  // Update who's editing what (latest user to touch the file wins the log entry)
  room.lastEditInfo = { userName, color, fileName };

  if (room.editActivityTimer) return; // already scheduled, don't reset — first editor of the burst gets the entry
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
    const { roomId, userName, color } = payload;

    if (currentRoomId && currentRoomId !== roomId) {
      socket.leave(currentRoomId);
      const prev = rooms.get(currentRoomId);
      if (prev) {
        prev.users.delete(socket.id);
        io.to(currentRoomId).emit('user-left', { socketId: socket.id });
      }
    }

    const room = await getOrCreateRoom(roomId);

    socket.join(roomId);
    currentRoomId = roomId;
    room.users.set(socket.id, { socketId: socket.id, name: userName, color });

    console.log(`[Room] ${userName} joined ${roomId} (${room.users.size} users)`);

    // Hydrate the new joiner with full room state + activity history
    socket.emit('room-state', {
      files: Array.from(room.files.entries()).map(([name, content]) => ({ name, content })),
      activeFile: room.activeFile,
      users: Array.from(room.users.values()),
    });

    // Deliver the activity history buffer to the new joiner
    socket.emit('activity-history', room.activityLog);

    // Notify others of the join
    socket.to(roomId).emit('user-joined', { socketId: socket.id, name: userName, color });

    // Log the join event
    await logActivity(roomId, room, { userName, color, action: 'joined the room' });
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
