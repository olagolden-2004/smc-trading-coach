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

// ============================================================
// CLOSED CANDLE FILTER
// ============================================================

function getTimeframeMinutes(timeframe) {
  if (timeframe === "15m") return 15;
  if (timeframe === "1h") return 60;
  if (timeframe === "4h") return 240;

  return 0;
}

function filterClosedCandles(candles, timeframe) {
  const minutes =
    getTimeframeMinutes(timeframe);

  if (!minutes || !Array.isArray(candles)) {
    return candles;
  }

  const now = Date.now();

  return candles.filter(candle => {
    const candleTime =
      new Date(candle.time).getTime();

    if (!Number.isFinite(candleTime)) {
      return false;
    }

    const candleEnd =
      candleTime +
      minutes * 60 * 1000;

    return candleEnd <= now;
  });
}

async function loadMarket(symbol) {
  const result = {};

  for (
    const timeframe of ANALYSIS_TIMEFRAMES
  ) {
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

function averageRange(
  candles,
  length = 20
) {
  const start =
    Math.max(
      0,
      candles.length - length
    );

  let total = 0;
  let count = 0;

  for (
    let i = start;
    i < candles.length;
    i++
  ) {
    total +=
      candles[i].high -
      candles[i].low;

    count++;
  }

  return count
    ? total / count
    : 0;
}

function candleBody(c) {
  return Math.abs(
    c.close - c.open
  );
}

function candleRange(c) {
  return (
    c.high - c.low
  );
}

function isBullish(c) {
  return c.close > c.open;
}

function isBearish(c) {
  return c.close < c.open;
}

function midpoint(
  high,
  low
) {
  return (
    low +
    (high - low) / 2
  );
}

// ============================================================
// SWING DETECTION
// ============================================================

function findSwingHighs(
  candles,
  strength = 3
) {
  const swings = [];

  for (
    let i = strength;
    i < candles.length - strength;
    i++
  ) {
    const current =
      candles[i];

    let valid = true;

    for (
      let j = 1;
      j <= strength;
      j++
    ) {
      if (
        current.high <=
          candles[i - j].high ||
        current.high <=
          candles[i + j].high
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

function findSwingLows(
  candles,
  strength = 3
) {
  const swings = [];

  for (
    let i = strength;
    i < candles.length - strength;
    i++
  ) {
    const current =
      candles[i];

    let valid = true;

    for (
      let j = 1;
      j <= strength;
      j++
    ) {
      if (
        current.low >=
          candles[i - j].low ||
        current.low >=
          candles[i + j].low
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

  // ----------------------------------------------------------
  // EXTERNAL STRUCTURE / BIAS
  // ----------------------------------------------------------

  let bias = "NEUTRAL";

  if (
    recentHighs.length >= 2 &&
    recentLows.length >= 2
  ) {
    const h1 =
      recentHighs[
        recentHighs.length - 2
      ];

    const h2 =
      recentHighs[
        recentHighs.length - 1
      ];

    const l1 =
      recentLows[
        recentLows.length - 2
      ];

    const l2 =
      recentLows[
        recentLows.length - 1
      ];

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

  // ----------------------------------------------------------
  // INTERNAL STRUCTURE BREAKS
  // ----------------------------------------------------------

  const bosEvents = [];

  const startIndex =
    Math.max(
      10,
      candles.length - 30
    );

  const brokenBullishLevels =
    new Set();

  const brokenBearishLevels =
    new Set();

  for (
    let i = startIndex;
    i < candles.length;
    i++
  ) {
    const candle =
      candles[i];

    const previousCandle =
      candles[i - 1];

    if (!previousCandle) {
      continue;
    }

    const previousCandles =
      candles.slice(0, i);

    const candleHighs =
      findSwingHighs(
        previousCandles,
        3
      );

    const candleLows =
      findSwingLows(
        previousCandles,
        3
      );

    const referenceHigh =
      candleHighs.length > 0
        ? candleHighs[
            candleHighs.length - 1
          ]
        : null;

    const referenceLow =
      candleLows.length > 0
        ? candleLows[
            candleLows.length - 1
          ]
        : null;

    // --------------------------------------------------------
    // BULLISH INTERNAL BREAK
    // --------------------------------------------------------

    if (
      referenceHigh &&
      previousCandle.close <=
        referenceHigh.price &&
      candle.close >
        referenceHigh.price
    ) {
      const levelKey =
        referenceHigh.index +
        ":" +
        referenceHigh.price;

      if (
        !brokenBullishLevels.has(
          levelKey
        )
      ) {
        bosEvents.push({
          direction: "BULLISH",
          index: i,
          time: candle.time,
          level: referenceHigh.price
        });

        brokenBullishLevels.add(
          levelKey
        );
      }
    }

    // --------------------------------------------------------
    // BEARISH INTERNAL BREAK
    // --------------------------------------------------------

    if (
      referenceLow &&
      previousCandle.close >=
        referenceLow.price &&
      candle.close <
        referenceLow.price
    ) {
      const levelKey =
        referenceLow.index +
        ":" +
        referenceLow.price;

      if (
        !brokenBearishLevels.has(
          levelKey
        )
      ) {
        bosEvents.push({
          direction: "BEARISH",
          index: i,
          time: candle.time,
          level: referenceLow.price
        });

        brokenBearishLevels.add(
          levelKey
        );
      }
    }
  }

  // ----------------------------------------------------------
  // LATEST INTERNAL BREAK
  // ----------------------------------------------------------

  const latestBOS =
    bosEvents.length > 0
      ? bosEvents[
          bosEvents.length - 1
        ]
      : null;

  // ----------------------------------------------------------
  // CHOCH
  //
  // Opposite break against the established external bias
  // is treated as a structural transition, not an immediate
  // trend reversal.
  // ----------------------------------------------------------

  let choch = null;

  if (
    latestBOS &&
    latestBOS.direction ===
      "BULLISH" &&
    bias === "BEARISH"
  ) {
    choch = "BULLISH";
  }

  if (
    latestBOS &&
    latestBOS.direction ===
      "BEARISH" &&
    bias === "BULLISH"
  ) {
    choch = "BEARISH";
  }

  // ----------------------------------------------------------
  // INTERNAL STRUCTURE DIRECTION
  // ----------------------------------------------------------

  let internalDirection =
    "NEUTRAL";

  if (latestBOS) {
    internalDirection =
      latestBOS.direction;
  }

  // ----------------------------------------------------------
  // TRANSITION
  //
  // This tells the signal engine:
  //
  // BEARISH external bias + BULLISH CHOCH
  // = possible bullish transition.
  //
  // BULLISH external bias + BEARISH CHOCH
  // = possible bearish transition.
  // ----------------------------------------------------------

  let transition =
    "NONE";

  if (choch === "BULLISH") {
    transition = "BULLISH";
  }

  if (choch === "BEARISH") {
    transition = "BEARISH";
  }

  const latestHigh =
    highs.length > 0
      ? highs[
          highs.length - 1
        ]
      : null;

  const latestLow =
    lows.length > 0
      ? lows[
          lows.length - 1
        ]
      : null;

  return {
    // External structure
    bias,

    // Internal structure
    internalDirection,

    // Latest internal BOS
    bos:
      latestBOS
        ? latestBOS.direction
        : null,

    bosIndex:
      latestBOS
        ? latestBOS.index
        : null,

    bosTime:
      latestBOS
        ? latestBOS.time
        : null,

    // Structural transition
    choch,

    transition,

    // Full BOS history
    bosEvents,

    swingHighs:
      highs,

    swingLows:
      lows,

    latestHigh:
      latestHigh
        ? latestHigh.price
        : null,

    latestLow:
      latestLow
        ? latestLow.price
        : null
  };
}

// ============================================================
// LIQUIDITY SWEEP DETECTION
// ============================================================

function detectLiquiditySweep(candles) {
  if (
    !Array.isArray(candles) ||
    candles.length < 20
  ) {
    return {
      detected: false,
      direction: null,
      index: null,
      time: null,
      level: null
    };
  }

  const startIndex =
    Math.max(
      10,
      candles.length - 20
    );

  for (
    let i = candles.length - 1;
    i >= startIndex;
    i--
  ) {
    const candle =
      candles[i];

    const previousCandles =
      candles.slice(
        0,
        i
      );

    const swingHighs =
      findSwingHighs(
        previousCandles,
        3
      );

    const swingLows =
      findSwingLows(
        previousCandles,
        3
      );

    const recentHigh =
      swingHighs.length > 0
        ? swingHighs[
            swingHighs.length - 1
          ]
        : null;

    const recentLow =
      swingLows.length > 0
        ? swingLows[
            swingLows.length - 1
          ]
        : null;

    // Bullish liquidity sweep:
    // price takes a previous low
    // but closes back above it.
    if (
      recentLow &&
      candle.low <
        recentLow.price &&
      candle.close >
        recentLow.price
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
    // price takes a previous high
    // but closes back below it.
    if (
      recentHigh &&
      candle.high >
        recentHigh.price &&
      candle.close <
        recentHigh.price
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

// ============================================================
// DISPLACEMENT DETECTION
// ============================================================

function detectDisplacement(candles) {
  if (
    !Array.isArray(candles) ||
    candles.length < 20
  ) {
    return {
      detected: false,
      direction: null,
      index: null,
      time: null,
      strength: 0
    };
  }

  const startIndex =
    Math.max(
      5,
      candles.length - 12
    );

  for (
    let i = candles.length - 1;
    i >= startIndex;
    i--
  ) {
    const candle =
      candles[i];

    const previous =
      candles.slice(
        Math.max(
          0,
          i - 10
        ),
        i
      );

    if (previous.length < 5) {
      continue;
    }

    const average =
      previous.reduce(
        (sum, item) =>
          sum +
          candleRange(item),
        0
      ) / previous.length;

    const range =
      candleRange(candle);

    const body =
      candleBody(candle);

    if (average <= 0) {
      continue;
    }

    const bodyRatio =
      range > 0
        ? body / range
        : 0;

    if (
      isBullish(candle) &&
      range >=
        average * 1.5 &&
      bodyRatio >= 0.65
    ) {
      return {
        detected: true,
        direction: "BULLISH",
        index: i,
        time: candle.time,
        strength: Number(
          (
            range / average
          ).toFixed(2)
        )
      };
    }

    if (
      isBearish(candle) &&
      range >=
        average * 1.5 &&
      bodyRatio >= 0.65
    ) {
      return {
        detected: true,
        direction: "BEARISH",
        index: i,
        time: candle.time,
        strength: Number(
          (
            range / average
          ).toFixed(2)
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

// ============================================================
// ORDER BLOCK
// ============================================================

function findOrderBlock(
  candles,
  direction,
  displacementIndex = null
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0
  ) {
    return null;
  }

  let anchor =
    Number.isInteger(
      displacementIndex
    )
      ? displacementIndex
      : candles.length - 1;

  anchor =
    Math.min(
      anchor,
      candles.length - 1
    );

  const start =
    Math.max(
      0,
      anchor - 8
    );

  for (
    let i = anchor - 1;
    i >= start;
    i--
  ) {
    const candle =
      candles[i];

    if (
      direction === "BULLISH" &&
      isBearish(candle)
    ) {
      return {
        direction: "BULLISH",
        index: i,
        time: candle.time,
        high: candle.high,
        low: candle.low,
        open: candle.open,
        close: candle.close
      };
    }

    if (
      direction === "BEARISH" &&
      isBullish(candle)
    ) {
      return {
        direction: "BEARISH",
        index: i,
        time: candle.time,
        high: candle.high,
        low: candle.low,
        open: candle.open,
        close: candle.close
      };
    }
  }

  return null;
}

// ============================================================
// PREMIUM / DISCOUNT
// ============================================================

function calculatePremiumDiscount(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0
  ) {
    return {
      zone: "UNKNOWN",
      midpoint: null,
      high: null,
      low: null
    };
  }

  const recent =
    candles.slice(
      Math.max(
        0,
        candles.length - 50
      )
    );

  const high =
    Math.max(
      ...recent.map(
        candle => candle.high
      )
    );

  const low =
    Math.min(
      ...recent.map(
        candle => candle.low
      )
    );

  const mid =
    midpoint(
      high,
      low
    );

  const latest =
    candles[
      candles.length - 1
    ];

  let zone =
    "EQUILIBRIUM";

  if (
    latest.close > mid
  ) {
    zone = "PREMIUM";
  }

  if (
    latest.close < mid
  ) {
    zone = "DISCOUNT";
  }

  return {
    zone,
    midpoint: mid,
    high,
    low
  };
}

// ============================================================
// TIMEFRAME ANALYSIS
// ============================================================

function analyzeTimeframe(
  candles,
  timeframe
) {
  const structure =
    analyzeStructure(
      candles
    );

  const sweep =
    detectLiquiditySweep(
      candles
    );

  const displacement =
    detectDisplacement(
      candles
    );

  let direction =
    structure.bias;

  if (
    direction === "NEUTRAL" &&
    structure.bos
  ) {
    direction =
      structure.bos;
  }

  const orderBlock =
    findOrderBlock(
      candles,
      displacement.direction,
      displacement.index
    );

  const premiumDiscount =
    calculatePremiumDiscount(
      candles
    );

  const latest =
    candles[
      candles.length - 1
    ];

  return {
    timeframe,

    direction,

    bias:
      structure.bias,

    structure,

    sweep,

    displacement,

    premiumDiscount,

    orderBlock,

    latest
  };
}

// ============================================================
// FIND BOS AFTER A SPECIFIC EVENT
// ============================================================

function findBOSAfterIndex(
  candles,
  direction,
  startIndex
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 20
  ) {
    return null;
  }

  if (
    direction !== "BULLISH" &&
    direction !== "BEARISH"
  ) {
    return null;
  }

  const safeStart =
    Number.isInteger(startIndex)
      ? startIndex
      : 0;

  const beginning =
    Math.max(
      safeStart,
      10
    );

  for (
    let i = beginning;
    i < candles.length;
    i++
  ) {
    const candle =
      candles[i];

    const previous =
      candles.slice(
        0,
        i
      );

    const swingHighs =
      findSwingHighs(
        previous,
        3
      );

    const swingLows =
      findSwingLows(
        previous,
        3
      );

    const recentHigh =
      swingHighs.length
        ? swingHighs[
            swingHighs.length - 1
          ]
        : null;

    const recentLow =
      swingLows.length
        ? swingLows[
            swingLows.length - 1
          ]
        : null;

    if (
      direction === "BULLISH" &&
      recentHigh &&
      candle.close >
        recentHigh.price
    ) {
      return {
        direction: "BULLISH",
        index: i,
        time: candle.time,
        level:
          recentHigh.price
      };
    }

    if (
      direction === "BEARISH" &&
      recentLow &&
      candle.close <
        recentLow.price
    ) {
      return {
        direction: "BEARISH",
        index: i,
        time: candle.time,
        level:
          recentLow.price
      };
    }
  }

  return null;
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

  let direction =
    "NO SIGNAL";

  // ==========================================================
  // 4H CONTEXT
  // ==========================================================

  const h4BullishContinuation =
    h4.structure.bias ===
    "BULLISH";

  const h4BearishContinuation =
    h4.structure.bias ===
    "BEARISH";

  const h4BullishTransition =
    h4.structure.transition ===
      "BULLISH" &&
    h4.structure.choch ===
      "BULLISH";

  const h4BearishTransition =
    h4.structure.transition ===
      "BEARISH" &&
    h4.structure.choch ===
      "BEARISH";

  const validBullishHTF =
    h4BullishContinuation ||
    h4BullishTransition;

  const validBearishHTF =
    h4BearishContinuation ||
    h4BearishTransition;

  // ==========================================================
  // 1H CONFIRMATION
  // ==========================================================

  const bullish1H =
    h1.structure.bias ===
    "BULLISH";

  const bearish1H =
    h1.structure.bias ===
    "BEARISH";

  // ==========================================================
  // 15M LIQUIDITY SWEEP
  // ==========================================================

  const bullishSweep =
    m15.sweep &&
    m15.sweep.detected === true &&
    m15.sweep.direction ===
      "BULLISH";

  const bearishSweep =
    m15.sweep &&
    m15.sweep.detected === true &&
    m15.sweep.direction ===
      "BEARISH";

  // ==========================================================
  // 15M DISPLACEMENT
  // ==========================================================

  const bullishDisplacement =
    m15.displacement &&
    m15.displacement.detected === true &&
    m15.displacement.direction ===
      "BULLISH";

  const bearishDisplacement =
    m15.displacement &&
    m15.displacement.detected === true &&
    m15.displacement.direction ===
      "BEARISH";

  // ==========================================================
  // SWEEP → DISPLACEMENT SEQUENCE
  // ==========================================================

  const bullishSweepDisplacement =
    bullishSweep &&
    bullishDisplacement &&
    Number.isInteger(
      m15.sweep.index
    ) &&
    Number.isInteger(
      m15.displacement.index
    ) &&
    m15.displacement.index >=
      m15.sweep.index;

  const bearishSweepDisplacement =
    bearishSweep &&
    bearishDisplacement &&
    Number.isInteger(
      m15.sweep.index
    ) &&
    Number.isInteger(
      m15.displacement.index
    ) &&
    m15.displacement.index >=
      m15.sweep.index;

  // ==========================================================
  // 15M BOS AFTER DISPLACEMENT
  // ==========================================================

  const bullishBOS =
    bullishSweepDisplacement
      ? findBOSAfterIndex(
          market["15m"],
          "BULLISH",
          m15.displacement.index
        )
      : null;

  const bearishBOS =
    bearishSweepDisplacement
      ? findBOSAfterIndex(
          market["15m"],
          "BEARISH",
          m15.displacement.index
        )
      : null;

  // ==========================================================
  // BUY SIGNAL
  // ==========================================================

  if (
    validBullishHTF &&
    bullish1H &&
    bullishSweepDisplacement &&
    bullishBOS
  ) {
    direction = "BUY";

    if (
      h4BullishTransition
    ) {
      reasons.push(
        "4H bullish transition confirmed by CHOCH."
      );
    } else {
      reasons.push(
        "4H bullish external structure."
      );
    }

    reasons.push(
      "1H confirms bullish direction."
    );

    reasons.push(
      "15M bullish liquidity sweep detected."
    );

    reasons.push(
      "15M bullish displacement followed the sweep."
    );

    reasons.push(
      "15M bullish BOS confirmed after displacement."
    );
  }

  // ==========================================================
  // SELL SIGNAL
  // ==========================================================

  if (
    validBearishHTF &&
    bearish1H &&
    bearishSweepDisplacement &&
    bearishBOS
  ) {
    direction = "SELL";

    if (
      h4BearishTransition
    ) {
      reasons.push(
        "4H bearish transition confirmed by CHOCH."
      );
    } else {
      reasons.push(
        "4H bearish external structure."
      );
    }

    reasons.push(
      "1H confirms bearish direction."
    );

    reasons.push(
      "15M bearish liquidity sweep detected."
    );

    reasons.push(
      "15M bearish displacement followed the sweep."
    );

    reasons.push(
      "15M bearish BOS confirmed after displacement."
    );
  }

  // ==========================================================
  // NO SIGNAL REASONS
  // ==========================================================

  if (
    direction ===
    "NO SIGNAL"
  ) {

    if (
      !validBullishHTF &&
      !validBearishHTF
    ) {
      reasons.push(
        "4H has no valid continuation or transition context."
      );
    }

    if (
      validBullishHTF &&
      !bullish1H
    ) {
      reasons.push(
        "4H bullish context is not confirmed by 1H."
      );
    }

    if (
      validBearishHTF &&
      !bearish1H
    ) {
      reasons.push(
        "4H bearish context is not confirmed by 1H."
      );
    }

    if (
      !bullishSweep &&
      !bearishSweep
    ) {
      reasons.push(
        "No confirmed 15M liquidity sweep."
      );
    }

    if (
      bullishSweep &&
      !bullishDisplacement
    ) {
      reasons.push(
        "Bullish 15M sweep has no bullish displacement."
      );
    }

    if (
      bearishSweep &&
      !bearishDisplacement
    ) {
      reasons.push(
        "Bearish 15M sweep has no bearish displacement."
      );
    }

    if (
      bullishDisplacement &&
      !bullishSweep
    ) {
      reasons.push(
        "Bullish displacement has no preceding bullish sweep."
      );
    }

    if (
      bearishDisplacement &&
      !bearishSweep
    ) {
      reasons.push(
        "Bearish displacement has no preceding bearish sweep."
      );
    }

    if (
      bullishSweepDisplacement &&
      !bullishBOS
    ) {
      reasons.push(
        "Bullish sweep and displacement confirmed, but no bullish 15M BOS followed."
      );
    }

    if (
      bearishSweepDisplacement &&
      !bearishBOS
    ) {
      reasons.push(
        "Bearish sweep and displacement confirmed, but no bearish 15M BOS followed."
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

  // ==========================================================
  // LATEST 15M PRICE
  // ==========================================================

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

    context: {
      bullishHTF:
        validBullishHTF,

      bearishHTF:
        validBearishHTF,

      bullishContinuation:
        h4BullishContinuation,

      bearishContinuation:
        h4BearishContinuation,

      bullishTransition:
        h4BullishTransition,

      bearishTransition:
        h4BearishTransition
    },

    sequence: {
      bullishSweep,
      bearishSweep,

      bullishDisplacement,
      bearishDisplacement,

      bullishSweepDisplacement,
      bearishSweepDisplacement,

      bullishBOS:
        bullishBOS
          ? bullishBOS.direction
          : null,

      bearishBOS:
        bearishBOS
          ? bearishBOS.direction
          : null,

      bullishSweepIndex:
        bullishSweep
          ? m15.sweep.index
          : null,

      bullishDisplacementIndex:
        bullishDisplacement
          ? m15.displacement.index
          : null,

      bearishSweepIndex:
        bearishSweep
          ? m15.sweep.index
          : null,

      bearishDisplacementIndex:
        bearishDisplacement
          ? m15.displacement.index
          : null,

      bullishBOSIndex:
        bullishBOS
          ? bullishBOS.index
          : null,

      bearishBOSIndex:
        bearishBOS
          ? bearishBOS.index
          : null
    },

    reasons,

    generatedAt:
      new Date().toISOString()
  };
}

// ============================================================
// SIGNAL DUPLICATION PROTECTION
// ============================================================

function signalKey(
  signal
) {
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

  return sentSignalKeys.has(
    key
  );
}

function markSignalSent(
  signal
) {
  const key =
    signalKey(signal);

  if (!key) {
    return;
  }

  sentSignalKeys.add(
    key
  );

  // Prevent unlimited memory growth.
  if (
    sentSignalKeys.size > 500
  ) {
    const first =
      sentSignalKeys.values().next().value;

    sentSignalKeys.delete(
      first
    );
  }
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegramMessage(
  message
) {
  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  const chatId =
    process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing."
    );
  }

  if (!chatId) {
    throw new Error(
      "TELEGRAM_CHAT_ID is missing."
    );
  }

  const url =
    `https://api.telegram.org/bot${token}/sendMessage`;

  const response =
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML"
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
      "Telegram send failed."
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

  const direction =
    signal.signal === "BUY"
      ? "BUY"
      : "SELL";

  const reasons =
    Array.isArray(
      signal.reasons
    )
      ? signal.reasons
      : [];

  return [
    `${emoji} <b>SMC SIGNAL</b>`,
    ``,
    `<b>Symbol:</b> ${signal.symbol}`,
    `<b>Direction:</b> ${direction}`,
    `<b>Price:</b> ${signal.price}`,
    `<b>15M Candle:</b> ${signal.candleTime}`,
    ``,
    `<b>Confirmation:</b>`,
    ...reasons.map(
      reason =>
        `• ${reason}`
    ),
    ``,
    `<b>Method:</b> 4H → 1H → 15M`,
    `<b>Provider:</b> Twelve Data`,
    ``,
    `⚠️ Signal generated automatically from closed-candle market data.`
  ].join("\n");
}

// ============================================================
// RUN SIGNAL ANALYSIS
// ============================================================

async function runSignalForSymbol(
  symbol
) {
  const normalizedSymbol =
    normalizeSymbol(symbol);

  if (
    !ALLOWED_SYMBOLS.includes(
      normalizedSymbol
    )
  ) {
    throw new Error(
      `Unsupported symbol: ${normalizedSymbol}`
    );
  }

  const market =
    await loadMarket(
      normalizedSymbol
    );

  const decision =
    buildSMCDecision(
      market,
      normalizedSymbol
    );

  signalState.candlesLoaded =
    true;

  signalState.lastSignal =
    decision;

  // Only BUY/SELL signals are sent.
  if (
    decision.signal !==
      "BUY" &&
    decision.signal !==
      "SELL"
  ) {
    return {
      ...decision,
      telegramSent: false
    };
  }

  if (
    hasSignalBeenSent(
      decision
    )
  ) {
    return {
      ...decision,
      telegramSent: false,
      telegramSkipped:
        "Duplicate signal already sent."
    };
  }

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

  return {
    ...decision,
    telegramSent: true
  };
}

// ============================================================
// AUTOMATIC SIGNAL MONITOR
// ============================================================

let automaticMonitor =
  null;

async function runAutomaticSignalAnalysis() {
  if (
    signalState.running
  ) {
    return {
      success: false,
      skipped: true,
      reason:
        "Signal analysis is already running."
    };
  }

  signalState.running =
    true;

  signalState.lastError =
    null;

  try {
    const results = [];

    for (
      const symbol of ALLOWED_SYMBOLS
    ) {
      try {
        const result =
          await runSignalForSymbol(
            symbol
          );

        results.push(
          result
        );
      } catch (error) {
        results.push({
          symbol,
          signal: "ERROR",
          error:
            error.message
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
    signalState.running =
      false;
  }
}

function startAutomaticMonitor() {
  if (
    automaticMonitor
  ) {
    return;
  }

  const enabled =
    String(
      process.env.AUTO_SIGNAL_ENABLED ||
        "false"
    ).toLowerCase() ===
    "true";

  if (!enabled) {
    console.log(
      "Automatic signal monitor is disabled."
    );

    return;
  }

  const interval =
    Number(
      process.env.AUTO_SIGNAL_INTERVAL_MS ||
        300000
    );

  console.log(
    `Automatic signal monitor enabled. Interval: ${interval}ms`
  );

  runAutomaticSignalAnalysis()
    .catch(error => {
      console.error(
        "Automatic signal analysis error:",
        error.message
      );
    });

  automaticMonitor =
    setInterval(() => {
      runAutomaticSignalAnalysis()
        .catch(error => {
          console.error(
            "Automatic signal analysis error:",
            error.message
          );
        });
    }, interval);
}

// ============================================================
// TELEGRAM TEST
// ============================================================

app.get(
  "/api/telegram/test",
  async (req, res) => {
    try {
      await sendTelegramMessage(
        "✅ <b>SMC Trading Coach</b>\n\nTelegram connection test successful."
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

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      success: true,
      status: "ok",
      version: "4.0.0",
      provider:
        "Twelve Data",
      automaticSignals:
        String(
          process.env.AUTO_SIGNAL_ENABLED ||
            "false"
        ).toLowerCase() ===
        "true",
      timestamp:
        new Date().toISOString()
    });
  }
);

// ============================================================
// SIGNAL STATUS
// ============================================================

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
      automaticEnabled:
        String(
          process.env.AUTO_SIGNAL_ENABLED ||
            "false"
        ).toLowerCase() ===
        "true"
    });
  }
);

// ============================================================
// MARKET DATA STATUS
// ============================================================

app.get(
  "/api/market-data/status",
  (req, res) => {
    res.json({
      success: true,
      provider:
        "Twelve Data",
      apiKeyConfigured:
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

// ============================================================
// MARKET DATA TEST
// ============================================================

app.get(
  "/api/market-data/test",
  async (req, res) => {
    try {
      const requested =
        normalizeSymbol(
          req.query.symbol ||
            "GBP/USD"
        );

      if (
        !ALLOWED_SYMBOLS.includes(
          requested
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            `Unsupported symbol. Allowed: ${ALLOWED_SYMBOLS.join(", ")}`
        });
      }

      const market =
        await loadMarket(
          requested
        );

      const response = {
        success: true,
        provider:
          "Twelve Data",
        symbol:
          requested,
        timeframes: {}
      };

      for (
        const timeframe of ANALYSIS_TIMEFRAMES
      ) {
        const candles =
          market[timeframe];

        const latest =
          candles[
            candles.length - 1
          ];

        response.timeframes[
          timeframe
        ] = {
          count:
            candles.length,
          latest
        };
      }

      res.json(
        response
      );
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
// MANUAL SIGNAL RUN
// ============================================================

app.get(
  "/api/signal/run",
  async (req, res) => {
    try {
      const requested =
        req.query.symbol
          ? normalizeSymbol(
              req.query.symbol
            )
          : null;

      if (
        requested &&
        !ALLOWED_SYMBOLS.includes(
          requested
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            `Unsupported symbol. Allowed: ${ALLOWED_SYMBOLS.join(", ")}`
        });
      }

      if (requested) {
        const result =
          await runSignalForSymbol(
            requested
          );

        return res.json({
          success: true,
          result
        });
      }

      const results = [];

      for (
        const symbol of ALLOWED_SYMBOLS
      ) {
        try {
          const result =
            await runSignalForSymbol(
              symbol
            );

          results.push(
            result
          );
        } catch (error) {
          results.push({
            symbol,
            signal: "ERROR",
            error:
              error.message
          });
        }
      }

      signalState.lastRun =
        new Date().toISOString();

      res.json({
        success: true,
        results
      });
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
// AUTH - SIGNUP
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
        user: data.user
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
// AUTH - LOGIN
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
          success: false,
          error:
            "Email and password are required."
        });
      }

      const supabaseClient =
        createClient(
          SUPABASE_URL,
          process.env.SUPABASE_ANON_KEY ||
            SUPABASE_SERVICE_ROLE_KEY
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
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      `SMC Trading Coach server running on port ${PORT}`
    );

    console.log(
      `Allowed symbols: ${ALLOWED_SYMBOLS.join(", ")}`
    );

    console.log(
      `Analysis timeframes: ${ANALYSIS_TIMEFRAMES.join(", ")}`
    );

    console.log(
      `Twelve Data configured: ${Boolean(TWELVE_DATA_API_KEY)}`
    );

    startAutomaticMonitor();
  }
);
