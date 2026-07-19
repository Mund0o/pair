#define NOMINMAX
#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <vector>
#include <mutex>
#include <thread>
#include <atomic>
#include <cmath>
#include <cstring>
#include <cstdlib>

class Capture {
public:
  std::vector<float> refRing;
  std::mutex refMutex;
  uint64_t refWritten=0;
  float estimatedGain=0.5f;
  int bestDelay=2048;
  bool runningFlag=false;
  static constexpr int RING_SIZE=96000;

  IMMDeviceEnumerator* enumerator=nullptr;
  IMMDevice* device=nullptr;
  IAudioClient* audioClient=nullptr;
  IAudioCaptureClient* captureClient=nullptr;
  WAVEFORMATEX* mixFormat=nullptr;
  UINT32 bufFrames=0;
  HANDLE captureEvent=nullptr;
  std::thread captureThread;
  Napi::ThreadSafeFunction dataCb,errCb;

  Capture():refRing(RING_SIZE,0.0f){}
  ~Capture(){stop();cleanup();}

  void start(Napi::Function dataCbFn,Napi::Function errCbFn){
    if(runningFlag)return;
    dataCb=Napi::ThreadSafeFunction::New(
      dataCbFn.Env(),dataCbFn,Napi::String::New(dataCbFn.Env(),"data"),0,1
    );
    errCb=Napi::ThreadSafeFunction::New(
      errCbFn.Env(),errCbFn,Napi::String::New(errCbFn.Env(),"err"),0,1
    );
    HRESULT hr=initWasapi();
    if(FAILED(hr)){
      char m[128];sprintf(m,"WASAPI init failed: 0x%08lX",(unsigned long)hr);
      throw Napi::Error::New(dataCbFn.Env(),m);
    }
    runningFlag=true;
    captureThread=std::thread(&Capture::loop,this);
  }

  void stop(){
    runningFlag=false;
    if(captureThread.joinable())captureThread.join();
    if(dataCb){dataCb.Release();dataCb=nullptr;}
    if(errCb){errCb.Release();errCb=nullptr;}
  }

  void pushRef(float* data,size_t frames){
    std::lock_guard<std::mutex> lk(refMutex);
    for(size_t i=0;i<frames;i++){
      refRing[(refWritten+i)%RING_SIZE]=data[i];
    }
    refWritten+=frames;
  }

  Napi::Object getFormat(Napi::Env env){
    auto o=Napi::Object::New(env);
    if(!mixFormat){o.Set("available",Napi::Boolean::New(env,false));return o;}
    o.Set("sampleRate",Napi::Number::New(env,(double)mixFormat->nSamplesPerSec));
    o.Set("channels",Napi::Number::New(env,(double)mixFormat->nChannels));
    o.Set("bitsPerSample",Napi::Number::New(env,(double)mixFormat->wBitsPerSample));
    o.Set("sampleType",mixFormat->wFormatTag==WAVE_FORMAT_IEEE_FLOAT?Napi::String::New(env,"float"):Napi::String::New(env,"pcm"));
    return o;
  }

private:
  HRESULT initWasapi(){
    HRESULT hr;
    hr=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if(FAILED(hr))return hr;
    hr=CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,__uuidof(IMMDeviceEnumerator),(void**)&enumerator);
    if(FAILED(hr))return hr;
    hr=enumerator->GetDefaultAudioEndpoint(eRender,eConsole,&device);
    if(FAILED(hr))return hr;
    hr=device->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,(void**)&audioClient);
    if(FAILED(hr))return hr;
    hr=audioClient->GetMixFormat(&mixFormat);
    if(FAILED(hr))return hr;
    hr=audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_EVENTCALLBACK,0,0,mixFormat,nullptr);
    if(FAILED(hr))return hr;
    hr=audioClient->GetBufferSize(&bufFrames);
    if(FAILED(hr))return hr;
    captureEvent=CreateEvent(nullptr,FALSE,FALSE,nullptr);
    if(!captureEvent)return E_FAIL;
    hr=audioClient->SetEventHandle(captureEvent);
    if(FAILED(hr))return hr;
    hr=audioClient->GetService(__uuidof(IAudioCaptureClient),(void**)&captureClient);
    return hr;
  }

  void loop(){
    HRESULT hr=audioClient->Start();
    if(FAILED(hr)){emitErr("start failed");return;}
    while(runningFlag){
      if(WaitForSingleObject(captureEvent,500)!=WAIT_OBJECT_0)continue;
      UINT32 pktLen=0;
      hr=captureClient->GetNextPacketSize(&pktLen);
      while(pktLen>0&&runningFlag){
        BYTE* data=nullptr;UINT32 frames=0;DWORD flags=0;
        hr=captureClient->GetBuffer(&data,&frames,&flags,nullptr,nullptr);
        if(FAILED(hr)||frames==0){if(FAILED(hr))break;captureClient->ReleaseBuffer(frames);hr=captureClient->GetNextPacketSize(&pktLen);continue;}
        if(!(flags&AUDCLNT_BUFFERFLAGS_SILENT))process(data,frames);
        captureClient->ReleaseBuffer(frames);
        hr=captureClient->GetNextPacketSize(&pktLen);
      }
    }
    audioClient->Stop();
  }

  void updateDelay(float* captured,int frames,int sr){
    if(refWritten<(uint64_t)(sr*0.05))return;
    static int counter=0;
    if(++counter%30!=0)return;

    int maxD=std::min((int)(sr*0.15),RING_SIZE-frames-256);
    int minD=(int)(sr*0.01);
    if(minD<256)minD=256;
    if(maxD<=minD)return;

    float bestCorr=0;int bestD=bestDelay;
    int n=std::min(frames,256);
    for(int d=minD;d<maxD;d+=4){
      float c=0,nc=0,nr=0;
      for(int i=0;i<n;i++){
        float cap=captured[i];
        float ref=refRing[(refWritten-d+i)%RING_SIZE];
        c+=cap*ref;nc+=cap*cap;nr+=ref*ref;
      }
      float denom=sqrtf(nc*nr);
      if(denom>1e-10f&&c/denom>bestCorr){bestCorr=c/denom;bestD=d;}
    }
    if(bestCorr>0.3f)bestDelay=(bestDelay*3+bestD)/4;
  }

  void process(BYTE* data,UINT32 frames){
    int ch=mixFormat->nChannels;
    int sr=(int)mixFormat->nSamplesPerSec;
    std::vector<float> captured(frames);
    if(mixFormat->wFormatTag==WAVE_FORMAT_IEEE_FLOAT){
      float* f=(float*)data;
      for(UINT32 i=0;i<frames;i++){float s=0;for(int c=0;c<ch;c++)s+=f[i*ch+c];captured[i]=s/ch;}
    }else if(mixFormat->wBitsPerSample==16){
      INT16* ps=(INT16*)data;
      for(UINT32 i=0;i<frames;i++){float s=0;for(int c=0;c<ch;c++)s+=ps[i*ch+c];captured[i]=s/(ch*32768.0f);}
    }else{
      INT32* pl=(INT32*)data;
      for(UINT32 i=0;i<frames;i++){float s=0;for(int c=0;c<ch;c++)s+=pl[i*ch+c];captured[i]=s/(ch*2147483648.0f);}
    }

    int delay=bestDelay;
    std::vector<float> clean(frames);
    {
      std::lock_guard<std::mutex> lk(refMutex);
      if(refWritten>(uint64_t)(delay+frames)){
        updateDelay(captured.data(),frames,sr);
        delay=bestDelay;
        for(UINT32 i=0;i<frames;i++){
          float r=refRing[(refWritten-delay+i)%RING_SIZE];
          float c=captured[i];
          clean[i]=c-estimatedGain*r;
          if(fabsf(r)>0.0001f){
            float num=c*r,den=r*r+1e-10f;
            estimatedGain=0.9995f*estimatedGain+0.0005f*num/den;
            if(estimatedGain<0)estimatedGain=0;if(estimatedGain>1)estimatedGain=1;
          }
        }
      }else memcpy(clean.data(),captured.data(),frames*sizeof(float));
    }

    float* buf=(float*)calloc(frames,sizeof(float));
    memcpy(buf,clean.data(),frames*sizeof(float));
    UINT32 fCopy=frames;
    auto status=dataCb.NonBlockingCall([buf,fCopy](Napi::Env e,Napi::Function cb){
      auto ab=Napi::ArrayBuffer::New(e,buf,fCopy*sizeof(float));
      cb.Call({ab,Napi::Number::New(e,(double)fCopy)});
    });
    if(status!=napi_ok){
      free(buf);
    }
  }

  void emitErr(const char* msg){
    errCb.NonBlockingCall([msg](Napi::Env e,Napi::Function cb){
      cb.Call({Napi::String::New(e,msg)});
    });
  }

  void cleanup(){
    if(captureEvent)CloseHandle(captureEvent);
    if(captureClient)captureClient->Release();
    if(audioClient)audioClient->Release();
    if(mixFormat)CoTaskMemFree(mixFormat);
    if(device)device->Release();
    if(enumerator)enumerator->Release();
    CoUninitialize();
  }
};

static Napi::Value Start(const Napi::CallbackInfo& info){
  auto* cap=static_cast<Capture*>(info.Data());
  if(!info[0].IsFunction()||!info[1].IsFunction())throw Napi::Error::New(info.Env(),"args: dataCallback, errorCallback");
  cap->start(info[0].As<Napi::Function>(),info[1].As<Napi::Function>());
  return info.Env().Undefined();
}
static Napi::Value Stop(const Napi::CallbackInfo& info){
  static_cast<Capture*>(info.Data())->stop();
  return info.Env().Undefined();
}
static Napi::Value PushRef(const Napi::CallbackInfo& info){
  float* data=nullptr;
  size_t len=0;
  if(info[0].IsBuffer()){
    auto buf=info[0].As<Napi::Buffer<float>>();
    data=buf.Data();len=buf.Length();
  }else if(info[0].IsTypedArray()){
    auto arr=info[0].As<Napi::TypedArray>();
    data=(float*)arr.ArrayBuffer().Data();len=arr.ElementLength();
  }
  if(data&&len>0)static_cast<Capture*>(info.Data())->pushRef(data,len);
  return info.Env().Undefined();
}
static Napi::Value GetFormat(const Napi::CallbackInfo& info){
  return static_cast<Capture*>(info.Data())->getFormat(info.Env());
}
static Napi::Object Init(Napi::Env env,Napi::Object exports){
  auto* cap=new Capture();
  exports.Set("start",Napi::Function::New(env,Start,"start",cap));
  exports.Set("stop",Napi::Function::New(env,Stop,"stop",cap));
  exports.Set("pushReference",Napi::Function::New(env,PushRef,"pushReference",cap));
  exports.Set("getFormat",Napi::Function::New(env,GetFormat,"getFormat",cap));
  napi_add_env_cleanup_hook(env,[](void* d){delete static_cast<Capture*>(d);},cap);
  return exports;
}
NODE_API_MODULE(pair_capture,Init)
