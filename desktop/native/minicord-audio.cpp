// Captura o áudio do sistema EXCETO o de um processo (e seus filhos), usando a
// API de Process Loopback do Windows (a mesma técnica do Discord).
// Assim, ao compartilhar a tela, a voz dos amigos que toca no Minicord não volta para eles.
//
// Uso: minicord-audio.exe <pid-a-excluir>
// Saída (stdout): PCM float32 intercalado, 2 canais, 48000 Hz. Encerra quando o stdin fecha.

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>
#include <fcntl.h>
#include <io.h>
#include <cstdio>
#include <vector>

#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "ole32.lib")

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

static const UINT32 kRate = 48000;
static const UINT16 kChannels = 2;

class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  ComPtr<IAudioClient> client;

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT activateResult = E_FAIL;
    ComPtr<IUnknown> unknown;
    result = op->GetActivateResult(&activateResult, &unknown);
    if (SUCCEEDED(result)) result = activateResult;
    if (SUCCEEDED(result)) result = unknown.As(&client);
    SetEvent(done);
    return S_OK;
  }
};

static int fail(const char* step, HRESULT hr, int code) {
  fprintf(stderr, "%s falhou: 0x%08lx\n", step, static_cast<unsigned long>(hr));
  return code;
}

// Encerra quando o processo pai fecha o stdin (ou morre).
static DWORD WINAPI WatchStdin(LPVOID) {
  char buf[64];
  while (fread(buf, 1, sizeof(buf), stdin) > 0) {
  }
  ExitProcess(0);
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) {
    fprintf(stderr, "uso: minicord-audio.exe <pid>\n");
    return 2;
  }
  const DWORD pid = wcstoul(argv[1], nullptr, 10);
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
  CreateThread(nullptr, 0, WatchStdin, nullptr, 0, nullptr);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail("CoInitializeEx", hr, 3);

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activateParams = {};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(params);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto handler = Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activateParams,
                                   handler.Get(), &op);
  if (FAILED(hr)) return fail("ActivateAudioInterfaceAsync", hr, 4);
  if (WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0) return fail("Ativação (timeout)", E_FAIL, 5);
  if (FAILED(handler->result)) return fail("Ativação", handler->result, 6);
  IAudioClient* client = handler->client.Get();

  // Tenta float32 direto; se o sistema recusar, captura em PCM 16 bits e converte.
  bool isFloat = true;
  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  fmt.nChannels = kChannels;
  fmt.nSamplesPerSec = kRate;
  fmt.wBitsPerSample = 32;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, &fmt, nullptr);
  if (FAILED(hr)) {
    isFloat = false;
    fmt.wFormatTag = WAVE_FORMAT_PCM;
    fmt.wBitsPerSample = 16;
    fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, &fmt, nullptr);
    if (FAILED(hr)) return fail("IAudioClient::Initialize", hr, 7);
  }

  HANDLE sampleReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(sampleReady);
  if (FAILED(hr)) return fail("SetEventHandle", hr, 8);

  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(IID_PPV_ARGS(&capture));
  if (FAILED(hr)) return fail("GetService", hr, 9);

  hr = client->Start();
  if (FAILED(hr)) return fail("Start", hr, 10);
  fprintf(stderr, "ok %s\n", isFloat ? "float32" : "pcm16");
  fflush(stderr);

  std::vector<float> out;
  for (;;) {
    WaitForSingleObject(sampleReady, 100);
    UINT32 packet = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD bufferFlags = 0;
      hr = capture->GetBuffer(&data, &frames, &bufferFlags, nullptr, nullptr);
      if (FAILED(hr)) return fail("GetBuffer", hr, 11);

      const size_t samples = static_cast<size_t>(frames) * kChannels;
      out.assign(samples, 0.0f);
      if (!(bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT)) {
        if (isFloat) {
          memcpy(out.data(), data, samples * sizeof(float));
        } else {
          const int16_t* pcm = reinterpret_cast<const int16_t*>(data);
          for (size_t i = 0; i < samples; i++) out[i] = pcm[i] / 32768.0f;
        }
      }
      capture->ReleaseBuffer(frames);

      if (fwrite(out.data(), sizeof(float), samples, stdout) != samples) return 0;  // pipe fechado
      fflush(stdout);
    }
  }
}
