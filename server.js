// -------------------------------------------------------------
// FindCare API  •  Custom Map JSON Feed for GoodBarber
// -------------------------------------------------------------
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const sql = require("mssql");

const app = express();
app.use(helmet());
app.use(cors({ origin: true })); // Restrict later if desired

// -------------------------------------------------------------
// Environment Variables (set locally or in Azure App Service)
// -------------------------------------------------------------
const {
  SQL_SERVER,
  SQL_DATABASE,
  SQL_USER,
  SQL_PASSWORD
} = process.env;

// -------------------------------------------------------------
// SQL Connection Configuration
// -------------------------------------------------------------
const sqlConfig = {
  user: SQL_USER,
  password: SQL_PASSWORD,
  server: SQL_SERVER,
  database: SQL_DATABASE,
  port: 1433,
  requestTimeout: 60000,      // 60-second query timeout
  connectionTimeout: 30000,   // 30-second connection timeout
  options: {
    encrypt: true,
    trustServerCertificate: false
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

const poolPromise = sql.connect(sqlConfig);

// -------------------------------------------------------------
// Helper Functions
// -------------------------------------------------------------
function isZip(s) {
  return /^\d{5}(-\d{4})?$/.test((s || "").trim());
}

function parseLocation(input) {
  if (!input) return {};
  const raw = input.trim();
  if (isZip(raw)) return { zip5: raw.slice(0, 5) };
  const [cityPart, statePart] = raw.split(",").map(s => (s || "").trim());
  const city = cityPart || null;
  const state = (statePart || "").toUpperCase().slice(0, 2) || null;
  return { city, state };
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// -------------------------------------------------------------
// Health Check Endpoint
// -------------------------------------------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------------------------------------------------
// Main /map_feed Endpoint
// -------------------------------------------------------------
app.get("/map_feed", async (req, res) => {
  try {
    const { q, category, location, limit = "20" } = req.query;
    const lim = Math.max(1, Math.min(parseInt(limit) || 20, 200)); // Enforce 1–200 rows
    const { zip5, city, state } = parseLocation(location);

    const pool = await poolPromise;
    const request = pool.request();

    request.input("limit", sql.Int, lim);
    request.input("category", sql.NVarChar(120), category || null);
    request.input("q", sql.NVarChar(200), q ? `%${q}%` : null);
    request.input("zip5", sql.VarChar(5), zip5 || null);
    request.input("city", sql.NVarChar(128), city || null);
    request.input("state", sql.VarChar(2), state || null);

    // ---------------------------------------------------------
    // Optimized SQL Query
    // ---------------------------------------------------------
    const result = await request.query(`
      SELECT TOP (@limit)
        Category,
        Provider_Organization_Name,
        Provider_Practice_City,
        Provider_Practice_State,
        Provider_Practice_Zip,
        Full_Address,
        Latitude,
        Longitude,
        Healthcare_Provider_Taxonomy_Code_1
      FROM dbo.Providers_Geocoded WITH (NOLOCK)
      WHERE Latitude IS NOT NULL AND Longitude IS NOT NULL
        AND (@category IS NULL OR Category = @category)
        AND (@q IS NULL OR Provider_Organization_Name LIKE @q)
        AND (@zip5 IS NULL OR LEFT(Provider_Practice_Zip, 5) = @zip5)
        AND (@city IS NULL OR Provider_Practice_City = @city)
        AND (@state IS NULL OR Provider_Practice_State = @state)
      ORDER BY Provider_Organization_Name ASC;
    `);

    // ---------------------------------------------------------
    // Format Output for GoodBarber Custom Map
    // ---------------------------------------------------------
    const items = (result.recordset || []).map((r, idx) => {
      const title = r.Provider_Organization_Name || "Unnamed Facility";
      const citySt = [r.Provider_Practice_City, r.Provider_Practice_State].filter(Boolean).join(", ");
      const summary = `${r.Category || "Healthcare Facility"}${citySt ? ` in ${citySt}` : ""}`;

      return {
        id: idx + 1,
        title: title,
        summary: summary,
        address: r.Full_Address || "",
        latitude: String(r.Latitude).trim(),
        longitude: String(r.Longitude).trim(),
        type: "maps",
        subtype: "custom",
        pinIconUrl: "https://fcare.io/files/findcare_map_icon_red.png",
        pinIconColor: "#0074D9",
        pinIconWidth: 150,
        pinIconHeight: 300,
        url: `https://findcare.dev/facility/${idx + 1}`,
        thumbnail: "https://findcare.dev/icons/default.png",
        smallThumbnail: "https://findcare.dev/icons/default.png",
        largeThumbnail: "https://findcare.dev/icons/default.png",
        content: `<div><strong>${esc(title)}</strong><br>${esc(r.Category || "")} - ${esc(citySt)}<br><a href="https://findcare.dev/facility/${idx + 1}" target="_blank">View Details</a></div>`
      };
    });

    res.json({
      items,
      next_page: null,
      generated_in: "0.01s",
      stat: "ok"
    });

  } catch (err) {
    console.error("❌ ERROR /map_feed:", err);
    res.status(500).json({
      stat: "error",
      message: err.message || "Internal server error"
    });
  }
});

// -------------------------------------------------------------
// Start Server
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ FindCare API listening on port ${PORT}`);
});
