# Changelog

Notes for the current version. Every earlier version is on [GitHub Releases](https://github.com/LeLibrary/LeLibrary/releases).

## [6.0.5]

### Fixes

- A debrid key that the provider rejects now pauses that library's scans for a day instead of retrying constantly. The Library page explains the rejection, and changing the key starts the scans again by itself. Setups with a dead key stop asking the provider on every cycle.
