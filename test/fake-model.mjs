// A recorded model for tests: prints FAKE_REPLY (or a reply that claims a real and an invented id).
// A gather call (its system prompt asks for a context brief) prints FAKE_BRIEF instead, or a brief
// with two real claims, one without a citation and one that cites a file nobody gathered.
let input = "";
for await (const c of process.stdin) input += c;
const req = JSON.parse(input);
if (process.env.FAKE_LOG) (await import("node:fs")).appendFileSync(process.env.FAKE_LOG, JSON.stringify(req) + "\n");
const gather = /context brief/.test(req.system);
if (process.env.FAKE_FAIL || (gather && process.env.FAKE_BRIEF_FAIL)) { process.stderr.write("model down\n"); process.exit(2); }
if (gather) {
  process.stdout.write(process.env.FAKE_BRIEF ?? JSON.stringify({
    reported: [{ text: 'One guest says "Beach House checkout opens."', cites: ["ticket-0003"] }, { text: "Everyone is angry.", cites: [] }],
    where: [{ text: "Likely in createBooking: the cited line checks the listing's status.", cites: ["src/bookings.ts:2"] }, { text: "Likely in the payments module.", cites: ["src/payments.ts:9"] }],
    tests: [],
    unknown: [{ text: "The card asks to confirm the expected behavior; no report says what it is.", cites: ["card:closed-home"] }],
  }));
} else process.stdout.write(process.env.FAKE_REPLY ?? JSON.stringify({ headline: "One bug blocks bookings.", pressing: [{ ids: ["card:closed-home", "gh#999"], title: "Closed home bookable", why: "Blocks booking" }, { ids: ["nope"], title: "Invented", why: "x" }] }));
