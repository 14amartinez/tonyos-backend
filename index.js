// index.js – TonyOS backend with Google Login

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const path = require("path");
const { OpenAI } = require("openai");
const Database = require("better-sqlite3");

// ==== BASIC SERVER SETUP ====
const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// Trust proxy for Render / HTTPS cookies
app.set("trust proxy", 1);

// ==== SESSION + PASSPORT SETUP ====
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ==== OPENAI CLIENT (if you use it elsewhere) ====
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== SQLITE SETUP ====
const db = new Database("tasks.db");

// Users table
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id  TEXT UNIQUE,
    email      TEXT,
    name       TEXT,
    avatar     TEXT,
    created_at TEXT NOT NULL
  )
`).run();

// Tasks table (now includes user_id)
db.prepare(`
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT,
    area        TEXT,
    status      TEXT    NOT NULL DEFAULT 'todo',      -- todo | doing | scheduled | done
    bucket      TEXT    NOT NULL DEFAULT 'later',     -- today | this_week | later | backlog
    priority    INTEGER NOT NULL DEFAULT 3,           -- 1 = highest
    due_date    TEXT,                                 -- ISO string or null
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    user_id     INTEGER
  )
`).run();

// ==== USER HELPERS ====
const findUserById = db.prepare("SELECT * FROM users WHERE id = ?");
const findUserByGoogleId = db.prepare("SELECT * FROM users WHERE google_id = ?");
const insertUser = db.prepare(`
  INSERT INTO users (google_id, email, name, avatar, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

// ==== PASSPORT GOOGLE STRATEGY ====
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  try {
    const user = findUserById.get(id);
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:
        process.env.GOOGLE_CALLBACK_URL ||
        "http://localhost:3000/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const email = profile.emails?.[0]?.value || null;
        const name = profile.displayName || null;
        const avatar = profile.photos?.[0]?.value || null;

        let user = findUserByGoogleId.get(googleId);
        if (!user) {
          const info = insertUser.run(
            googleId,
            email,
            name,
            avatar,
            new Date().toISOString()
          );
          user = findUserById.get(info.lastInsertRowid);
        }
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);

// ==== AUTH MIDDLEWARE ====
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ==== STATIC FILES (dashboard.html + login.html sitting next to this file) ====
app.use(express.static(__dirname));

// Root route – send to login or dashboard depending on auth
app.get("/", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.redirect("/dashboard.html");
  }
  return res.redirect("/login.html");
});

// ==== GOOGLE AUTH ROUTES ====

// Start Google OAuth flow
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

// Google callback
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login.html" }),
  (req, res) => {
    // Successful auth –> go to TonyOS
    res.redirect("/dashboard.html");
  }
);

// Get current user
app.get("/api/me", (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(200).json({ user: null });
  }
  const { id, email, name, avatar } = req.user;
  res.json({ user: { id, email, name, avatar } });
});

// Logout
app.get("/logout", (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.redirect("/login.html");
    });
  });
});

// ==== TASKS CRUD (per-user) ====

// List tasks for this user
const listTasksStmt = db.prepare(`
  SELECT * FROM tasks
  WHERE user_id = ?
  ORDER BY
    CASE bucket
      WHEN 'today' THEN 1
      WHEN 'this_week' THEN 2
      WHEN 'later' THEN 3
      ELSE 4
    END,
    priority ASC,
    created_at DESC
`);

// Insert task
const insertTaskStmt = db.prepare(`
  INSERT INTO tasks (
    title, description, area, status, bucket,
    priority, due_date, created_at, updated_at, user_id
  )
  VALUES (
    @title, @description, @area, @status, @bucket,
    @priority, @due_date, @created_at, @updated_at, @user_id
  )
`);

// Update task
const updateTaskStmt = db.prepare(`
  UPDATE tasks
  SET
    title       = @title,
    description = @description,
    area        = @area,
    status      = @status,
    bucket      = @bucket,
    priority    = @priority,
    due_date    = @due_date,
    updated_at  = @updated_at
  WHERE id = @id AND user_id = @user_id
`);

// Delete task
const deleteTaskStmt = db.prepare(`
  DELETE FROM tasks WHERE id = ? AND user_id = ?
`);

// GET /api/tasks – list tasks for logged-in user
app.get("/api/tasks", ensureAuth, (req, res) => {
  const tasks = listTasksStmt.all(req.user.id);
  res.json({ tasks });
});

// POST /api/tasks – create task for logged-in user
app.post("/api/tasks", ensureAuth, (req, res) => {
  const now = new Date().toISOString();
  const {
    title,
    description = "",
    area = "",
    status = "todo",
    bucket = "later",
    priority = 3,
    due_date = null,
  } = req.body || {};

  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }

  const info = insertTaskStmt.run({
    title,
    description,
    area,
    status,
    bucket,
    priority,
    due_date,
    created_at: now,
    updated_at: now,
    user_id: req.user.id,
  });

  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?")
    .get(info.lastInsertRowid, req.user.id);

  res.status(201).json({ task });
});

// PUT /api/tasks/:id – update existing task
app.put("/api/tasks/:id", ensureAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });

  const existing = db
    .prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?")
    .get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: "not found" });

  const {
    title = existing.title,
    description = existing.description,
    area = existing.area,
    status = existing.status,
    bucket = existing.bucket,
    priority = existing.priority,
    due_date = existing.due_date,
  } = req.body || {};

  updateTaskStmt.run({
    id,
    title,
    description,
    area,
    status,
    bucket,
    priority,
    due_date,
    updated_at: new Date().toISOString(),
    user_id: req.user.id,
  });

  const updated = db
    .prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?")
    .get(id, req.user.id);

  res.json({ task: updated });
});

// DELETE /api/tasks/:id – delete task
app.delete("/api/tasks/:id", ensureAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "invalid id" });

  deleteTaskStmt.run(id, req.user.id);
  res.status(204).end();
});

// ==== (OPTIONAL) AI CHAT ENDPOINTS COULD GO HERE, ALSO PROTECTED BY ensureAuth ====

// ==== START SERVER ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TonyOS backend listening on port ${PORT}`);
});
