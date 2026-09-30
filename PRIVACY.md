# Supercrit privacy policy

_Last updated: September 29, 2026_

Supercrit is a Chrome extension that shows Letterboxd ratings on The Criterion Channel. It is not affiliated with Letterboxd or The Criterion Channel.

**Supercrit does not collect, sell or share your data. Nothing you do with it is sent to the developer.** There are no analytics, no tracking and no accounts.

## What is stored, and where

Everything Supercrit keeps is stored in your browser's local extension storage, on your device only:

- **Your Letterboxd username**, if you enter one in the extension's popup. This is optional.
- **Your watched films, your ratings of them, and your watchlist**, read from your public Letterboxd profile when a username is set. They are used only to mark films on The Criterion Channel.
- **Film ratings and details** looked up on Letterboxd and The Criterion Channel, cached so pages load faster.
- **Your settings**: which features are on, and your All Films filters.

To delete all of it, clear the username in the popup, or remove the extension.

## Network requests

Supercrit only contacts these sites, and only to show you ratings:

- **letterboxd.com**: to read public film pages and, if you set a username, your public profile's film and watchlist pages. These need no login. To find films that can't be matched any other way, Supercrit also uses Letterboxd's film search. Your browser sends its usual Letterboxd cookies with that request, as it would if you searched on the site yourself. Supercrit never reads, stores or sends those cookies anywhere else.
- **www.criterionchannel.com**: to read film details (title, year, directors, runtime) from the site's own API while you browse it.
- **cpparnell.github.io**: to download a shared file of ratings for the Criterion catalog, made once a day. This request contains nothing about you.

Each of these sites receives the ordinary information any web request carries, like your IP address, and handles it under its own privacy policy.

## Changes and contact

If this policy changes, the new version will be posted here with a new date. For questions, open an issue at https://github.com/cpparnell/supercrit/issues.
