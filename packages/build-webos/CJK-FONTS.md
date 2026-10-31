# Offline CJK font fix for Moonfin 3.0

This fork's webOS 3.0.1 build fixes missing Chinese glyphs in the interface and
subtitles without changing the TV's regional firmware or system fonts.

* Bundle the unmodified, full Noto Sans CJK SC Regular font, not a small subset.
* Use a CJK-only CSS face before app theme fonts. Latin text retains its own face.
* Supply normal, italic, and condensed Sandstone CJK faces for controls that
  declare their own family, including semibold controls.
* Share the same bundled file with the libass worker as its ASS/SSA fallback.
  Keep media font attachments and subtitle styles; no blanket font replacement.
* Keep the app ID `org.moonfin.webos`, so an update can preserve app storage.

Run `python3 scripts/check-cjk-font.py` to verify the pinned font and GB2312/Big5
Han coverage. The provenance and OFL license are in `packages/app/resources/fonts`.
Run the ASS constructor, subtitle text/style, and theme override tests with Enact.
The webOS build packages the license and fails if the font or license is absent.

The font covers common simplified and traditional Chinese and many uncommon Han
characters. No single font promises every Unicode Han character. This fixes
missing glyphs, not invalid source encoding or missing text in an image subtitle.
A later upstream app update will replace this build; keep this patch when merging
upstream versions. The stock TV and DTS plugin are not modified by this fix.
