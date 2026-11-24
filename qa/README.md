# EC4206 Software Testing & QA: CheesyBeez POS

The group assignment's test suites, run against the real POS code (Option A).

| Task | Where | Run (from `qa/`) |
| --- | --- | --- |
| Black-box (EP, BVA), decision table, white-box | `unit/` | `npm run test:unit` |
| BDD (Gherkin + Cucumber) | `features/` | `npm run test:bdd` |
| API (Postman collection, run by Newman) | `postman/` | `npm run server` then `npm run test:api` |
| UI (Selenium, headless Chrome) | `selenium/` | `npx vite --port 5179` (repo root), then `npm run test:ui` |
| Load (JMeter 5.6.3) | `jmeter/cheesybeez-load.jmx` | `jmeter -n -t jmeter/cheesybeez-load.jmx -Jtoken=<from .env.json> -Jusers=50 -Jloops=40 -l evidence/load.jtl -e -o evidence/jmeter-report` |
| OWASP brute-force check | `tools/bruteforce.sh` | `npm run server` then `./tools/bruteforce.sh` |
| Cyclomatic complexity | `eslint.complexity.config.mjs` | `npx eslint -c qa/eslint.complexity.config.mjs --no-config-lookup src/domain/parser.ts` (repo root) |
| SonarQube | `../sonar-project.properties` | local SonarQube on :9000, then `npx @sonar/scan -Dsonar.host.url=http://localhost:9000 -Dsonar.token=...` (repo root) |
| CI | `../.github/workflows/qa.yml` | every push and pull request |

`npm run server` starts the real sync server (`server/app.ts`) on a throwaway SQLite file, with one counter device and
the staff Nimal (cashier, PIN 1111), Ravi (manager, 2580) and Danit (owner, 9999); it writes the token to `.env.json`.
`evidence/` holds the logs and screenshots used in the report; `tools/shot.mjs` renders a log as a screenshot.
