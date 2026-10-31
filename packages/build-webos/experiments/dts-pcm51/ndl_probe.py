# SPDX-License-Identifier: MPL-2.0
#!/usr/bin/env python3
"""Bounded, temporary NDL API-v2 PCM probe. No configuration writes."""
import argparse, ctypes as C, datetime, json, os, signal, sys, time, wave
p=argparse.ArgumentParser();p.add_argument('--wave',required=True);p.add_argument('--seconds',type=float,default=48);p.add_argument('--channels',type=int,choices=[2,6],default=6);p.add_argument('--app-id',default='org.codex.ndlpcmprobe');p.add_argument('--h264');p.add_argument('--no-window',action='store_true');p.add_argument('--repeat',action='store_true');a=p.parse_args()
def log(event,**kv):print(json.dumps(dict(timestamp=datetime.datetime.now().astimezone().isoformat(),event=event,**kv)),flush=True)
video_frames=[]
if a.h264:
 import re
 data=open(a.h264,'rb').read();starts=[m.start() for m in re.finditer(b'\x00\x00(?:\x00)?\x01\x09',data)]
 video_frames=[data[x:y] for x,y in zip(starts,starts[1:]+[len(data)])]
 if not video_frames:raise ValueError('No H.264 access unit delimiters')
class Video(C.Structure):_fields_=[('width',C.c_int),('height',C.c_int),('type',C.c_int),('padding',C.c_int)]
class PCM(C.Structure):_fields_=[('type',C.c_int),('padding',C.c_int),('format',C.c_char_p),('layout',C.c_char_p),('channelMode',C.c_char_p),('sampleRate',C.c_int)]
class Opus(C.Structure):_fields_=[('type',C.c_int),('padding',C.c_int),('channels',C.c_int),('padding2',C.c_int),('rate',C.c_double),('header',C.c_char_p)]
class Audio(C.Union):_fields_=[('type',C.c_int),('pcm',PCM),('opus',Opus),('padding',C.c_char*32)]
class Info(C.Structure):_fields_=[('video',Video),('audio',Audio)]
assert C.sizeof(C.c_void_p)==4 and C.sizeof(PCM)==24 and C.sizeof(Info)==48 and Info.audio.offset==16
os.environ['APPID']=a.app_id
os.environ.setdefault('XDG_RUNTIME_DIR','/tmp/xdg')
sdl=C.CDLL('libSDL2-2.0.so.0',mode=C.RTLD_GLOBAL)
sdl.SDL_Init.argtypes=[C.c_uint];sdl.SDL_Init.restype=C.c_int
sdl.SDL_CreateWindow.argtypes=[C.c_char_p,C.c_int,C.c_int,C.c_int,C.c_int,C.c_uint];sdl.SDL_CreateWindow.restype=C.c_void_p
sdl.SDL_GetError.restype=C.c_char_p;sdl.SDL_DestroyWindow.argtypes=[C.c_void_p]
sdl.SDL_PumpEvents.argtypes=[];sdl.SDL_Quit.argtypes=[]
lib=C.CDLL('libNDL_directmedia.so.1',mode=C.RTLD_GLOBAL)
glib=C.CDLL('libglib-2.0.so.0');glib.g_main_context_iteration.argtypes=[C.c_void_p,C.c_int];glib.g_main_context_iteration.restype=C.c_int
LoadCB=C.CFUNCTYPE(None,C.c_int,C.c_longlong,C.c_char_p)
MultiCB=C.CFUNCTYPE(None,C.c_int,C.c_char_p)
state={'loaded':False,'async_error':False,'stop':False}
@LoadCB
def onload(t,n,s):
 log('callback',type=hex(t),value=n,text=s.decode(errors='replace') if s else None)
 if t==0x16:state['loaded']=True
 if t==0x12:state['async_error']=True
@MultiCB
def onmulti(code,s):log('multichannel_callback',code=code,text=s.decode(errors='replace') if s else None)
for name,args,ret in [('NDL_DirectMediaInit',[C.c_char_p],C.c_int),('NDL_DirectMediaQuit',[],C.c_int),('NDL_DirectMediaSetAppState',[C.c_int],C.c_int),('NDL_DirectMediaLoad',[C.POINTER(Info),LoadCB],C.c_int),('NDL_DirectMediaUnload',[],C.c_int),('NDL_DirectVideoPlay',[C.c_void_p,C.c_uint,C.c_longlong],C.c_int),('NDL_DirectAudioPlay',[C.c_void_p,C.c_uint,C.c_longlong],C.c_int),('NDL_DirectAudioSupportMultiChannel',[C.POINTER(C.c_int)],C.c_int),('NDL_DirectAudioRegisterCallback',[MultiCB],C.c_int),('NDL_DirectAudioGetAvailableBufferSize',[C.POINTER(C.c_int)],C.c_int),('NDL_DirectMediaGetError',[],C.c_char_p)]:
 fn=getattr(lib,name);fn.argtypes=args;fn.restype=ret

def pump():
 sdl.SDL_PumpEvents()
 for _ in range(8):
  if not glib.g_main_context_iteration(None,0):break

def support(stage):
 value=C.c_int(-999);rc=lib.NDL_DirectAudioSupportMultiChannel(C.byref(value));log('multichannel_support',stage=stage,rc=rc,code=value.value)

def stop(*_):state['stop']=True
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop);signal.signal(signal.SIGHUP,stop)
initialized=False;load_requested=False;accepted=failed=0;last_report=-1;exit_code=0;window=None;sdl_initialized=False
try:
 log('start',app_id=a.app_id,channels=a.channels,format='S16LE',layout='interleaved',sample_rate_hz=48000,info_bytes=C.sizeof(Info))
 sr=sdl.SDL_Init(0 if a.no_window else 0x20);log('sdl_init',rc=sr,error=sdl.SDL_GetError().decode(errors='replace'))
 if sr:raise RuntimeError('SDL video init failed')
 sdl_initialized=True
 window=None if a.no_window else sdl.SDL_CreateWindow(b'NDL PCM 5.1 probe',0x2FFF0000,0x2FFF0000,640,360,4)
 log('native_window',created=bool(window),error=sdl.SDL_GetError().decode(errors='replace'))
 if not window and not a.no_window:raise RuntimeError('Native window creation failed')
 rc=lib.NDL_DirectMediaInit(a.app_id.encode());log('init',rc=rc)
 if rc:raise RuntimeError('NDL init failed')
 initialized=True
 log('foreground',rc=lib.NDL_DirectMediaSetAppState(0));log('register_callback',rc=lib.NDL_DirectAudioRegisterCallback(onmulti));support('before_load')
 info=Info();info.video=Video(640,360,1,0) if video_frames else Video();info.audio.pcm=PCM(1,0,b'S16LE',b'interleaved',b'6-channel' if a.channels==6 else b'stereo',1)
 origin=time.monotonic();rc=lib.NDL_DirectMediaLoad(C.byref(info),onload);log('load',rc=rc,error=lib.NDL_DirectMediaGetError().decode(errors='replace') if rc else None);load_requested=(rc==0)
 if rc:raise RuntimeError('NDL load failed')
 log('foreground_after_load',rc=lib.NDL_DirectMediaSetAppState(0))
 if video_frames:
  first_video=C.create_string_buffer(video_frames[0]);log('video_prime',rc=lib.NDL_DirectVideoPlay(first_video,len(video_frames[0]),40),access_units=len(video_frames))
 zero=C.create_string_buffer(480*a.channels*2)
 for _ in range(80):
  pump()
  if state['loaded'] or state['stop'] or state['async_error']:break
  rc=lib.NDL_DirectAudioPlay(zero,len(zero),int((time.monotonic()-origin)*1000)+40)
  if _%10==0:log('prime',iteration=_,rc=rc)
  time.sleep(.025)
 pump();support('after_prime');log('primed',load_callback_seen=state['loaded'],async_error=state['async_error'])
 if state['async_error']:raise RuntimeError('NDL reported an asynchronous error')
 with wave.open(a.wave,'rb') as w:
  assert (w.getnchannels(),w.getsampwidth(),w.getframerate())==(6,2,48000)
  start=time.monotonic();next_time=start;frames=0;video_index=1;video_accepted=0;video_failed=0;limit=int(a.seconds*48000) if a.repeat else min(w.getnframes(),int(a.seconds*48000));cycle=0
  while frames<limit and not state['stop']:
   pump()
   if state['async_error']:raise RuntimeError('NDL reported an asynchronous playback error')
   now=time.monotonic()
   if now<next_time:time.sleep(min(next_time-now,.01));continue
   if video_frames and video_index<len(video_frames) and video_index/25.0 <= (now-start)%48:
    vr=video_frames[video_index];vb=C.create_string_buffer(vr);vc=lib.NDL_DirectVideoPlay(vb,len(vr),int((now-origin)*1000)+80)
    video_index+=1
    if vc:video_failed+=1
    else:video_accepted+=1
   raw=w.readframes(min(480,limit-frames))
   if not raw:
    if not a.repeat:break
    w.rewind();cycle+=1;video_index=0;raw=w.readframes(min(480,limit-frames));log('cycle',number=cycle+1)
   if a.channels==2:
    import array
    samples=array.array('h');samples.frombytes(raw);stereo=array.array('h')
    for j in range(0,len(samples),6):stereo.extend(samples[j:j+2])
    raw=stereo.tobytes()
   buf=C.create_string_buffer(raw);rc=lib.NDL_DirectAudioPlay(buf,len(raw),int((now-origin)*1000)+40)
   if rc:failed+=1
   else:accepted+=1
   frames+=len(raw)//(a.channels*2);next_time+=len(raw)/(48000*a.channels*2)
   sec=int(now-start)
   if sec!=last_report:
    avail=C.c_int(-1);ar=lib.NDL_DirectAudioGetAvailableBufferSize(C.byref(avail));log('feeding',seconds=sec,cycle=sec//48+1,channel=['FL','FR','FC','LFE','SL','SR'][(sec%48)//8],accepted=accepted,failed=failed,available_rc=ar,available_bytes=avail.value);last_report=sec
    if sec%5==0:support('feeding_'+str(sec))
  end=time.monotonic()+.3
  while time.monotonic()<end and not state['stop']:pump();time.sleep(.01)
 log('complete',accepted=accepted,failed=failed,load_callback_seen=state['loaded'],video_accepted=video_accepted,video_failed=video_failed)
except Exception as e:
 log('error',message=str(e));exit_code=1
finally:
 if load_requested:log('unload',rc=lib.NDL_DirectMediaUnload())
 if initialized:log('quit',rc=lib.NDL_DirectMediaQuit())
 if window:sdl.SDL_DestroyWindow(window)
 if sdl_initialized:sdl.SDL_Quit()
 log('finished')

sys.exit(exit_code)
