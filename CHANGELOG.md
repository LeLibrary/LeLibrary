# Changelog

Notes for the current version. Every earlier version is on [GitHub Releases](https://github.com/LeLibrary/LeLibrary/releases).

## [6.0.4]

### Fixes

- A debrid key that is rejected is now caught when you create the setup or change the key, instead of saving quietly and leaving an empty library. TorBox, Real-Debrid, AllDebrid and Premiumize are all checked, and a key pasted with a stray space is tidied up first.
- The Library page now says why a scan failed. If a provider rejects the key it names the provider and where to fix it; other failures show the last error and when the last successful scan was. Previously an empty library looked exactly like an empty account.
