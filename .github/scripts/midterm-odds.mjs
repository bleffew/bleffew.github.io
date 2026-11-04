// Fetches Kalshi prices for uncalled 2026 races and writes odds.json for /elections/.
// Kalshi's API can't be called from a browser, so this runs on a schedule instead.
import { writeFile } from "node:fs/promises";

const STOP_AFTER = Date.parse("2026-11-20T00:00:00Z");
const CIVIC = "https://civicapi.org/api/v2/race/search?startDate=2026-11-03&endDate=2026-11-03&country=US&limit=2000&election_type=";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SPECIAL_SENATE = { OH: "SENATEOHS-26", FL: "SENATEFLS-26" };
const GAP_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

const isOpen = (x) => !(x.candidates || []).some((c) => c.winner);
const lastName = (s) => String(s).replace(/,?\s+(Jr\.?|Sr\.?|II|III|IV)$/i, "").trim().split(/\s+/).pop();

// A price is a contract's latest trade. Democratic and Republican contracts are read separately,
// and the higher one is the leading side.
async function lastTrade(ticker) {
  const j = await getJson(`${KALSHI}/markets/trades?ticker=${ticker}&limit=1`);
  const t = (j.trades || [])[0];
  await sleep(GAP_MS);
  return t ? { p: Number(t.yes_price_dollars), t: t.created_time } : null;
}
async function quote(event, names = {}) {
  const sides = [["D", await lastTrade(`${event}-D`)], ["R", await lastTrade(`${event}-R`)]].filter((x) => x[1] && x[1].p > 0);
  if (!sides.length) return null;
  sides.sort((a, b) => b[1].p - a[1].p);
  const [side, t] = sides[0];
  // With a single contract priced below 50 cents, the other side leads.
  if (t.p < 0.5) {
    const other = side === "D" ? "R" : "D";
    return { side: other, price: Math.round((1 - t.p) * 1000) / 1000, name: names[other] || "", t: t.t };
  }
  return { side, price: Math.round(t.p * 1000) / 1000, name: names[side] || "", t: t.t };
}
function namesOf(x) {
  const out = {};
  for (const c of x.candidates || []) {
    const side = /^democrat/i.test(c.party) ? "D" : /^republican/i.test(c.party) ? "R" : null;
    if (side && !out[side]) out[side] = lastName(c.name);
  }
  return out;
}

async function main() {
  if (Date.now() > STOP_AFTER) { console.log("Past the stop date, nothing to do."); return false; }
  const [general, statewide] = await Promise.all([getJson(CIVIC + "General"), getJson(CIVIC + "Statewide")]);
  const races = [...(general.races || []), ...(statewide.races || [])].filter((x) => !["US", "GU", "VI", "MP", "AS", "PR", "DC"].includes(x.province));
  const jobs = [];
  for (const x of races) {
    if (!isOpen(x)) continue;
    if (x.type === "US Senate") {
      jobs.push(["senate", x.province, SPECIAL_SENATE[x.province] || `SENATE${x.province}-26`, namesOf(x)]);
    } else if (x.type === "Governor") {
      jobs.push(["gov", x.province, `GOVPARTY${x.province}-26`, namesOf(x)]);
    } else if (x.type === "House of Representatives") {
      const at = /At-Large/i.test(x.election_name);
      const d = at ? "AL" : (x.election_name.match(/US House (\d+)/) || [])[1];
      if (d) jobs.push(["house", `${x.province}-${d}`, `HOUSE${x.province}${at ? 1 : d}-26`, namesOf(x)]);
    }
  }
  const out = { asOf: new Date().toISOString(), source: "Kalshi last trade", control: {}, senate: {}, gov: {}, house: {} };
  let ok = 0, bad = 0;
  for (const [kind, key, event, names] of jobs) {
    try {
      const q = await quote(event, names);
      if (q) { out[kind][key] = q; ok++; } else bad++;
    } catch (e) {
      bad++;
      console.log("skip", event, e.message);
    }
  }
  for (const [name, event] of [["senate", "CONTROLS-2026"], ["house", "CONTROLH-2026"]]) {
    try {
      const q = await quote(event);
      if (q) out.control[name] = `${q.side === "D" ? "Democrats" : "Republicans"} ${Math.round(q.price * 1000) / 10}¢ at the last trade`;
    } catch (e) { console.log("skip", event, e.message); }
  }
  await writeFile("odds.json", JSON.stringify(out));
  console.log(`Priced ${ok} of ${jobs.length} open races, ${bad} missing. Senate ${Object.keys(out.senate).length}, governors ${Object.keys(out.gov).length}, House ${Object.keys(out.house).length}.`);
  return true;
}

main().catch((e) => { console.error(e); process.exit(1); });
