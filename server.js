const express = require("express");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIG
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const SIGNAL_TIMEFRAME = "15m";
const ANALYSIS_TIMEFRAMES = ["4h", "1h", "15m"];

const ALLOWED_SYMBOLS = [
  "GBP/USD",
  "EUR/USD",
  "XAU/USD"
];

const TWELVE_DATA_INTERVALS = {
  "15m": "15min",
  "1h": "1h",
  "4h": "4h"
};

const CANDLE_LIMIT = 300;

// ============================================================
// BASIC APP SETUP
// ============================================================

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static("public"));

// ============================================================
// SUPABASE
// ============================================================

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables."
  );
  process.exit(1);
}

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// SIGNAL STATE
// ============================================================

const signalState = {
  running: false,
  lastRun: null,
  lastSignal: null,
  lastError: null,
  candlesLoaded: false,
  provider: "Twelve Data"
};

// ============================================================
// HELPERS
// ============================================================

function normalizeCandle(candle) {
  if (!candle || typeof candle !== "object") {
    return null;
  }

  const time =
    candle.datetime ??
    candle.time ??
    candle.timestamp ??
    candle.t;

  const open = Number(candle.open ?? candle.o);
  const high = Number(candle.high ?? candle.h);
  const low = Number(candle.low ?? candle.l);
  const close = Number(candle.close ?? candle.c);

  if (
    time === undefined ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close
  };
}

function validateCandles(candles) {
  if (!Array.isArray(candles)) {
    return {
      valid: false,
      reason: "Candles must be an array."
    };
  }

  if (candles.length < 20) {
    return {
      valid: false,
      reason: `Not enough candles. Received ${candles.length}, minimum is 20.`
    };
  }

  for (let i = 0; i < candles.length; i++) {
    const c = normalizeCandle(candles[i]);

    if (!c) {
      return {
        valid: false,
        reason: `Invalid candle at index ${i}.`
      };
    }

    if (c.high < c.low) {
      return {
        valid: false,
        reason: `Invalid candle at index ${i}: high is below low.`
      };
    }

    if (c.high < c.open || c.high < c.close) {
      return {
        valid: false,
        reason: `Invalid candle at index ${i}: high is below open/close.`
      };
    }

    if (c.low > c.open || c.low > c.close) {
      return {
        valid: false,
        reason: `Invalid candle at index ${i}: low is above open/close.`
      };
    }
  }

  return {
    valid: true,
    reason: "Candles are valid."
  };
}

function normalizeSymbol(symbol) {
  if (!symbol) {
    return null;
  }

  const normalized = String(symbol)
    .trim()
    .toUpperCase()
    .replace("-", "/")
    .replace(" ", "");

  const aliases = {
    GBPUSD: "GBP/USD",
    EURUSD: "EUR/USD",
    XAUUSD: "XAU/USD"
  };

  return aliases[normalized] || normalized;
}

function normalizeTimeframe(timeframe) {
  if (!timeframe) {
    return null;
  }

  const value = String(timeframe).trim().toLowerCase();

  const aliases = {
    "15": "15m",
    "15m": "15m",
    "15min": "15m",

    "1h": "1h",
    "1hour": "1h",
    "60m": "1h",

    "4h": "4h",
    "4hour": "4h",
    "240m": "4h"
  };

  return aliases[value] || null;
}

// ============================================================
// TWELVE DATA
// ============================================================

async function fetchTwelveDataCandles(symbol, timeframe, outputsize = CANDLE_LIMIT) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing from environment variables."
    );
  }

  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedTimeframe = normalizeTimeframe(timeframe);

  if (!ALLOWED_SYMBOLS.includes(normalizedSymbol)) {
    throw new Error(
      `Symbol ${normalizedSymbol} is not enabled. Allowed symbols: ${ALLOWED_SYMBOLS.join(
        ", "
      )}`
    );
  }

  if (!normalizedTimeframe) {
    throw new Error(
      "Unsupported timeframe. Use 15m, 1h, or 4h."
    );
  }

  const interval = TWELVE_DATA_INTERVALS[normalizedTimeframe];

  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", normalizedSymbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("order", "asc");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP error: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(
      data.message || "Twelve Data returned an API error."
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      "Twelve Data response did not contain candle values."
    );
  }

  const candles = data.values
    .map(normalizeCandle)
    .filter(Boolean);

  const validation = validateCandles(candles);

  if (!validation.valid) {
    throw new Error(
      `Invalid Twelve Data candles: ${validation.reason}`
    );
  }

  return {
    symbol: normalizedSymbol,
    timeframe: normalizedTimeframe,
    provider: "Twelve Data",
    candles,
    count: candles.length,
    latest: candles[candles.length - 1],
    meta: data.meta || null
  };
}

// ============================================================
// FETCH ALL 3 SMC TIMEFRAMES
// ============================================================

async function loadAnalysisCandles(symbol) {
  const result = {
    symbol,
    "4h": null,
    "1h": null,
    "15m": null
  };

  for (const timeframe of ANALYSIS_TIMEFRAMES) {
    result[timeframe] = await fetchTwelveDataCandles(
      symbol,
      timeframe,
      CANDLE_LIMIT
    );
  }

  return result;
}

// ============================================================
// HEALTH
// ============================================================

app.get("/health", async (req, res) => {
  let supabaseStatus = "unknown";

  try {
    const { error } = await supabaseAdmin
      .from("analysis_slots")
      .select("id")
      .limit(1);

    supabaseStatus = error ? "error" : "ok";
  } catch (error) {
    supabaseStatus = "error";
  }

  res.json({
    status: "online",
    version: "2.1.0",
    marketData: TWELVE_DATA_API_KEY
      ? "configured"
      : "missing_api_key",
    provider: "Twelve Data",
    supabase: supabaseStatus,
    timeframes: ANALYSIS_TIMEFRAMES,
    symbols: ALLOWED_SYMBOLS
  });
});

// ============================================================
// SIGNAL STATUS
// ============================================================

app.get("/api/signal/status", (req, res) => {
  res.json({
    success: true,
    ...signalState
  });
});

// ============================================================
// MARKET DATA STATUS
// ============================================================

app.get("/api/market-data/status", (req, res) => {
  res.json({
    success: true,
    provider: "Twelve Data",
    apiKeyConfigured: Boolean(TWELVE_DATA_API_KEY),
    symbols: ALLOWED_SYMBOLS,
    timeframes: ANALYSIS_TIMEFRAMES
  });
});

// ============================================================
// TEST ONE MARKET DATA REQUEST
// ============================================================

app.get("/api/market-data/candles", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    const timeframe = normalizeTimeframe(req.query.timeframe);

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: "Missing symbol."
      });
    }

    if (!timeframe) {
      return res.status(400).json({
        success: false,
        error: "Missing or invalid timeframe. Use 15m, 1h, or 4h."
      });
    }

    const result = await fetchTwelveDataCandles(
      symbol,
      timeframe,
      CANDLE_LIMIT
    );

    signalState.candlesLoaded = true;
    signalState.lastError = null;

    res.json({
      success: true,
      provider: result.provider,
      symbol: result.symbol,
      timeframe: result.timeframe,
      count: result.count,
      latest: result.latest,
      candles: result.candles
    });

  } catch (error) {
    signalState.lastError = error.message;

    console.error("Market data error:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// TEST ALL 3 TIMEFRAMES FOR ONE SYMBOL
// ============================================================

app.get("/api/market-data/all", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: "Missing symbol."
      });
    }

    const result = await loadAnalysisCandles(symbol);

    signalState.candlesLoaded = true;
    signalState.lastError = null;

    res.json({
      success: true,
      provider: "Twelve Data",
      symbol,
      timeframes: {
        "4h": {
          count: result["4h"].count,
          latest: result["4h"].latest
        },
        "1h": {
          count: result["1h"].count,
          latest: result["1h"].latest
        },
        "15m": {
          count: result["15m"].count,
          latest: result["15m"].latest
        }
      }
    });

  } catch (error) {
    signalState.lastError = error.message;

    console.error("All timeframe market data error:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// SMC ENGINE PLACEHOLDER
// ============================================================

async function runAutomaticSignalAnalysis(symbol) {
  const market = await loadAnalysisCandles(symbol);

  /*
    IMPORTANT:

    This section is intentionally NOT pretending to generate
    BUY/SELL signals yet.

    The next stage will analyze:

    4H:
      - Higher-timeframe structure
      - Liquidity
      - Premium / discount
      - Bias

    1H:
      - Structure confirmation
      - BOS / CHOCH
      - Liquidity sweep
      - Displacement
      - Key zones

    15M:
      - Liquidity sweep
      - BOS / CHOCH
      - Displacement
      - FVG
      - Order block
      - Fresh retracement
      - Entry confirmation

    Final:
      BUY
      SELL
      NO SIGNAL

    We do NOT want fake signals while the engine is unfinished.
  */

  return {
    symbol,
    decision: "NO SIGNAL",
    reason: "Market data connected. SMC signal engine is the next stage.",
    marketData: {
      provider: "Twelve Data",
      "4h": market["4h"].count,
      "1h": market["1h"].count,
      "15m": market["15m"].count
    },
    latest: {
      "4h": market["4h"].latest,
      "1h": market["1h"].latest,
      "15m": market["15m"].latest
    }
  };
}

// ============================================================
// MANUAL SIGNAL ENGINE TEST
// ============================================================

app.post("/api/signal/run", async (req, res) => {
  if (signalState.running) {
    return res.status(409).json({
      success: false,
      error: "Signal analysis is already running."
    });
  }

  const symbol = normalizeSymbol(
    req.body?.symbol || "GBP/USD"
  );

  if (!ALLOWED_SYMBOLS.includes(symbol)) {
    return res.status(400).json({
      success: false,
      error: `Unsupported symbol. Use one of: ${ALLOWED_SYMBOLS.join(", ")}`
    });
  }

  signalState.running = true;
  signalState.lastRun = new Date().toISOString();
  signalState.lastError = null;

  try {
    const result = await runAutomaticSignalAnalysis(symbol);

    signalState.lastSignal = result.decision;

    res.json({
      success: true,
      result
    });

  } catch (error) {
    signalState.lastError = error.message;

    console.error("Signal analysis error:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  } finally {
    signalState.running = false;
  }
});

// ============================================================
// AUTOMATIC MONITOR
// ============================================================

const AUTO_MONITOR_ENABLED =
  String(process.env.AUTO_MONITOR_ENABLED || "false").toLowerCase() ===
  "true";

const AUTO_MONITOR_INTERVAL =
  Number(process.env.AUTO_MONITOR_INTERVAL_MS) || 60 * 1000;

const AUTO_SYMBOLS = ALLOWED_SYMBOLS;

async function automaticMonitor() {
  if (signalState.running) {
    return;
  }

  for (const symbol of AUTO_SYMBOLS) {
    try {
      console.log(
        `[AUTO MONITOR] Checking ${symbol}...`
      );

      signalState.running = true;
      signalState.lastRun = new Date().toISOString();

      const result = await runAutomaticSignalAnalysis(symbol);

      signalState.lastSignal = result.decision;
      signalState.lastError = null;

      console.log(
        `[AUTO MONITOR] ${symbol}: ${result.decision}`
      );

    } catch (error) {
      signalState.lastError = error.message;

      console.error(
        `[AUTO MONITOR] ${symbol} error:`,
        error.message
      );

    } finally {
      signalState.running = false;
    }
  }
}

if (AUTO_MONITOR_ENABLED) {
  console.log(
    `Automatic monitor enabled. Interval: ${AUTO_MONITOR_INTERVAL}ms`
  );

  setInterval(
    automaticMonitor,
    AUTO_MONITOR_INTERVAL
  );
} else {
  console.log(
    "Automatic monitor disabled. Set AUTO_MONITOR_ENABLED=true to enable it."
  );
}

// ============================================================
// SUPABASE SLOT ROTATION
// ============================================================

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
      "Slot rotation exception:",
      error.message
    );
  }
}

setInterval(
  checkExpiredSlots,
  5 * 60 * 1000
);

checkExpiredSlots();

// ============================================================
// AUTH
// ============================================================

app.post("/auth/signup", async (req, res) => {
  try {
    const {
      email,
      password
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required."
      });
    }

    const {
      data,
      error
    } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    try {
      await supabaseAdmin.rpc(
        "assign_analysis_slot",
        {
          target_user_id: data.user.id
        }
      );
    } catch (slotError) {
      console.error(
        "Slot assignment error:",
        slotError.message
      );
    }

    res.json({
      success: true,
      message: "Account created successfully.",
      user: {
        id: data.user.id,
        email: data.user.email
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const {
      email,
      password
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required."
      });
    }

    const {
      data,
      error
    } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      return res.status(401).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      session: data.session,
      user: data.user
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  res.json({
    message: "SMC Trading Coach AI is running",
    version: "2.1.0",
    status: "online",
    marketData: "Twelve Data connected",
    symbols: ALLOWED_SYMBOLS,
    analysisTimeframes: ANALYSIS_TIMEFRAMES
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(
    `SMC Trading Coach AI running on port ${PORT}`
  );

  console.log(
    `Twelve Data API key configured: ${Boolean(
      TWELVE_DATA_API_KEY
    )}`
  );

  console.log(
    `Supported symbols: ${ALLOWED_SYMBOLS.join(", ")}`
  );

  console.log(
    `Analysis timeframes: ${ANALYSIS_TIMEFRAMES.join(", ")}`
  );
});
