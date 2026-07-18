#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <vector>
#include <mutex>
#include <thread>
#include <atomic>
#include <cmath>
#include <cstring>

class Capture {
public:
  std::vector<float> refBuffer;
  std::mutex refMutex;
  std::vector<float> delayLine;
  size_t delayPos=0,refWritePos=0,refSize=0;
  float estimatedGain=0.5f;
  bool runningFlag=false,firstRef=true;
  static constexpr size_t MAX_DELAY=96000;

  IMMDeviceEnumerator* enumerator=nullptr;
  IMMDevice* device=nullptr;
  IAudioClient* audioClient=nullptr;
  IAudioCaptureClient* captureClient=nullptr;
  WAVEFORMATEX* mixFormat=nullptr;
  UINT32 bufFrames=0;
  HANDLE captureEvent=nullptr;
  std::thread captureThread;
  Napi::ThreadSafeFunction dataCb,errCb;

  Capture():delayLine(MAX_DELAY,0.0f){}
  ~Capture(){stop();cleanup();}

  void start(Napi::Function dataCbFn,Napi::Function errCbFn){
    if(runningFlag)return;
    dataCb=Napi::ThreadSafeFunction::New(dataCbFn.Env(),dataCbFn,"data",0,1);
    errCb=Napi::ThreadSafeFunction::New(errCbFn.Env(),errCbFn,"err",0,1);
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
    if(dataCb){dataCb.Release();}
    if(errCb){errCb.Release();}
  }

  void pushRef(float* data,size_t frames){
    std::lock_guard<std::mutex> lk(refMutex);
    refBuffer.resize(frames);
    memcpy(refBuffer.data(),data,frames*sizeof(float));
    refSize=frames;
    refWritePos=0;
    firstRef=true;
  }

  Napi::Object getFormat(Napi::Env env){
    auto o=Napi::Object::New(env);
    if(!mixFormat){
      o.Set("available",Napi::Boolean::New(env,false));
      return o;
    }
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

  void process(BYTE* data,UINT32 frames){
    int ch=mixFormat->nChannels;
    std::vector<float> clean(frames);
    std::vector<float> refFrames(frames);
    bool hasRef=false;
    {
      std::lock_guard<std::mutex> lk(refMutex);
      if(refSize>0){
        for(UINT32 i=0;i<frames;i++){refFrames[i]=refBuffer[refWritePos%refSize];refWritePos=(refWritePos+1)%refSize;}
        hasRef=true;
      }
    }
    if(mixFormat->wFormatTag==WAVE_FORMAT_IEEE_FLOAT){
      float* f=(float*)data;
      for(UINT32 i=0;i<frames;i++){
        float s=0;for(int c=0;c<ch;c++)s+=f[i*ch+c];s/=ch;
        if(hasRef){
          float r=refFrames[i];
          float captured=s;
          clean[i]=captured-estimatedGain*r;
          if(fabsf(r)>0.0001f){float num=captured*r;float den=r*r+1e-10f;estimatedGain=0.9995f*estimatedGain+0.0005f*num/den;if(estimatedGain<0)estimatedGain=0;if(estimatedGain>1)estimatedGain=1;}
        }else clean[i]=s;
      }
    }else{
      for(UINT32 i=0;i<frames;i++){
        float s=0;
        if(mixFormat->wBitsPerSample==16){INT16*ps=(INT16*)data;for(int c=0;c<ch;c++)s+=ps[i*ch+c];s/=ch*32768.0f;}
        else if(mixFormat->wBitsPerSample==32){INT32*pl=(INT32*)data;for(int c=0;c<ch;c++)s+=pl[i*ch+c];s/=ch*2147483648.0f;}
        if(hasRef){
          float r=refFrames[i];
          float captured=s;
          clean[i]=captured-estimatedGain*r;
          if(fabsf(r)>0.0001f){float num=captured*r;float den=r*r+1e-10f;estimatedGain=0.9995f*estimatedGain+0.0005f*num/den;if(estimatedGain<0)estimatedGain=0;if(estimatedGain>1)estimatedGain=1;}
        }else clean[i]=s;
      }
    }
    float* buf=new float[frames];
    memcpy(buf,clean.data(),frames*sizeof(float));
    UINT32 fCopy=frames;
    dataCb.BlockingCall([buf,fCopy](Napi::Env e,Napi::Function cb){
      auto ab=Napi::ArrayBuffer::New(e,buf,fCopy*sizeof(float));
      cb.Call({ab,Napi::Number::New(e,(double)fCopy)});
    });
  }

  void emitErr(const char* msg){
    errCb.BlockingCall([msg](Napi::Env e,Napi::Function cb){
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
  Napi::Env env=info.Env();
  auto* cap=static_cast<Capture*>(info.Data());
  if(!info[0].IsFunction()||!info[1].IsFunction())throw Napi::Error::New(env,"args: dataCallback, errorCallback");
  cap->start(info[0].As<Napi::Function>(),info[1].As<Napi::Function>());
  return env.Undefined();
}
static Napi::Value Stop(const Napi::CallbackInfo& info){
  auto* cap=static_cast<Capture*>(info.Data());
  cap->stop();
  return info.Env().Undefined();
}
static Napi::Value PushRef(const Napi::CallbackInfo& info){
  auto* cap=static_cast<Capture*>(info.Data());
  auto buf=info[0].As<Napi::Buffer<float>>();
  cap->pushRef(buf.Data(),buf.Length());
  return info.Env().Undefined();
}
static Napi::Value GetFormat(const Napi::CallbackInfo& info){
  auto* cap=static_cast<Capture*>(info.Data());
  return cap->getFormat(info.Env());
}
static Napi::Object Init(Napi::Env env,Napi::Object exports){
  auto* cap=new Capture();
  exports.Set("start",Napi::Function::New(env,Start,"start",cap));
  exports.Set("stop",Napi::Function::New(env,Stop,"stop",cap));
  exports.Set("pushReference",Napi::Function::New(env,PushRef,"pushReference",cap));
  exports.Set("getFormat",Napi::Function::New(env,GetFormat,"getFormat",cap));
  // Clean up on module unload
  auto cleanup=[](void* data){delete static_cast<Capture*>(data);};
  napi_add_env_cleanup_hook(env,cleanup,cap);
  return exports;
}
NODE_API_MODULE(pair_capture,Init)
