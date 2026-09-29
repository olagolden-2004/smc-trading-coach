const express = require("express");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIG
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const TWELVE_DATA_API_KEY =
  process.env.TWELVE_DATA_API_KEY;

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
// APP
// ============================================================

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ============================================================
// SUPABASE
// ============================================================

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY."
  );
  process.exit(1);
}

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// STATE
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
// GENERAL HELPERS
// ============================================================

function normalizeSymbol(symbol) {
  if (!symbol) return null;

  const value = String(symbol)
    .trim()
    .toUpperCase()
    .replace("-", "/")
    .replace(" ", "");

  const aliases = {
    GBPUSD: "GBP/USD",
    EURUSD: "EUR/USD",
    XAUUSD: "XAU/USD"
  };

  return aliases[value] || value;
}

function normalizeTimeframe(timeframe) {
  if (!timeframe) return null;

  const value = String(timeframe)
    .trim()
    .toLowerCase();

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

  if (candles.length < 50) {
    return {
      valid: false,
      reason:
        `Not enough candles. Received ${candles.length}; minimum is 50.`
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
        reason: `Invalid candle ${i}: high below low.`
      };
    }

    if (c.high < c.open || c.high < c.close) {
      return {
        valid: false,
        reason: `Invalid candle ${i}: high below open/close.`
      };
    }

    if (c.low > c.open || c.low > c.close) {
      return {
        valid: false,
        reason: `Invalid candle ${i}: low above open/close.`
      };
    }
  }

  return {
    valid: true,
    reason: "Candles are valid."
  };
}

// ============================================================
// TWELVE DATA
// ============================================================

async function fetchTwelveDataCandles(
  symbol,
  timeframe,
  outputsize = CANDLE_LIMIT
) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing."
    );
  }

  const normalizedSymbol =
    normalizeSymbol(symbol);

  const normalizedTimeframe =
    normalizeTimeframe(timeframe);

  if (!ALLOWED_SYMBOLS.includes(normalizedSymbol)) {
    throw new Error(
      `Unsupported symbol: ${normalizedSymbol}`
    );
  }

  if (!normalizedTimeframe) {
    throw new Error(
      "Unsupported timeframe. Use 15m, 1h or 4h."
    );
  }

  const interval =
    TWELVE_DATA_INTERVALS[normalizedTimeframe];

  const url = new URL(
    "https://api.twelvedata.com/time_series"
  );

  url.searchParams.set(
    "symbol",
    normalizedSymbol
  );

  url.searchParams.set(
    "interval",
    interval
  );

  url.searchParams.set(
    "outputsize",
    String(outputsize)
  );

  url.searchParams.set(
    "order",
    "asc"
  );

  url.searchParams.set(
    "timezone",
    "UTC"
  );

  url.searchParams.set(
    "apikey",
    TWELVE_DATA_API_KEY
  );

  const response =
    await fetch(url.toString());

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP error: ${response.status}`
    );
  }

  const data =
    await response.json();

  if (data.status === "error") {
    throw new Error(
      data.message ||
      "Twelve Data API error."
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      "Twelve Data returned no candle values."
    );
  }

  const candles =
    data.values
      .map(normalizeCandle)
      .filter(Boolean);

  const validation =
    validateCandles(candles);

  if (!validation.valid) {
    throw new Error(
      validation.reason
    );
  }

  return candles;
}

function getTimeframeMinutes(timeframe) {
  if (timeframe === "15m") return 15;
  if (timeframe === "1h") return 60;
  if (timeframe === "4h") return 240;

  return 0;
}

function filterClosedCandles(candles, timeframe) {
  const minutes = getTimeframeMinutes(timeframe);

  if (!minutes || !Array.isArray(candles)) {
    return candles;
  }

  const now = Date.now();

  return candles.filter(candle => {
    const candleTime = new Date(candle.time).getTime();

    if (!Number.isFinite(candleTime)) {
      return false;
    }

    const candleEnd =
      candleTime + minutes * 60 * 1000;

    return candleEnd <= now;
  });
}

async function loadMarket(symbol) {
  const result = {};

  for (const timeframe of ANALYSIS_TIMEFRAMES) {
    const candles =
      await fetchTwelveDataCandles(
        symbol,
        timeframe,
        CANDLE_LIMIT
      );

    const closedCandles =
      filterClosedCandles(
        candles,
        timeframe
      );

    if (closedCandles.length < 50) {
      throw new Error(
        `${symbol} ${timeframe}: not enough closed candles after filtering.`
      );
    }

    result[timeframe] =
      closedCandles;
  }

  return result;
        }

// ============================================================
// SMC MATH HELPERS
// ============================================================

function averageRange(candles, length = 20) {
  const start =
    Math.max(0, candles.length - length);

  let total = 0;
  let count = 0;

  for (let i = start; i < candles.length; i++) {
    total +=
      candles[i].high -
      candles[i].low;

    count++;
  }

  return count ? total / count : 0;
}

function candleBody(c) {
  return Math.abs(c.close - c.open);
}

function candleRange(c) {
  return c.high - c.low;
}

function isBullish(c) {
  return c.close > c.open;
}

function isBearish(c) {
  return c.close < c.open;
}

function midpoint(high, low) {
  return low + (high - low) / 2;
}

// ============================================================
// SWING DETECTION
// ============================================================

function findSwingHighs(candles, strength = 3) {
  const swings = [];

  for (
    let i = strength;
    i < candles.length - strength;
    i++
  ) {
    const current = candles[i];

    let valid = true;

    for (
      let j = 1;
      j <= strength;
      j++
    ) {
      if (
        current.high <= candles[i - j].high ||
        current.high <= candles[i + j].high
      ) {
        valid = false;
        break;
      }
    }

    if (valid) {
      swings.push({
        index: i,
        price: current.high,
        time: current.time
      });
    }
  }

  return swings;
}

function findSwingLows(candles, strength = 3) {
  const swings = [];

  for (
    let i = strength;
    i < candles.length - strength;
    i++
  ) {
    const current = candles[i];

    let valid = true;

    for (
      let j = 1;
      j <= strength;
      j++
    ) {
      if (
        current.low >= candles[i - j].low ||
        current.low >= candles[i + j].low
      ) {
        valid = false;
        break;
      }
    }

    if (valid) {
      swings.push({
        index: i,
        price: current.low,
        time: current.time
      });
    }
  }

  return swings;
}

// ============================================================
// MARKET STRUCTURE
// ============================================================

function analyzeStructure(candles) {
  const highs =
    findSwingHighs(candles, 3);

  const lows =
    findSwingLows(candles, 3);

  const recentHighs =
    highs.slice(-4);

  const recentLows =
    lows.slice(-4);

  let bias = "NEUTRAL";

  if (
    recentHighs.length >= 2 &&
    recentLows.length >= 2
  ) {
    const h1 =
      recentHighs[recentHighs.length - 2];

    const h2 =
      recentHighs[recentHighs.length - 1];

    const l1 =
      recentLows[recentLows.length - 2];

    const l2 =
      recentLows[recentLows.length - 1];

    const bullishStructure =
      h2.price > h1.price &&
      l2.price > l1.price;

    const bearishStructure =
      h2.price < h1.price &&
      l2.price < l1.price;

    if (bullishStructure) {
      bias = "BULLISH";
    } else if (bearishStructure) {
      bias = "BEARISH";
    }
  }

  const latest =
    candles[candles.length - 1];

  const previousHigh =
    highs.length
      ? highs[highs.length - 1]
      : null;

  const previousLow =
    lows.length
      ? lows[lows.length - 1]
      : null;

  let bos = null;
  let choch = null;

  if (
    previousHigh &&
    latest.close > previousHigh.price
  ) {
    bos = "BULLISH";
  }

  if (
    previousLow &&
    latest.close < previousLow.price
  ) {
    bos = "BEARISH";
  }

  if (bos === "BULLISH" && bias === "BEARISH") {
    choch = "BULLISH";
  }

  if (bos === "BEARISH" && bias === "BULLISH") {
    choch = "BEARISH";
  }

  return {
    bias,
    bos,
    choch,
    swingHighs: highs,
    swingLows: lows,
    latestHigh:
      previousHigh
        ? previousHigh.price
        : null,
    latestLow:
      previousLow
        ? previousLow.price
        : null
  };
}
// ============================================================
// PART 2 — SMC ENGINE + SIGNAL FILTER + API + AUTO MONITOR
// ============================================================

// LIQUIDITY SWEEP
function detectLiquiditySweep(candles) {
  if (!Array.isArray(candles) || candles.length < 20) {
    return {
      detected: false,
      direction: null,
      index: null,
      time: null,
      level: null
    };
  }

  const startIndex = Math.max(10, candles.length - 20);

  for (let i = candles.length - 1; i >= startIndex; i--) {
    const candle = candles[i];

    const previousCandles = candles.slice(0, i);

    const swingHighs = findSwingHighs(previousCandles, 3);
    const swingLows = findSwingLows(previousCandles, 3);

    const recentHigh =
      swingHighs.length > 0
        ? swingHighs[swingHighs.length - 1]
        : null;

    const recentLow =
      swingLows.length > 0
        ? swingLows[swingLows.length - 1]
        : null;

    // Bullish liquidity sweep:
    // price takes a previous low but closes back above it.
    if (
      recentLow &&
      candle.low < recentLow.price &&
      candle.close > recentLow.price
    ) {
      return {
        detected: true,
        direction: "BULLISH",
        index: i,
        time: candle.time,
        level: recentLow.price
      };
    }

    // Bearish liquidity sweep:
    // price takes a previous high but closes back below it.
    if (
      recentHigh &&
      candle.high > recentHigh.price &&
      candle.close < recentHigh.price
    ) {
      return {
        detected: true,
        direction: "BEARISH",
        index: i,
        time: candle.time,
        level: recentHigh.price
      };
    }
  }

  return {
    detected: false,
    direction: null,
    index: null,
    time: null,
    level: null
  };
}

// DISPLACEMENT
function detectDisplacement(candles) {
  if (!Array.isArray(candles) || candles.length < 20) {
    return {
      detected: false,
      direction: null,
      index: null,
      time: null,
      strength: 0
    };
  }

  const startIndex = Math.max(5, candles.length - 12);

  for (let i = candles.length - 1; i >= startIndex; i--) {
    const candle = candles[i];

    const previous = candles.slice(
      Math.max(0, i - 10),
      i
    );

    if (previous.length < 5) {
      continue;
    }

    const averageRange =
      previous.reduce(
        (sum, item) => sum + candleRange(item),
        0
      ) / previous.length;

    const range = candleRange(candle);
    const body = candleBody(candle);

    if (averageRange <= 0) {
      continue;
    }

    const bodyRatio = body / range;

    // Strong bullish displacement
    if (
      isBullish(candle) &&
      range >= averageRange * 1.5 &&
      bodyRatio >= 0.65
    ) {
      return {
        detected: true,
        direction: "BULLISH",
        index: i,
        time: candle.time,
        strength: Number(
          (range / averageRange).toFixed(2)
        )
      };
    }

    // Strong bearish displacement
    if (
      isBearish(candle) &&
      range >= averageRange * 1.5 &&
      bodyRatio >= 0.65
    ) {
      return {
        detected: true,
        direction: "BEARISH",
        index: i,
        time: candle.time,
        strength: Number(
          (range / averageRange).toFixed(2)
        )
      };
    }
  }

  return {
    detected: false,
    direction: null,
    index: null,
    time: null,
    strength: 0
  };
}

// ORDER BLOCK APPROXIMATION
function findOrderBlock(candles, direction) {
  if (candles.length < 10) {
    return null;
  }

  const displacementIndex =
    candles.length - 1;

  const searchStart =
    Math.max(
      0,
      displacementIndex - 8
    );

  for (
    let i = displacementIndex - 1;
    i >= searchStart;
    i--
  ) {
    const c = candles[i];

    if (
      direction === "BULLISH" &&
      isBearish(c)
    ) {
      return {
        index: i,
        time: c.time,
        high: c.high,
        low: c.low,
        midpoint: midpoint(
          c.high,
          c.low
        )
      };
    }

    if (
      direction === "BEARISH" &&
      isBullish(c)
    ) {
      return {
        index: i,
        time: c.time,
        high: c.high,
        low: c.low,
        midpoint: midpoint(
          c.high,
          c.low
        )
      };
    }
  }

  return null;
}

// PREMIUM / DISCOUNT
function calculatePremiumDiscount(
  candles,
  structure
) {
  const latest =
    candles[candles.length - 1];

  const high =
    structure.latestHigh;

  const low =
    structure.latestLow;

  if (
    high === null ||
    low === null ||
    high <= low
  ) {
    return {
      zone: "UNKNOWN",
      midpoint: null
    };
  }

  const mid =
    midpoint(high, low);

  let zone = "EQUILIBRIUM";

  if (latest.close > mid) {
    zone = "PREMIUM";
  }

  if (latest.close < mid) {
    zone = "DISCOUNT";
  }

  return {
    zone,
    midpoint: mid
  };
}

// TIMEFRAME ANALYSIS
function analyzeTimeframe(
  candles,
  timeframe
) {
  const structure =
    analyzeStructure(candles);

  const sweep =
    detectLiquiditySweep(
      candles,
      structure
    );

  const displacement =
    detectDisplacement(candles);

  const premiumDiscount =
    calculatePremiumDiscount(
      candles,
      structure
    );

  const bullishOrderBlock =
    findOrderBlock(
      candles,
      "BULLISH"
    );

  const bearishOrderBlock =
    findOrderBlock(
      candles,
      "BEARISH"
    );

  let direction = "NEUTRAL";

  if (
    structure.bias === "BULLISH"
  ) {
    direction = "BULLISH";
  }

  if (
    structure.bias === "BEARISH"
  ) {
    direction = "BEARISH";
  }

  return {
    timeframe,
    direction,
    structure,
    sweep,
    displacement,
    premiumDiscount,
    orderBlocks: {
      bullish: bullishOrderBlock,
      bearish: bearishOrderBlock
    },
    latest:
      candles[candles.length - 1]
  };
}

// ============================================================
// TOP-DOWN SMC DECISION
// ============================================================

function buildSMCDecision(
  market,
  symbol
) {
  const h4 =
    analyzeTimeframe(
      market["4h"],
      "4h"
    );

  const h1 =
    analyzeTimeframe(
      market["1h"],
      "1h"
    );

  const m15 =
    analyzeTimeframe(
      market["15m"],
      "15m"
    );

  const reasons = [];

  let direction = "NO SIGNAL";

  // ----------------------------------------------------------
  // HIGHER-TIMEFRAME DIRECTION
  // ----------------------------------------------------------

  const bullishHTF =
    h4.direction === "BULLISH";

  const bearishHTF =
    h4.direction === "BEARISH";

  const bullish1H =
    h1.direction === "BULLISH";

  const bearish1H =
    h1.direction === "BEARISH";

  const bullish15M =
    m15.direction === "BULLISH";

  const bearish15M =
    m15.direction === "BEARISH";

  // ----------------------------------------------------------
  // 15M LIQUIDITY SWEEP
  // ----------------------------------------------------------

  const bullishSweep =
    m15.sweep &&
    m15.sweep.detected === true &&
    m15.sweep.direction === "BULLISH";

  const bearishSweep =
    m15.sweep &&
    m15.sweep.detected === true &&
    m15.sweep.direction === "BEARISH";

  // ----------------------------------------------------------
  // 15M DISPLACEMENT
  // ----------------------------------------------------------

  const bullishDisplacement =
    m15.displacement &&
    m15.displacement.detected === true &&
    m15.displacement.direction === "BULLISH";

  const bearishDisplacement =
    m15.displacement &&
    m15.displacement.detected === true &&
    m15.displacement.direction === "BEARISH";

  // ----------------------------------------------------------
  // 15M BOS
  // ----------------------------------------------------------

  const bullishBOS =
    m15.structure.bos === "BULLISH";

  const bearishBOS =
    m15.structure.bos === "BEARISH";

  // ----------------------------------------------------------
  // SWEEP → DISPLACEMENT SEQUENCE
  // ----------------------------------------------------------

  const bullishSequence =
    bullishSweep &&
    bullishDisplacement &&
    Number.isInteger(
      m15.sweep.index
    ) &&
    Number.isInteger(
      m15.displacement.index
    ) &&
    m15.sweep.index <
      m15.displacement.index;

  const bearishSequence =
    bearishSweep &&
    bearishDisplacement &&
    Number.isInteger(
      m15.sweep.index
    ) &&
    Number.isInteger(
      m15.displacement.index
    ) &&
    m15.sweep.index <
      m15.displacement.index;

  // ----------------------------------------------------------
  // BUY DECISION
  // ----------------------------------------------------------

  if (
    bullishHTF &&
    bullish1H &&
    bullish15M &&
    bullishSequence &&
    bullishBOS
  ) {
    direction = "BUY";

    reasons.push(
      "4H bullish structure."
    );

    reasons.push(
      "1H confirms bullish direction."
    );

    reasons.push(
      "15M confirms bullish structure."
    );

    reasons.push(
      "Bullish liquidity sweep detected."
    );

    reasons.push(
      "Bullish displacement followed the sweep."
    );

    reasons.push(
      "15M bullish BOS confirmed."
    );
  }

  // ----------------------------------------------------------
  // SELL DECISION
  // ----------------------------------------------------------

  if (
    bearishHTF &&
    bearish1H &&
    bearish15M &&
    bearishSequence &&
    bearishBOS
  ) {
    direction = "SELL";

    reasons.push(
      "4H bearish structure."
    );

    reasons.push(
      "1H confirms bearish direction."
    );

    reasons.push(
      "15M confirms bearish structure."
    );

    reasons.push(
      "Bearish liquidity sweep detected."
    );

    reasons.push(
      "Bearish displacement followed the sweep."
    );

    reasons.push(
      "15M bearish BOS confirmed."
    );
  }

  // ----------------------------------------------------------
  // NO SIGNAL
  // ----------------------------------------------------------

  if (
    direction === "NO SIGNAL"
  ) {

    if (
      h4.direction === "NEUTRAL"
    ) {
      reasons.push(
        "4H structure is not clear."
      );
    }

    if (
      h4.direction !==
      h1.direction
    ) {
      reasons.push(
        "4H and 1H are not aligned."
      );
    }

    if (
      h1.direction !==
      m15.direction
    ) {
      reasons.push(
        "1H and 15M are not aligned."
      );
    }

    if (
      !bullishSweep &&
      !bearishSweep
    ) {
      reasons.push(
        "No confirmed liquidity sweep."
      );
    }

    if (
      !bullishDisplacement &&
      !bearishDisplacement
    ) {
      reasons.push(
        "No confirmed displacement."
      );
    }

    if (
      bullishSweep &&
      bullishDisplacement &&
      !bullishSequence
    ) {
      reasons.push(
        "Bullish displacement did not follow the bullish sweep."
      );
    }

    if (
      bearishSweep &&
      bearishDisplacement &&
      !bearishSequence
    ) {
      reasons.push(
        "Bearish displacement did not follow the bearish sweep."
      );
    }

    if (
      !bullishBOS &&
      !bearishBOS
    ) {
      reasons.push(
        "No confirmed 15M BOS."
      );
    }

    if (
      bullishBOS &&
      !bullishHTF
    ) {
      reasons.push(
        "Bullish 15M BOS conflicts with the 4H direction."
      );
    }

    if (
      bearishBOS &&
      !bearishHTF
    ) {
      reasons.push(
        "Bearish 15M BOS conflicts with the 4H direction."
      );
    }

    if (
      reasons.length === 0
    ) {
      reasons.push(
        "SMC conditions are incomplete."
      );
    }
  }

  // ----------------------------------------------------------
  // FINAL RESULT
  // ----------------------------------------------------------

  const latest15M =
    market["15m"][
      market["15m"].length - 1
    ];

  return {
    symbol,

    signal:
      direction,

    price:
      latest15M.close,

    candleTime:
      latest15M.time,

    timeframes: {
      "4h": h4,
      "1h": h1,
      "15m": m15
    },

    sequence: {
      bullishSweep,
      bearishSweep,
      bullishDisplacement,
      bearishDisplacement,
      bullishSequence,
      bearishSequence
    },

    reasons,

    generatedAt:
      new Date().toISOString()
  };
    }

// ============================================================
// SIGNAL DUPLICATION PROTECTION
// ============================================================

function signalKey(signal) {
  if (!signal) {
    return null;
  }

  return [
    signal.symbol,
    signal.signal,
    signal.candleTime
  ].join("|");
}

const sentSignalKeys =
  new Set();

function hasSignalBeenSent(
  signal
) {
  const key =
    signalKey(signal);

  if (!key) {
    return false;
  }

  return sentSignalKeys.has(key);
}

function markSignalSent(
  signal
) {
  const key =
    signalKey(signal);

  if (key) {
    sentSignalKeys.add(key);
  }

  // Prevent unlimited memory growth.
  if (sentSignalKeys.size > 500) {
    const first =
      sentSignalKeys.values().next().value;

    sentSignalKeys.delete(first);
  }
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegramMessage(
  message
) {
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN;

  const chatId =
    process.env.TELEGRAM_CHAT_ID;

  if (
    !botToken ||
    !chatId
  ) {
    throw new Error(
      "Telegram is not configured. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID."
    );
  }

  const url =
    `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response =
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    });

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.ok
  ) {
    throw new Error(
      data.description ||
      "Telegram message failed."
    );
  }

  return data;
}

function formatSignalMessage(
  signal
) {
  const emoji =
    signal.signal === "BUY"
      ? "🟢"
      : "🔴";

  const title =
    signal.signal === "BUY"
      ? "BUY SIGNAL"
      : "SELL SIGNAL";

  return [
    `${emoji} SMC ${title}`,
    "",
    `Pair: ${signal.symbol}`,
    `Direction: ${signal.signal}`,
    `Price: ${signal.price}`,
    "",
    "Timeframe confirmation:",
    "4H → 1H → 15M",
    "",
    "SMC confirmation:",
    ...signal.reasons.map(
      reason => `• ${reason}`
    ),
    "",
    `Candle: ${signal.candleTime}`,
    `Generated: ${signal.generatedAt}`
  ].join("\n");
}

// ============================================================
// RUN ONE SYMBOL
// ============================================================

async function runSymbolAnalysis(
  symbol
) {
  const normalized =
    normalizeSymbol(symbol);

  if (
    !ALLOWED_SYMBOLS.includes(
      normalized
    )
  ) {
    throw new Error(
      `Unsupported symbol: ${normalized}`
    );
  }

  const market =
    await loadMarket(normalized);

  const decision =
    buildSMCDecision(
      market,
      normalized
    );

  signalState.candlesLoaded = true;

  if (
    decision.signal === "BUY" ||
    decision.signal === "SELL"
  ) {
    if (
      !hasSignalBeenSent(
        decision
      )
    ) {
      const message =
        formatSignalMessage(
          decision
        );

      await sendTelegramMessage(
        message
      );

      markSignalSent(
        decision
      );

      signalState.lastSignal =
        decision;

      return {
        ...decision,
        telegramSent: true
      };
    }

    return {
      ...decision,
      telegramSent: false,
      duplicate: true
    };
  }

  return {
    ...decision,
    telegramSent: false
  };
}

// ============================================================
// RUN ALL SYMBOLS
// ============================================================

async function runAutomaticSignalAnalysis() {
  if (signalState.running) {
    return {
      success: false,
      message:
        "Signal analysis is already running."
    };
  }

  signalState.running = true;
  signalState.lastError = null;

  try {
    const results = [];

    for (
      const symbol of ALLOWED_SYMBOLS
    ) {
      try {
        const result =
          await runSymbolAnalysis(
            symbol
          );

        results.push(result);
      } catch (error) {
        results.push({
          symbol,
          signal: "ERROR",
          error: error.message
        });
      }
    }

    signalState.lastRun =
      new Date().toISOString();

    return {
      success: true,
      results
    };
  } catch (error) {
    signalState.lastError =
      error.message;

    throw error;
  } finally {
    signalState.running = false;
  }
}

// ============================================================
// API ROUTES
// ============================================================
app.get(
  "/api/telegram/test",
  async (req, res) => {
    try {
      await sendTelegramMessage(
        "✅ SMC Trading Coach AI\n\nTelegram connection test successful."
      );

      res.json({
        success: true,
        message:
          "Telegram test message sent successfully."
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);
app.get(
  "/health",
  (req, res) => {
    res.json({
      success: true,
      service:
        "SMC Trading Coach AI",
      status: "online",
      version: "3.0.0",
      provider:
        signalState.provider,
      automaticSignals: true
    });
  }
);

app.get(
  "/api/signal/status",
  (req, res) => {
    res.json({
      success: true,
      running:
        signalState.running,
      lastRun:
        signalState.lastRun,
      lastSignal:
        signalState.lastSignal,
      lastError:
        signalState.lastError,
      candlesLoaded:
        signalState.candlesLoaded,
      symbols:
        ALLOWED_SYMBOLS
    });
  }
);

app.get(
  "/api/market-data/status",
  (req, res) => {
    res.json({
      success: true,
      provider:
        "Twelve Data",
      configured:
        Boolean(
          TWELVE_DATA_API_KEY
        ),
      symbols:
        ALLOWED_SYMBOLS,
      timeframes:
        ANALYSIS_TIMEFRAMES
    });
  }
);

app.get(
  "/api/market-data/test",
  async (req, res) => {
    try {
      const symbol =
        normalizeSymbol(
          req.query.symbol ||
          "GBP/USD"
        );

      const market =
        await loadMarket(
          symbol
        );

      res.json({
        success: true,
        provider:
          "Twelve Data",
        symbol,
        timeframes: {
          "4h": {
            count:
              market["4h"].length,
            latest:
              market["4h"][
                market["4h"].length - 1
              ]
          },

          "1h": {
            count:
              market["1h"].length,
            latest:
              market["1h"][
                market["1h"].length - 1
              ]
          },

          "15m": {
            count:
              market["15m"].length,
            latest:
              market["15m"][
                market["15m"].length - 1
              ]
          }
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

app.get(
  "/api/signal/run",
  async (req, res) => {
    try {
      const result =
        await runAutomaticSignalAnalysis();

      res.json(result);
    } catch (error) {
      signalState.lastError =
        error.message;

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// SUPABASE AUTH
// ============================================================

app.post(
  "/auth/signup",
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
          success: false,
          error:
            "Email and password are required."
        });
      }

      const {
        data,
        error
      } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true
        });

      if (error) {
        return res.status(400).json({
          success: false,
          error:
            error.message
        });
      }

      res.json({
        success: true,
        user: {
          id: data.user.id,
          email:
            data.user.email
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

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
          success: false,
          error:
            "Email and password are required."
        });
      }

      const supabaseClient =
        createClient(
          SUPABASE_URL,
          process.env.SUPABASE_ANON_KEY ||
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );

      const {
        data,
        error
      } =
        await supabaseClient.auth.signInWithPassword({
          email,
          password
        });

      if (error) {
        return res.status(401).json({
          success: false,
          error:
            error.message
        });
      }

      res.json({
        success: true,
        session:
          data.session,
        user:
          data.user
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// AUTOMATIC MONITOR
// ============================================================

const AUTO_SIGNAL_ENABLED =
  String(
    process.env.AUTO_SIGNAL_ENABLED ||
      "false"
  ).toLowerCase() === "true";

const AUTO_SIGNAL_INTERVAL_MS =
  Number(
    process.env.AUTO_SIGNAL_INTERVAL_MS ||
      300000
  );

async function automaticMonitor() {
  if (
    !AUTO_SIGNAL_ENABLED
  ) {
    console.log(
      "Automatic signal monitor is disabled."
    );
    return;
  }

  console.log(
    "Automatic signal monitor started."
  );

  const execute = async () => {
    try {
      console.log(
        `[AUTO] Checking markets at ${new Date().toISOString()}`
      );

      await runAutomaticSignalAnalysis();

      console.log(
        "[AUTO] Market check completed."
      );
    } catch (error) {
      signalState.lastError =
        error.message;

      console.error(
        "[AUTO] Error:",
        error.message
      );
    }
  };

  await execute();

  setInterval(
    execute,
    AUTO_SIGNAL_INTERVAL_MS
  );
}

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      `SMC Trading Coach AI running on port ${PORT}`
    );

    console.log(
      `Automatic signals: ${AUTO_SIGNAL_ENABLED ? "ENABLED" : "DISABLED"}`
    );

    console.log(
      `Symbols: ${ALLOWED_SYMBOLS.join(", ")}`
    );

    console.log(
      `Timeframes: ${ANALYSIS_TIMEFRAMES.join(", ")}`
    );

    automaticMonitor();
  }
);
