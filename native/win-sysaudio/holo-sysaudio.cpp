// holo-sysaudio — computer-sound capture for HoloVoice on Windows (10 2004+).
//
// Chromium's "loopbackWithMute" mutes the whole output endpoint, which also silences the
// processed copy HoloVoice plays back. This helper does it per application instead:
//   * captures everything Windows plays EXCEPT the HoloVoice process tree (process loopback),
//   * turns the other applications' audio sessions down to -80 dB while it runs (and scales the capture
//     back up), so only the processed copy is heard,
//   * streams float32 stereo 48 kHz to stdout,
//   * gives every session its volume back when stdin closes (HoloVoice stopped or died).
// The original volumes are also written to a state file, so a crashed run is undone by the next start
// (or by "--restore").
//
//   holo-sysaudio.exe <excludePid> [--rate 48000] [--atten 0.0001] [--no-mute]   capture
//   holo-sysaudio.exe --restore                  only undo what a previous run left
//   holo-sysaudio.exe --probe-endpoint <ms>      (tests) RMS of what the default output actually plays
//
// Diagnostics go to stderr as single lines.

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
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

static const GUID kHoloContext = { 0x6f1c2a77, 0x3d2b, 0x4c55, { 0x9a, 0x1e, 0x48, 0x6f, 0x6c, 0x6f, 0x56, 0x63 } };
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

// ------------------------------------------------------------------ recorders

// Apps that record what is playing (loopback capture) have a session on the output device too, and turning it down
// would make them record silence. The session API doesn't tell recording from playback, so known recorders are
// skipped by name — they record our processed copy as it plays. Other copies of this helper (tests) as well.
static const wchar_t* kRecorders[] = {
  L"obs64.exe", L"obs32.exe", L"obs.exe", L"sharex.exe", L"bdcam.exe", L"bandicam.exe", L"nvcontainer.exe",
  L"nvidia share.exe", L"nvsphelper64.exe", L"gamebar.exe", L"gamebarftserver.exe", L"streamlabs obs.exe",
  L"xsplit.core.exe", L"action.exe", L"fraps.exe", L"holo-sysaudio.exe",
};

static bool isRecorder(DWORD pid) {
  if (!pid) return false;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return false;
  wchar_t path[MAX_PATH]; DWORD n = MAX_PATH;
  bool hit = false;
  if (QueryFullProcessImageNameW(h, 0, path, &n)) {
    const wchar_t* name = wcsrchr(path, L'\\');
    name = name ? name + 1 : path;
    for (auto r : kRecorders) if (!_wcsicmp(name, r)) { hit = true; break; }
  }
  CloseHandle(h);
  return hit;
}

// ------------------------------------------------------------------ session attenuation
//
// A muted session is also missing from process loopback, so the other apps are not muted but turned
// down by a fixed factor (-80 dB: inaudible) and the capture is scaled back up. The engine mixes in
// float, so nothing is lost. Every session gets the same factor, so the mix keeps its balance.

static float g_atten = 0.0001f;

static std::wstring stateFile() {
  wchar_t* dir = nullptr;
  std::wstring p;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &dir))) p = std::wstring(dir) + L"\\HoloVoice";
  CoTaskMemFree(dir);
  CreateDirectoryW(p.c_str(), nullptr);
  return p + L"\\attenuated-sessions.txt";
}

// session identifier -> the volume it had before we turned it down
static std::map<std::wstring, float> readState() {
  std::map<std::wstring, float> st;
  std::wifstream f(stateFile());
  for (std::wstring line; std::getline(f, line);) {
    size_t tab = line.rfind(L'\t');
    if (tab != std::wstring::npos) st[line.substr(0, tab)] = (float)_wtof(line.c_str() + tab + 1);
  }
  return st;
}

static void writeState(const std::map<std::wstring, float>& st) {
  if (st.empty()) { DeleteFileW(stateFile().c_str()); return; }
  std::wofstream f(stateFile(), std::ios::trunc);
  for (auto& kv : st) f << kv.first << L"\t" << kv.second << L"\n";
}

struct Session {
  ComPtr<IAudioSessionControl2> ctl;
  ComPtr<ISimpleAudioVolume> vol;
  ComPtr<IAudioMeterInformation> meter;
  DWORD pid = 0;
  std::wstring id;       // stable across runs (app + device)
  std::wstring instance; // unique to this session
  float original = 1.f;
  float set = 1.f;       // what we put there
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
      c.As(&s.meter);
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

// Undo what an earlier run left (it crashed or was killed): sessions still at our level get their volume back.
static void restoreState() {
  auto st = readState();
  if (st.empty()) return;
  auto left = st;
  for (auto& s : allSessions()) {
    auto it = st.find(s.id);
    if (it == st.end()) continue;
    float v = 1.f; s.vol->GetMasterVolume(&v);
    if (v <= it->second * g_atten * 1.5f + 1e-6f) s.vol->SetMasterVolume(it->second, &kHoloContext);
    left.erase(s.id);
    logf("restored pid=%lu", s.pid);
  }
  writeState(left); // apps that aren't running now are restored next time
}

class Attenuator {
public:
  Attenuator(DWORD excludeRoot) : root_(excludeRoot) {}
  // New sessions outside our tree are queued; they are turned down once they actually play (see tick).
  // Every ~500 ms.
  void scan() {
    auto tree = processTree(root_);
    tree.insert(GetCurrentProcessId());
    for (auto& s : allSessions()) {
      std::wstring key = s.instance.empty() ? s.id : s.instance;
      if (key.empty() || seen_.count(key)) continue;
      if (s.pid && tree.count(s.pid)) continue; // our own output (a new child may join the tree later: don't mark seen)
      seen_.insert(key);
      if (isRecorder(s.pid)) { logf("skipped recorder pid=%lu", s.pid); continue; }
      pending_.push_back(s);
    }
  }
  // Only sessions with sound on their meter are turned down: silent ones (an idle app) are left as they are.
  // Every ~20 ms: the start of a sound leaks for that long.
  void tick() {
    bool changed = false;
    for (size_t i = 0; i < pending_.size();) {
      auto& s = pending_[i];
      float peak = 0.f;
      AudioSessionState st = AudioSessionStateActive;
      s.ctl->GetState(&st);
      if (st == AudioSessionStateExpired) { pending_.erase(pending_.begin() + i); continue; }
      if (!s.meter || FAILED(s.meter->GetPeakValue(&peak)) || peak < 1e-4f) { i++; continue; }
      if (SUCCEEDED(s.vol->GetMasterVolume(&s.original))) {
        s.set = s.original * g_atten;
        if (SUCCEEDED(s.vol->SetMasterVolume(s.set, &kHoloContext))) {
          state_[s.id] = s.original;
          ours_.push_back(s);
          changed = true;
          float back = 0.f; s.vol->GetMasterVolume(&back);
          logf("attenuated pid=%lu volume=%.3f now=%.7f", s.pid, s.original, back);
        }
      }
      pending_.erase(pending_.begin() + i);
    }
    if (changed) writeState(merged());
  }
  // The app (or the user in the mixer) changed its volume: take it as the new level and turn it down again.
  // Every ~100 ms, so a loud leak stays short.
  void watch() {
    for (auto& s : ours_) {
      float v = 0.f;
      // only a clear rise counts: the stored value may come back slightly rounded
      if (FAILED(s.vol->GetMasterVolume(&v)) || v <= s.set * 2.f + 1e-6f) continue;
      s.original = v;
      s.set = v * g_atten;
      s.vol->SetMasterVolume(s.set, &kHoloContext);
      state_[s.id] = v;
      writeState(merged());
    }
  }
  void restore() {
    pending_.clear();
    for (auto& s : ours_) {
      float v = 0.f;
      if (SUCCEEDED(s.vol->GetMasterVolume(&v)) && v <= s.set * 2.f + 1e-6f) s.vol->SetMasterVolume(s.original, &kHoloContext);
      logf("restored pid=%lu", s.pid);
    }
    // keep apps that already closed: Windows remembers their volume, the next run restores them
    std::set<std::wstring> live;
    for (auto& s : allSessions()) live.insert(s.id);
    auto left = readState();
    for (auto& s : ours_) if (live.count(s.id)) left.erase(s.id);
    writeState(left);
    ours_.clear();
    state_.clear();
  }
private:
  std::map<std::wstring, float> merged() {
    auto st = readState();
    for (auto& kv : state_) st[kv.first] = kv.second;
    return st;
  }
  DWORD root_;
  std::set<std::wstring> seen_;
  std::map<std::wstring, float> state_;
  std::vector<Session> ours_, pending_;
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

static DWORD g_rate = 48000;

static WAVEFORMATEX format(bool asFloat) {
  WAVEFORMATEX wf = {};
  wf.wFormatTag = asFloat ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;
  wf.nChannels = 2;
  wf.nSamplesPerSec = g_rate;
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
  Attenuator att(pid);
  if (mute) { att.scan(); att.tick(); }
  if (FAILED(hr = client->Start())) { logf("error start 0x%08lx", hr); att.restore(); return 2; }
  logf("ready rate=%lu channels=2 format=%s", g_rate, asFloat ? "f32" : "s16");

  std::vector<float> out;
  const float gain = mute ? 1.f / g_atten : 1.f;
  ULONGLONG lastScan = GetTickCount64(), lastWatch = lastScan, lastTick = lastScan;
  while (g_running) {
    WaitForSingleObject(ev, 10);
    UINT32 packet = 0;
    while (g_running && SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet) {
      BYTE* data = nullptr; UINT32 frames = 0; DWORD fl = 0;
      if (FAILED(cap->GetBuffer(&data, &frames, &fl, nullptr, nullptr))) break;
      out.assign(size_t(frames) * 2, 0.f);
      if (!(fl & AUDCLNT_BUFFERFLAGS_SILENT)) {
        if (asFloat) { auto f = reinterpret_cast<const float*>(data); for (size_t i = 0; i < out.size(); i++) out[i] = f[i] * gain; }
        else { auto s = reinterpret_cast<const int16_t*>(data); for (size_t i = 0; i < out.size(); i++) out[i] = s[i] * (gain / 32768.f); }
      }
      cap->ReleaseBuffer(frames);
      if (fwrite(out.data(), sizeof(float), out.size(), stdout) != out.size() || fflush(stdout)) g_running = false;
    }
    ULONGLONG now = GetTickCount64();
    if (mute && now - lastTick >= 20) { att.tick(); lastTick = now; }
    if (mute && now - lastWatch >= 100) { att.watch(); lastWatch = now; }
    if (mute && now - lastScan >= 500) { att.scan(); lastScan = now; }
  }
  client->Stop();
  att.restore();
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
  // 10 ms blocks: how many are near-silent (dropouts) — printed after the RMS
  std::vector<double> blocks; double blockSum = 0; size_t blockN = 0; const size_t blockLen = mix->nSamplesPerSec / 100 * mix->nChannels;
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
        for (size_t i = 0; i < n; i++) {
          sum += double(f[i]) * f[i];
          blockSum += double(f[i]) * f[i];
          if (++blockN == blockLen) { blocks.push_back(std::sqrt(blockSum / blockN)); blockSum = 0; blockN = 0; }
        }
      }
      count += n;
      cap->ReleaseBuffer(frames);
    }
  }
  client->Stop();
  CoTaskMemFree(mix);
  double rms = count ? std::sqrt(sum / count) : 0.0;
  size_t quiet = 0;
  for (double b : blocks) if (b < rms * 0.1) quiet++;
  printf("%.6f %zu/%zu\n", rms, quiet, blocks.size());
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) { logf("error com"); return 2; }
  SetConsoleCtrlHandler(onCtrl, TRUE);
  if (argc >= 2 && !wcscmp(argv[1], L"--restore")) { restoreState(); return 0; }
  if (argc >= 3 && !wcscmp(argv[1], L"--probe-endpoint")) return probeEndpoint(_wtoi(argv[2]));
  if (argc < 2) { logf("usage: holo-sysaudio <excludePid> [--rate N] [--no-mute] | --restore"); return 1; }
  DWORD pid = wcstoul(argv[1], nullptr, 10);
  bool mute = true;
  for (int i = 2; i < argc; i++) {
    if (!wcscmp(argv[i], L"--no-mute")) mute = false;
    else if (!wcscmp(argv[i], L"--rate") && i + 1 < argc) g_rate = wcstoul(argv[++i], nullptr, 10);
    else if (!wcscmp(argv[i], L"--atten") && i + 1 < argc) g_atten = (float)_wtof(argv[++i]);
  }
  if (g_rate < 8000 || g_rate > 192000) g_rate = 48000;
  if (!(g_atten > 0.f && g_atten <= 1.f)) g_atten = 0.0001f;
  restoreState();
  CreateThread(nullptr, 0, stdinWatch, nullptr, 0, nullptr);
  int rc = capture(pid, mute);
  CoUninitialize();
  return rc;
}
