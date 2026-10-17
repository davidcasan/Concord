// Captura de áudio do Concord usando a API de Process Loopback do Windows (a mesma técnica do Discord).
//
// Uso:
//   minicord-audio.exe exclude <pid>          todo o áudio do PC, EXCETO o do processo (e filhos). Evita o eco da voz dos amigos.
//   minicord-audio.exe include <pid>          só o áudio do aplicativo desse processo (sobe até o processo raiz do app).
//   minicord-audio.exe include-window <hwnd>  só o áudio do aplicativo dono da janela.
//   minicord-audio.exe list                   lista (JSON) os aplicativos com sessão de áudio no dispositivo padrão.
// Captura: PCM float32 intercalado, 2 canais, 48000 Hz no stdout. Encerra quando o stdin fecha.

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <wrl/implements.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "user32.lib")

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

// ---------- Processos ----------
struct ProcInfo {
  DWORD parent;
  std::wstring exe;
};

static std::map<DWORD, ProcInfo> Snapshot() {
  std::map<DWORD, ProcInfo> procs;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return procs;
  PROCESSENTRY32W entry = {};
  entry.dwSize = sizeof(entry);
  for (BOOL ok = Process32FirstW(snap, &entry); ok; ok = Process32NextW(snap, &entry)) {
    std::wstring name = entry.szExeFile;
    std::transform(name.begin(), name.end(), name.begin(), ::towlower);
    procs[entry.th32ProcessID] = {entry.th32ParentProcessID, name};
  }
  CloseHandle(snap);
  return procs;
}

// Navegadores e jogos tocam som em processos filhos. Sobe até o ancestral mais alto com o mesmo executável.
static DWORD RootPid(DWORD pid, const std::map<DWORD, ProcInfo>& procs) {
  DWORD current = pid;
  for (int depth = 0; depth < 32; depth++) {
    auto self = procs.find(current);
    if (self == procs.end()) break;
    auto parent = procs.find(self->second.parent);
    if (parent == procs.end() || parent->first == current || parent->second.exe != self->second.exe) break;
    current = parent->first;
  }
  return current;
}

static std::string Utf8(const std::wstring& wide) {
  if (wide.empty()) return "";
  int size = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string out(size > 0 ? size - 1 : 0, '\0');
  if (size > 1) WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, out.data(), size, nullptr, nullptr);
  return out;
}

static std::string JsonEscape(const std::string& in) {
  std::string out;
  for (unsigned char c : in) {
    if (c == '\\' || c == '"') {
      out += '\\';
      out += static_cast<char>(c);
    } else if (c < 0x20) {
      char buf[8];
      snprintf(buf, sizeof(buf), "\\u%04x", c);
      out += buf;
    } else {
      out += static_cast<char>(c);
    }
  }
  return out;
}

static std::wstring ExePath(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return L"";
  wchar_t buf[MAX_PATH * 2];
  DWORD size = static_cast<DWORD>(sizeof(buf) / sizeof(buf[0]));
  std::wstring path;
  if (QueryFullProcessImageNameW(process, 0, buf, &size)) path.assign(buf, size);
  CloseHandle(process);
  return path;
}

// ---------- Lista de aplicativos com áudio ----------
static int ListAudioApps() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail("CoInitializeEx", hr, 3);

  ComPtr<IMMDeviceEnumerator> enumerator;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) return fail("MMDeviceEnumerator", hr, 4);
  ComPtr<IMMDevice> device;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device);
  if (FAILED(hr)) return fail("GetDefaultAudioEndpoint", hr, 5);
  ComPtr<IAudioSessionManager2> manager;
  hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(manager.GetAddressOf()));
  if (FAILED(hr)) return fail("IAudioSessionManager2", hr, 6);
  ComPtr<IAudioSessionEnumerator> sessions;
  hr = manager->GetSessionEnumerator(&sessions);
  if (FAILED(hr)) return fail("GetSessionEnumerator", hr, 7);

  int count = 0;
  sessions->GetCount(&count);
  const auto procs = Snapshot();
  std::map<DWORD, bool> apps;  // pid raiz -> tocando agora?
  for (int i = 0; i < count; i++) {
    ComPtr<IAudioSessionControl> control;
    if (FAILED(sessions->GetSession(i, &control))) continue;
    ComPtr<IAudioSessionControl2> control2;
    if (FAILED(control.As(&control2))) continue;
    if (control2->IsSystemSoundsSession() == S_OK) continue;
    DWORD pid = 0;
    if (FAILED(control2->GetProcessId(&pid)) || pid == 0) continue;
    AudioSessionState state = AudioSessionStateInactive;
    control->GetState(&state);
    const DWORD root = RootPid(pid, procs);
    apps[root] = apps[root] || state == AudioSessionStateActive;
  }

  std::string json = "[";
  bool first = true;
  for (const auto& app : apps) {
    const std::wstring path = ExePath(app.first);
    if (path.empty()) continue;
    if (!first) json += ",";
    first = false;
    json += "{\"pid\":" + std::to_string(app.first) + ",\"exe\":\"" + JsonEscape(Utf8(path)) + "\",\"active\":" +
            (app.second ? "true" : "false") + "}";
  }
  json += "]\n";
  fwrite(json.data(), 1, json.size(), stdout);
  fflush(stdout);
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) {
    fprintf(stderr, "uso: minicord-audio.exe exclude|include|include-window <pid|hwnd> | list\n");
    return 2;
  }
  const std::wstring mode = argv[1];
  _setmode(_fileno(stdout), _O_BINARY);
  if (mode == L"list") return ListAudioApps();
  if (argc < 3) {
    fprintf(stderr, "uso: minicord-audio.exe exclude|include|include-window <pid|hwnd>\n");
    return 2;
  }

  DWORD pid = 0;
  bool include = false;
  if (mode == L"exclude") {
    pid = wcstoul(argv[2], nullptr, 10);
  } else if (mode == L"include") {
    include = true;
    pid = wcstoul(argv[2], nullptr, 10);
  } else if (mode == L"include-window") {
    include = true;
    const HWND window = reinterpret_cast<HWND>(static_cast<UINT_PTR>(_wcstoui64(argv[2], nullptr, 10)));
    GetWindowThreadProcessId(window, &pid);
    if (pid == 0) return fail("Janela não encontrada", E_FAIL, 12);
  } else {
    fprintf(stderr, "modo desconhecido\n");
    return 2;
  }
  if (include) pid = RootPid(pid, Snapshot());

  _setmode(_fileno(stdin), _O_BINARY);
  CreateThread(nullptr, 0, WatchStdin, nullptr, 0, nullptr);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail("CoInitializeEx", hr, 3);

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      include ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

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
