// A recorded model for tests: prints FAKE_REPLY (or a reply that claims a real and an invented id).
// The planner call (system starts "PLANNER") prints FAKE_PLAN, or a plan of code only.
// A judging gatherer ("GATHERER: <name>") prints FAKE_FINDINGS_<NAME> or no findings; FAKE_FAIL_<NAME>
// makes it fail and FAKE_SLOW_<NAME> (ms) makes it slow.
// The code gatherer (its system prompt asks for a context brief) prints FAKE_BRIEF, or a brief
// with two real claims, one without a citation and one that cites a file nobody gathered.
let input = "";
for await (const c of process.stdin) input += c;
const req = JSON.parse(input);
if (process.env.FAKE_LOG) (await import("node:fs")).appendFileSync(process.env.FAKE_LOG, JSON.stringify(req) + "\n");
const planner = /^PLANNER/.test(req.system);
const judge = /^GATHERER: (\w+)/.exec(req.system)?.[1];
const gather = !planner && !judge && /context brief/.test(req.system);
const NAME = planner ? "PLAN" : judge ? judge.toUpperCase() : gather ? "CODE" : "TRIAGE";
if (process.env[`FAKE_SLOW_${NAME}`]) await new Promise((r) => setTimeout(r, Number(process.env[`FAKE_SLOW_${NAME}`])));
if (process.env.FAKE_FAIL || process.env[`FAKE_FAIL_${NAME}`] || (gather && process.env.FAKE_BRIEF_FAIL)) { process.stderr.write("model down\n"); process.exit(2); }
if (planner) process.stdout.write(process.env.FAKE_PLAN ?? JSON.stringify({ gatherers: [{ name: "code", look_for: "the checkout check", reason: "the reports name checkout" }] }));
else if (judge) process.stdout.write(process.env[`FAKE_FINDINGS_${NAME}`] ?? JSON.stringify({ findings: [] }));
else if (gather) {
  process.stdout.write(process.env.FAKE_BRIEF ?? JSON.stringify({
    reported: [{ text: 'One guest says "Beach House checkout opens."', cites: ["ticket-0003"] }, { text: "Everyone is angry.", cites: [] }],
    where: [{ text: "Likely in createBooking: the cited line checks the listing's status.", cites: ["src/bookings.ts:2"] }, { text: "Likely in the payments module.", cites: ["src/payments.ts:9"] }],
    tests: [],
    unknown: [{ text: "The card asks to confirm the expected behavior; no report says what it is.", cites: ["card:closed-home"] }],
  }));
} else process.stdout.write(process.env.FAKE_REPLY ?? JSON.stringify({ headline: "One bug blocks bookings.", pressing: [{ ids: ["card:closed-home", "gh#999"], title: "Closed home bookable", why: "Blocks booking" }, { ids: ["nope"], title: "Invented", why: "x" }] }));
