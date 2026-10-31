#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Bounded C5 diagnostic, not a Moonfin movie playback implementation.

Run over SSH as root with Moonfin 3.0 foreground and no movie playing.
Only the self-generated, hash-identified six-channel test fixture is accepted.
Installed firmware, Moonfin and DTS Enabler files are never written.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import wave

APP = 'org.moonfin.webos'
FIXTURE_SHA256 = 'a7cc2d38b6be11877e2a349784734e9137618b3dd07220b85c74b4d6a9445850'
MAT = [2, 7, 0, 0, 1]
CONTROL = 'Sndout EARC Outputtype'
stop_requested = False


def report(event, **fields):
    print(json.dumps(dict(time=time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                          event=event, **fields)), flush=True)


def luna(uri, payload):
    master, slave = os.openpty()
    try:
        result = subprocess.run(
            ['luna-send', '-n', '1', '-w', '2500', '-f', uri,
             json.dumps(payload, separators=(',', ':'))],
            stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=5, check=True)
        value = json.loads(result.stdout)
        if isinstance(value, dict) and value.get('returnValue') is False:
            # Do not forward errors that could contain a user's stream URL.
            raise RuntimeError('Native service request rejected')
        return value
    finally:
        os.close(slave)
        os.close(master)


def foreground():
    return luna('luna://com.webos.applicationManager/getForegroundAppInfo', {}).get('appId')


def output_ready():
    value = luna('luna://com.webos.settingsservice/getSystemSettings', {
        'category': 'sound',
        'keys': ['soundOutput', 'soundOutputDigital', 'eArcSupport']})['settings']
    return (value.get('soundOutput') == 'external_arc'
            and value.get('soundOutputDigital') == 'auto'
            and value.get('eArcSupport') == 'on')


def ott():
    value = luna('luna://com.webos.service.audiooutput/quality/getSettings', {
        'category': 'ottAdecMode', 'settings': {}})
    return value['settings'][0]['value']


def set_ott(value):
    luna('luna://com.webos.service.audio/tv/setDolbyOTTMode', {
        'ottmode': bool(value['isOTTEnable']),
        'atmoslocking': bool(value['isATMOSLockingEnable']), 'callerId': APP})


def earc(value=None):
    command = ['amixer', '-c', '0', 'cget' if value is None else 'cset',
               'name=' + CONTROL]
    if value is not None:
        command.append(','.join(map(str, value)))
    output = subprocess.check_output(command, text=True, timeout=4)
    match = re.search(r'^\s*: values=([0-9,]+)\s*$', output, re.M)
    if not match:
        raise RuntimeError('Unexpected eARC control format')
    return [int(v) for v in match[1].split(',')]


def verify_fixture(source):
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != FIXTURE_SHA256:
        raise ValueError('Use the exact self-generated DTS 5.1 fixture; arbitrary streams are not accepted')


def decode_fixture(source, raw, wav):
    env = os.environ.copy()
    env.update(GST_REGISTRY_UPDATE='no',
               GST_REGISTRY_1_0='/mnt/flash/data/gst_1_0_registry.arm.bin',
               GST_REGISTRY_FORK='no')
    command = [
        'gst-launch-1.0', '-q', 'filesrc', 'location=' + str(source), '!',
        'matroskademux', 'name=d', 'd.audio_0', '!', 'queue', '!',
        'dtsdec', 'passthrough=0', 'makeup-gain-db=0', '!', 'audioconvert', '!',
        'audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=6', '!',
        'filesink', 'location=' + str(raw),
        'd.video_0', '!', 'queue', '!', 'fakesink', 'sync=false']
    subprocess.run(command, env=env, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=90, check=True)
    size = raw.stat().st_size
    if not 47 * 48000 * 12 <= size <= 49 * 48000 * 12 or size % 12:
        raise RuntimeError('Unexpected decoded PCM length')
    with wave.open(str(wav), 'wb') as output:
        output.setnchannels(6)
        output.setsampwidth(2)
        output.setframerate(48000)
        with raw.open('rb') as stream:
            for block in iter(lambda: stream.read(12 * 48000), b''):
                output.writeframesraw(block)
    report('tv_decode_complete', channels=6, rate=48000, bits=16, frames=size // 12)


def require_idle_moonfin():
    power = luna('luna://com.webos.service.tvpower/power/getPowerState', {})
    if 'standby' in str(power.get('state', '')).lower() or foreground() != APP:
        raise RuntimeError('Turn the TV on and leave Moonfin foreground')
    if not output_ready():
        raise RuntimeError('Requires HDMI eARC, eARC On and Digital Sound Output Auto')
    for row in luna('luna://com.webos.media/getActivePipelines', {}):
        if row.get('currentAppId') == APP and any(
                r.get('resource') == 'ADEC' for r in row.get('resource', [])):
            raise RuntimeError('Stop the Moonfin movie before starting this isolated diagnostic')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=120)
    parser.add_argument('--window', action='store_true',
                        help='Create a temporary SDL window; this can cover the Moonfin UI')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not 10 <= args.seconds <= 300:
        parser.error('--seconds must be 10 to 300')
    verify_fixture(args.source)
    require_idle_moonfin()
    previous_ott, previous_earc = ott(), earc()
    report('preflight', channels=6, sample_rate=48000,
           dry_run=args.dry_run, native_window=args.window)
    if args.dry_run:
        return
    if os.geteuid() != 0:
        raise RuntimeError('This temporary C5 diagnostic requires root')
    def interrupted(*_):
        global stop_requested
        stop_requested = True
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    child = None
    changed = False
    with tempfile.TemporaryDirectory(prefix='moonfin-dts-pcm51-') as folder:
        root = Path(folder)
        decode_fixture(args.source, root / 'audio.s16', root / 'audio.wav')
        require_idle_moonfin()
        if stop_requested:
            return
        try:
            changed = True
            set_ott({'isOTTEnable': True, 'isATMOSLockingEnable': False})
            command = [sys.executable, '-u', str(Path(__file__).with_name('ndl_probe.py')),
                       '--wave', str(root / 'audio.wav'), '--channels', '6',
                       '--seconds', str(args.seconds), '--repeat', '--app-id', APP]
            if not args.window:
                command.append('--no-window')
            child = subprocess.Popen(command)
            deadline = time.monotonic() + args.seconds + 15
            while child.poll() is None and not stop_requested and time.monotonic() < deadline:
                if foreground() != APP or not output_ready():
                    report('stopping', reason='Application or audio route changed')
                    break
                if earc() != MAT:
                    actual = earc(MAT)
                    report('mat_requested', actual=actual)
                    if actual != MAT:
                        raise RuntimeError('MAT output request rejected')
                time.sleep(.6)
            report('probe_end', child_exit=child.poll(), interrupted=stop_requested)
        finally:
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            if changed:
                try:
                    set_ott(previous_ott)
                finally:
                    if foreground() == APP and output_ready():
                        earc(previous_earc)
                report('restored', ott=ott(), earc=earc())


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        # File/decoder errors may contain paths. The source is a known local
        # fixture, but still keep logs limited to the error class.
        report('failed', error_class=type(error).__name__,
               reason=str(error) if isinstance(error, (RuntimeError, ValueError)) else None)
        raise SystemExit(1)
