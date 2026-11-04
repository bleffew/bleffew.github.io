// Fetches Kalshi prices for uncalled 2026 races and writes odds.json for /midterms/.
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

// A market's price is its last trade, falling back to the bid/ask midpoint when it has no trades.
function price(m) {
  const last = Number(m.last_price_dollars);
  if (last > 0) return last;
  const bid = Number(m.yes_bid_dollars), ask = Number(m.yes_ask_dollars);
  return bid > 0 || ask > 0 ? (bid + ask) / 2 : 0;
}
function sideOf(m) {
  const end = String(m.ticker).split("-").pop();
  return end === "D" ? "D" : end === "R" ? "R" : "I";
}
async function quote(event) {
  const j = await getJson(`${KALSHI}/events/${event}?with_nested_markets=true`);
  const markets = j.markets || (j.event && j.event.markets) || [];
  const top = markets.map((m) => ({ m, p: price(m) })).sort((a, b) => b.p - a.p)[0];
  if (!top || !top.p) return null;
  const sub = String(top.m.yes_sub_title || "");
  return {
    side: sideOf(top.m),
    price: Math.max(0.5, Math.min(1, Math.round(top.p * 1000) / 1000)),
    name: /part(y|ies)$/i.test(sub) || !sub ? "" : lastName(sub),
    t: new Date().toISOString(),
  };
}

async function main() {
  if (Date.now() > STOP_AFTER) { console.log("Past the stop date, nothing to do."); return false; }
  const [general, statewide] = await Promise.all([getJson(CIVIC + "General"), getJson(CIVIC + "Statewide")]);
  const races = [...(general.races || []), ...(statewide.races || [])].filter((x) => x.province !== "US");
  const jobs = [];
  for (const x of races) {
    if (!isOpen(x)) continue;
    if (x.type === "US Senate") {
      jobs.push(["senate", x.province, SPECIAL_SENATE[x.province] || `SENATE${x.province}-26`]);
    } else if (x.type === "Governor") {
      jobs.push(["gov", x.province, `GOVPARTY${x.province}-26`]);
    } else if (x.type === "House of Representatives") {
      const at = /At-Large/i.test(x.election_name);
      const d = at ? "AL" : (x.election_name.match(/US House (\d+)/) || [])[1];
      if (d) jobs.push(["house", `${x.province}-${d}`, `HOUSE${x.province}${at ? 1 : d}-26`]);
    }
  }
  const out = { asOf: new Date().toISOString(), source: "Kalshi last trade", control: {}, senate: {}, gov: {}, house: {} };
  let ok = 0, bad = 0;
  for (const [kind, key, event] of jobs) {
    try {
      const q = await quote(event);
      if (q) { out[kind][key] = q; ok++; } else bad++;
    } catch (e) {
      bad++;
      console.log("skip", event, e.message);
    }
    await sleep(GAP_MS);
  }
  for (const [name, event] of [["senate", "CONTROLS-2026"], ["house", "CONTROLH-2026"]]) {
    try {
      const q = await quote(event);
      if (q) out.control[name] = `${q.side === "D" ? "Democrats" : "Republicans"} ${Math.round(q.price * 1000) / 10}¢ at the last trade`;
    } catch (e) { console.log("skip", event, e.message); }
    await sleep(GAP_MS);
  }
  await writeFile("odds.json", JSON.stringify(out));
  console.log(`Priced ${ok} of ${jobs.length} open races, ${bad} missing.`);
  return true;
}

main().catch((e) => { console.error(e); process.exit(1); });
