// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const stringSimilarity = require("string-similarity");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ---------- Supabase ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ---------- Middlewares ----------
app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        "https://worshipready.onrender.com",
        "https://grey-gratis-ice.onrender.com",
      ];
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("❌ CORS blocked:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);
app.options("*", cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use((req, res, next) => (req.method === "OPTIONS" ? res.sendStatus(204) : next()));

// ---------- Helpers ----------
function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

function sbAssert(res, err) {
  if (err) {
    console.error("Supabase error:", err);
    return jsonError(res, 500, err.message || "Database error");
  }
  return true;
}

// -------------------------------
// ✅ Presentations API
// -------------------------------
app.post("/presentations", async (req, res) => {
  const { presentationName, createdDateTime } = req.body;
  if (!presentationName || !createdDateTime)
    return jsonError(res, 400, "presentationName and createdDateTime required.");
  // parity with original behavior: no DB write here
  return res.status(201).json({ message: "Presentation initialized." });
});

app.post("/presentations/slide", async (req, res) => {
  const { presentationName, slideOrder, slideData, randomId } = req.body;
  if (!presentationName || !slideData || !randomId)
    return jsonError(res, 400, "presentationName, randomId and slideData are required.");

  const now = new Date().toISOString();

  const { error } = await supabase.from("presentations").insert([
    {
      random_id: randomId,
      presentation_name: presentationName,
      slide_order: slideOrder ?? null,
      slide_data: typeof slideData === "string" ? JSON.parse(slideData) : slideData,
      created_datetime: now,
      updated_datetime: now,
    },
  ]);

  if (sbAssert(res, error) !== true) return;
  return res.status(201).json({ message: "Slide added." });
});

app.get("/presentations/older", async (req, res) => {
  const hours = parseInt(req.query.hours) || 48;
  const thresholdDate = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("presentations")
    .select("presentation_name, created_datetime")
    .lt("created_datetime", thresholdDate);

  if (sbAssert(res, error) !== true) return;

  const grouped = {};
  for (const row of data || []) {
    const name = row.presentation_name;
    const created = row.created_datetime;
    if (!grouped[name] || new Date(created) < new Date(grouped[name])) {
      grouped[name] = created;
    }
  }

  const result = Object.entries(grouped)
    .map(([presentationName, createdDateTime]) => ({ presentationName, createdDateTime }))
    .sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime));

  return res.json(result);
});

app.put("/presentations/slide", async (req, res) => {
  const { presentationName, randomId, slideData } = req.body;
  if (!presentationName || !randomId || !slideData)
    return jsonError(res, 400, "presentationName, randomId and slideData are required.");

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("presentations")
    .update({
      slide_data: typeof slideData === "string" ? JSON.parse(slideData) : slideData,
      updated_datetime: now,
    })
    .eq("presentation_name", presentationName)
    .eq("random_id", randomId)
    .select("id");

  if (sbAssert(res, error) !== true) return;
  if (!data || data.length === 0) return jsonError(res, 404, "Slide not found.");
  return res.json({ message: "Slide updated." });
});

app.get("/presentations/:name/slides", async (req, res) => {
  const { data, error } = await supabase
    .from("presentations")
    .select("random_id, slide_data, created_datetime")
    .eq("presentation_name", req.params.name)
    .order("created_datetime", { ascending: true });

  if (sbAssert(res, error) !== true) return;

  return res.json(
    (data || []).map((r) => ({
      randomId: r.random_id,
      slideData: r.slide_data,
      createdDateTime: r.created_datetime,
    }))
  );
});

app.delete("/presentations/slide/:presentationName/:randomId", async (req, res) => {
  const { presentationName, randomId } = req.params;
  const { data, error } = await supabase
    .from("presentations")
    .delete()
    .eq("presentation_name", presentationName)
    .eq("random_id", randomId)
    .select("id");

  if (sbAssert(res, error) !== true) return;
  if (!data || data.length === 0) return jsonError(res, 404, "Slide not found.");
  return res.json({ message: `Slide with ID "${randomId}" deleted.` });
});

app.get("/presentations", async (req, res) => {
  const { data, error } = await supabase
    .from("presentations")
    .select("presentation_name, created_datetime");

  if (sbAssert(res, error) !== true) return;

  const set = new Set((data || []).map((r) => r.presentation_name));
  return res.json([...set].sort((a, b) => a.localeCompare(b)));
});

app.delete("/presentations/:presentationName", async (req, res) => {
  const { presentationName } = req.params;
  const { data, error } = await supabase
    .from("presentations")
    .delete()
    .eq("presentation_name", presentationName)
    .select("id");

  if (sbAssert(res, error) !== true) return;
  if (!data || data.length === 0)
    return jsonError(res, 404, "No presentation found with that name.");
  return res.json({
    message: `Deleted ${data.length} slide(s) from presentation "${presentationName}".`,
  });
});

// -------------------------------
/* ✅ Songs API
   Bulk endpoint defaults to NO similarity (imports everything).
   You can toggle with:
   - allowSimilar=true  (default)  -> no similarity checks (import all)
   - allowSimilar=false & similarity=0.8 (or 0..1) to enable checks
*/
app.post("/songs/bulk", async (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body : req.body?.songs;
    if (!Array.isArray(payload) || payload.length === 0) {
      return jsonError(res, 400, "Body must be a non-empty array or { songs: [...] }");
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("songs")
      .select("song_id, song_name");
    if (fetchErr) return sbAssert(res, fetchErr);

    const existingNames = (existing || []).map((s) => s.song_name);
    const acceptedNames = [];

    const asObj = (v) => (typeof v === "string" ? JSON.parse(v) : v);

    // Controls — defaults import everything (no similarity)
    const allowSimilar = (req.query.allowSimilar ?? "true") === "true"; // default true
    const similarity = Math.max(0, Math.min(1, parseFloat(req.query.similarity ?? "0.8")));

    const results = [];
    const toInsert = [];

    for (let i = 0; i < payload.length; i++) {
      const raw = payload[i];
      const song_name = raw.song_name || raw.songName;
      const main_stanza = raw.main_stanza ?? raw.mainStanza;
      const stanzas = raw.stanzas;

      if (!song_name || !main_stanza || !stanzas) {
        results.push({ index: i, song_name, status: "invalid", reason: "Missing fields" });
        continue;
      }

      let blockedBySimilarity = false;
      if (!allowSimilar) {
        const conflictExisting = existingNames.some(
          (n) => stringSimilarity.compareTwoStrings(song_name, n) >= similarity
        );
        const conflictInPayload = acceptedNames.some(
          (n) => stringSimilarity.compareTwoStrings(song_name, n) >= similarity
        );
        blockedBySimilarity = conflictExisting || conflictInPayload;
      }

      if (blockedBySimilarity) {
        results.push({
          index: i,
          song_name,
          status: "skipped_conflict",
          conflictWith: "similarity",
          similarityThreshold: similarity,
        });
        continue;
      }

      const row = {
        song_name,
        main_stanza: asObj(main_stanza),
        stanzas: asObj(stanzas),
        created_at: raw.created_at || new Date().toISOString(),
        last_updated_at: raw.last_updated_at || new Date().toISOString(),
        created_by: raw.created_by || "System",
        last_updated_by: raw.last_updated_by || "",
      };

      toInsert.push({ index: i, row });
      acceptedNames.push(song_name);
    }

    const BATCH = 500;
    let createdCount = 0;

    for (let off = 0; off < toInsert.length; off += BATCH) {
      const chunk = toInsert.slice(off, off + BATCH);
      const { data, error } = await supabase
        .from("songs")
        .insert(chunk.map((c) => c.row))
        .select("song_id, song_name");

      if (error) {
        chunk.forEach((c) => {
          results.push({
            index: c.index,
            song_name: c.row.song_name,
            status: "failed",
            reason: error.message,
          });
        });
      } else {
        createdCount += data.length;
        for (let k = 0; k < data.length; k++) {
          const c = chunk[k];
          const d = data[k];
          results.push({
            index: c.index,
            song_name: d.song_name,
            status: "created",
            song_id: d.song_id,
          });
        }
      }
    }

    results.sort((a, b) => a.index - b.index);

    const summary = {
      requested: payload.length,
      created: createdCount,
      skipped_conflict: results.filter((r) => r.status === "skipped_conflict").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      failed: results.filter((r) => r.status === "failed").length,
    };

    // If anything failed/invalid/skipped, still return 201 if some created; otherwise 200.
    const status = createdCount > 0 ? 201 : 200;
    return res.status(status).json({ summary, results });
  } catch (e) {
    console.error("bulk songs error:", e);
    return jsonError(res, 500, e.message || "Bulk insert failed");
  }
});

app.post("/songs", async (req, res) => {
  const { song_name, main_stanza, stanzas } = req.body;
  if (!song_name || !main_stanza || !stanzas)
    return jsonError(res, 400, "Missing required fields");

  // Keep similarity check for single insert (can adjust if desired)
  const { data: allSongs, error: fetchErr } = await supabase
    .from("songs")
    .select("song_id, song_name");
  if (sbAssert(res, fetchErr) !== true) return;

  const conflict = (allSongs || []).find(
    (song) => stringSimilarity.compareTwoStrings(song_name, song.song_name) >= 0.8
  );
  if (conflict) return jsonError(res, 409, "A similar song already exists");

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("songs")
    .insert([
      {
        song_name,
        main_stanza: typeof main_stanza === "string" ? JSON.parse(main_stanza) : main_stanza,
        stanzas: typeof stanzas === "string" ? JSON.parse(stanzas) : stanzas,
        created_at: now,
        last_updated_at: now,
        created_by: "System",
        last_updated_by: "",
      },
    ])
    .select("song_id")
    .single();

  if (sbAssert(res, error) !== true) return;
  return res.status(201).json({ song_id: data.song_id });
});

app.put("/songs/:id", async (req, res) => {
  const { song_name, main_stanza, stanzas, last_updated_by } = req.body;
  const updatedBy = last_updated_by || "System";

  const { data, error } = await supabase
    .from("songs")
    .update({
      song_name,
      main_stanza: typeof main_stanza === "string" ? JSON.parse(main_stanza) : main_stanza,
      stanzas: typeof stanzas === "string" ? JSON.parse(stanzas) : stanzas,
      last_updated_by: updatedBy,
    })
    .eq("song_id", req.params.id)
    .select("song_id");

  if (sbAssert(res, error) !== true) return;
  if (!data || data.length === 0) return jsonError(res, 404, "Song not found");
  return res.json({ message: "Song updated" });
});

// PAGINATED: avoid the ~1000 row cap
app.get("/songs", async (req, res) => {
  const {
    name,
    created_by,
    last_updated_by,
    created_from,
    created_to,
    updated_from,
    updated_to,
    limit,
    offset,
  } = req.query;

  const pageSize = Math.min(parseInt(limit ?? "1000"), 5000);
  const pageOffset = Math.max(parseInt(offset ?? "0"), 0);

  let query = supabase.from("songs").select("*", { count: "exact" });

  if (name) query = query.ilike("song_name", `%${name}%`);
  if (created_by) query = query.eq("created_by", created_by);
  if (last_updated_by) query = query.eq("last_updated_by", last_updated_by);
  if (created_from) query = query.gte("created_at", created_from);
  if (created_to) query = query.lte("created_at", created_to);
  if (updated_from) query = query.gte("last_updated_at", updated_from);
  if (updated_to) query = query.lte("last_updated_at", updated_to);

  const { data, error, count } = await query
    .range(pageOffset, pageOffset + pageSize - 1)
    .order("song_id", { ascending: true });

  if (sbAssert(res, error) !== true) return;

  const mapped = (data || []).map((row) => ({
    song_id: row.song_id,
    song_name: row.song_name,
    main_stanza: row.main_stanza,
    stanzas: row.stanzas,
    created_at: row.created_at,
    last_updated_at: row.last_updated_at,
    created_by: row.created_by,
    last_updated_by: row.last_updated_by,
  }));

  return res.json({
    total: count ?? mapped.length,
    limit: pageSize,
    offset: pageOffset,
    data: mapped,
  });
});

app.get("/songs/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("songs")
    .select("*")
    .eq("song_id", req.params.id)
    .single();

  if (error && error.code === "PGRST116") return jsonError(res, 404, "Song not found");
  if (sbAssert(res, error) !== true) return;

  return res.json({
    song_id: data.song_id,
    song_name: data.song_name,
    main_stanza: data.main_stanza,
    stanzas: data.stanzas,
    created_at: data.created_at,
    last_updated_at: data.last_updated_at,
    created_by: data.created_by,
    last_updated_by: data.last_updated_by,
  });
});

app.delete("/songs/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("songs")
    .delete()
    .eq("song_id", req.params.id)
    .select("song_id");

  if (sbAssert(res, error) !== true) return;
  if (!data || data.length === 0) return jsonError(res, 404, "Song not found.");
  return res.json({ message: "Song deleted successfully." });
});

app.delete("/songs/by-name/:name", async (req, res) => {
  const name = req.params.name;
  const { data, error } = await supabase
    .from("songs")
    .delete()
    .filter("song_name", "ilike", name) // exact match, case-insensitive
    .select("song_id");

  if (sbAssert(res, error) !== true) return;
  if (!data || data.length === 0) return jsonError(res, 404, "No song found with that name.");
  return res.json({ message: "Song(s) deleted successfully." });
});

// -------------------------------
// ✅ Psalms API
// -------------------------------
app.post("/psalms", async (req, res) => {
  const { chapter, verse, telugu, english } = req.body;
  if (!chapter || !verse || !telugu || !english)
    return jsonError(res, 400, "All fields are required.");

  const { data, error } = await supabase
    .from("psalms")
    .insert([{ chapter, verse, telugu, english }])
    .select("id")
    .single();

  if (sbAssert(res, error) !== true) return;
  return res.status(201).json({ id: data.id });
});

app.get("/psalms/:chapter/range", async (req, res) => {
  const { start, end } = req.query;
  const { data, error } = await supabase
    .from("psalms")
    .select("*")
    .eq("chapter", req.params.chapter)
    .gte("verse", start)
    .lte("verse", end)
    .order("verse", { ascending: true });

  if (sbAssert(res, error) !== true) return;
  return res.json(data || []);
});

app.get("/psalms/:chapter/:verse", async (req, res) => {
  const { data, error } = await supabase
    .from("psalms")
    .select("*")
    .eq("chapter", req.params.chapter)
    .eq("verse", req.params.verse)
    .single();

  if (error && error.code === "PGRST116")
    return jsonError(res, 404, "Verse not found.");
  if (sbAssert(res, error) !== true) return;
  return res.json(data);
});

app.get("/psalms/:chapter", async (req, res) => {
  const { data, error } = await supabase
    .from("psalms")
    .select("*")
    .eq("chapter", req.params.chapter)
    .order("verse", { ascending: true });

  if (sbAssert(res, error) !== true) return;
  return res.json(data || []);
});

app.put("/psalms/:id", async (req, res) => {
  const { chapter, verse, telugu, english } = req.body;
  const { data, error } = await supabase
    .from("psalms")
    .update({ chapter, verse, telugu, english })
    .eq("id", req.params.id)
    .select("id");

  if (sbAssert(res, error) !== true) return;
  if (!data || data.length === 0) return jsonError(res, 404, "Psalm not found.");
  return res.json({ message: "Psalm updated." });
});

app.delete("/psalms/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("psalms")
    .delete()
    .eq("id", req.params.id)
    .select("id");

  if (sbAssert(res, error) !== true) return;
  if (!data || data.length === 0) return jsonError(res, 404, "Psalm not found.");
  return res.json({ message: "Psalm deleted successfully." });
});

app.post("/psalms/bulk", async (req, res) => {
  const verses = req.body;
  if (!Array.isArray(verses) || verses.length === 0)
    return jsonError(res, 400, "Must be a non-empty array of verses.");

  const rows = verses
    .filter((v) => v && v.chapter && v.verse && v.telugu && v.english)
    .map(({ chapter, verse, telugu, english }) => ({ chapter, verse, telugu, english }));

  const { error } = await supabase.from("psalms").insert(rows);
  if (sbAssert(res, error) !== true) return;
  return res.status(201).json({ message: "Psalms inserted successfully.", inserted: rows.length });
});

// -------------------------------
// ✅ Health Check
// -------------------------------
app.get("/ping", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// -------------------------------
// 🧹 Cleanup: delete presentation groups with no new slides in last 48h
// -------------------------------
async function deleteOldPresentationsCompletely() {
  const twoDaysAgoISO = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("presentations")
    .select("presentation_name, created_datetime")
    .lt("created_datetime", twoDaysAgoISO);

  if (error) {
    console.error("❌ Error querying old presentation groups:", error.message);
    return;
  }

  const groups = new Map();
  for (const r of data || []) {
    const k = r.presentation_name;
    const cur = groups.get(k);
    if (!cur || new Date(r.created_datetime) > new Date(cur)) {
      groups.set(k, r.created_datetime);
    }
  }

  const staleNames = [...groups.entries()]
    .filter(([, maxCreated]) => new Date(maxCreated) < new Date(twoDaysAgoISO))
    .map(([name]) => name);

  if (staleNames.length === 0) {
    console.log("🧼 No stale presentations to delete.");
    return;
  }

  const del = await supabase
    .from("presentations")
    .delete()
    .in("presentation_name", staleNames)
    .select("id");

  if (del.error) {
    console.error("❌ Deletion error:", del.error.message);
  } else {
    console.log(`🧹 Deleted ${del.data?.length || 0} slide(s) from presentations:`, staleNames);
  }
}

function scheduleRandomCleanup() {
  const randomHour = Math.floor(Math.random() * 24);
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setDate(now.getDate() + 1);
  nextRun.setHours(randomHour, 0, 0, 0);

  const delay = nextRun - now;
  console.log(`⏰ Next cleanup scheduled at ${nextRun.toLocaleString()}`);
  setTimeout(async () => {
    await deleteOldPresentationsCompletely();
    scheduleRandomCleanup();
  }, delay);
}

// Run once on startup and schedule
deleteOldPresentationsCompletely();
scheduleRandomCleanup();

// -------------------------------
// ✅ Start Server
// -------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});