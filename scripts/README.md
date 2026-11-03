# Scripts and prerequisites

## Supported local app and checks

Run the app from the repository root with `npm ci`, then `npm start`. Open http://localhost:3000 on the same computer. No proxy or stored credentials are needed for the labelled simulator. For the live sandbox, the console reads `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` from the terminal environment. `ANTHROPIC_API_KEY` enables real model extraction and execution. Notifications stay preview-only by default.

`npm run smoke`, `npm test`, `npm run typecheck`, `npm run evals`, `npm run drill:crash` and `npm run check:clean` are the supported local verification commands. They do not require the historical live-proof environment.

## Historical operator-only live harnesses

These are retained for provenance and maintenance. They are not turnkey app entry points, and are not needed to use the console. Do not run them as part of setup or a routine test sweep: they can create sandbox resources and authorizations.

| Script | Required environment |
| --- | --- |
| `demo.ts` (`npm run demo`) | An already running authenticated local Airwallex proxy. Defaults to `http://localhost:8788`; `AIRWALLEX_BASE` selects a compatible proxy endpoint. It sends the sentinel `proxy-injected` bearer value, not a usable provider token. The proxy is not included or started by this command. Writes recording artifacts to `runs/` and `docs/`. |
| `live-run.ts` | The same authenticated local proxy and endpoint requirements as `demo.ts`. Writes run artifacts. |
| `proof-airwallex-live.ts` | The original operator environment, including its machine-specific credential-file paths. Those paths are not portable and no credential files are shipped. It calls the provider directly. This is a historical proof script, not a supported way to configure credentials on another computer. |

The console's environment-variable configuration is the portable live-sandbox route. Never copy credential files into the repository or package. Real-money use, sending email, new access and production deployment are separate decisions, not implied by these scripts.
