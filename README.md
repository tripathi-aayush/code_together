# CodeTogether

> A real-time collaborative coding workspace — edit code together, see each other's cursors and presence live, across multiple files in shared rooms.

![Tech Stack](https://img.shields.io/badge/stack-React%20%7C%20TypeScript%20%7C%20Socket.IO%20%7C%20PostgreSQL-blue)

---

## ✨ Features

- **Real-time sync** — multiple users edit the same file simultaneously with ~100ms latency
- **Live cursors & selections** — see colored cursor markers and selection highlights for every collaborator
- **User presence** — colored name chips showing who's currently in the room
- **Multi-file rooms** — create, rename, delete files within a shared room
- **Activity log** — live feed of who joined, left, created, or edited files
- **Room codes** — share a short code or link to invite collaborators

---

## 🛠 Tech Stack

```
Client  →  React + TypeScript (Vite) + Monaco Editor
Server  →  Node.js + TypeScript + Express + Socket.IO
DB      →  PostgreSQL (via Prisma ORM)
Infra   →  Docker + docker-compose
```

### Architecture

```
┌─────────────────────┐        WebSocket (Socket.IO)       ┌──────────────────────┐
│   Browser (React)   │ ◄─────────────────────────────────► │  Node.js + Express   │
│   Monaco Editor     │                                      │  Socket.IO Server    │
└─────────────────────┘                                      └────────┬─────────────┘
                                                                      │ Prisma ORM
                                                             ┌────────▼─────────────┐
                                                             │      PostgreSQL       │
                                                             └──────────────────────┘
```

---

## 🚀 Running Locally

### Prerequisites
- [Docker](https://www.docker.com/get-started) + Docker Compose
- That's it — no local Node/Postgres needed

### Steps

```bash
# 1. Clone the repo
git clone <repo-url>
cd collabcode

# 2. Copy env file (uses sensible defaults — no changes needed for local dev)
cp .env.example .env

# 3. Boot everything
docker-compose up
```

The first run will:
1. Pull the Postgres image and start the database
2. Install dependencies and run Prisma migrations
3. Start the backend on **http://localhost:3001**
4. Start the frontend on **http://localhost:5173**

Open **http://localhost:5173** in your browser. Open a second tab and join the same room — start typing!

### Running without Docker (for faster development)

```bash
# Terminal 1 — start Postgres only
docker-compose up postgres

# Terminal 2 — server
cd server
cp ../.env.example .env   # edit DATABASE_URL to point to localhost
npm run db:migrate
npm run dev

# Terminal 3 — client
cd client
npm run dev
```

---

## 🗄 Database

```bash
# Run migrations (inside Docker)
docker-compose exec server npm run db:migrate

# Open Prisma Studio (outside Docker)
cd server && npm run db:studio
```

### Schema overview
- **Room** — a shared workspace identified by a short code
- **File** — a named file belonging to a room, with its content
- **ActivityLog** — append-only log of room events (join/leave/create/edit)

---

## 📁 Project Structure

```
collabcode/
├── client/               # React + Vite frontend
│   ├── src/
│   │   ├── components/   # UI components
│   │   ├── pages/        # Route-level pages
│   │   ├── hooks/        # Custom React hooks
│   │   └── lib/          # Utilities (socket, api)
│   └── Dockerfile.dev
│
├── server/               # Node.js + Express backend
│   ├── src/
│   │   ├── index.ts      # Entry point
│   │   ├── socket/       # Socket.IO event handlers
│   │   └── routes/       # REST endpoints (if any)
│   ├── prisma/
│   │   └── schema.prisma # Data model
│   └── Dockerfile.dev
│
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## 🔒 Out of Scope (by design)

This is an intentionally scoped project. The following are **explicitly excluded**:
- CRDTs / Operational Transform (raw broadcast sync only)
- In-browser code execution / compiler
- Real user authentication / OAuth
- Mobile clients

---

## 📄 License

MIT
