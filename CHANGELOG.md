# Changelog

Notes for the current version. Every earlier version is on [GitHub Releases](https://github.com/LeLibrary/LeLibrary/releases).

## [6.0.6]

### Fixes

- Prevented some anime titles from being matched to unrelated shows when an exact anime title is available.

- Improved matching for accented and foreign-language titles, including Pokemon, reducing incorrect matches to similarly named shows.

- Premiumize library scans now keep the previous library if the provider cannot return a complete listing, instead of treating a failed or partial scan as an empty library.
- Nuvio collection updates wait longer after an authentication failure and retry later, reducing repeated failures while allowing recovery.

### Improvements

- Added privacy-safe resource diagnostics to help identify memory pressure and background workload problems.
