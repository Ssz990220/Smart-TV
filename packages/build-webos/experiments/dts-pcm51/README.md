# DTS decode → PCM 5.1 feasibility probe for Moonfin 3.0

This is an opt-in SSH diagnostic for a rooted LG C5 running webOS 25. It is
**not a working Moonfin movie playback backend**, and the webOS build does not
package or invoke these files. It changes no installed Moonfin, system, or DTS
Enabler files. Do not expose it as a successful PCM setting in the app yet.

## Evidence collected on the test TV

- Moonfin 3.0.0 is installed. Its existing webOS player still sets an HTML
  video element's source and delegates playback to Starfish.
- A separate NDL test, using PCM decoded on a Mac, activated `pcm-multi-ch`,
  delivered a Dolby MAT 5.1 carrier to Sonos Arc Ultra, and passed the user's
  separate rear-left, rear-right, and audible-LFE listening checks.
- The TV's already-installed `dtsdec` also decoded the same DTS fixture into
  six-channel, 48 kHz, S16LE PCM. Per-slot sample measurements confirmed the
  order FL, FR, FC, LFE, SL, SR. No new decoder was installed.
- **The complete TV-decode + NDL path with Moonfin's web-app identity has not
  passed a listening test.** The TV was in standby when this probe was prepared.
- No 7.1, DTS-HD MA, movie seeking, subtitles, video synchronization, or streaming
  authentication integration has been validated.

The successful NDL route differs from the failing native DTS route in several
ways, including the PCM flag, sample format, channel mask, and playback
framework. The experiment does not establish that the flag alone fixes it.

## Run the next controlled test

Copy this folder and the previously generated 48-second DTS 5.1 test fixture to
a private temporary folder on the TV. The fixture is identified by SHA-256:

```text
a7cc2d38b6be11877e2a349784734e9137618b3dd07220b85c74b4d6a9445850
```

Turn the TV on, select HDMI eARC output with eARC enabled and Digital Sound
Output Auto, and leave Moonfin foreground with its movie stopped. This probe
rejects an active Moonfin audio pipeline rather than stopping a user's movie.

```sh
python3 probe.py --source /tmp/channel-test.mkv --dry-run
python3 probe.py --source /tmp/channel-test.mkv --seconds 120
```

The default uses audio-only NDL without creating an SDL window, to test whether
the existing Moonfin web-app surface is sufficient. `--window` enables the
temporary native window used in the earlier Moonlight-context probe; this can
cover the Moonfin interface. Both variants remain unvalidated in Moonfin.

The probe decodes the fixture on the TV before playback, temporarily enables
OTT/MAT, feeds six-channel PCM through NDL, and stops after at most five minutes
of audio. Timeout, SIGTERM, SIGHUP, and Ctrl-C trigger unload/quit and restoration
of the captured OTT setting. The old eARC control is restored only if Moonfin
and the same sound-output selection remain active. Leaving Moonfin stops the
probe. No permanent MAT loop or startup hook is installed.

Listen in 8-second slots: front left, front right, center, LFE, surround left,
surround right. Each slot includes silence. Confirm the receiver's format and
the physical location of the last two tones; a 5.1 badge alone is insufficient.

## Integration gate

Before wiring a movie playback option into Moonfin, establish whether an NDL
audio process can coexist with its web player, how audio resource ownership and
muting work, and how pause, seek, track changes, backgrounding and clock drift
will be synchronized. Moonfin's app service runs as an unprivileged user on the
test TV, while this probe needs root for the private route controls. Root/helper
access must be explicit and unavailable on ordinary TVs, with no arbitrary
command or stream credential exposed in logs.

Do not substitute a server's lossy AC3/AAC encode or DTS bitstream passthrough
for this goal. A production option must accurately describe where DTS decoding
happens and verify that it preserves the requested PCM channels.
