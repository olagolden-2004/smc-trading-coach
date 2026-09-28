const express = require("express");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));


// ============================================================
// ENVIRONMENT
// ============================================================

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
  );

  process.exit(1);
}


const supabaseAdmin =
  createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  );


// ============================================================
// CONFIGURATION
// ============================================================

const PORT =
  process.env.PORT || 3000;


// Automatic signal system settings.
//
// These can later be moved entirely into environment
// variables when we connect the live market-data provider.

const SIGNAL_TIMEFRAME = "15m";

const ANALYSIS_TIMEFRAMES = [
  "4h",
  "1h",
  "15m"
];


// ============================================================
// SYSTEM STATE
// ============================================================

const signalState = {
  running: false,
  lastRun: null,
  lastSignal: null,
  lastError: null,
  candlesLoaded: false
};


// ============================================================
// HELPER
// ============================================================

function safeNumber(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", async (req, res) => {

  try {

    const { error } =
      await supabaseAdmin
        .from("analysis_slots")
        .select("*")
        .limit(1);

    if (error) {
      return res.status(500).json({
        status: "error",
        supabase: false,
        signalSystem: signalState
      });
    }

    res.json({
      status: "online",
      supabase: true,
      signalSystem: {
        running: signalState.running,
        lastRun: signalState.lastRun,
        lastSignal: signalState.lastSignal,
        lastError: signalState.lastError,
        candlesLoaded: signalState.candlesLoaded
      }
    });

  } catch (error) {

    res.status(500).json({
      status: "error",
      message: error.message
    });

  }

});


// ============================================================
// SIGNAL SYSTEM STATUS
// ============================================================

app.get("/api/signal/status", (req, res) => {

  res.json({
    success: true,

    system: {
      running: signalState.running,
      lastRun: signalState.lastRun,
      lastSignal: signalState.lastSignal,
      lastError: signalState.lastError,
      candlesLoaded: signalState.candlesLoaded
    },

    analysis: {
      timeframes: ANALYSIS_TIMEFRAMES,
      signalTimeframe: SIGNAL_TIMEFRAME
    }
  });

});


// ============================================================
// MARKET DATA PLACEHOLDER
// ============================================================
//
// This endpoint is intentionally prepared first.
//
// We will connect the real live candle provider in the next
// step. The automatic SMC engine must never invent candles.
//
// ============================================================

app.get("/api/market-data/status", (req, res) => {

  res.json({

    success: true,

    provider:
      process.env.MARKET_DATA_PROVIDER || "not-connected",

    live:
      false,

    message:
      "Live market data provider has not been connected yet."

  });

});


// ============================================================
// CANDLE DATA NORMALIZER
// ============================================================
//
// The automatic SMC engine will eventually receive candles
// in this common format:
//
// {
//   time,
//   open,
//   high,
//   low,
//   close
// }
//
// Keeping one format makes it possible to change the market
// data provider later without rewriting the SMC engine.
//

function normalizeCandle(candle) {

  if (!candle) {
    return null;
  }

  const time =
    candle.time ??
    candle.timestamp ??
    candle.t ??
    null;

  const open =
    safeNumber(
      candle.open ??
      candle.o
    );

  const high =
    safeNumber(
      candle.high ??
      candle.h
    );

  const low =
    safeNumber(
      candle.low ??
      candle.l
    );

  const close =
    safeNumber(
      candle.close ??
      candle.c
    );


  if (
    time === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null
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


// ============================================================
// SMC CANDLE VALIDATION
// ============================================================

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
      reason:
        "Not enough candles for SMC analysis."
    };
  }


  for (const candle of candles) {

    if (
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close)
    ) {

      return {
        valid: false,
        reason:
          "Invalid candle price detected."
      };

    }


    if (
      candle.high < candle.low ||
      candle.high < candle.open ||
      candle.high < candle.close ||
      candle.low > candle.open ||
      candle.low > candle.close
    ) {

      return {
        valid: false,
        reason:
          "Invalid OHLC candle detected."
      };

    }

  }


  return {
    valid: true,
    reason: null
  };

}


// ============================================================
// TEST CANDLE ENDPOINT
// ============================================================
//
// This lets us verify the candle-processing layer before
// connecting the live provider.
//

app.post("/api/market-data/test", (req, res) => {

  try {

    const rawCandles =
      req.body?.candles;


    if (!Array.isArray(rawCandles)) {

      return res.status(400).json({

        success: false,

        error:
          "Request must contain a candles array."

      });

    }


    const candles =
      rawCandles
        .map(normalizeCandle)
        .filter(Boolean);


    const validation =
      validateCandles(candles);


    if (!validation.valid) {

      return res.status(400).json({

        success: false,

        error: validation.reason,

        candleCount: candles.length

      });

    }


    signalState.candlesLoaded = true;


    res.json({

      success: true,

      candleCount: candles.length,

      firstCandle:
        candles[0],

      lastCandle:
        candles[candles.length - 1],

      message:
        "Candle data accepted successfully."

    });

  } catch (error) {

    res.status(500).json({

      success: false,

      error: error.message

    });

  }

});


// ============================================================
// AUTOMATIC SIGNAL ENGINE PLACEHOLDER
// ============================================================
//
// IMPORTANT:
// We are NOT generating BUY or SELL yet.
//
// The system must first receive real market candles.
// Once the live provider is connected, this function will:
//
// 1. Load 4H candles
// 2. Load 1H candles
// 3. Load 15M candles
// 4. Calculate market structure
// 5. Detect liquidity
// 6. Detect BOS / CHOCH
// 7. Detect displacement
// 8. Detect FVG / order blocks
// 9. Confirm top-down alignment
// 10. Produce BUY / SELL / NO SIGNAL
// 11. Prevent duplicate signals
// 12. Send qualifying signals to Telegram
//

async function runAutomaticSignalAnalysis() {

  signalState.running = true;
  signalState.lastRun =
    new Date().toISOString();

  signalState.lastError = null;


  try {

    console.log(
      "[SIGNAL ENGINE] Analysis cycle started."
    );


    // Live market-data connection will be added next.

    signalState.candlesLoaded = false;


    console.log(
      "[SIGNAL ENGINE] Waiting for live market data provider."
    );


    return {
      signal: "NO SIGNAL",
      reason:
        "Live market data provider is not connected."
    };

  } catch (error) {

    signalState.lastError =
      error.message;

    console.error(
      "[SIGNAL ENGINE ERROR]",
      error
    );

    return {
      signal: "NO SIGNAL",
      reason: error.message
    };

  } finally {

    signalState.running = false;

  }

}


// ============================================================
// MANUAL ENGINE TEST ENDPOINT
// ============================================================

app.post(
  "/api/signal/run",
  async (req, res) => {

    try {

      const result =
        await runAutomaticSignalAnalysis();


      signalState.lastSignal =
        result.signal;


      res.json({

        success: true,

        result

      });

    } catch (error) {

      res.status(500).json({

        success: false,

        error: error.message

      });

    }

  }
);


// ============================================================
// AUTOMATIC MONITOR LOOP
// ============================================================
//
// We keep this disabled until live market data is connected.
// This prevents the application from pretending that it is
// monitoring a real market when it is not.
//

const AUTO_MONITOR_ENABLED =
  process.env.AUTO_MONITOR_ENABLED === "true";


if (AUTO_MONITOR_ENABLED) {

  console.log(
    "[SIGNAL ENGINE] Automatic monitoring enabled."
  );


  setInterval(
    async () => {

      await runAutomaticSignalAnalysis();

    },
    60 * 1000
  );

} else {

  console.log(
    "[SIGNAL ENGINE] Automatic monitoring is currently disabled."
  );

}


// ============================================================
// SUPABASE SLOT ROTATION
// ============================================================

async function checkExpiredSlots() {

  try {

    const { error } =
      await supabaseAdmin.rpc(
        "rotate_expired_slots"
      );


    if (error) {

      console.error(
        "Slot rotation error:",
        error.message
      );

      return;

    }


    console.log(
      "Expired analysis slots checked."
    );

  } catch (error) {

    console.error(
      "Slot rotation failed:",
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
// AUTH — SIGNUP
// ============================================================

app.post(
  "/auth/signup",
  async (req, res) => {

    try {

      const {
        full_name,
        email,
        password
      } = req.body;


      if (
        !email ||
        !password
      ) {

        return res.status(400).json({

          error:
            "Email and password are required."

        });

      }


      if (password.length < 6) {

        return res.status(400).json({

          error:
            "Password must contain at least 6 characters."

        });

      }


      const {
        data,
        error
      } =
        await supabaseAdmin.auth.admin.createUser({

          email,
          password,

          email_confirm: true,

          user_metadata: {
            full_name:
              full_name || ""
          }

        });


      if (error) {

        return res.status(400).json({

          error:
            error.message

        });

      }


      // Preserve the existing slot system.

      try {

        await supabaseAdmin.rpc(
          "assign_analysis_slot",
          {
            user_id_input:
              data.user.id
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

        user: {
          id: data.user.id,
          email: data.user.email
        }

      });

    } catch (error) {

      res.status(500).json({

        error:
          error.message

      });

    }

  }
);


// ============================================================
// AUTH — LOGIN
// ============================================================

app.post(
  "/auth/login",
  async (req, res) => {

    try {

      const {
        email,
        password
      } = req.body;


      if (
        !email ||
        !password
      ) {

        return res.status(400).json({

          error:
            "Email and password are required."

        });

      }


      const {
        data,
        error
      } =
        await supabaseAdmin.auth.signInWithPassword({

          email,
          password

        });


      if (error) {

        return res.status(401).json({

          error:
            error.message

        });

      }


      res.json({

        success: true,

        user: {

          id:
            data.user.id,

          email:
            data.user.email

        },

        session: data.session

      });

    } catch (error) {

      res.status(500).json({

        error:
          error.message

      });

    }

  }
);


// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {

  res.json({

    message:
      "SMC Trading Signal System is running.",

    version:
      "2.0.0",

    status:
      "online",

    signalSystem:
      "prepared",

    marketData:
      "not-connected"

  });

});


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      `SMC Trading Signal System running on port ${PORT}`
    );

  }
);
