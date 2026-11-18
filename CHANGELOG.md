# Changelog

Notes for the current version. Every earlier version is on [GitHub Releases](https://github.com/LeLibrary/LeLibrary/releases).

## [6.0.6]

### New

- Favourites: pick films and shows from your own library on the Setup page, and they appear in a new Favourites folder in the LeLibrary Hub with its own cover and animated tile. Only titles you actually have are ever shown, so a favourite you later delete from your library simply drops out.
- The Releases page can now show what you already hold. Open your setup page, make a short code under Favourites, type it on Releases once, and each title tells you whether it is in your library and how much of a series you have ("seasons 1 and 2 complete, season 3 has 4 of 10"), with a star for the ones you want to keep. The code is single use, expire in ten minutes, and the browser can be unlinked from your setup page at any time.

- The LeLibrary Hub has an Anime folder, with a cover and animated tile drawn in the same style as the rest of the Hub art. It holds the same titles as your My Anime row, so an episode you started there is the same episode here.

- Hubs saved before it was added get the new folder on their next push, placed after Shows. Turn Hide anime on and the folder is left out with the rest of your anime.

### Fixes

- Rows you add to Your Home from another addon now say that addon's name (or its site), never its raw manifest id, in the Home rows list and in folder sources.
- A Nuvio push now reads the Home order back once and re-applies it if a Nuvio device wrote its own order while the push was running, so the order you set in LeLibrary sticks.
- After a Nuvio push, the setup pages say that a Nuvio which is already open has to be restarted (or the profile switched) before it shows the new Home order.

- Pokemon packs that number whole eras as one season now match by episode title, including Pokemon Horizons packs numbered S20, instead of landing on another Pokemon series.

- Prevented some anime titles from being matched to unrelated shows when an exact anime title is available.

- Improved matching for accented and foreign-language titles, including Pokemon, reducing incorrect matches to similarly named shows.

- Pokemon releases with no episode title in the name (RESTORE, RETRY and whole-season packs) now match the right series instead of failing. Packs numbered S20 are matched to Pokemon Horizons, the others to the main Pokemon series, using the episode numbers in the release name. Three-digit episode numbers such as `S19E049` are now read correctly instead of being cut to `S19E04`.

- Fixed several releases that would not match at all: Monster season 4 packs named after Abby Borden (now matched to the Lizzie Borden season), S00E01 making-of specials (now matched as films), and Top Boy packs numbered S04 or S05 (now matched to the 2019 series with the correct season). The titles of the files inside a pack are used to confirm these matches where the release name alone is not enough.

- After these matching changes, your library is re-checked once automatically. Matches you fixed yourself are kept, and a re-check that finds nothing better never replaces a working match.

- Premiumize library scans now keep the previous library if the provider cannot return a complete listing, instead of treating a failed or partial scan as an empty library.
- Nuvio collection updates wait longer after an authentication failure and retry later, reducing repeated failures while allowing recovery.

### Improvements

- Added privacy-safe resource diagnostics to help identify memory pressure and background workload problems.
