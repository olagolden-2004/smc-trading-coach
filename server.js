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

setInterval(
  checkExpiredSlots,
  5 * 60 * 1000
);

checkExpiredSlots();

// ============================================
// FILE UPLOAD
// ============================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

// ============================================
// GEMINI HELPER
// ============================================

function extractGeminiText(data) {
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

  return text.trim();
}

// ============================================
// GEMINI TEST
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
          model: "gemini-3.6-flash",
          input:
            "Reply with exactly: GEMINI TEST SUCCESS"
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

    res.json({
      success: true,
      model: "gemini-3.6-flash",
      response: extractGeminiText(data),
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
// GEMINI IMAGE TEST
// ============================================

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

      res.json({
        success: true,
        model: "gemini-3.6-flash",
        analysis: extractGeminiText(data),
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
// SMC 4H ANALYSIS
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

      const prompt = `
You are the 4H Smart Money Concepts analysis engine.

Analyze ONLY the 4H timeframe.

Do not provide an entry.
Do not provide a trade signal.
Do not analyze 1H or 15M.

Use only information clearly visible.
Never invent prices or structures.

Return:

MARKET:
TIMEFRAME:
4H BIAS:
4H MARKET STRUCTURE:
4H LIQUIDITY:
4H PREMIUM / DISCOUNT:
4H KEY ZONES:
4H IMPORTANT LEVELS:
4H SMC CONCLUSION:
CONFIDENCE:

If evidence is insufficient, say:

INSUFFICIENT 4H EVIDENCE
`;

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
                text: prompt
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

      res.json({
        success: true,
        timeframe: "4H",
        model: "gemini-3.6-flash",
        analysis: extractGeminiText(data),
        interaction_id: data.id || null
      });

    } catch (error) {
      console.error(
        "4H analysis error:",
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
// SMC 1H ANALYSIS
// ============================================

app.post(
  "/smc-analysis-1h",
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
          error: "Please upload a 1H chart."
        });
      }

      const base64Image =
        req.file.buffer.toString("base64");

      const prompt = `
You are the 1H Smart Money Concepts confirmation engine.

Analyze ONLY the 1H timeframe.

Do not analyze 15M.
Do not create a trade entry.

Use only information clearly visible.

Return:

MARKET:
TIMEFRAME:
1H BIAS:
1H MARKET STRUCTURE:
1H LIQUIDITY:
1H LIQUIDITY SWEEP:
1H BOS / CHOCH CONFIRMATION:
1H DISPLACEMENT:
1H KEY ZONES:
1H PREMIUM / DISCOUNT:
1H IMPORTANT LEVELS:
1H SMC CONCLUSION:
CONFIDENCE:

If evidence is unclear, say:

INSUFFICIENT 1H EVIDENCE
`;

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
                text: prompt
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

      res.json({
        success: true,
        timeframe: "1H",
        model: "gemini-3.6-flash",
        analysis: extractGeminiText(data),
        interaction_id: data.id || null
      });

    } catch (error) {
      console.error(
        "1H analysis error:",
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
// SMC 15M ANALYSIS
// ============================================

app.post(
  "/smc-analysis-15m",
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
          error: "Please upload a 15M chart."
        });
      }

      const base64Image =
        req.file.buffer.toString("base64");

      const prompt = `
You are the 15M Smart Money Concepts entry-confirmation engine.

Analyze ONLY the 15M timeframe.

Determine whether a valid fresh entry confirmation exists.

Never force a trade.

A liquidity sweep alone is NOT enough.
A BOS/CHOCH alone is NOT enough.

Prefer:

Liquidity sweep
+
Displacement
+
Structural confirmation
+
Fresh retracement

Return:

MARKET:
TIMEFRAME:
15M BIAS:
15M MARKET STRUCTURE:
LIQUIDITY:
LIQUIDITY SWEEP:
CHOCH / BOS:
DISPLACEMENT:
FAIR VALUE GAP:
ORDER BLOCK:
RETRACEMENT:
ENTRY CONFIRMATION:
ENTRY AREA:
STOP LOSS AREA:
TAKE PROFIT / LIQUIDITY TARGET:
RISK WARNING:
15M CONCLUSION:
CONFIDENCE:

If confirmation is incomplete:

NO TRADE — WAIT FOR CONFIRMATION.

Never invent prices.
`;

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
                text: prompt
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

      res.json({
        success: true,
        timeframe: "15M",
        model: "gemini-3.6-flash",
        analysis: extractGeminiText(data),
        interaction_id: data.id || null
      });

    } catch (error) {
      console.error(
        "15M analysis error:",
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
// SMC TOP-DOWN DECISION ENGINE
// ============================================

app.post(
  "/smc-top-down",
  async (req, res) => {
    try {
      const apiKey =
        process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(500).json({
          success: false,
          error:
            "GEMINI_API_KEY is not configured."
        });
      }

      const {
        analysis_4h,
        analysis_1h,
        analysis_15m
      } = req.body;

      if (
        !analysis_4h ||
        !analysis_1h ||
        !analysis_15m
      ) {
        return res.status(400).json({
          success: false,
          error:
            "4H, 1H and 15M analyses are required."
        });
      }

      // ========================================
      // FINAL SMC PROMPT
      // ========================================

      const prompt = `
You are the FINAL SMC TOP-DOWN TRADING COACH.

You have received three completed analyses:

4H ANALYSIS:
${analysis_4h}

1H ANALYSIS:
${analysis_1h}

15M ANALYSIS:
${analysis_15m}

Analyze strictly in this order:

4H → 1H → 15M

The 4H establishes the higher-timeframe context.
The 1H confirms or challenges that context.
The 15M is used for entry confirmation only.

Never allow the 15M to override strong
higher-timeframe evidence.

========================================
TOP-DOWN ALIGNMENT
========================================

STRONG:
4H, 1H and 15M clearly support the same direction.

MODERATE:
4H is Ranging, Neutral, Sideways, or Consolidating,
while 1H and 15M clearly support the same direction.

WEAK:
There is some directional agreement, but important
confirmation is missing or unclear.

CONFLICTING:
The timeframes clearly point in opposite directions.

IMPORTANT:

A ranging, sideways, neutral, or consolidating 4H
is NOT automatically conflicting.

Examples:

4H Ranging + 1H Bearish + 15M Bearish
= MODERATE

4H Ranging + 1H Bullish + 15M Bullish
= MODERATE

4H Bullish + 1H Bearish + 15M Bearish
= CONFLICTING

4H Bearish + 1H Bullish + 15M Bullish
= CONFLICTING

========================================
4H CONTEXT
========================================

Determine:

- 4H bias
- 4H structure
- Major liquidity
- Premium / discount
- Supply
- Demand
- Important Order Blocks
- Important FVGs
- Major highs and lows

========================================
1H CONFIRMATION
========================================

Determine:

- 1H bias
- Market structure
- BOS / CHOCH
- Liquidity
- Liquidity sweep
- Displacement
- FVG
- Order Block
- Whether 1H agrees with 4H

========================================
15M ENTRY CONFIRMATION
========================================

Determine:

- 15M bias
- Market structure
- Liquidity sweep
- BOS / CHOCH
- Displacement
- FVG
- Order Block
- Retracement
- Whether a fresh entry exists

A liquidity sweep alone is NOT enough.

A BOS/CHOCH alone is NOT enough.

Prefer:

Liquidity sweep
+
Displacement
+
Structural confirmation
+
Fresh retracement

If the move has already happened and price
is extended, do NOT create an entry.

========================================
SETUP GRADING
========================================

A+:

Only when all major confirmations are present:

- Strong higher-timeframe context
- Valid 1H confirmation
- Clear liquidity sweep
- BOS/CHOCH
- Strong displacement
- Valid 15M confirmation
- Fresh retracement
- Clear invalidation
- Good risk/reward

A:

Strong setup with one minor imperfection.

B:

Potentially tradable, but one important
confirmation is weaker or incomplete.

C:

Weak setup with significant uncertainty,
missing confirmation, or poor location.

D:

Poor setup. Major confirmation is missing,
timeframes genuinely conflict, or entry is too extended.

IMPORTANT:

A+ must NOT be given if the 15M move is already
extended or there is no fresh retracement.

C or D should normally result in:

NO TRADE — WAIT FOR CONFIRMATION.

========================================
FINAL SIGNAL RULES
========================================

BUY only when:

- Higher-timeframe context supports the idea
- 1H confirmation is valid
- 15M provides valid entry confirmation
- The setup is not already extended
- Risk/reward is reasonable

SELL only under equivalent bearish conditions.

If timeframes genuinely conflict:

WAIT.

If 15M has already made the move:

WAIT.

If there is no fresh entry:

WAIT.

If evidence is incomplete:

WAIT.

Never force a trade.

========================================
TRADE PLAN
========================================

Only provide Entry, Stop Loss and Take Profit
when a valid fresh setup is confirmed.

If no valid setup exists:

Entry: N/A
Stop Loss: N/A
Take Profit: N/A
Risk/Reward: N/A

Never invent missing prices.

========================================
FINAL RESPONSE FORMAT
========================================

Return exactly:

MARKET:

4H BIAS:

4H STRUCTURE:

1H BIAS:

1H CONFIRMATION:

15M BIAS:

15M ENTRY CONFIRMATION:

TOP-DOWN ALIGNMENT:
Strong / Moderate / Weak / Conflicting

LIQUIDITY STORY:

STRUCTURE STORY:

ENTRY CONFIRMATION:
YES / NO

SETUP GRADE:
A+ / A / B / C / D

FINAL SIGNAL:
BUY / SELL / WAIT

ENTRY:

STOP LOSS:

TAKE PROFIT:

RISK/REWARD:

CONFIDENCE:
High / Medium / Low

FINAL DECISION:

TRADE REASONING:

INVALIDATION:

IMPORTANT:

If there is no valid fresh setup,
the FINAL DECISION must be:

NO TRADE — WAIT FOR CONFIRMATION

Never invent missing prices.
Never manufacture an entry.
Never force BUY or SELL.
`;

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
            input: prompt
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

      res.json({
        success: true,
        model: "gemini-3.6-flash",
        analysis: extractGeminiText(data),
        interaction_id: data.id || null
      });

    } catch (error) {
      console.error(
        "SMC top-down decision error:",
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
// COMPLETE SMC TRADING COACH
// 4H -> 1H -> 15M -> FINAL DECISION
// ============================================

app.post(
  "/smc-coach",
  upload.fields([
    {
      name: "chart_4h",
      maxCount: 1
    },
    {
      name: "chart_1h",
      maxCount: 1
    },
    {
      name: "chart_15m",
      maxCount: 1
    }
  ]),
  async (req, res) => {
    try {
      const apiKey =
        process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(500).json({
          success: false,
          error:
            "GEMINI_API_KEY is not configured."
        });
      }

      const chart4h =
        req.files?.chart_4h?.[0];

      const chart1h =
        req.files?.chart_1h?.[0];

      const chart15m =
        req.files?.chart_15m?.[0];

      if (
        !chart4h ||
        !chart1h ||
        !chart15m
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Please upload all three charts: 4H, 1H and 15M."
        });
      }

      const image4h =
        chart4h.buffer.toString("base64");

      const image1h =
        chart1h.buffer.toString("base64");

      const image15m =
        chart15m.buffer.toString("base64");

      const prompt = `
You are the SMC TRADING COACH.

Analyze these three charts in strict order:

4H -> 1H -> 15M

The 4H establishes the higher-timeframe context.
The 1H confirms or challenges that context.
The 15M is used only for entry confirmation.

Do not allow the 15M timeframe to override
strong conflicting higher-timeframe evidence.

Use only information clearly visible in the
three uploaded charts.

Do not invent prices, structure, liquidity,
FVGs, Order Blocks or trade setups.

========================================
4H ANALYSIS
========================================

Determine:

- Market
- Timeframe
- 4H bias
- 4H market structure
- Major liquidity
- Premium / Discount
- Major supply and demand
- Important Order Blocks
- Important FVGs
- Major highs and lows

========================================
1H ANALYSIS
========================================

Determine:

- 1H bias
- Market structure
- BOS / CHOCH
- Liquidity
- Liquidity sweep
- Displacement
- FVG
- Order Block
- Premium / Discount
- Whether 1H agrees with 4H

========================================
15M ANALYSIS
========================================

Determine:

- 15M bias
- Market structure
- Liquidity sweep
- BOS / CHOCH
- Displacement
- FVG
- Order Block
- Retracement
- Whether a fresh entry exists

IMPORTANT:

A liquidity sweep alone is NOT enough.

A BOS/CHOCH alone is NOT enough.

Prefer:

Liquidity sweep
+
Displacement
+
Structural confirmation
+
Fresh retracement

========================================
FINAL TOP-DOWN DECISION
========================================

Grade the setup:

A+ = Excellent alignment and confirmation.

A = Strong setup with minor imperfection.

B = Tradable but one important confirmation
is weaker.

C = Weak setup.

D = Poor setup.

A C or D setup should normally be WAIT.

BUY only when the higher-timeframe context,
1H confirmation and 15M entry confirmation
support the same direction.

SELL only under equivalent bearish conditions.

If the timeframes conflict:

WAIT.

If the 15M move has already happened:

WAIT.

If there is no fresh entry:

WAIT.

Never force a trade.

========================================
FINAL OUTPUT
========================================

Return exactly:

MARKET:

4H BIAS:

4H STRUCTURE:

1H BIAS:

1H CONFIRMATION:

15M BIAS:

15M ENTRY CONFIRMATION:

TOP-DOWN ALIGNMENT:
Strong / Moderate / Weak / Conflicting

LIQUIDITY STORY:

SETUP GRADE:
A+ / A / B / C / D

FINAL SIGNAL:
BUY / SELL / WAIT

ENTRY:

STOP LOSS:

TAKE PROFIT:

RISK/REWARD:

CONFIDENCE:
High / Medium / Low

FINAL DECISION:

TRADE REASONING:

INVALIDATION:

If there is no valid setup, the FINAL DECISION
must be:

NO TRADE — WAIT FOR CONFIRMATION

Never invent missing prices.

Never force BUY or SELL.

Only provide Entry, Stop Loss and Take Profit
when a fresh valid setup is actually confirmed.
`;

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
                type: "text",
                text: prompt
              },
              {
                type: "image",
                data: image4h,
                mime_type: chart4h.mimetype
              },
              {
                type: "image",
                data: image1h,
                mime_type: chart1h.mimetype
              },
              {
                type: "image",
                data: image15m,
                mime_type: chart15m.mimetype
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

      res.json({
        success: true,
        model: "gemini-3.6-flash",
        analysis: extractGeminiText(data),
        interaction_id: data.id || null
      });

    } catch (error) {
      console.error(
        "SMC Coach error:",
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

app.get("/health", async (req, res) => {
  try {
    const { error } =
      await supabaseAdmin
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

app.post(
  "/auth/signup",
  async (req, res) => {
    try {
      const {
        email,
        password,
        full_name
      } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          error:
            "Email and password are required."
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          error:
            "Password must be at least 6 characters."
        });
      }

      const {
        data,
        error
      } =
        await supabaseAdmin.auth.admin.createUser(
          {
            email,
            password,
            email_confirm: true,
            user_metadata: {
              full_name:
                full_name || ""
            }
          }
        );

      if (error) {
        return res.status(400).json({
          error: error.message
        });
      }

      await new Promise(
        resolve =>
          setTimeout(resolve, 300)
      );

      const {
        data: slotData,
        error: slotError
      } =
        await supabaseAdmin.rpc(
          "assign_analysis_slot",
          {
            p_user_id:
              data.user.id
          }
        );

      if (slotError) {
        console.error(
          "Slot assignment error:",
          slotError
        );

        return res.status(201).json({
          message:
            "Account created, but AI slot assignment is pending.",
          user: {
            id: data.user.id,
            email: data.user.email
          }
        });
      }

      res.status(201).json({
        message:
          "Account created successfully.",
        access: slotData,
        user: {
          id: data.user.id,
          email: data.user.email
        }
      });

    } catch (error) {
      console.error(
        "Signup error:",
        error
      );

      res.status(500).json({
        error: error.message
      });
    }
  }
);

// ============================================
// LOGIN
// ============================================

app.post(
  "/auth/login",
  async (req, res) => {
    try {
      const {
        email,
        password
      } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          error:
            "Email and password are required."
        });
      }

      const supabaseAuth =
        createClient(
          supabaseUrl,
          supabaseServiceRoleKey
        );

      const {
        data,
        error
      } =
        await supabaseAuth.auth
          .signInWithPassword({
            email,
            password
          });

      if (error) {
        return res.status(401).json({
          error:
            "Invalid email or password."
        });
      }

      res.json({
        message:
          "Login successful.",
        session:
          data.session,
        user:
          data.user
      });

    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

// ============================================
// ROOT
// ============================================

app.get("/", (req, res) => {
  res.json({
    message:
      "SMC Trading Coach AI is running",
    version: "1.0.0",
    status: "online"
  });
});

// ============================================
// START SERVER
// ============================================

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {
    console.log(
      `SMC Trading Coach AI running on port ${PORT}`
    );
  }
);
