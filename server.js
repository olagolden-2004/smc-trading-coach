const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
require("dotenv").config();

const app = express();

app.use(express.json());
app.use(express.static("public"));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error(
    "ERROR: Supabase environment variables are missing."
  );
  process.exit(1);
}

const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceRoleKey
);

// ============================================
// AUTOMATIC SLOT ROTATION
// ============================================

async function checkExpiredSlots() {
  try {
    const { error } = await supabaseAdmin.rpc(
      "rotate_expired_slots"
    );

    if (error) {
      console.error(
        "Slot rotation error:",
        error.message
      );
    }
  } catch (error) {
    console.error(
      "Slot rotation error:",
      error.message
    );
  }
}

// Check expired slots every 5 minutes
setInterval(
  checkExpiredSlots,
  5 * 60 * 1000
);

// Check once when the server starts
checkExpiredSlots();
// ============================================
// GEMINI FREE API TEST - INTERACTIONS API
// ============================================

app.get("/gemini-test", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: "GEMINI_API_KEY is not configured."
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          model: "gemini-3.5-flash-lite",
          input: "Reply with exactly: GEMINI TEST SUCCESS"
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: data
      });
    }

    let text = "";

    if (Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (
          step.type === "model_output" &&
          Array.isArray(step.content)
        ) {
          for (const content of step.content) {
            if (content.type === "text") {
              text += content.text;
            }
          }
        }
      }
    }

    res.json({
      success: true,
      model: "gemini-2.5-flash-lite",
      response: text.trim(),
      interaction_id: data.id || null
    });

  } catch (error) {
    console.error("Gemini test error:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ============================================
// GEMINI CHART IMAGE TEST
// ============================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

app.post(
  "/gemini-image-test",
  upload.single("chart"),
  async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(500).json({
          success: false,
          error: "GEMINI_API_KEY is not configured."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Please upload a chart image."
        });
      }

      const base64Image =
        req.file.buffer.toString("base64");

      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            model: "gemini-3.6-flash",
            input: [
              {
                type: "image",
                data: base64Image,
                mime_type: req.file.mimetype
              },
              {
                type: "text",
                text:
                  "Look at this trading chart. Describe only what you can clearly see. Identify the market, timeframe, current price if visible, and general price direction. Do not give a trade signal."
              }
            ]
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          error: data
        });
      }

      let text = "";

      if (Array.isArray(data.steps)) {
        for (const step of data.steps) {
          if (
            step.type === "model_output" &&
            Array.isArray(step.content)
          ) {
            for (const content of step.content) {
              if (content.type === "text") {
                text += content.text;
              }
            }
          }
        }
      }

      res.json({
        success: true,
        model: "gemini-3.6-flash",
        analysis: text.trim(),
        interaction_id: data.id || null
      });

    } catch (error) {
      console.error(
        "Gemini image test error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);
// ============================================
// SMC 4H ANALYSIS ENGINE
// ============================================

app.post(
  "/smc-analysis-4h",
  upload.single("chart"),
  async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(500).json({
          success: false,
          error: "GEMINI_API_KEY is not configured."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Please upload a 4H chart."
        });
      }

      const base64Image =
        req.file.buffer.toString("base64");

      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            model: "gemini-3.6-flash",
            input: [
              {
                type: "image",
                data: base64Image,
                mime_type: req.file.mimetype
              },
              {
                type: "text",
                text: `
You are the 4H Smart Money Concepts (SMC) analysis engine.

Analyze ONLY the 4H timeframe shown in the uploaded chart.

Do NOT provide an entry.
Do NOT provide a trade signal.
Do NOT analyze 1H or 15M.

Use only information that is clearly visible on the chart.
Never invent prices or structures that cannot be confirmed.

Return the analysis using exactly this structure:

MARKET:
Identify the instrument if visible.

TIMEFRAME:
Confirm the chart timeframe.

4H BIAS:
Bullish / Bearish / Neutral

4H MARKET STRUCTURE:
Explain the visible higher highs, higher lows,
lower highs, lower lows, BOS or CHOCH.

4H LIQUIDITY:
Identify major visible buy-side and sell-side liquidity.

4H PREMIUM / DISCOUNT:
Explain whether current price is in premium,
discount, or equilibrium relative to the visible
dealing range.

4H KEY ZONES:
Identify important visible:
- Supply
- Demand
- Order Blocks
- Fair Value Gaps

4H IMPORTANT LEVELS:
List important visible highs, lows and liquidity levels.

4H SMC CONCLUSION:
Give a short explanation of the dominant 4H context.

CONFIDENCE:
High / Medium / Low

IMPORTANT RULE:
If the chart does not provide enough visual evidence,
say "INSUFFICIENT 4H EVIDENCE" instead of guessing.
`
              }
            ]
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          error: data
        });
      }

      let text = "";

      if (Array.isArray(data.steps)) {
        for (const step of data.steps) {
          if (
            step.type === "model_output" &&
            Array.isArray(step.content)
          ) {
            for (const content of step.content) {
              if (content.type === "text") {
                text += content.text;
              }
            }
          }
        }
      }

      res.json({
        success: true,
        timeframe: "4H",
        model: "gemini-3.6-flash",
        analysis: text.trim(),
        interaction_id: data.id || null
      });

    } catch (error) {
      console.error(
        "4H SMC analysis error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);
// ============================================
// HEALTH CHECK
// ============================================

app.get("/", (req, res) => {
  res.json({
    message: "SMC Trading Coach AI is running",
    version: "1.0.0",
    status: "online"
  });
});

app.get("/health", async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from("analysis_slots")
      .select("id")
      .limit(1);

    if (error) {
      return res.status(500).json({
        status: "error",
        message: error.message
      });
    }

    res.json({
      status: "healthy",
      database: "connected"
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// ============================================
// SIGN UP
// ============================================

app.post("/auth/signup", async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters."
      });
    }

    const { data, error } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: full_name || ""
        }
      });

    if (error) {
      return res.status(400).json({
        error: error.message
      });
    }

    // Give the database trigger time to create the profile
    await new Promise(resolve => setTimeout(resolve, 300));

    // Automatically assign one of the four AI analysis slots
    const { data: slotData, error: slotError } =
      await supabaseAdmin.rpc(
        "assign_analysis_slot",
        {
          p_user_id: data.user.id
        }
      );

    if (slotError) {
      console.error("Slot assignment error:", slotError);

      return res.status(201).json({
        message: "Account created, but AI slot assignment is pending.",
        user: {
          id: data.user.id,
          email: data.user.email
        }
      });
    }

    res.status(201).json({
      message: "Account created successfully.",
      access: slotData,
      user: {
        id: data.user.id,
        email: data.user.email
      }
    });

  } catch (error) {
    console.error("Signup error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

// ============================================
// LOGIN
// ============================================

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required."
      });
    }

    const supabaseAuth = createClient(
      supabaseUrl,
      supabaseAdmin.auth
        ? process.env.SUPABASE_SERVICE_ROLE_KEY
        : process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data, error } =
      await supabaseAuth.auth.signInWithPassword({
        email,
        password
      });

    if (error) {
      return res.status(401).json({
        error: "Invalid email or password."
      });
    }

    res.json({
      message: "Login successful.",
      session: data.session,
      user: data.user
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`SMC Trading Coach AI running on port ${PORT}`);
});
