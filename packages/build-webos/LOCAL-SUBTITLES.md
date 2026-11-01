# Standalone TV subtitles (webOS 3.0.5 personal fork)

The TV fetches and renders these subtitles without an Emby/Jellyfin subtitle
provider, subtitle-write permission, or server-side video transcoding.
The application ID remains `org.moonfin.webos`.

## Use

1. Play or pause a video in Moonfin. The subtitle service starts automatically.
   Open **Subtitles → 电视在线字幕／本地导入** to see its address or QR code.
2. Open `http://TV-IP:17832` on the same LAN. The address has no token or fragment.
   On first use, request pairing in the browser and approve it in the TV popup.
   The browser remembers approval for 30 days using an HttpOnly, SameSite=Strict
   cookie. The TV panel can revoke remembered browsers.
3. Send an SRT/ASS/SSA/VTT file. It loads into the current video automatically,
   even with the TV subtitle panel closed. The page follows movie changes.
   ZIP/RAR/7z packages show a file picker when they contain several subtitles.
   USB imports scan `/tmp/usb` and `/media/removable` with bounded traversal.
4. ASSRT/OpenSubtitles results can be downloaded and loaded directly on the TV.
   Set personal API credentials in the pairing page before searching. Missing
   credentials are reported before any provider request is sent.
5. The pairing page also has SubHD/Zimuku website links. Complete any website
   verification normally, download a file, then send it through the same page.
   These are browser-assisted sources, not automatic CAPTCHA-solving providers.
6. Imported subtitles appear as a local track. Choose None to disable, or choose
   the local track again to re-enable. Existing offset/appearance controls apply;
   ASS retains its own styling through libass with the bundled Chinese fallback.
7. Local choices and timing are now persistent. Replaying the same movie/media
   version restores the last chosen local file, archive member, encoding and
   offset. Each file/member has independent timing. Before a choice has been
   saved, the latest upload/USB import takes priority over provider downloads.
   Selecting None or a server track disables automatic local restoration until
   a local file is explicitly chosen or a new upload is loaded. Timing is kept
   when disabled. The offset panel shows whether saving succeeded.

UTF-8 and UTF-16 BOMs are detected. Non-UTF-8 input defaults to GB18030; select
Big5 explicitly when needed. Source format and source character encoding are
separate from font support.

## Credentials and cache

The private application directory is `/media/internal/.moonfin-local-subtitles`
(mode 0700; files 0600). It survives normal application upgrades. Passwords are
used only for the OpenSubtitles HTTPS login; only the resulting token is saved.
No API credentials are embedded in the IPK or returned by the status endpoint.
Provider calls use verified HTTPS. The TV's private control token stays inside
the application; it is not in the address or QR code. Browsers use a remembered
cookie after TV approval. Only hashes of browser secrets are stored on disk.
The portal is a LAN HTTP page and should only be used on a trusted local network.
Use its clear-keys button to remove provider credentials.
Selection/timing records are stored separately in `preferences.json` and survive
normal app upgrades and service/TV restarts. They are scoped to the server, movie
and media-source ID. Offsets can still finish saving after the HTTP session has
closed. Deleted or evicted files have their preference records pruned.

Uploads require an approved browser or the private TV control token, reject
unrelated browser origins and Host headers, use generated storage IDs instead
of user paths, and are scoped to a server/item/media-source hash. A stale browser
upload is rejected when its displayed movie no longer matches the TV's movie.
Private TV tokens rotate between movies. Playback keeps the service alive;
leaving the player stops it. A 30-minute watchdog also stops abandoned sessions.
The service caps uploads at 16 MiB and its cache at 96 MiB / 120 files. Single
extracted subtitle files are limited to 4 MiB; encrypted archives require manual
extraction. Unsafe archive paths are discarded. Cache deletion removes only
application-owned files; USB files are read, never written.

No TV sound setting, LG system font, or DTS plugin is changed by this feature.
No subtitle is uploaded to the media server. Movie metadata used for a search is
sent only to the selected subtitle provider.

## Validation and limits

Run Node HTTP integration tests:
`node --test packages/build-webos/service/test/local-subtitles.test.js`

Run the localSubtitleFiles/assRenderer/subtitleText/subtitleStyle tests with Enact.
Browser integration additionally covers pairing/upload/settings/provider fixtures
and actual ZIP/RAR/7z extraction of original bilingual subtitle test data.

Real ASSRT/OpenSubtitles account downloads still require user-owned API keys.
Fixture API tests do not prove account quota, availability or a specific movie's
subtitle match. SubHD/Zimuku availability and website verification remain external.
The standalone service requires Node 12+; the target C5 webOS 25 uses Node 16.

Target-device validation on LG C5 / webOS 25 (Node 16): the installed 3.0.3
service started, authenticated LAN upload/readback passed, and its cache used
0700/0600 permissions. Original bilingual SRT text rendered in the real player;
original ASS rendered through libass with nonempty canvas pixels and the user
confirmed Chinese glyphs displayed correctly. ZIP/RAR/7z imports all completed
using the actual TV archive worker. USB scanning succeeded with no USB subtitles
attached; importing a physical USB file was not exercised. Test imports were
removed and the temporary subtitle track/session disabled after verification.

Version 3.0.4 validation: nine HTTP integration tests cover browser approval,
persistent/revocable cookies, movie changes, stale-upload rejection, origin/Host
checks and existing providers. Playwright verified the plain URL, TV-approval
simulation, remembered login on a second tab, current-movie synchronization,
upload and fixture-provider download. The final installed LG C5 build resumed
the same video after update; its service started automatically with the subtitle
panel closed, showed only plain addresses, and preserved the existing browser
approval. Real provider credentials were not used.

Version 3.0.5 was installed after the user authorized replacement. Its 59 app
tests and 12 service integration tests passed. Local tests cover selection/offset recovery
after service restart, per-member archive timing, explicit disabling, deletion
fallback, cached restoration with the panel closed, and cancellation after
leaving the player. The player suppresses initial server subtitles for a saved
local preference, including avoiding server subtitle burn-in, and restores local
subtitles after initial server-track setup has settled.

Actual LG C5 verification for 3.0.5: the existing local subtitle was selected
automatically. A temporary manual offset persisted to disk and was restored
with the same local track after leaving and reopening the video. The original
alignment was restored after testing. Existing cached subtitles and browser
approval were preserved. No test files were added to the TV.
