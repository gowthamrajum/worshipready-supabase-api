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
  // Use SERVICE_ROLE so this backend can bypass RLS safely.
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

// Small helper to standardize Supabase error responses
function sbAssert(res, err) {
  if (err) {
    console.error("Supabase error:", err);
    res.status(500).send(err.message || "Database error");
    return false;
  }
  return true;
}

// -------------------------------
// ✅ Presentations API
// -------------------------------
app.post("/presentations", async (req, res) => {
  const { presentationName, createdDateTime } = req.body;
  if (!presentationName || !createdDateTime)
    return res.status(400).send("presentationName and createdDateTime required.");
  // We don't actually persist anything here (to match your existing behavior)
  res.status(201).send("Presentation initialized.");
});

app.post("/songs/bulk", async (req, res) => {
  try {
    // Accept either array body or { songs: [...] }
    const payload = Array.isArray(req.body) ? req.body : req.body?.songs;
    if (!Array.isArray(payload) || payload.length === 0) {
      return res.status(400).json({ error: "Body must be a non-empty array or { songs: [...] }" });
    }

    // Pull existing names once for similarity checks
    const { data: existing, error: fetchErr } = await supabase
      .from("songs")
      .select("song_id, song_name");
    if (fetchErr) return res.status(500).send(fetchErr.message);

    const existingNames = (existing || []).map(s => s.song_name);
    const acceptedNames = []; // names we will insert in this batch (to avoid dup inside payload)

    // helpers
    const asObj = (v) => (typeof v === "string" ? JSON.parse(v) : v);
    const isValid = (s) =>
      s &&
      (s.song_name || s.songName) &&
      (s.main_stanza || s.mainStanza) &&
      (s.stanzas);

    const results = [];
    const toInsert = [];

    for (let i = 0; i < payload.length; i++) {
      const raw = payload[i];

      // Map common aliases from your file to DB fields
      const song_name = raw.song_name || raw.songName;
      const main_stanza = raw.main_stanza ?? raw.mainStanza;
      const stanzas = raw.stanzas;

      if (!isValid({ song_name, main_stanza, stanzas })) {
        results.push({ index: i, song_name, status: "invalid", reason: "Missing fields" });
        continue;
      }

      // Similarity checks against DB
      const conflictExisting = existingNames.some((n) =>
        stringSimilarity.compareTwoStrings(song_name, n) >= 0.8
      );

      // …and within the current payload we’re accepting this run
      const conflictInPayload = acceptedNames.some((n) =>
        stringSimilarity.compareTwoStrings(song_name, n) >= 0.8
      );

      if (conflictExisting || conflictInPayload) {
        results.push({
          index: i,
          song_name,
          status: "skipped_conflict",
          conflictWith: conflictExisting ? "database" : "payload",
        });
        continue;
      }

      // Build row; keep meta when present
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

    // Insert in one or a few batches (keeps it simple)
    const BATCH = 500;
    let createdCount = 0;

    for (let off = 0; off < toInsert.length; off += BATCH) {
      const chunk = toInsert.slice(off, off + BATCH);
      const { data, error } = await supabase
        .from("songs")
        .insert(chunk.map(c => c.row))
        .select("song_id, song_name");

      if (error) {
        // mark every row in this chunk as failed
        chunk.forEach(c => {
          results.push({ index: c.index, song_name: c.row.song_name, status: "failed", reason: error.message });
        });
      } else {
        createdCount += data.length;
        // mark created rows
        // Note: order from PostgREST is typically input order for simple inserts
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

    // Also make sure any invalid/skipped rows that were pushed earlier are present.
    // (They already are; created rows appended above.)

    // Sort results back to original order by index for convenience
    results.sort((a, b) => a.index - b.index);

    const summary = {
      requested: payload.length,
      created: createdCount,
      skipped_conflict: results.filter(r => r.status === "skipped_conflict").length,
      invalid: results.filter(r => r.status === "invalid").length,
      failed: results.filter(r => r.status === "failed").length,
    };

    res.status(createdCount > 0 ? 201 : 200).json({ summary, results });
  } catch (e) {
    console.error("bulk songs error:", e);
    res.status(500).json({ error: e.message || "Bulk insert failed" });
  }
});

app.post("/presentations/slide", async (req, res) => {
  const { presentationName, slideOrder, slideData, randomId } = req.body;
  if (!presentationName || !slideData || !randomId)
    return res.status(400).send("presentationName, randomId and slideData are required.");

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

  if (!sbAssert(res, error)) return;
  res.status(201).send("Slide added.");
});

app.get("/presentations/older", async (req, res) => {
  const hours = parseInt(req.query.hours) || 48;
  const thresholdDate = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // Fetch all older rows, then group in Node (PostgREST doesn't do GROUP BY directly)
  const { data, error } = await supabase
    .from("presentations")
    .select("presentation_name, created_datetime")
    .lt("created_datetime", thresholdDate);

  if (!sbAssert(res, error)) return;

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

  res.json(result);
});

app.put("/presentations/slide", async (req, res) => {
  const { presentationName, randomId, slideData } = req.body;
  if (!presentationName || !randomId || !slideData)
    return res.status(400).send("presentationName, randomId and slideData are required.");

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("presentations")
    .update({
      slide_data: typeof slideData === "string" ? JSON.parse(slideData) : slideData,
      updated_datetime: now,
    })
    .eq("presentation_name", presentationName)
    .eq("random_id", randomId)
    .select("id"); // so we can see if any row changed

  if (!sbAssert(res, error)) return;
  if (!data || data.length === 0) return res.status(404).send("Slide not found.");
  res.send("Slide updated.");
});

app.get("/presentations/:name/slides", async (req, res) => {
  const { data, error } = await supabase
    .from("presentations")
    .select("random_id, slide_data, created_datetime")
    .eq("presentation_name", req.params.name)
    .order("created_datetime", { ascending: true });

  if (!sbAssert(res, error)) return;

  // Keep API shape close to original (slide_data as is; created_datetime already ISO)
  res.json(
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
    .eq("random_id", randomId);

  if (!sbAssert(res, error)) return;
  if (!data || data.length === 0) return res.status(404).send("Slide not found.");
  res.send(`Slide with ID "${randomId}" deleted.`);
});

app.get("/presentations", async (req, res) => {
  const { data, error } = await supabase
    .from("presentations")
    .select("presentation_name, created_datetime");

  if (!sbAssert(res, error)) return;

  const set = new Set((data || []).map((r) => r.presentation_name));
  res.json([...set].sort((a, b) => a.localeCompare(b)));
});

app.delete("/presentations/:presentationName", async (req, res) => {
  const { presentationName } = req.params;
  const { data, error } = await supabase
    .from("presentations")
    .delete()
    .eq("presentation_name", presentationName)
    .select("id");

  if (!sbAssert(res, error)) return;
  if (!data || data.length === 0)
    return res.status(404).send("No presentation found with that name.");
  res.send(`Deleted ${data.length} slide(s) from presentation "${presentationName}".`);
});

// -------------------------------
// ✅ Songs API
// -------------------------------
app.post("/songs", async (req, res) => {
  const { song_name, main_stanza, stanzas } = req.body;
  if (!song_name || !main_stanza || !stanzas)
    return res.status(400).send("Missing required fields");

  // Similarity check (pull names and compare)
  const { data: allSongs, error: fetchErr } = await supabase
    .from("songs")
    .select("song_id, song_name");

  if (!sbAssert(res, fetchErr)) return;

  const conflict = (allSongs || []).find(
    (song) => stringSimilarity.compareTwoStrings(song_name, song.song_name) >= 0.8
  );
  if (conflict) return res.status(409).send("A similar song already exists");

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

  if (!sbAssert(res, error)) return;
  res.json({ song_id: data.song_id });
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
      // last_updated_at is auto-bumped by trigger
    })
    .eq("song_id", req.params.id)
    .select("song_id");

  if (!sbAssert(res, error)) return;
  if (!data || data.length === 0) return res.status(404).send("Song not found");
  res.send("Song updated");
});

app.get("/songs", async (req, res) => {
  const {
    name,
    created_by,
    last_updated_by,
    created_from,
    created_to,
    updated_from,
    updated_to,
  } = req.query;

  let query = supabase.from("songs").select("*");

  if (name) query = query.ilike("song_name", `%${name}%`);
  if (created_by) query = query.eq("created_by", created_by);
  if (last_updated_by) query = query.eq("last_updated_by", last_updated_by);
  if (created_from) query = query.gte("created_at", created_from);
  if (created_to) query = query.lte("created_at", created_to);
  if (updated_from) query = query.gte("last_updated_at", updated_from);
  if (updated_to) query = query.lte("last_updated_at", updated_to);

  const { data, error } = await query;
  if (!sbAssert(res, error)) return;

  const mapped = (data || []).map((row) => ({
    song_id: row.song_id,
    song_name: row.song_name,
    main_stanza: row.main_stanza, // already JSON
    stanzas: row.stanzas,
    created_at: row.created_at,
    last_updated_at: row.last_updated_at,
    created_by: row.created_by,
    last_updated_by: row.last_updated_by,
  }));

  res.json(mapped);
});

app.get("/songs/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("songs")
    .select("*")
    .eq("song_id", req.params.id)
    .single();

  if (error && error.code === "PGRST116") // not found
    return res.status(404).send("Song not found");
  if (!sbAssert(res, error)) return;

  res.json({
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

  if (!sbAssert(res, error)) return;
  if (!data || data.length === 0) return res.status(404).send("Song not found.");
  res.send("Song deleted successfully.");
});

app.delete("/songs/by-name/:name", async (req, res) => {
  const name = req.params.name;
  const { data, error } = await supabase
    .from("songs")
    .delete()
    .filter("song_name", "ilike", name) // exact match case-insensitive
    .select("song_id");

  if (!sbAssert(res, error)) return;
  if (!data || data.length === 0) return res.status(404).send("No song found with that name.");
  res.send("Song(s) deleted successfully.");
});

// -------------------------------
// ✅ Psalms API
// -------------------------------
app.post("/psalms", async (req, res) => {
  const { chapter, verse, telugu, english } = req.body;
  if (!chapter || !verse || !telugu || !english)
    return res.status(400).send("All fields are required.");

  const { data, error } = await supabase
    .from("psalms")
    .insert([{ chapter, verse, telugu, english }])
    .select("id")
    .single();

  if (!sbAssert(res, error)) return;
  res.send({ id: data.id });
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

  if (!sbAssert(res, error)) return;
  res.json(data || []);
});

app.get("/psalms/:chapter/:verse", async (req, res) => {
  const { data, error } = await supabase
    .from("psalms")
    .select("*")
    .eq("chapter", req.params.chapter)
    .eq("verse", req.params.verse)
    .single();

  if (error && error.code === "PGRST116")
    return res.status(404).send("Verse not found.");
  if (!sbAssert(res, error)) return;
  res.json(data);
});

app.get("/psalms/:chapter", async (req, res) => {
  const { data, error } = await supabase
    .from("psalms")
    .select("*")
    .eq("chapter", req.params.chapter)
    .order("verse", { ascending: true });

  if (!sbAssert(res, error)) return;
  res.json(data || []);
});

app.put("/psalms/:id", async (req, res) => {
  const { chapter, verse, telugu, english } = req.body;
  const { data, error } = await supabase
    .from("psalms")
    .update({ chapter, verse, telugu, english })
    .eq("id", req.params.id)
    .select("id");

  if (!sbAssert(res, error)) return;
  if (!data || data.length === 0) return res.status(404).send("Psalm not found.");
  res.send("Psalm updated.");
});

app.delete("/psalms/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("psalms")
    .delete()
    .eq("id", req.params.id)
    .select("id");

  if (!sbAssert(res, error)) return;
  if (!data || data.length === 0) return res.status(404).send("Psalm not found.");
  res.send("Psalm deleted successfully.");
});

app.post("/psalms/bulk", async (req, res) => {
  const verses = req.body;
  if (!Array.isArray(verses) || verses.length === 0)
    return res.status(400).send("Must be a non-empty array of verses.");

  const rows = verses
    .filter(v => v && v.chapter && v.verse && v.telugu && v.english)
    .map(({ chapter, verse, telugu, english }) => ({ chapter, verse, telugu, english }));

  const { error } = await supabase.from("psalms").insert(rows);
  if (!sbAssert(res, error)) return;
  res.send("Psalms inserted successfully.");
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
    return console.error("❌ Error querying old presentation groups:", error.message);
  }

  // group by name, keep max(created_datetime)
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

  const { data: delData, error: delErr } = await supabase
    .from("presentations")
    .delete()
    .in("presentation_name", staleNames)
    .select("id");

  if (delErr) {
    console.error("❌ Deletion error:", delErr.message);
  } else {
    console.log(`🧹 Deleted ${delData?.length || 0} slide(s) from presentations:`, staleNames);
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
    scheduleRandomCleanup(); // reschedule next cleanup
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