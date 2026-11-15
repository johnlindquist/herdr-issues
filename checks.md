# Checks for Issues

Run against a seeded clone of RentAPlace (https://github.com/johnlindquist/rentaplace, then `npm run seed` in it). The checks look for it at `../rentaplace`; set `RENTAPLACE` to use another folder.

Dir: .
## Most pressing, with evidence
Input: node --disable-warning=ExperimentalWarning -e "import('./src/sources.mjs').then(async m=>{for (const i of await m.localSource({root: process.env.RENTAPLACE||'../rentaplace'}).list()) console.log('['+i.id+'] '+i.title+': '+i.body.replace(/\n/g,' '))})"
Do: TRIAGE_STATE=$(mktemp -d) node --disable-warning=ExperimentalWarning triage.mjs refresh --root ${RENTAPLACE:-../rentaplace} --force
Expect: at most 5 issues under "pressing", each with a "why" that names evidence found in the input, and ids that exist in the input
Never: a why that claims something stronger than the reports it cites (for example calling a question about when a refund will arrive a missing refund, or saying something "blocks" people when no report says so)
## The context brief
Input: node --disable-warning=ExperimentalWarning triage.mjs prompt card:closed-home-booking --root ${RENTAPLACE:-../rentaplace} --no-context
Do: TRIAGE_STATE=$(mktemp -d) sh -c 'node --disable-warning=ExperimentalWarning triage.mjs refresh --root ${RENTAPLACE:-../rentaplace} >/dev/null && node --disable-warning=ExperimentalWarning triage.mjs gather card:closed-home-booking --root ${RENTAPLACE:-../rentaplace} --pretty'
Expect: a brief with what is reported in the reporters' words, where it likely lives, tests near it and what is not known; every claim names its file and line or its ticket
Never: state a cause the cited evidence does not show
Never: a claim that names no file or ticket
Never: invent a file, a test or a ticket that is not in the project or the inbox
