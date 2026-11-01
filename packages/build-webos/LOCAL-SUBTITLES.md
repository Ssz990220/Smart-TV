# Standalone TV subtitles (webOS 3.0.3 personal fork)

The TV fetches and renders these subtitles without an Emby/Jellyfin subtitle
provider, subtitle-write permission, or server-side video transcoding.
The application ID remains `org.moonfin.webos`.

## Use

1. Play a video, open Subtitles, then **电视在线字幕／本地导入**.
2. Scan the locally generated QR code from a phone on the same LAN, or open the
   displayed full pairing link on a Mac. The link expires after 30 minutes.
3. Send an SRT/ASS/SSA/VTT file. The open TV panel loads it automatically.
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

UTF-8 and UTF-16 BOMs are detected. Non-UTF-8 input defaults to GB18030; select
Big5 explicitly when needed. Source format and source character encoding are
separate from font support.

## Credentials and cache

The private application directory is `/media/internal/.moonfin-local-subtitles`
(mode 0700; files 0600). It survives normal application upgrades. Passwords are
used only for the OpenSubtitles HTTPS login; only the resulting token is saved.
No API credentials are embedded in the IPK or returned by the status endpoint.
Provider calls use verified HTTPS. Private pairing tokens travel in the URL
fragment initially and in Authorization headers for requests, never query strings.
The portal is a LAN HTTP page and should only be used on a trusted local network.
Use its clear-keys button to remove provider credentials.

Uploads require the current pairing token, reject unrelated browser origins,
use generated storage IDs instead of user paths, and are scoped to a server/item/
media-source hash. Sessions rotate between items and expire after 30 minutes.
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
