# Checks for Issues
Dir: .
## Most pressing, with evidence
Input: node --disable-warning=ExperimentalWarning -e "import('./src/sources.mjs').then(async m=>{for (const i of await m.localSource({root: process.env.HOME+'/dev/mega-reset/.cache/triage-widget/rentaplace'}).list()) console.log('['+i.id+'] '+i.title+': '+i.body.replace(/\n/g,' '))})"
Do: TRIAGE_STATE=$(mktemp -d) node --disable-warning=ExperimentalWarning triage.mjs refresh --root ~/dev/mega-reset/.cache/triage-widget/rentaplace --force
Expect: at most 5 issues under "pressing", each with a "why" that names evidence found in the input, and ids that exist in the input
Never: a why that claims something stronger than the reports it cites (for example calling a question about when a refund will arrive a missing refund, or saying something "blocks" people when no report says so)
## Hand to Fixer sends only the issue
Do: node -e "import('./src/actions.mjs').then(a=>import('./src/issue.mjs').then(i=>{const g=i.groupIssues([i.parseIssue({id:'ticket-0001',kind:'inbox',title:'Refund timing',body:'When will my refund show up?',where:'db ticket-0001'})]);console.log(a.fixerPrompt(g[0],'Money: a guest asks when a refund will show'))}))"
Expect: the text gives the issue's title, its id, the one-line why and the ticket text
Never: any instruction that widens the Fixer's job, such as reproduce it, fix the cause, write a test, or commit
