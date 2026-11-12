// A recorded model for tests: prints FAKE_REPLY (or a reply that claims a real and an invented id).
let input = "";
for await (const c of process.stdin) input += c;
const req = JSON.parse(input);
if (process.env.FAKE_LOG) (await import("node:fs")).appendFileSync(process.env.FAKE_LOG, JSON.stringify(req) + "\n");
if (process.env.FAKE_FAIL) { process.stderr.write("model down\n"); process.exit(2); }
process.stdout.write(process.env.FAKE_REPLY ?? JSON.stringify({ headline: "One bug blocks bookings.", pressing: [{ ids: ["card:closed-home", "gh#999"], title: "Closed home bookable", why: "Blocks booking" }, { ids: ["nope"], title: "Invented", why: "x" }] }));
