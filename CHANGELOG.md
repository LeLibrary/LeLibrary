# Changelog

Notes for the current version. Every earlier version is on [GitHub Releases](https://github.com/LeLibrary/LeLibrary/releases).

## [6.0.6]

### New

- The LeLibrary Hub has an Anime folder, with a cover and animated tile drawn in the same style as the rest of the Hub art. It holds the same titles as your My Anime row, so an episode you started there is the same episode here.

- Hubs saved before it was added get the new folder on their next push, placed after Shows. Turn Hide anime on and the folder is left out with the rest of your anime.

### Fixes

- Pokemon packs that number whole eras as one season now match by episode title, including Pokemon Horizons packs numbered S20, instead of landing on another Pokemon series.

- Prevented some anime titles from being matched to unrelated shows when an exact anime title is available.

- Improved matching for accented and foreign-language titles, including Pokemon, reducing incorrect matches to similarly named shows.

- Premiumize library scans now keep the previous library if the provider cannot return a complete listing, instead of treating a failed or partial scan as an empty library.
- Nuvio collection updates wait longer after an authentication failure and retry later, reducing repeated failures while allowing recovery.

### Improvements

- Added privacy-safe resource diagnostics to help identify memory pressure and background workload problems.
