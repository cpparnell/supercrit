# Supercrit

A Chrome extension that brings Letterboxd into [The Criterion Channel](https://www.criterionchannel.com).

Supercrit isn't affiliated with Letterboxd or The Criterion Channel.

## What it does

- **Ratings on every film card.** A small badge with the film's Letterboxd average shows up on film cards across the site: browse rails, collections and All Films.
- **Ratings on film and series pages.** A score line under the title gives the film's Letterboxd average and how many people rated it, and links to the film on Letterboxd.
- **Your watched films and watchlist.** Enter your Letterboxd username in the toolbar popup, and films you've watched get an eye mark, with your own rating shown beside the average. Films on your watchlist get a clock. Supercrit reads your public profile, so you don't need to log in.
- **Letterboxd filters on All Films.** A "Letterboxd" group at the top of the All Films filter panel filters the catalog by minimum rating, runtime, and whether you've watched a film or have it on your watchlist. It works alongside the site's own genre, decade, country, director and sort options.

Each feature can be switched on or off under **Show** in the popup.

## Install

Until it's on the Chrome Web Store, load it unpacked:

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the repository folder.
4. Open or refresh a Criterion Channel tab.

To set your username, click the Supercrit icon in the toolbar.

## How it works

Every night, a GitHub Action matches the whole Criterion catalog to Letterboxd and publishes the results as a shared snapshot. The extension downloads that snapshot, so most ratings appear straight away without any requests. Films the snapshot doesn't cover are looked up on Letterboxd live and cached in your browser.

Everything is stored locally in your browser, and nothing is sent to the developer. See [PRIVACY.md](PRIVACY.md) for details.

## Development

There's no build step. It's plain JavaScript that Chrome loads directly.

- Run the tests with `node --test`.
- After changing code, reload the extension at `chrome://extensions` and refresh the Criterion tab.
- Build the snapshot locally with `node scripts/build-snapshot.js` (needs Node 22). `LIMIT=50` gives a quick partial run.
- Package for the Chrome Web Store with `scripts/package.sh`, which writes `dist/supercrit-<version>.zip`.
