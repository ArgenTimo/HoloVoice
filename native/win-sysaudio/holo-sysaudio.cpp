// holo-sysaudio — computer-sound capture for HoloVoice on Windows (10 2004+).
//
// Chromium's "loopbackWithMute" mutes the whole output endpoint, which also silences the
// processed copy HoloVoice plays back. This helper does it per application instead:
//   * captures everything Windows plays EXCEPT the HoloVoice process tree (process loopback),
//   * mutes the other applications' audio sessions while it runs, so only the processed copy is heard,
//   * streams float32 stereo 48 kHz to stdout,
//   * unmutes everything it muted when stdin closes (HoloVoice stopped or died).
// Sessions it muted are also written to a state file, so a crashed run is undone by the next start
// (or by "--restore").
//
//   holo-sysaudio.exe <excludePid> [--no-mute]   capture
//   holo-sysaudio.exe --restore                  only undo a previous run's mutes
//   holo-sysaudio.exe --probe-endpoint <ms>      (tests) RMS of what the default output actually plays
//
// Diagnostics go to stderr as single lines.

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <shlobj.h>
#include <wrl/implements.h>
#include <io.h>
#include <fcntl.h>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <atomic>
#include <fstream>
#include <map>
#include <set>
#include <string>
#include <vector>

#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")

using Microsoft::WRL::ComPtr;

static const GUID kMuteContext = { 0x6f1c2a77, 0x3d2b, 0x4c55, { 0x9a, 0x1e, 0x48, 0x6f, 0x6c, 0x6f, 0x56, 0x63 } };
static std::atomic<bool> g_running{ true };

static void logf(const char* fmt, ...) {
  va_list a; va_start(a, fmt); vfprintf(stderr, fmt, a); va_end(a);
  fputc('\n', stderr); fflush(stderr);
}

static std::string narrow(const wchar_t* w) {
  if (!w) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

// ------------------------------------------------------------------ process tree

static std::set<DWORD> processTree(DWORD root) {
  std::multimap<DWORD, DWORD> children;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap != INVALID_HANDLE_VALUE) {
    PROCESSENTRY32W pe = { sizeof(pe) };
    for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe))
      if (pe.th32ProcessID != pe.th32ParentProcessID) children.emplace(pe.th32ParentProcessID, pe.th32ProcessID);
    CloseHandle(snap);
  }
  std::set<DWORD> tree{ root };
  std::vector<DWORD> todo{ root };
  while (!todo.empty()) {
    DWORD p = todo.back(); todo.pop_back();
    auto r = children.equal_range(p);
    for (auto it = r.first; it != r.second; ++it) if (tree.insert(it->second).second) todo.push_back(it->second);
  }
  return tree;
}

// ------------------------------------------------------------------ session muting

static std::wstring stateFile() {
  wchar_t* dir = nullptr;
  std::wstring p;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &dir))) p = std::wstring(dir) + L"\\HoloVoice";
  CoTaskMemFree(dir);
  CreateDirectoryW(p.c_str(), nullptr);
  return p + L"\\muted-sessions.txt";
}

static std::set<std::wstring> readState() {
  std::set<std::wstring> ids;
  std::wifstream f(stateFile());
  for (std::wstring line; std::getline(f, line);) if (!line.empty()) ids.insert(line);
  return ids;
}

static void writeState(const std::set<std::wstring>& ids) {
  if (ids.empty()) { DeleteFileW(stateFile().c_str()); return; }
  std::wofstream f(stateFile(), std::ios::trunc);
  for (auto& id : ids) f << id << L"\n";
}

struct Session {
  ComPtr<IAudioSessionControl2> ctl;
  ComPtr<ISimpleAudioVolume> vol;
  DWORD pid = 0;
  std::wstring id;       // stable across runs (app + device)
  std::wstring instance; // unique to this session
};

static std::vector<Session> allSessions() {
  std::vector<Session> out;
  ComPtr<IMMDeviceEnumerator> en;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en)))) return out;
  ComPtr<IMMDeviceCollection> devs;
  if (FAILED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devs))) return out;
  UINT nd = 0; devs->GetCount(&nd);
  for (UINT d = 0; d < nd; d++) {
    ComPtr<IMMDevice> dev; ComPtr<IAudioSessionManager2> mgr; ComPtr<IAudioSessionEnumerator> se;
    if (FAILED(devs->Item(d, &dev))) continue;
    if (FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)mgr.GetAddressOf()))) continue;
    if (FAILED(mgr->GetSessionEnumerator(&se))) continue;
    int n = 0; se->GetCount(&n);
    for (int i = 0; i < n; i++) {
      ComPtr<IAudioSessionControl> c; Session s;
      if (FAILED(se->GetSession(i, &c)) || FAILED(c.As(&s.ctl)) || FAILED(c.As(&s.vol))) continue;
      s.ctl->GetProcessId(&s.pid);
      LPWSTR id = nullptr, inst = nullptr;
      if (SUCCEEDED(s.ctl->GetSessionIdentifier(&id)) && id) s.id = id;
      if (SUCCEEDED(s.ctl->GetSessionInstanceIdentifier(&inst)) && inst) s.instance = inst;
      CoTaskMemFree(id); CoTaskMemFree(inst);
      out.push_back(s);
    }
  }
  return out;
}

// Undo mutes left by an earlier run (only sessions that are still muted).
static void restoreState() {
  auto ids = readState();
  if (ids.empty()) return;
  std::set<std::wstring> left = ids;
  for (auto& s : allSessions()) {
    if (!ids.count(s.id)) continue;
    BOOL m = FALSE; s.vol->GetMute(&m);
    if (m) s.vol->SetMute(FALSE, &kMuteContext);
    left.erase(s.id);
    logf("restored pid=%lu", s.pid);
  }
  writeState(left); // apps that aren't running now get unmuted next time
}

class Muter {
public:
  Muter(DWORD excludeRoot) : root_(excludeRoot) {}
  // Mute every session outside our tree that we haven't seen yet. A session the user
  // unmutes by hand stays unmuted (it's already "seen").
  void poll() {
    auto tree = processTree(root_);
    tree.insert(GetCurrentProcessId());
    bool changed = false;
    for (auto& s : allSessions()) {
      std::wstring key = s.instance.empty() ? s.id : s.instance;
      if (key.empty() || seen_.count(key)) continue;
      if (s.pid && tree.count(s.pid)) continue; // our own output (pid may appear later in the tree: don't mark seen)
      seen_.insert(key);
      BOOL m = FALSE;
      if (FAILED(s.vol->GetMute(&m)) || m) continue; // already muted by the user: leave it alone
      if (SUCCEEDED(s.vol->SetMute(TRUE, &kMuteContext))) {
        muted_.push_back(s);
        ids_.insert(s.id);
        changed = true;
        logf("muted pid=%lu", s.pid);
      }
    }
    if (changed) writeState(ids_);
  }
  void restore() {
    for (auto& s : muted_) {
      BOOL m = FALSE;
      if (SUCCEEDED(s.vol->GetMute(&m)) && m) s.vol->SetMute(FALSE, &kMuteContext);
      logf("unmuted pid=%lu", s.pid);
    }
    muted_.clear();
    // keep entries of sessions whose app is gone: Windows remembers the mute for the app
    std::set<std::wstring> live;
    for (auto& s : allSessions()) live.insert(s.id);
    std::set<std::wstring> left;
    for (auto& id : ids_) if (!live.count(id)) left.insert(id);
    auto old = readState();
    for (auto& id : old) if (!ids_.count(id)) left.insert(id);
    writeState(left);
    ids_.clear();
  }
private:
  DWORD root_;
  std::set<std::wstring> seen_, ids_;
  std::vector<Session> muted_;
};

// ------------------------------------------------------------------ process loopback

class Activator : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                                      Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
  Activator() { done = CreateEventW(nullptr, TRUE, FALSE, nullptr); }
  ~Activator() { CloseHandle(done); }
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT ahr = E_FAIL; ComPtr<IUnknown> unk;
    hr = op->GetActivateResult(&ahr, &unk);
    if (SUCCEEDED(hr)) hr = ahr;
    if (SUCCEEDED(hr)) hr = unk.As(&client);
    SetEvent(done);
    return S_OK;
  }
  HANDLE done;
  HRESULT hr = E_FAIL;
  ComPtr<IAudioClient> client;
};

static HRESULT activateLoopback(DWORD pid, ComPtr<IAudioClient>& client) {
  AUDIOCLIENT_ACTIVATION_PARAMS ap = {};
  ap.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  ap.ProcessLoopbackParams.TargetProcessId = pid;
  ap.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT pv = {};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(ap);
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&ap);
  auto act = Microsoft::WRL::Make<Activator>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, act.Get(), &op);
  if (FAILED(hr)) return hr;
  if (WaitForSingleObject(act->done, 5000) != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
  if (FAILED(act->hr)) return act->hr;
  client = act->client;
  return S_OK;
}

static WAVEFORMATEX format(bool asFloat) {
  WAVEFORMATEX wf = {};
  wf.wFormatTag = asFloat ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;
  wf.nChannels = 2;
  wf.nSamplesPerSec = 48000;
  wf.wBitsPerSample = asFloat ? 32 : 16;
  wf.nBlockAlign = wf.nChannels * wf.wBitsPerSample / 8;
  wf.nAvgBytesPerSec = wf.nSamplesPerSec * wf.nBlockAlign;
  return wf;
}

static DWORD WINAPI stdinWatch(LPVOID) {
  char buf[256];
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  DWORD n = 0;
  while (ReadFile(in, buf, sizeof(buf), &n, nullptr) && n > 0) {}
  g_running = false;
  return 0;
}

static BOOL WINAPI onCtrl(DWORD) { g_running = false; return TRUE; }

static int capture(DWORD pid, bool mute) {
  ComPtr<IAudioClient> client;
  HRESULT hr = activateLoopback(pid, client);
  if (FAILED(hr)) { logf("error activate 0x%08lx", hr); return 2; }
  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
  bool asFloat = true;
  WAVEFORMATEX wf = format(true);
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, &wf, nullptr);
  if (FAILED(hr)) {
    // some builds only accept PCM for process loopback: reactivate and convert ourselves
    client.Reset();
    if (FAILED(hr = activateLoopback(pid, client))) { logf("error activate 0x%08lx", hr); return 2; }
    asFloat = false;
    wf = format(false);
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, &wf, nullptr);
    if (FAILED(hr)) { logf("error initialize 0x%08lx", hr); return 2; }
  }
  HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  ComPtr<IAudioCaptureClient> cap;
  if (FAILED(hr = client->SetEventHandle(ev)) || FAILED(hr = client->GetService(IID_PPV_ARGS(&cap)))) {
    logf("error service 0x%08lx", hr); return 2;
  }
  Muter muter(pid);
  if (mute) muter.poll();
  if (FAILED(hr = client->Start())) { logf("error start 0x%08lx", hr); muter.restore(); return 2; }
  logf("ready rate=48000 channels=2 format=%s", asFloat ? "f32" : "s16");

  std::vector<float> out;
  ULONGLONG lastPoll = GetTickCount64();
  while (g_running) {
    WaitForSingleObject(ev, 50);
    UINT32 packet = 0;
    while (g_running && SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet) {
      BYTE* data = nullptr; UINT32 frames = 0; DWORD fl = 0;
      if (FAILED(cap->GetBuffer(&data, &frames, &fl, nullptr, nullptr))) break;
      out.assign(size_t(frames) * 2, 0.f);
      if (!(fl & AUDCLNT_BUFFERFLAGS_SILENT)) {
        if (asFloat) memcpy(out.data(), data, out.size() * sizeof(float));
        else { auto s = reinterpret_cast<const int16_t*>(data); for (size_t i = 0; i < out.size(); i++) out[i] = s[i] / 32768.f; }
      }
      cap->ReleaseBuffer(frames);
      if (fwrite(out.data(), sizeof(float), out.size(), stdout) != out.size() || fflush(stdout)) g_running = false;
    }
    if (mute && GetTickCount64() - lastPoll > 500) { muter.poll(); lastPoll = GetTickCount64(); }
  }
  client->Stop();
  muter.restore();
  CloseHandle(ev);
  logf("stopped");
  return 0;
}

// What the default output actually plays (endpoint loopback): used by tests to check that the
// original sound is muted.
static int probeEndpoint(int ms) {
  ComPtr<IMMDeviceEnumerator> en; ComPtr<IMMDevice> dev; ComPtr<IAudioClient> client; ComPtr<IAudioCaptureClient> cap;
  WAVEFORMATEX* mix = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
  if (SUCCEEDED(hr)) hr = en->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
  if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)client.GetAddressOf());
  if (SUCCEEDED(hr)) hr = client->GetMixFormat(&mix);
  if (SUCCEEDED(hr)) hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 1000000, 0, mix, nullptr);
  if (SUCCEEDED(hr)) hr = client->GetService(IID_PPV_ARGS(&cap));
  if (SUCCEEDED(hr)) hr = client->Start();
  if (FAILED(hr)) { logf("error probe 0x%08lx", hr); return 2; }
  bool isFloat = mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
    (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE && mix->wBitsPerSample == 32);
  double sum = 0; size_t count = 0;
  ULONGLONG end = GetTickCount64() + ms;
  while (GetTickCount64() < end) {
    Sleep(10);
    UINT32 packet = 0;
    while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet) {
      BYTE* data; UINT32 frames; DWORD fl;
      if (FAILED(cap->GetBuffer(&data, &frames, &fl, nullptr, nullptr))) break;
      size_t n = size_t(frames) * mix->nChannels;
      if (!(fl & AUDCLNT_BUFFERFLAGS_SILENT) && isFloat) {
        auto f = reinterpret_cast<const float*>(data);
        for (size_t i = 0; i < n; i++) sum += double(f[i]) * f[i];
      }
      count += n;
      cap->ReleaseBuffer(frames);
    }
  }
  client->Stop();
  CoTaskMemFree(mix);
  printf("%.6f\n", count ? std::sqrt(sum / count) : 0.0);
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) { logf("error com"); return 2; }
  SetConsoleCtrlHandler(onCtrl, TRUE);
  if (argc >= 2 && !wcscmp(argv[1], L"--restore")) { restoreState(); return 0; }
  if (argc >= 3 && !wcscmp(argv[1], L"--probe-endpoint")) return probeEndpoint(_wtoi(argv[2]));
  if (argc < 2) { logf("usage: holo-sysaudio <excludePid> [--no-mute] | --restore"); return 1; }
  DWORD pid = wcstoul(argv[1], nullptr, 10);
  bool mute = !(argc >= 3 && !wcscmp(argv[2], L"--no-mute"));
  restoreState();
  CreateThread(nullptr, 0, stdinWatch, nullptr, 0, nullptr);
  int rc = capture(pid, mute);
  CoUninitialize();
  return rc;
}
