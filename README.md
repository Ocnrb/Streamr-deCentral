# Streamr deCentral

A community dashboard for the [Streamr Network](https://streamr.network). Manage your operator and stake, follow sponsorships and see the network live.

**Live app**: https://streamr-decentral.vercel.app

## Features

- **Overview**: the network at a glance: an introduction to Streamr and its three-layer network, then stake, delegations, APY, operators, sponsorships, streams, DATA sponsored and slashed, and the DATA price, each with its chart over time; top operators, best sponsorships, the latest network activity (new streams, permission and storage changes, sponsorships created and funded) and operator and delegator activity (staking, delegations, earnings, flags and votes)
- **Streams**: browse, create and manage streams
- **Operators and Delegators**: stake, delegate, sponsorships, history and wallets
- **Governance**: flags and votes
- **Network Map and Leaderboard**: the network on a live map, and operator rankings over time
- **Autostaker**: automatic stake management across sponsorships, based on the official Streamr Autostaker plugin
- **Swap**: DATA against POL, USDC and USDC.e on Polygon, straight through the DEX contracts
- **Bridge**: DATA between Ethereum and Polygon with the official Polygon PoS bridge
- **Subgraph**: query builder for every entity of the Streamr subgraph

Everything runs in the browser. Data comes from the Streamr subgraph (The Graph), Polygon RPCs and the Etherscan API. There is no backend of its own.

## Run locally

```bash
npm install
npm run dev        # Vite dev server: http://localhost:5500 (Tailwind and modules rebuilt on save)
npm run build      # production build in dist/ (what Vercel serves)
npm run preview    # serves dist/
```

## Tests and checks

```bash
npm run test:install   # once: the Chromium used by the tests
npm test               # builds, then runs the end-to-end tests (Playwright) on the build
npm run lint           # ESLint
```

The tests run the app from a local server with the outside world mocked in `tests/support/network.mjs`: an
in-memory subgraph that answers the app's queries (and checks them against the subgraph's schema), the Etherscan
logs API, a Polygon RPC and a Streamr client. They cover the Overview, the security rules (CSP on every page,
injected markup shown as text) and the sidebar. GitHub Actions runs all of these on every pull request.

Default API keys are included. You can use your own The Graph and Etherscan keys in **Settings**.

## Stack

- Vanilla JavaScript (ES modules), with no framework, bundled by Vite
- Tailwind CSS v4 (through Vite)
- ethers v5, Chart.js, Leaflet, d3 and Lucide from npm (pinned versions, bundled by Vite); the Streamr SDK and
  MapLibre are vendored in `public/libs/`
- Hosted on Vercel (`vercel.json` routes every page to `index.html` and sets the security headers)

## Structure

```
index.html      Markup of every page and modal
main.js         Entry point: wires the app modules and global events
src/app/        Routes, sign-in and saved key, page loading, autostaker panel, PWA install
src/core/       Router, services (RPC, subgraph), constants, utils
src/features/   One module per page or tool
src/ui/         Navigation and shared UI
src/input.css   Tailwind source
public/         Served as they are: early.js (before the first paint), sw.js, libs/ (Streamr SDK and
                MapLibre, pinned, no CDNs), workers/, assets/, favicon/, data/
scripts/        Server for a built app (used by the tests)
tests/          End-to-end tests and their mocks
```

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability and what the app does to stay safe.

## License

[MIT](LICENSE)
