// index.js — TonyOS backend (industry-grade single-file version)

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

// Important for Render / other proxies so rate-limit + IPs work correctly
app.set("trust proxy", 1);

app.use(express.json());
app.use(
  cors({
    origin: "*", // you can lock this down later to your Vercel origin
  })
);
app.use(helmet());
app.use(morgan("tiny"));

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 100,            // 100 requests / minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true, // fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR weirdness
});
app.use(limiter);

// ---------- CONFIG & CLIENTS ----------

const PORT = process.env.PORT || 10000;

if (!process.env.DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL is not set. Backend will crash on DB usage.");
}
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY is not set. /chat and /brain-dump will fail.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render PostgreSQL requires TLS
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- DB INIT ----------

async function initDb() {
  const ddl = `
    CREATE TABLE IF NOT EXISTS tasks (
      id              SERIAL PRIMARY KEY,
      title           TEXT        NOT NULL,
      description     TEXT,
      area            TEXT,
      status          TEXT        NOT NULL DEFAULT 'open',   -- open | doing | scheduled | done
      bucket          TEXT        NOT NULL DEFAULT 'later',  -- today | this_week | later
      priority        INTEGER     NOT NULL DEFAULT 3,        -- 1 = highest

      leverage_score  INTEGER,
      urgency_score   INTEGER,
      risk_score      INTEGER,
      friction_score  INTEGER,

      due_date        TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await pool.query(ddl);
  console.log("✅ Postgres initialized (TonyOS schema ready)");
}

// Small helper to keep updated_at correct
async function touchUpdatedAt(id) {
  await pool.query(`UPDATE tasks SET updated_at = NOW() WHERE id = $1`, [id]);
}

// ---------- SCORING ENGINE (SAME LOGIC AS FRONTEND) ----------

function urgencyScore(task) {
  const { due_date: due, bucket } = task;
  if (!due) {
    if (bucket === "today") return 3;
    if (bucket === "this_week") return 2;
    return 1;
  }
  const now = new Date();
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return 1;
  const diffMs = d.getTime() - now.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours < 0) return 5;
  if (diffHours <= 24) return 4;
  if (diffHours <= 72) return 3;
  if (diffHours <= 24 * 7) return 2;
  return 1;
}

function leverageScore(task) {
  const p =
    typeof task.priority === "number"
      ? task.priority
      : parseInt(task.priority || "3", 10);
  const clamped = Math.min(Math.max(p || 3, 1), 5);
  return 6 - clamped; // priority 1 → 5 leverage … priority 5 → 1
}

function riskScore(task) {
  const u = urgencyScore(task);
  if (u >= 4) return 4;
  if (u === 3) return 3;
  return 2;
}

function frictionScore(task) {
  const desc = (task.description || "").toLowerCase();
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

function computeScores(task) {
  const L = leverageScore(task);
  const U = urgencyScore(task);
  const R = riskScore(task);
  const F = frictionScore(task);
  return { L, U, R, F, score: L + U + R - F };
}

// ---------- SIMPLE HEALTH ENDPOINTS ----------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "tonyos-backend",
    message: "TonyOS backend API",
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ---------- TASK ENDPOINTS ----------

// GET /tasks  → list all tasks
app.get("/tasks", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tasks ORDER BY created_at ASC;`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /tasks  → create single task
app.post("/tasks", async (req, res, next) => {
  try {
    const {
      title,
      description = null,
      area = null,
      status = "open",
      bucket = "later",
      priority = 3,
      due_date = null,
    } = req.body || {};

    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title is required" });
    }

    const scores = computeScores({ title, description, bucket, priority, due_date });

    const insert = `
      INSERT INTO tasks
        (title, description, area, status, bucket, priority,
         leverage_score, urgency_score, risk_score, friction_score, due_date)
      VALUES
        ($1,   $2,          $3,   $4,    $5,     $6,
         $7,             $8,           $9,         $10,            $11)
      RETURNING *;
    `;
    const params = [
      title,
      description,
      area,
      status,
      bucket,
      priority,
      scores.L,
      scores.U,
      scores.R,
      scores.F,
      due_date,
    ];

    const { rows } = await pool.query(insert, params);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /tasks/:id/complete  → mark done
app.patch("/tasks/:id/complete", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "invalid id" });
    }

    const { rows } = await pool.query(
      `UPDATE tasks
         SET status = 'done',
             updated_at = NOW()
       WHERE id = $1
       RETURNING *;`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "task not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /tasks/:id → delete task
app.delete("/tasks/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "invalid id" });
    }

    const { rowCount } = await pool.query(`DELETE FROM tasks WHERE id = $1`, [
      id,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ error: "task not found" });
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---------- BRAIN DUMP → TASKS (OPENAI) ----------

// POST /brain-dump  { text, default_bucket, default_area }
app.post("/brain-dump", async (req, res, next) => {
  try {
    const { text, default_bucket = "today", default_area = null } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ error: "OPENAI_API_KEY not configured on backend" });
    }

    const prompt = `
You are TonyOS, a task parser.
User brain dump:

"""${text}"""

Return a strict JSON array (no extra text) where each item is:
{
  "title": string,                     // short task name
  "description": string,               // one line detail
  "bucket": "today" | "this_week" | "later",
  "area": string | null,               // e.g. "TM Weddings", "Personal"
  "priority": 1 | 2 | 3 | 4 | 5,       // 1 = highest
  "due_date": string | null            // ISO date if obvious, else null
}
Only infer due_date when the text clearly implies it; otherwise use null.
If something is not a clear actionable task, drop it.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    const raw = completion.choices[0]?.message?.content || "[]";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("Brain dump JSON parse failed, raw:", raw);
      return res
        .status(502)
        .json({ error: "LLM returned invalid JSON", raw });
    }

    const tasks = Array.isArray(parsed) ? parsed : [];
    if (!tasks.length) {
      return res.json({ tasks: [] });
    }

    const created = [];
    for (const t of tasks) {
      const title = String(t.title || "").trim();
      if (!title) continue;

      const description = t.description ? String(t.description) : null;
      const area = t.area ? String(t.area) : default_area;
      const bucket = t.bucket || default_bucket;
      const priority = Number.isFinite(Number(t.priority))
        ? Number(t.priority)
        : 3;
      const due_date = t.due_date || null;

      const scores = computeScores({
        title,
        description,
        bucket,
        priority,
        due_date,
      });

      const insert = `
        INSERT INTO tasks
          (title, description, area, status, bucket, priority,
           leverage_score, urgency_score, risk_score, friction_score, due_date)
        VALUES
          ($1,   $2,          $3,   'open', $4,      $5,
           $6,             $7,           $8,         $9,            $10)
        RETURNING *;
      `;

      const params = [
        title,
        description,
        area,
        bucket,
        priority,
        scores.L,
        scores.U,
        scores.R,
        scores.F,
        due_date,
      ];

      const { rows } = await pool.query(insert, params);
      created.push(rows[0]);
    }

    res.status(201).json({ tasks: created });
  } catch (err) {
    next(err);
  }
});

// ---------- CHAT GPT ENDPOINT ----------

// POST /chat  { prompt }
app.post("/chat", async (req, res, next) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ error: "OPENAI_API_KEY not configured on backend" });
    }

    // Pull current tasks so ChatGPT can reason over them
    const { rows: tasks } = await pool.query(
      `SELECT * FROM tasks ORDER BY created_at ASC;`
    );

    const systemMsg = `
You are TonyOS, an execution-focused AI.
Given Tony's current tasks (with priority, bucket, and leverage/urgency/risk/friction),
tell him what to do next and why in 2–4 short bullet points and one clear sentence:
"Start with: …".
Do NOT invent new tasks, just reason over what's given.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemMsg },
        {
          role: "user",
          content: JSON.stringify(
            { prompt, tasks },
            null,
            2
          ),
        },
      ],
      temperature: 0.3,
    });

    const answer = completion.choices[0]?.message?.content?.trim() || "";
    res.json({ response: answer });
  } catch (err) {
    next(err);
  }
});

// ---------- 404 + ERROR HANDLERS ----------

app.use((req, res, next) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

app.use((err, req, res, next) => {
  console.error("❌ Backend error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ---------- STARTUP ----------

(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(
        `🚀 TonyOS backend running on http://localhost:${PORT}`
      );
    });
  } catch (err) {
    console.error("Failed to start backend:", err);
    process.exit(1);
  }
})();

