import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// ─── In-memory room state ──────────────────────────────────────
// Phase 1: single-file rooms, keyed by roomId.
// Phase 2 will extend this to multi-file support.

interface RoomUser {
  socketId: string;
  name: string;
}

interface RoomState {
  code: string;
  users: Map<string, RoomUser>; // socketId → user
}

const rooms = new Map<string, RoomState>();

function getOrCreateRoom(roomId: string): RoomState {
  let room = rooms.get(roomId);
  if (!room) {
    room = { code: '', users: new Map() };
    rooms.set(roomId, room);
    console.log(`[Room] Created room: ${roomId}`);
  }
  return room;
}

// ─── Health check ──────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Socket.IO events ─────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  let currentRoomId: string | null = null;

  // --- Join Room ---
  socket.on('join-room', (payload: { roomId: string; userName: string }) => {
    const { roomId, userName } = payload;
    const room = getOrCreateRoom(roomId);

    // Leave previous room if any
    if (currentRoomId && currentRoomId !== roomId) {
      socket.leave(currentRoomId);
      const prevRoom = rooms.get(currentRoomId);
      if (prevRoom) {
        prevRoom.users.delete(socket.id);
        io.to(currentRoomId).emit('user-left', { socketId: socket.id });
        console.log(`[Room] ${userName} left room ${currentRoomId}`);
      }
    }

    // Join new room
    socket.join(roomId);
    currentRoomId = roomId;
    room.users.set(socket.id, { socketId: socket.id, name: userName });

    console.log(`[Room] ${userName} (${socket.id}) joined room ${roomId} (${room.users.size} users)`);

    // Send current room state to the newly joined user
    socket.emit('room-state', {
      code: room.code,
      users: Array.from(room.users.values()),
    });

    // Notify other users in the room
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      name: userName,
    });
  });

  // --- Code Change ---
  // Phase 1: full-content sync. Client sends the entire editor content,
  // server stores it and broadcasts to all OTHER clients in the room.
  socket.on('code-change', (payload: { code: string }) => {
    if (!currentRoomId) return;

    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.code = payload.code;

    // Broadcast to everyone else in the room — NOT back to sender.
    // This is critical: sending back to sender would cause feedback loops.
    socket.to(currentRoomId).emit('code-change', { code: payload.code });
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);

    if (currentRoomId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        const user = room.users.get(socket.id);
        room.users.delete(socket.id);

        io.to(currentRoomId).emit('user-left', { socketId: socket.id });

        console.log(`[Room] ${user?.name || 'Unknown'} left room ${currentRoomId} (${room.users.size} users remaining)`);

        // Clean up empty rooms to prevent memory leaks
        if (room.users.size === 0) {
          rooms.delete(currentRoomId);
          console.log(`[Room] Deleted empty room: ${currentRoomId}`);
        }
      }
    }
  });
});

// ─── Start server ──────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Accepting connections from: ${CLIENT_URL}`);
});
