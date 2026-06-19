# CodeTogether

> **Real-time collaborative code editing for developers — a simplified VS Code Live Share.**

Join a shared room with teammates, edit the same files simultaneously, and see each other's live cursors, selections, and activity — all without installing anything.

[![React](https://img.shields.io/badge/React-19-61dafb?style=flat&logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat&logo=typescript)](https://www.typescriptlang.org)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?style=flat&logo=socketdotio)](https://socket.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-336791?style=flat&logo=postgresql)](https://postgresql.org)
[![Monaco Editor](https://img.shields.io/badge/Monaco-0.52-7c5cff?style=flat)](https://microsoft.github.io/monaco-editor/)

---

## ✅ Features

- **Real-time sync** — keystrokes appear for all users within ~50ms via Socket.IO broadcast
- **Live cursors & selections** — see colored cursor markers and selection highlights for every collaborator, in real time, throttled at 50ms
- **Multi-file workspace** — create, rename, delete files; everyone in the room follows the active file (shared-file model)
- **Presence sidebar** — colored avatar chips show who's currently in the room
- **Activity log** — a live feed ("Alice edited index.ts", "Bob joined the room") with history that persists per room
- **Dark theme** — Monaco Editor dark theme with a purple/cyan accent palette
- **Room persistence** — files and room state survive server restarts (PostgreSQL-backed)
- **Reconnect handling** — banner appears on disconnect; re-emits join-room on reconnect to resync state
- **No auth** — enter a display name, join a room code, start coding

---

## 🏗️ Architecture

```
┌─────────────────────────────────┐      WebSocket (Socket.IO)
│   Browser (React + Vite)        │ ◄──────────────────────────► ┌─────────────────────────┐
│                                 │                               │  Node.js Server         │
│  ┌───────────┐  ┌───────────┐   │   Events:                     │  (Express + Socket.IO)  │
│  │ Monaco    │  │ FileExpl. │   │   code-change →               │                         │
│  │ Editor    │  │ Sidebar   │   │   cursor-update →             │  In-memory room state   │
│  └───────────┘  └───────────┘   │   file-create / rename / del  │  (files, users, cursors)│
│  ┌───────────┐  ┌───────────┐   │   join-room / leave →         │          │              │
│  │ ActivityLog│ │ TabBar    │   │   ← activity-log              │          │ Prisma ORM   │
│  └───────────┘  └───────────┘   │   ← room-state                │          ▼              │
└─────────────────────────────────┘                               │     PostgreSQL          │
                                                                  └─────────────────────────┘
```

**Sync model:** Plain broadcast — the server re-broadcasts each `code-change` to all other users in the room. An `isRemoteUpdate` ref on the client prevents the feedback loop of a remote change triggering a local emit. This is simpler than CRDTs (Yjs) and sufficient for a collaborative demo at this scope.

---

## 🚀 Quick Start

### Prerequisites
- [Docker](https://www.docker.com/get-started) + Docker Compose
- Node.js 20+ (if running without Docker)

### With Docker (recommended)

```bash
# 1. Clone and enter the project
git clone <repo-url> && cd codetogether

# 2. Copy environment files
cp .env.example .env

# 3. Start everything
docker-compose up

# 4. Open the app
open http://localhost:5173
```

That's it. No manual migration step — Prisma migrations run automatically on server startup.

### Without Docker

```bash
# Terminal 1 — start Postgres (or use any local Postgres instance)
# Then set DATABASE_URL in server/.env

# Terminal 2 — server
cd server
cp .env.example .env    # edit DATABASE_URL
npm install
npx prisma migrate deploy
npm run dev             # http://localhost:3001

# Terminal 3 — client
cd client
npm install
npm run dev             # http://localhost:5173
```

---

## 🚢 Deployment

When deploying to a production environment (e.g., Render, Vercel, Railway), ensure that `VITE_SERVER_URL` is set to your actual public server URL **before** building the frontend. This variable is baked into the client bundle at build time, so setting it at runtime will not work.

Example:
```bash
VITE_SERVER_URL=https://api.your-domain.com npm run build
```

---

## 🌍 Environment Variables

| Variable | Location | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | `server/.env` | *(required)* | PostgreSQL connection string |
| `PORT` | `server/.env` | `3001` | Server listening port |
| `CLIENT_ORIGIN` | `server/.env` | `http://localhost:5173` | CORS allowed origin for Socket.IO |
| `VITE_SERVER_URL` | `client/.env` | `http://localhost:3001` | Socket.IO server URL |

---

## 📁 Project Structure

```
codetogether/
├── client/                        # React + Vite frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── Editor.tsx          # Monaco wrapper with remote cursors
│   │   │   ├── FileExplorer.tsx    # File CRUD sidebar
│   │   │   ├── TabBar.tsx          # Active file tab with language badge
│   │   │   └── ActivityLog.tsx     # Live activity feed panel
│   │   ├── pages/
│   │   │   ├── Home.tsx            # Landing / join page
│   │   │   └── Room.tsx            # Main room page (socket logic lives here)
│   │   ├── lib/
│   │   │   ├── socket.ts           # Socket.IO singleton
│   │   │   └── colors.ts           # Name → HSL color hash
│   │   └── index.css              # Full design system (CSS vars, all components)
│   └── index.html
│
├── server/                        # Node.js + Express + Socket.IO backend
│   ├── src/
│   │   └── index.ts               # All server logic (room state, events, DB sync)
│   └── prisma/
│       └── schema.prisma          # Room, File, ActivityLog models
│
├── docker-compose.yml             # Postgres + server + client services
└── .env.example                   # Template for all environment variables
```

---

## 💡 How It Works

1. **Room creation**: The client navigates to `/room/<code>?name=Alice`. No database write happens until a user joins.
2. **State hydration**: On `join-room`, the server sends the full room state (files, active file, users) as a single `room-state` event. New users are immediately in sync.
3. **Edit flow**: Every Monaco `onChange` emits `code-change` to the server. The server broadcasts it to all *other* users. The receiver applies it via a programmatic `setValue` call behind an `isRemoteUpdate` ref to prevent re-emitting.
4. **Cursor flow**: `onDidChangeCursorPosition/Selection` events emit `cursor-update`, throttled to 50ms. The server stamps the sender's socket ID and broadcasts. Recipients render Monaco content widgets at the received line/column.
5. **Persistence**: The server debounces file saves to PostgreSQL (saves after 2s of inactivity). On server restart, rooms are re-loaded from DB on first join.
6. **Activity log**: Meaningful events (join, leave, file ops, edits) are appended to an in-memory circular buffer (100 entries) and persisted to the `ActivityLog` table. New joiners receive the full buffer as `activity-history`.

---

## 🔧 Tech Stack

| Layer | Technology |
|---|---|
| Frontend framework | React 19 + TypeScript + Vite |
| Code editor | Monaco Editor (`@monaco-editor/react`) |
| Realtime | Socket.IO (client + server) |
| Backend | Node.js + Express + TypeScript |
| Database | PostgreSQL 15 + Prisma ORM |
| Containerization | Docker + Docker Compose |
| Fonts | Inter (UI) + JetBrains Mono (code) |

---

## 🚫 Out of Scope (by design)

- **CRDTs / Yjs** — plain broadcast sync is sufficient and simpler for this scope
- **Conflict resolution** — last write wins per file; designed for small teams, not concurrent same-line editing
- **Authentication** — display name only; no accounts, passwords, or OAuth
- **Code execution** — the editor is view/edit only; no sandboxed runner
- **Mobile** — desktop-first tool; layout degrades gracefully to tablet widths

---

## 📸 Demo

Open two browser tabs, navigate to the same room code, and start typing — changes appear in real time in both windows.

```
Tab 1:  http://localhost:5173/room/abc-1x4z?name=Alice
Tab 2:  http://localhost:5173/room/abc-1x4z?name=Bob
```
