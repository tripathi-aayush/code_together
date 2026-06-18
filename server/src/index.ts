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

interface RoomState {
  files: Map<string, string>;   // fileName → content
  activeFile: string;           // DESIGN DECISION: shared active file model.
                                // All users in a room view the same file.
                                // When any user switches files, all users switch.
                                // Simpler than per-user active file; feels like true pair-programming.
  users: Map<string, RoomUser>; // socketId → user
  dbSyncTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_FILE_NAME = 'main.js';
const DEFAULT_FILE_CONTENT = `// Welcome to CodeTogether! 🚀
// Share the room code to invite collaborators.

function greet(name) {
  return \`Hello, \${name}!\`;
}

console.log(greet('World'));
`;

const DB_SYNC_DEBOUNCE_MS = 3000; // Debounce DB saves — don't hit DB on every keystroke

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
  };
}

// ─── DB helpers (all wrapped in try-catch — app works without DB) ─

async function loadRoomFromDB(roomCode: string): Promise<RoomState | null> {
  if (!prisma) return null;
  try {
    const dbRoom = await prisma.room.findUnique({
      where: { code: roomCode },
      include: { files: { orderBy: { createdAt: 'asc' } } },
    });
    if (!dbRoom || dbRoom.files.length === 0) return null;

    const files = new Map<string, string>();
    for (const f of dbRoom.files) {
      files.set(f.name, f.content);
    }
    const activeFile = dbRoom.files[0].name;

    console.log(`[DB] Loaded room ${roomCode} from DB (${files.size} files)`);
    return { files, activeFile, users: new Map(), dbSyncTimer: null };
  } catch (err) {
    console.warn('[DB] Could not load room (DB may be unavailable):', (err as Error).message);
    return null;
  }
}

async function saveRoomToDB(roomCode: string, room: RoomState): Promise<void> {
  if (!prisma) return;
  try {
    // Upsert the Room record
    const dbRoom = await prisma.room.upsert({
      where: { code: roomCode },
      create: { code: roomCode },
      update: { updatedAt: new Date() },
    });

    // Upsert each file
    for (const [name, content] of room.files) {
      await prisma.file.upsert({
        where: { roomId_name: { roomId: dbRoom.id, name } },
        create: { roomId: dbRoom.id, name, content },
        update: { content, updatedAt: new Date() },
      });
    }

    // Delete files no longer in memory
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

  // Try loading from DB first (handles server restart case)
  const fromDB = await loadRoomFromDB(roomCode);
  if (fromDB) {
    rooms.set(roomCode, fromDB);
    return fromDB;
  }

  // Brand new room
  const newRoom = createDefaultRoom();
  rooms.set(roomCode, newRoom);
  console.log(`[Room] Created new room: ${roomCode}`);
  return newRoom;
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

    // Leave previous room if re-joining
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

    // Send full room state to the newly joined user
    socket.emit('room-state', {
      files: Array.from(room.files.entries()).map(([name, content]) => ({ name, content })),
      activeFile: room.activeFile,
      users: Array.from(room.users.values()),
    });

    // Notify others
    socket.to(roomId).emit('user-joined', { socketId: socket.id, name: userName, color });
  });

  // ── Code Change ──────────────────────────────────────────────
  // Sender edits a file; broadcast to everyone else in the room.
  // Includes fileName so receivers can update the correct file in their state.
  socket.on('code-change', (payload: { code: string; fileName: string }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.files.set(payload.fileName, payload.code);
    socket.to(currentRoomId).emit('code-change', { code: payload.code, fileName: payload.fileName });

    // Debounce DB sync — don't write on every keystroke
    scheduleDebouncedDBSync(currentRoomId, room);
  });

  // ── File Create ──────────────────────────────────────────────
  socket.on('file-create', async (payload: { fileName: string }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const name = payload.fileName.trim();
    if (!name || room.files.has(name)) return; // Ignore duplicates/empty

    room.files.set(name, '');
    // Broadcast to ALL in room (including sender) — keeps state consistent
    io.to(currentRoomId).emit('file-created', { name, content: '' });

    // Persist immediately — file structure changes are infrequent
    await saveRoomToDB(currentRoomId, room);
  });

  // ── File Delete ──────────────────────────────────────────────
  socket.on('file-delete', async (payload: { fileName: string }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.files.has(payload.fileName)) return;

    room.files.delete(payload.fileName);

    // If the deleted file was active, switch everyone to the first remaining file
    let newActiveFile = room.activeFile;
    if (room.activeFile === payload.fileName) {
      newActiveFile = room.files.size > 0 ? room.files.keys().next().value! : '';
      room.activeFile = newActiveFile;
    }

    io.to(currentRoomId).emit('file-deleted', {
      fileName: payload.fileName,
      newActiveFile,
    });

    await saveRoomToDB(currentRoomId, room);
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

    if (room.activeFile === oldName) {
      room.activeFile = trimmedNew;
    }

    io.to(currentRoomId).emit('file-renamed', {
      oldName,
      newName: trimmedNew,
      newActiveFile: room.activeFile,
    });

    await saveRoomToDB(currentRoomId, room);
  });

  // ── File Switch ──────────────────────────────────────────────
  // Shared active file: when any user switches, everyone switches.
  socket.on('file-switch', (payload: { fileName: string }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.files.has(payload.fileName)) return;

    room.activeFile = payload.fileName;
    // Broadcast to others; sender already switched locally
    socket.to(currentRoomId).emit('file-switched', { fileName: payload.fileName });
  });

  // ── Disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users.get(socket.id);
    room.users.delete(socket.id);
    io.to(currentRoomId).emit('user-left', { socketId: socket.id });

    console.log(`[Socket] ${user?.name ?? 'Unknown'} disconnected from ${currentRoomId} (${room.users.size} remaining)`);

    // Flush any pending DB sync immediately before potentially deleting the room
    if (room.dbSyncTimer) {
      clearTimeout(room.dbSyncTimer);
      room.dbSyncTimer = null;
      saveRoomToDB(currentRoomId, room); // Fire-and-forget
    }

    // Evict empty rooms from memory (DB retains the data)
    if (room.users.size === 0) {
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
