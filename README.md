# Streamr deCentral

A community dashboard for the [Streamr Network](https://streamr.network). Manage your operator and stake, follow sponsorships and see the network live.

**Live app**: https://streamr-decentral.vercel.app

## Features

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
npm run build:css
npm run dev
```

Then open http://localhost:5500.

After changing Tailwind classes, run `npm run build:css` again, or keep `npm run watch:css` running. The generated `styles.css` is committed.

Default API keys are included. You can use your own The Graph and Etherscan keys in **Settings**.

## Stack

- Vanilla JavaScript (ES modules), with no framework and no JS build step
- Tailwind CSS v4
- ethers v5, Streamr SDK, MapLibre and Chart.js (in `libs/`)
- Hosted on Vercel (`vercel.json` routes every page to `index.html`)

## Structure

```
index.html      Markup of every page and modal
main.js         App startup, routes and global events
src/core/       Router, services (RPC, subgraph), constants, utils
src/features/   One module per page or tool
src/ui/         Navigation and shared UI
src/input.css   Tailwind source (built to styles.css)
libs/           Vendored libraries
workers/        Web workers (CSV parsing, leaderboard)
```

## License

[MIT](LICENSE)
