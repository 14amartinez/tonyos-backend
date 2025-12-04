// index.js — TonyOS backend (single-file, industry-style)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { OpenAI } = require("openai");

// ---------- BASIC APP SETUP ----------
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: "*", // you can tighten to your Vercel domain later
  })
);
app.use(helmet());
app.use(morgan("tiny"));

// Small rate-limit to protect backend / OpenAI
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
});
app.use(limiter);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- POSTGRES SETUP ----------
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://tonymartinez@localhost:5432/tonyos",
  ssl: process.env.RENDER
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  const ddl = `
    CREATE TABLE IF NOT EXISTS tasks (
      id            SERIAL PRIMARY KEY,
      title         TEXT    NOT NULL,
      description   TEXT,
      area          TEXT,
      status        TEXT    NOT NULL DEFAULT 'open',   -- open | doing | scheduled | done
      bucket        TEXT    NOT NULL DEFAULT 'later',  -- today | this_week | later
      priority      INTEGER NOT NULL DEFAULT 3,        -- 1 = highest
      leverage_score INTEGER,
      urgency_score  INTEGER,
      risk_score     INTEGER,
      friction_score INTEGER,
      score          INTEGER,
      due_date      TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await pool.query(ddl);
  console.log("✅ Postgres initialized (TonyOS schema ready)");
}

// helper: keep updated_at fresh
async function touchTask(id) {
  await pool.query(
    "UPDATE tasks SET updated_at = NOW() WHERE id = $1",
    [id]
  );
}

// ---------- HELPERS ----------
function computeTonyScore(t) {
  const bucket = t.bucket || "later";

  // urgency based on due_date + bucket
  function urgencyScore() {
    if (!t.due_date) {
      if (bucket === "today") return 3;
      if (bucket === "this_week") return 2;
      return 1;
    }
    const now = new Date();
    const d = new Date(t.due_date);
    if (Number.isNaN(d.getTime())) return 1;
    const diffHours = (d.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (diffHours < 0) return 5;
    if (diffHours <= 24) return 4;
    if (diffHours <= 72) return 3;
    if (diffHours <= 24 * 7) return 2;
    return 1;
  }

  function leverageScore() {
    if (typeof t.leverage_score === "number") return t.leverage_score;
    const p = typeof t.priority === "number" ? t.priority : 3;
    const clamped = Math.min(Math.max(p, 1), 5);
    return 6 - clamped; // P1 => 5, P5 => 1
  }

  function riskScore() {
    if (typeof t.risk_score === "number") return t.risk_score;
    const u = urgencyScore();
    if (u >= 4) return 4;
    if (u === 3) return 3;
    return 2;
  }

  function frictionScore() {
    if (typeof t.friction_score === "number") return t.friction_score;
    const desc = (t.description || "").toLowerCase();
    if (!desc) return 2;
    if (
      desc.includes("tax") ||
      desc.includes("accounting") ||
      desc.includes("legal")
    )
      return 3;
    if (desc.includes("call") || desc.includes("email")) return 1;
    return 2;
  }

  const L = leverageScore();
  const U = urgencyScore();
  const R = riskScore();
  const F = frictionScore();
  const score = L + U + R - F;

  return { L, U, R, F, score };
}

// re-score tasks when we fetch them
function withScores(rows) {
  return rows.map((t) => {
    const metrics = computeTonyScore(t);
    return { ...t, ...metrics };
  });
}

// ---------- ROUTES ----------

// Healthcheck
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    console.error("Healthcheck error", err);
    res.status(500).json({ ok: false });
  }
});

// GET /tasks  – main feed for dashboard
app.get("/tasks", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id, title, description, area, status, bucket, priority,
        leverage_score, urgency_score, risk_score, friction_score, score,
        due_date, created_at, updated_at
      FROM tasks
      ORDER BY
        (status = 'done') ASC,
        bucket,
        priority,
        COALESCE(due_date, '9999-12-31') ASC
      `
    );
    res.json(withScores(result.rows));
  } catch (err) {
    console.error("GET /tasks error", err);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

// POST /tasks  – quick add
app.post("/tasks", async (req, res) => {
  try {
    const {
      title,
      description = null,
      area = null,
      bucket = "later",
      status = "open",
      priority = 3,
      due_date = null,
    } = req.body || {};

    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title is required" });
    }

    const insert = `
      INSERT INTO tasks
        (title, description, area, status, bucket, priority, due_date)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING
        id, title, description, area, status, bucket, priority,
        leverage_score, urgency_score, risk_score, friction_score, score,
        due_date, created_at, updated_at
    `;

    const result = await pool.query(insert, [
      title,
      description,
      area,
      status,
      bucket,
      priority,
      due_date,
    ]);

    const [row] = withScores(result.rows);
    res.status(201).json(row);
  } catch (err) {
    console.error("POST /tasks error", err);
    res.status(500).json({ error: "Failed to create task" });
  }
});

// PATCH /tasks/:id/complete
app.patch("/tasks/:id/complete", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const result = await pool.query(
      `
      UPDATE tasks
      SET status = 'done',
          updated_at = NOW()
      WHERE id = $1
      RETURNING
        id, title, description, area, status, bucket, priority,
        leverage_score, urgency_score, risk_score, friction_score, score,
        due_date, created_at, updated_at
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Task not found" });
    }

    const [row] = withScores(result.rows);
    res.json(row);
  } catch (err) {
    console.error("PATCH /tasks/:id/complete error", err);
    res.status(500).json({ error: "Failed to complete task" });
  }
});

// DELETE /tasks/:id
app.delete("/tasks/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const result = await pool.query("DELETE FROM tasks WHERE id = $1", [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Task not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /tasks/:id error", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// POST /brain-dump  – use OpenAI to turn text into tasks
app.post("/brain-dump", async (req, res) => {
  try {
    const { text, default_bucket = "today", default_area = null } = req.body || {};

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are TonyOS, an AI that converts a messy brain dump into a concise list of actionable tasks for a task manager. " +
            "Return ONLY valid JSON.Each task must have: title (string), description (string), bucket (today|this_week|later), " +
            "priority (1-5, 1 = most important), due_date (ISO date string or null), area (string or null).",
        },
        {
          role: "user",
          content: `Brain dump:\n${text}\n\nDefault bucket: ${default_bucket}\nDefault area: ${
            default_area || "null"
          }.`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "tasks_payload",
          schema: {
            type: "object",
            properties: {
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    description: { type: "string" },
                    bucket: { type: "string" },
                    priority: { type: "integer" },
                    due_date: { type: ["string", "null"] },
                    area: { type: ["string", "null"] },
                  },
                  required: ["title"],
                  additionalProperties: false,
                },
              },
            },
            required: ["tasks"],
            additionalProperties: false,
          },
        },
      },
    });

    const parsed = JSON.parse(
      completion.choices[0].message.content || '{"tasks":[]}'
    );
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];

    const created = [];

    for (const t of tasks) {
      const {
        title,
        description = null,
        bucket = default_bucket,
        priority = 3,
        due_date = null,
        area = default_area || null,
      } = t;

      if (!title) continue;

      const result = await pool.query(
        `
        INSERT INTO tasks
          (title, description, area, status, bucket, priority, due_date)
        VALUES
          ($1, $2, $3, 'open', $4, $5, $6)
        RETURNING
          id, title, description, area, status, bucket, priority,
          leverage_score, urgency_score, risk_score, friction_score, score,
          due_date, created_at, updated_at
        `,
        [title, description, area, bucket, priority, due_date]
      );

      created.push(withScores(result.rows)[0]);
    }

    res.json({ tasks: created });
  } catch (err) {
    console.error("POST /brain-dump error", err);
    res.status(500).json({ error: "Failed to parse brain dump" });
  }
});

// POST /chat  – THIS is the upgraded TonyOS brain
app.post("/chat", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required" });
    }

    // Load current tasks
    const result = await pool.query(
      `
      SELECT
        id, title, description, area, status, bucket, priority,
        leverage_score, urgency_score, risk_score, friction_score, score,
        due_date, created_at, updated_at
      FROM tasks
      ORDER BY
        (status = 'done') ASC,
        bucket,
        priority,
        COALESCE(due_date, '9999-12-31') ASC
      `
    );
    const tasks = withScores(result.rows);

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are TonyOS, Tony Ellis Martinez's AI Command Board. " +
            "You ALWAYS think like a ruthless operator and prioritization engine. " +
            "You are given Tony's current task list (with leverage/urgency/risk/friction scores). " +
            "Use ONLY that task list to answer questions about what he should do, in what order, and why. " +
            "If he asks for the 'most important' or 'next' thing, choose 1–3 tasks and justify them briefly. " +
            "Be blunt, clear, and practical.",
        },
        {
          role: "system",
          content:
            "Current tasks JSON:\n" +
            JSON.stringify(tasks, null, 2),
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const answer =
      completion.choices[0]?.message?.content?.trim() ||
      "No response from model.";

    res.json({
      response: answer,
      task_count: tasks.length,
    });
  } catch (err) {
    console.error("POST /chat error", err);
    res.status(500).json({ error: "Chat failed" });
  }
});

// fallback
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

// ---------- STARTUP ----------
const PORT = process.env.PORT || 10000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 TonyOS backend running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to init DB", err);
    process.exit(1);
  });
