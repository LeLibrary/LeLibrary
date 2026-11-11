# Changelog

Notes for the current version. Every earlier version is on [GitHub Releases](https://github.com/LeLibrary/LeLibrary/releases).

## [6.0.0]

### New

- A new layout for every setup page. The steps sit along the top, a side panel shows how far along your setup is (what is required, what is optional, your collections, folders and sources) and Continue is always in view at the bottom, so you never have to scroll down to find it. On phones the top bar has buttons for Preview and Arrange home.
- Seven new shelves in the LeLibrary Hub, all built from your own library: New Releases (films released and shows with a new episode in the last year), Recently Added (the last 30 days), Top Rated, By Decade, World Cinema (a tab per language), Family Friendly and Short or Long (under 100 minutes, or over two and a half hours). Each has its own cover and animation, and existing Hubs get them on the next push. They can also be added as Home rows.
- Arrange home: drag your collections and Home rows into the order they should appear in Nuvio, from any step. Collections always stay above your Home rows, as Nuvio shows them.
- Preview your setup as it looks in Nuvio. Press Open preview (on phones, the play button at the top) on any setup page, while creating or editing, and a full screen copy of Nuvio opens: your Home rows in order with real posters, your collections and folders, a details page with sample streams in your stream style, on a phone layout or a TV layout. Stremio has its own view too. It shows your unsaved changes and never pushes or saves anything.
- A new API keys section. TMDB, TVDB, OMDb and MDBList now have the same cards as the library providers, and the MDBList card shows which account it is connected to.
- A separate Integrations section for Simkl and AniList. Once you connect, the card shows the account name straight away.
- Simkl rows: connect Simkl to add Up Next, Airing Next, Plan to Watch, Watching and Completed rows.
- Watch history, under Integrations. LeLibrary can read what you have watched in Nuvio, Simkl, AniList and (if you turn it on) MDBList, to add Continue Watching and Up Next rows. You can also hide films you have watched and shows you are caught up on, and copy what you finish in Nuvio to Simkl, MDBList or AniList. Everything is optional and off until you turn it on, except reading history from accounts you connect. Live scrobbling stays with Nuvio: sign in to Simkl or MDBList inside the Nuvio app for that.
- Your MDBList lists: with an MDBList key you can pick your own lists, the lists you liked, your watchlist and Up Next straight from the Home rows and folder pickers, without adding each list somewhere else first.
- AniList rows: connect AniList to get Watching, Plan to Watch and Completed anime rows, private lists included.
- Content filters, on Settle In and Move In: one Setup section with Use Main Metadata, Hide anime, Hide adult content and the categories you want left out (Anime, Animation, Reality TV, Talk Shows, Kids, Family, Musical, Documentary, News, Soap Operas, Horror). A title is hidden when any of its categories is ticked, everywhere Hide anime already worked: My Movies, My Shows, the Hub, collections and search. Hide adult content drops titles TMDB flags as adult or rates NC-17 or X (films) and TV-MA (shows); unrated titles stay. Titles TMDB has not described yet are never hidden by a guess.
- TorBox sources now look like proper cards (Torrents, Usenet, Web downloads), and Use Main Metadata says plainly that turning it on lets your library rows bring through streams you have enabled, so leave it off if you only want your own files.
- Nuvio now lists far fewer LeLibrary catalogues. Collection folders already shared one catalogue, but every pack source was still listed on its own as a hidden row, so a setup with packs showed well over a hundred catalogues in Nuvio. Only the rows you actually picked for Home are listed now. Push again or restart Nuvio to see the smaller list.
- Forgot your password? On the hosted site you can now set a new one, or have your setup deleted, without waiting for anyone. Choose Forgot your password? on the password prompt (or open /reset), enter your install link and one of the API keys saved in the setup, then run /reset in the LeLibrary Discord server and paste your request id. The bot sends you a one-time code by direct message within about a minute; it lasts 15 minutes and works once. You then choose your own new password (or confirm the deletion) on the site. Nobody is ever sent a password, and your keys never go through Discord. Someone who only has your install link cannot do this, and a setup with no saved API key cannot use it.

### Jellyfin

The Jellyfin plugin (Jellyfin 12 only) is now a real library, not just a working one. It is still installed from its own repository, and LeLibrary still never sees your debrid key or a byte of playback.

- **LeLibrary serves the metadata itself.** A new read-only endpoint, `/{uuid}.{secret}/jellyfin/metadata.json`, answers with one entry per title, episodes nested under their show: overview, runtime, genres, rating, vote count, certification, release date, poster, backdrop, and for episodes the title, synopsis, runtime, air date and still. It is the same install-token model as the plan: the URL is the read capability and nothing in the answer is a key. Because we send it, the library no longer depends on Jellyfin's own TMDb or TVDB plugins being installed and keyed.
- **The plugin stands Jellyfin's own providers down for its libraries**, so TMDb does not overwrite what LeLibrary knows. An entry you change yourself in Jellyfin's metadata settings is left alone.
- **Episode titles come from the library, not the release name.** Episodes are named from the library's own episode data, so they stop being "Episode N". The numbering a release uses is not always the numbering the metadata provider uses, so a minority of episodes keep the name they had.
- **Artwork**: posters, backdrops and episode stills are handed to Jellyfin as addresses and downloaded once, by Jellyfin, the first time something asks for it. The plugin never downloads an image.
- **The three playback bugs are fixed** in the same release (plugin 0.1.9):
  - Playback no longer fails with "Failed to find an appropriate file extension" after a resync. The container is now the real file's, and a resync keeps it.
  - Removing one episode of a show no longer removes the show. Every kind of item has its own identity, so a series is no longer identified by one of its episodes.
  - Changing the Server URL no longer duplicates the library or orphans watch history. Item ids come from what the item is, not from the address it is served at. A library that already doubled is cleaned up on the next sync, keeping the copy that carries the watch history.
- A file that covers several episodes now creates every episode, each playing the one file.
- A plan that came from the cache removes nothing: only a plan fetched fresh, against a complete provider listing, can delete.
- The Debrid provider setting is honoured. TorBox is the provider the plugin talks to; the other three are listed as not supported yet instead of silently using TorBox.
- Newly captured for this: the TMDB fill keeps the overview and the backdrop it was already fetching and throwing away, and the identity resolver keeps an episode's image. Existing libraries pick them up on the next sync after the fill has re-read the titles, so overviews and backdrops appear over the first day or two rather than all at once.
- Known limits: embedded subtitles work, sidecar subtitle files are not written; box sets are not created; files with no season or episode in their name are skipped rather than guessed.

### Changes

- The Docker image now lives at `ghcr.io/lelibrary/lelibrary`, because the project moved to its own GitHub organisation. An existing `compose.yml` that still points at `ghcr.io/leleasley/lelibrary` keeps working, but it stops receiving new versions: change the `image:` line once.
- Simkl now uses Simkl's newer sign-in. Connections made before this keep working for now; reconnect Simkl once to keep it working after 2027.
- On the edit page, connecting or disconnecting Simkl, AniList or Trakt now waits for Save like every other change. The card says "not saved yet" until you save, and Clear my edits undoes it.
- Clicking a key card now also switches it on, the same as clicking its switch.
- Buttons that cannot be pressed yet (for example Unlock before you type a password) now look greyed out instead of ready.
- In the Collections picker, LeLibrary's own essentials are listed first.
- AniList can only be connected now. The old username option is gone: a saved username is not shown, cannot be added and no longer serves any rows. Connect AniList to keep your anime rows.
- Library row names are no longer on Settle In or Move In. Rows are named where you add them, in Home rows; names already saved keep working.
- Trakt can no longer be connected to new setups. Setups that already use it keep it.
- Importing an old account setup is gone for good. It was switched off in 5.9.5 and all old account data has been deleted. Old account links still open the setup page.
- Keys, sign-ins and your own stream addon links you type in before creating a setup are no longer kept in your browser's storage. They stay only while the page is open, so after a reload you enter them again. Settings that are not secret are still kept as before.
- A push to Nuvio now updates the badge pack, TMDB enrichment and playback settings in one go instead of three separate writes, and skips the write when nothing changed. This should stop one app on your account overwriting the others halfway through.

### Fixes

- Streaming service folders such as Shudder now show the provider's current regional catalogue instead of restricting it to a rotating three-year release window, which could leave smaller series rows empty. New additions can appear as the source updates.
- Episodes in multi-season downloads using names such as `S01.E01` now match the correct video file instead of showing no streams.
- Importing a public Nuvio collection that uses Nuvio's own TMDB or Trakt lists (for example "no addons" packs) brought the folders in with 0 sources. Every source now comes across and is sent to Nuvio as the pack has it. If you imported one of these before, remove it and import it again.
- Simkl and MDBList watchlist rows were always empty since 5.5. They now show your list, including rows you pushed before.
- MDBList lists with more than 100 titles now show all of them.
- Saving Custom Streams on a setup made in v5.5 or later no longer fails with "Could not protect Custom Streams".
- Movie Collections warming now uses the same poster settings as the collection page, so Pictorium and Posters+ setups get warmed copies too.

### Security

- Setup edits, deletion, install-link rotation and saved-key reveal now require the edit session from Unlock. A password can no longer be guessed through other management endpoints without the unlock protections.
- A Cloudflare check now appears under the password when you create a setup or unlock one to edit it, and the button waits until the check has passed. It only appears on sites that have Turnstile set up; self-hosted installs without it work as before.
- Setup pages can no longer be shown inside another website's frame, which protects the password screens from click-jacking tricks.
- An old settings endpoint could be told to save stream and poster settings for a setup it did not own. It now only saves for the browser's own settings, and setups made in v5.5 or later are always edited from their own setup page.
- The fingerprints that keep one setup's cached posters, ratings and streams apart from another's are much longer now, making an accidental shared cache entry far less likely. Cached pages rebuild once after the update.
- Several in-memory lists that could grow forever on a busy server now have limits.
- Many leftovers from the old account system were removed from the code, and the Docker build no longer copies private notes or tooling into the image.

### Upgrading

- Nothing to do for most people. After updating, the first page loads can be a little slower while caches rebuild, and Nuvio shows the shorter catalogue list after your next push or a restart of the app.
- Jellyfin: install or update the plugin (0.1.9) from its repository, then press Run sync now once. The first sync after the update re-keys existing items without recreating them, cleans up a library that doubled when the Server URL changed, and refreshes every title so the metadata lands. Watch history stays attached.
