/**
 * Address and street-name normalization to the conventions used in the City of
 * Frisco address-point and street-centerline layers (upper case, USPS suffixes:
 * "FRISCO SQUARE" + "BLVD").
 */

export const SUFFIXES: Record<string, string> = {
  ALLEY: "ALY", AVENUE: "AVE", AV: "AVE", AVE: "AVE", BEND: "BND", BND: "BND", BOULEVARD: "BLVD", BLVD: "BLVD",
  BLV: "BLVD", CIRCLE: "CIR", CIR: "CIR", COURT: "CT", CT: "CT", COVE: "CV", CV: "CV", CROSSING: "XING",
  XING: "XING", DRIVE: "DR", DR: "DR", EXPRESSWAY: "EXPY", EXPY: "EXPY", FREEWAY: "FWY", FWY: "FWY",
  HIGHWAY: "HWY", HWY: "HWY", HOLLOW: "HOLW", HOLW: "HOLW", LANE: "LN", LN: "LN", LOOP: "LOOP",
  PARKWAY: "PKWY", PKWY: "PKWY", PKY: "PKWY", PASS: "PASS", PATH: "PATH", PLACE: "PL", PL: "PL",
  PLAZA: "PLZ", PLZ: "PLZ", POINT: "PT", PT: "PT", RIDGE: "RDG", RDG: "RDG", ROAD: "RD", RD: "RD",
  ROW: "ROW", RUN: "RUN", SQUARE: "SQ", SQ: "SQ", STREET: "ST", ST: "ST", TERRACE: "TER", TER: "TER",
  TRAIL: "TRL", TRL: "TRL", TRACE: "TRCE", TRCE: "TRCE", VIEW: "VW", VW: "VW", WAY: "WAY", WALK: "WALK",
};

const DIRECTIONS: Record<string, string> = {
  N: "N", NORTH: "N", S: "S", SOUTH: "S", E: "E", EAST: "E", W: "W", WEST: "W",
};

export interface ParsedAddress {
  number?: number;
  direction?: string;
  /** Street name without suffix, upper case (e.g. "FRISCO SQUARE"). */
  name: string;
  suffix?: string;
  unit?: string;
}

const TRAILING_TOKENS = new Set(["TX", "TEXAS", "USA", "US"]);

/**
 * Tokenize the street part of an address. Anything after the first comma
 * (city, state, ZIP) is dropped; without commas, trailing ZIP/state tokens and a
 * trailing "FRISCO" that follows a street suffix are dropped. "FRISCO" inside a
 * street name ("Frisco Square Blvd") is preserved.
 */
function cleanTokens(input: string): string[] {
  const streetPart = input.split(",")[0] ?? "";
  const tokens = streetPart
    .toUpperCase()
    .replace(/#/g, " ")
    .replace(/\./g, "")
    .replace(/[^A-Z0-9\- ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (TRAILING_TOKENS.has(last) || /^75\d{3}(-\d{4})?$/.test(last)) {
      tokens.pop();
    } else if (last === "FRISCO" && tokens.length > 2 && SUFFIXES[tokens[tokens.length - 2]]) {
      tokens.pop();
    } else break;
  }
  return tokens;
}

/** Parse "6101 Frisco Square Blvd, Frisco, TX" → {number: 6101, name: "FRISCO SQUARE", suffix: "BLVD"}. */
export function parseAddress(input: string): ParsedAddress | null {
  let tokens = cleanTokens(input);
  let unit: string | undefined;
  const unitIdx = tokens.findIndex((t) => ["APT", "UNIT", "STE", "SUITE", "BLDG"].includes(t));
  if (unitIdx >= 0) {
    unit = tokens.slice(unitIdx + 1, unitIdx + 2).join(" ") || undefined;
    tokens = tokens.slice(0, unitIdx);
  }
  if (tokens.length === 0) return null;
  let number: number | undefined;
  if (/^\d{1,6}$/.test(tokens[0])) {
    number = Number.parseInt(tokens[0], 10);
    tokens = tokens.slice(1);
  }
  let direction: string | undefined;
  if (tokens.length > 1 && DIRECTIONS[tokens[0]]) {
    direction = DIRECTIONS[tokens[0]];
    tokens = tokens.slice(1);
  }
  let suffix: string | undefined;
  if (tokens.length > 1 && SUFFIXES[tokens[tokens.length - 1]]) {
    suffix = SUFFIXES[tokens[tokens.length - 1]];
    tokens = tokens.slice(0, -1);
  }
  const name = tokens.join(" ").trim();
  if (!name) return null;
  return { number, direction, name, suffix, unit };
}

/** Parse a street name such as "Preston Road" or "Main St." → {name: "PRESTON", suffix: "RD"}. */
export function parseStreetName(input: string): { name: string; suffix?: string; direction?: string } | null {
  const parsed = parseAddress(input.replace(/^\s*\d+\s+/, ""));
  if (!parsed) return null;
  return { name: parsed.name, suffix: parsed.suffix, direction: parsed.direction };
}

export function formatParsedAddress(p: ParsedAddress): string {
  return [p.number, p.direction, p.name, p.suffix].filter(Boolean).join(" ");
}
