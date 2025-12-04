// seed.js
// Run with: node seed.js

const Database = require("better-sqlite3");

// open (or create) DB
const db = new Database("tasks.db");

// create table (same schema your backend expects)
db.prepare(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    area TEXT NOT NULL,
    status TEXT NOT NULL,       -- todo, doing, done
    bucket TEXT NOT NULL,       -- today, this_week, later
    priority INTEGER NOT NULL,  -- 1 = highest
    due_date TEXT,              -- ISO string
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`).run();

// wipe existing rows so you don't get duplicates
db.prepare(`DELETE FROM tasks`).run();

const now = new Date().toISOString();

const tasks = [
  // 🔥 TODAY
  {
    title: "Load 2025 weddings + shoots into AI dashboard",
    description: "Import all 2025 weddings / shoots so the board reflects real pipeline.",
    area: "TM Weddings",
    status: "todo",
    bucket: "today",
    priority: 1,
    due_date: new Date().toISOString()
  },
  {
    title: "Schedule Dec/Jan team headshot + interview filming days",
    description: "Lock in dates for team portraits + shooter interviews before holidays.",
    area: "TM Weddings",
    status: "todo",
    bucket: "today",
    priority: 1,
    due_date: new Date().toISOString()
  },
  {
    title: "Set pre-production date for TM Weddings commercial",
    description: "Pick and schedule the pre-pro meeting for the 2026 TM Weddings spot.",
    area: "TM Weddings",
    status: "todo",
    bucket: "today",
    priority: 2,
    due_date: new Date().toISOString()
  },
  {
    title: "Finalize Ma’s snack product designs & send to manufacturers",
    description: "Lock packaging and send final art files to manufacturers for quoting.",
    area: "Ma’s Fresh Foods",
    status: "todo",
    bucket: "today",
    priority: 1,
    due_date: new Date().toISOString()
  },

  // 🔥 THIS WEEK
  {
    title: "TM Weddings retention policy (storage + upsell system)",
    description: "Define gallery expiration, cold storage, and paid extension upsells.",
    area: "TM Weddings",
    status: "todo",
    bucket: "this_week",
    priority: 2,
    due_date: null
  },
  {
    title: "Prep café plan for May 1–4 festival",
    description: "Staffing, inventory, hours, signage, and flow for festival weekend.",
    area: "Ma’s Crepes & Cakes",
    status: "todo",
    bucket: "this_week",
    priority: 3,
    due_date: null
  },
  {
    title: "Build cold-storage plan for café digital assets",
    description: "Where photos, menus, designs, and footage live long-term and how.",
    area: "Ma’s Crepes & Cakes",
    status: "todo",
    bucket: "this_week",
    priority: 3,
    due_date: null
  },
  {
    title: "Gather all entity documents for trust/holding review",
    description: "Pull LLC docs, operating agreements, tax returns for CPA/attorney.",
    area: "Trust & Holdings",
    status: "todo",
    bucket: "this_week",
    priority: 2,
    due_date: null
  },
  {
    title: "Begin QNAP redundancy upgrade plan",
    description: "Decide on mirror/backup strategy, hardware, and budget for storage.",
    area: "Infrastructure",
    status: "todo",
    bucket: "this_week",
    priority: 1,
    due_date: null
  },

  // 🔥 LATER (December)
  {
    title: "Draft 2026 restructuring map (trust → holding → LLCs)",
    description: "High-level diagram of entities, flows, and roles for 2026 structure.",
    area: "Trust & Holdings",
    status: "todo",
    bucket: "later",
    priority: 1,
    due_date: "2025-12-15T00:00:00.000Z"
  },
  {
    title: "Build asset list for transfer into the holding company",
    description: "Cameras, lenses, computers, IP, domains, vehicles, etc.",
    area: "Trust & Holdings",
    status: "todo",
    bucket: "later",
    priority: 2,
    due_date: "2025-12-20T00:00:00.000Z"
  },
  {
    title: "Consolidate all bookkeeping for 2024 → 2025",
    description: "Clean books across all entities before restructuring + tax season.",
    area: "Finance",
    status: "todo",
    bucket: "later",
    priority: 2,
    due_date: "2025-12-31T00:00:00.000Z"
  },

  // 🔥 PERSONAL / WELLBEING
  {
    title: "Schedule annual health check + bloodwork",
    description: "Book appointment and get base health data for 2026 push.",
    area: "Personal",
    status: "todo",
    bucket: "this_week",
    priority: 1,
    due_date: null
  },
  {
    title: "Set weekly ‘3 Key Habits’ routine (sleep, gym, food)",
    description: "Lock simple weekly schedule for sleep, training, and meals.",
    area: "Personal",
    status: "todo",
    bucket: "this_week",
    priority: 2,
    due_date: null
  },
  {
    title: "Plan December family days (Eden, Noah, Brynn)",
    description: "Pick specific days and rough plans so work doesn’t swallow them.",
    area: "Family",
    status: "todo",
    bucket: "later",
    priority: 1,
    due_date: "2025-12-05T00:00:00.000Z"
  }
];

const insert = db.prepare(`
  INSERT INTO tasks
    (title, description, area, status, bucket, priority, due_date, created_at, updated_at)
  VALUES
    (@title, @description, @area, @status, @bucket, @priority, @due_date, @created_at, @updated_at)
`);

const tx = db.transaction((rows) => {
  for (const t of rows) {
    insert.run({
      ...t,
      created_at: now,
      updated_at: now
    });
  }
});

tx(tasks);

console.log(`Seeded ${tasks.length} tasks into tasks.db`);
db.close();
