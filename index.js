// index.js – TonyOS backend (industry-grade single-file version)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { OpenAI } = require("openai");

// -------------------- ENV + CONSTANTS --------------------

const PORT = process.env.PORT || 5000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY is not set. /chat and /brain-dump will fail.");
}
if (!DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL is not set. Backend will not connect to Postgres.");
}

// -------------------- APP SETUP --------------------

const app = express();

// Security + basics
app.use(helmet());
app.use(cors({ origin: "*", methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

// Rate limits – protect AI + write-heavy endpoints
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/chat", aiLimiter);
app.use("/brain-dump", aiLimiter);

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/tasks", writeLimiter);

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------- POSTGRES SETUP --------------------

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false } // Render / managed Postgres
      : false,
});

/**
 * Initialize DB schema. Safe to call repeatedly.
 */
async function initDb() {
  const ddl = `
    CREATE TABLE IF NOT EXISTS tasks (
      id              SERIAL PRIMARY KEY,
      title           TEXT NOT NULL,
      description     TEXT,
      area            TEXT,
      status          TEXT NOT NULL DEFAULT 'open',   -- open | doing | scheduled | done
      bucket          TEXT NOT NULL DEFAULT 'later',  -- today | this_week | later
      priority        INTEGER NOT NULL DEFAULT 3,     -- 1 highest, 5 lowest
      leverage_score  INTEGER,
      urgency_score   INTEGER,
      risk_score      INTEGER,
      friction_score  INTEGER,
      due_date        TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_bucket ON tasks(bucket);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
  `;

  await pool.query(ddl);
  console.log("✅ Postgres initialized (TonyOS schema ready)");
}

// -------------------- SMALL HELPERS --------------------

function isValidBucket(bucket) {
  return ["today", "this_week", "later"].includes(bucket);
}

function clampPriority(p) {
  if (Number.isNaN(p)) return 3;
  if (p < 1) return 1;
  if (p > 5) return 5;
  return p;
}

function validateTaskPayload(body, { partial = false } = {}) {
  const errors = [];

  if (!partial || body.title !== undefined) {
    if (!body.title || typeof body.title !== "string" || body.title.trim().length < 3) {
      errors.push("title must be a non-empty string (min 3 chars).");
    }
  }

  if (body.bucket !== undefined && !isValidBucket(body.bucket)) {
    errors.push("bucket must be one of: today, this_week, later.");
  }

  if (body.priority !== undefined) {
    const p = Number(body.priority);
    if (!Number.isInteger(p) || p < 1 || p > 5) {
      errors.push("priority must be an integer between 1 and 5.");
    }
  }

  if (body.due_date !== undefined && body.due_date !== null && body.due_date !== "") {
    const d = new Date(body.due_date);
    if (Number.isNaN(d.getTime())) {
      errors.push("due_date must be a valid date or omitted.");
    }
  }

  return errors;
}

// TonyOS scoring – same logic front + back (source of truth)
function computeTonyScore(task) {
  const now = new Date();

  // Leverage from priority (1 high → 5 low) if not set
  const leverage =
    typeof task.leverage_score === "number"
      ? task.leverage_score
      : (() => {
          const p = clampPriority(task.priority ?? 3);
          return 6 - p; // 1 → 5, 2 → 4, ...
        })();

  // Urgency (due date + bucket)
  let urgency = 1;
  if (task.due_date) {
    const d = new Date(task.due_date);
    if (!Number.isNaN(d.getTime())) {
      const diffHours = (d.getTime() - now.getTime()) / (1000 * 60 * 60);
      if (diffHours < 0) urgency = 5;
      else if (diffHours <= 24) urgency = 4;
      else if (diffHours <= 72) urgency = 3;
      else if (diffHours <= 24 * 7) urgency = 2;
      else urgency = 1;
    }
  } else if (task.bucket === "today") urgency = 3;
  else if (task.bucket === "this_week") urgency = 2;

  const risk =
    typeof task.risk_score === "number"
      ? task.risk_score
      : urgency >= 4
      ? 4
      : urgency === 3
      ? 3
      : 2;

  let friction = 2;
  if (typeof task.friction_score === "number") friction = task.friction_score;
  else {
    const desc = (task.description || "").toLowerCase();
    if (!desc) friction = 2;
    else if (desc.includes("tax") || desc.includes("accounting") || desc.includes("legal"))
      friction = 3;
    else if (desc.includes("call") || desc.includes("email")) friction = 1;
    else friction = 2;
  }

  const score = leverage + urgency + risk - friction;

  return {
    leverage_score: leverage,
    urgency_score: urgency,
    risk_score: risk,
    friction_score: friction,
    tony_score: score,
  };
}

// Normalize a raw DB row into the JSON shape the frontend already expects
function mapTaskRow(row) {
  const scores = computeTonyScore(row);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    area: row.area,
    status: row.status,
    bucket: row.bucket,
    priority: row.priority,
    due_date: row.due_date,
    created_at: row.created_at,
    updated_at: row.updated_at,
    leverage_score: scores.leverage_score,
    urgency_score: scores.urgency_score,
    risk_score: scores.risk_score,
    friction_score: scores.friction_score,
    score: scores.tony_score,
  };
}

// -------------------- ROUTES: HEALTH --------------------

app.get("/health", async (req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// -------------------- ROUTES: TASKS --------------------

// GET /tasks – list all tasks
app.get("/tasks", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM tasks
       ORDER BY
         status = 'done',
         bucket,
         priority,
         COALESCE(due_date, '9999-12-31'::timestamptz),
         created_at`
    );
    const tasks = result.rows.map(mapTaskRow);
    res.json(tasks);
  } catch (err) {
    next(err);
  }
});

// POST /tasks – create a new task
app.post("/tasks", async (req, res, next) => {
  try {
    const body = req.body || {};
    const errors = validateTaskPayload(body, { partial: false });
    if (errors.length) {
      return res.status(400).json({ error: "Invalid task payload", details: errors });
    }

    const title = body.title.trim();
    const description = body.description ? String(body.description).trim() : null;
    const area = body.area ? String(body.area).trim() : null;
    const bucket = isValidBucket(body.bucket) ? body.bucket : "later";
    const priority = clampPriority(Number(body.priority ?? 3));
    const dueDate =
      body.due_date && body.due_date !== ""
        ? new Date(body.due_date).toISOString()
        : null;

    const scoreObj = computeTonyScore({
      title,
      description,
      area,
      bucket,
      priority,
      due_date: dueDate,
    });

    const result = await pool.query(
      `INSERT INTO tasks
        (title, description, area, status, bucket, priority,
         leverage_score, urgency_score, risk_score, friction_score,
         due_date, created_at, updated_at)
       VALUES
        ($1, $2, $3, 'open', $4, $5,
         $6, $7, $8, $9,
         $10, NOW(), NOW())
       RETURNING *`,
      [
        title,
        description,
        area,
        bucket,
        priority,
        scoreObj.leverage_score,
        scoreObj.urgency_score,
        scoreObj.risk_score,
        scoreObj.friction_score,
        dueDate,
      ]
    );

    const task = mapTaskRow(result.rows[0]);
    res.status(201).json(task);
  } catch (err) {
    next(err);
  }
});

// PATCH /tasks/:id/complete – mark as done
app.patch("/tasks/:id/complete", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid task id" });
    }

    const result = await pool.query(
      `UPDATE tasks
       SET status = 'done',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Task not found" });
    }

    const task = mapTaskRow(result.rows[0]);
    res.json(task);
  } catch (err) {
    next(err);
  }
});

// DELETE /tasks/:id – delete a task
app.delete("/tasks/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid task id" });
    }

    const result = await pool.query(
      `DELETE FROM tasks
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Task not found" });
    }

    res.status(204).send(); // No content
  } catch (err) {
    next(err);
  }
});

// -------------------- ROUTES: CHAT --------------------

app.post("/chat", async (req, res, next) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const prompt = (req.body && req.body.prompt) || "";
    if (!prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }

    // Pull recent tasks as context (limit to 40 to keep tokens sane)
    const result = await pool.query(
      `SELECT *
       FROM tasks
       ORDER BY created_at DESC
       LIMIT 40`
    );
    const tasks = result.rows.map(mapTaskRow);

    const systemPrompt = `
You are TonyOS, an AI priority engine for Tony Ellis Martinez.
You see his current task list and must give concise, actionable guidance.

Rules:
- Speak clearly and directly.
- Focus on leverage, urgency, and risk.
- Return a short answer (1–3 tight paragraphs or bullet lists).
    `.trim();

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            prompt,
            tasks,
          }),
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim() || "";
    res.json({ response: text });
  } catch (err) {
    next(err);
  }
});

// -------------------- ROUTES: BRAIN DUMP → TASKS --------------------

app.post("/brain-dump", async (req, res, next) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const text = (req.body && req.body.text) || "";
    const defaultBucket = isValidBucket(req.body?.default_bucket)
      ? req.body.default_bucket
      : "today";
    const defaultArea =
      req.body && req.body.default_area && String(req.body.default_area).trim()
        ? String(req.body.default_area).trim()
        : null;

    if (!text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }
    if (text.length > 4000) {
      return res.status(400).json({ error: "text too long (max 4000 chars)" });
    }

    const prompt = `
You are TonyOS, an AI that converts a messy brain dump into clear tasks.

Return STRICT JSON with this exact shape:

{
  "tasks": [
    {
      "title": "string, required",
      "description": "string, optional",
      "bucket": "today | this_week | later, optional",
      "priority": "1-5, integer, optional (1 highest)",
      "area": "string, optional",
      "due_date": "YYYY-MM-DD or null, optional"
    }
  ]
}

Rules:
- Only include tasks that are concrete actions (not vague reflections).
- If bucket is missing, use "${defaultBucket}".
- If area is missing, use "${defaultArea || "General"}".
- If you are unsure about dates, set due_date to null.
    `.trim();

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: text },
      ],
    });

    const raw = response.choices[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({
        error: "Failed to parse AI response",
        raw,
      });
    }

    const tasksArr = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    if (!tasksArr.length) {
      return res.json({ tasks: [] });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const created = [];

      for (const t of tasksArr) {
        const title = (t.title || "").trim();
        if (!title) continue;

        const bucket = isValidBucket(t.bucket) ? t.bucket : defaultBucket;
        const priority = clampPriority(Number(t.priority ?? 3));
        const area =
          (t.area && String(t.area).trim()) || defaultArea || "General";
        const description =
          t.description && String(t.description).trim().length
            ? String(t.description).trim()
            : null;
        const dueDate =
          t.due_date && String(t.due_date).trim()
            ? new Date(t.due_date).toISOString()
            : null;

        const scores = computeTonyScore({
          title,
          description,
          area,
          bucket,
          priority,
          due_date: dueDate,
        });

        const result = await client.query(
          `INSERT INTO tasks
            (title, description, area, status, bucket, priority,
             leverage_score, urgency_score, risk_score, friction_score,
             due_date, created_at, updated_at)
           VALUES
            ($1, $2, $3, 'open', $4, $5,
             $6, $7, $8, $9,
             $10, NOW(), NOW())
           RETURNING *`,
          [
            title,
            description,
            area,
            bucket,
            priority,
            scores.leverage_score,
            scores.urgency_score,
            scores.risk_score,
            scores.friction_score,
            dueDate,
          ]
        );

        created.push(mapTaskRow(result.rows[0]));
      }

      await client.query("COMMIT");
      res.status(201).json({ tasks: created });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// -------------------- 404 + ERROR HANDLERS --------------------

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message:
      process.env.NODE_ENV === "production"
        ? "Something went wrong."
        : err.message,
  });
});

// -------------------- START SERVER --------------------

(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`✅ TonyOS backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to init TonyOS backend", err);
    process.exit(1);
  }
})();
