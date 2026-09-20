#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <shellapi.h>
#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace h3b {
struct Failure : std::runtime_error {
  using std::runtime_error::runtime_error;
};
inline void require(bool ok, const char* code) {
  if (!ok) throw Failure(code);
}
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE h) : value(h) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& h) noexcept : value(h.value) {
    h.value = INVALID_HANDLE_VALUE;
  }
  Handle& operator=(Handle&& h) noexcept {
    if (this != &h) {
      reset();
      value = h.value;
      h.value = INVALID_HANDLE_VALUE;
    }
    return *this;
  }
  ~Handle() { reset(); }
  bool valid() const { return value && value != INVALID_HANDLE_VALUE; }
  void reset() {
    if (valid()) CloseHandle(value);
    value = INVALID_HANDLE_VALUE;
  }
  void checkedClose() {
    if (valid()) {
      HANDLE h = value;
      value = INVALID_HANDLE_VALUE;
      require(CloseHandle(h) != FALSE, "qualification-io-failed");
    }
  }
};
inline uint64_t qpc() {
  LARGE_INTEGER v{};
  require(QueryPerformanceCounter(&v) && v.QuadPart >= 0,
          "qualification-qpc-invalid");
  return static_cast<uint64_t>(v.QuadPart);
}
inline uint64_t frequency() {
  LARGE_INTEGER v{};
  require(QueryPerformanceFrequency(&v) && v.QuadPart > 0 &&
              v.QuadPart <= 9007199254740991LL,
          "qualification-qpc-invalid");
  return static_cast<uint64_t>(v.QuadPart);
}
inline std::string hex(uint64_t value, unsigned width = 16) {
  char out[33]{};
  snprintf(out, sizeof(out), "%0*llx", width,
           static_cast<unsigned long long>(value));
  return out;
}
inline std::string hexBytes(const BYTE* bytes, size_t size) {
  std::string out;
  for (size_t i = 0; i < size; ++i) out += hex(bytes[i], 2);
  return out;
}
inline uint64_t fileTime(const FILETIME& t) {
  return (static_cast<uint64_t>(t.dwHighDateTime) << 32) | t.dwLowDateTime;
}
inline uint64_t creation(HANDLE process) {
  FILETIME c{}, e{}, k{}, u{};
  require(GetProcessTimes(process, &c, &e, &k, &u) != FALSE,
          "qualification-peer-invalid");
  return fileTime(c);
}
inline void nonInherited(HANDLE h) {
  DWORD flags = 0;
  require(GetHandleInformation(h, &flags) && !(flags & HANDLE_FLAG_INHERIT),
          "qualification-launch-invalid");
}
inline std::wstring environment(const wchar_t* name) {
  DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
  require(n > 1 && n < 32768, "qualification-isolation-invalid");
  std::wstring s(n, L'\0');
  require(GetEnvironmentVariableW(name, s.data(), n) == n - 1,
          "qualification-isolation-invalid");
  s.resize(n - 1);
  return s;
}
inline std::string utf8(const std::wstring& value) {
  int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), nullptr, 0,
                              nullptr, nullptr);
  require(n > 0 || value.empty(), "qualification-frame-invalid");
  std::string out(n, '\0');
  if (n)
    require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                static_cast<int>(value.size()), out.data(), n,
                                nullptr, nullptr) == n,
            "qualification-frame-invalid");
  return out;
}
inline std::wstring wide(const std::string& value) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), nullptr, 0);
  require(n > 0 || value.empty(), "qualification-frame-invalid");
  std::wstring out(n, L'\0');
  if (n)
    require(
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), out.data(), n) == n,
        "qualification-frame-invalid");
  return out;
}
inline void nfc(const std::wstring& value) {
  require(IsNormalizedString(NormalizationC, value.data(),
                             static_cast<int>(value.size())) != FALSE,
          "qualification-frame-invalid");
  for (wchar_t c : value)
    require(c >= 32 && !(c >= 127 && c <= 159), "qualification-frame-invalid");
  utf8(value);
}
inline std::wstring parentPath(const std::wstring& path) {
  auto p = path.find_last_of(L'\\');
  require(p != std::wstring::npos && p >= 2, "qualification-isolation-invalid");
  return path.substr(0, p);
}
inline void strictLocalPath(const std::wstring& path) {
  nfc(path);
  require(path.size() > 3 && path.size() < 240 &&
              ((path[0] >= L'A' && path[0] <= L'Z') ||
               (path[0] >= L'a' && path[0] <= L'z')) &&
              path[1] == L':' && path[2] == L'\\',
          "qualification-isolation-invalid");
  require(path.find_first_of(L"/:*?\"<>|", 2) == std::wstring::npos &&
              path.back() != L'\\',
          "qualification-isolation-invalid");
  size_t start = 3;
  while (start < path.size()) {
    size_t end = path.find(L'\\', start);
    if (end == std::wstring::npos) end = path.size();
    auto part = path.substr(start, end - start);
    require(!part.empty() && part != L"." && part != L".." &&
                part.back() != L'.' && part.back() != L' ',
            "qualification-isolation-invalid");
    start = end + 1;
  }
  wchar_t volume[] = {path[0], L':', L'\\', 0};
  require(GetDriveTypeW(volume) == DRIVE_FIXED,
          "qualification-isolation-invalid");
}
inline std::vector<BYTE> tokenInfo(TOKEN_INFORMATION_CLASS kind) {
  Handle token;
  require(
      OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != FALSE,
      "qualification-launch-invalid");
  DWORD n = 0;
  GetTokenInformation(token.value, kind, nullptr, 0, &n);
  require(n > 0, "qualification-launch-invalid");
  std::vector<BYTE> bytes(n);
  require(GetTokenInformation(token.value, kind, bytes.data(), n, &n) != FALSE,
          "qualification-launch-invalid");
  return bytes;
}
inline std::vector<BYTE> logonSid() {
  auto bytes = tokenInfo(TokenGroups);
  auto groups = reinterpret_cast<TOKEN_GROUPS*>(bytes.data());
  for (DWORD i = 0; i < groups->GroupCount; ++i)
    if ((groups->Groups[i].Attributes & SE_GROUP_LOGON_ID) ==
        SE_GROUP_LOGON_ID) {
      DWORD n = GetLengthSid(groups->Groups[i].Sid);
      std::vector<BYTE> sid(n);
      require(CopySid(n, sid.data(), groups->Groups[i].Sid) != FALSE,
              "qualification-launch-invalid");
      return sid;
    }
  throw Failure("qualification-launch-invalid");
}
inline std::wstring sidText(PSID sid) {
  LPWSTR out = nullptr;
  require(ConvertSidToStringSidW(sid, &out) != FALSE,
          "qualification-launch-invalid");
  std::wstring result(out);
  LocalFree(out);
  return result;
}
struct Security {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
  explicit Security(bool pipe = false, bool immutableRoot = false) {
    auto sid = logonSid();
    auto userBytes = tokenInfo(TokenUser);
    auto user = reinterpret_cast<TOKEN_USER*>(userBytes.data());
    auto acl = L"O:" + sidText(user->User.Sid) + L"D:P" +
               (immutableRoot ? L"(D;;0x000c0100;;;OW)" : L"") + L"(A;" +
               std::wstring(pipe ? L"" : L"OICI") + L";" +
               (pipe ? L"0x00100082" : L"FA") + L";;;" + sidText(sid.data()) +
               L")";
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != FALSE,
            "qualification-launch-invalid");
    attributes.lpSecurityDescriptor = descriptor;
  }
  ~Security() {
    if (descriptor) LocalFree(descriptor);
  }
};
inline void verifyRootAcl(HANDLE h, bool immutableRoot = true) {
  PACL dacl = nullptr;
  PSID owner = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(GetSecurityInfo(
              h, SE_FILE_OBJECT,
              OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner,
              nullptr, &dacl, nullptr, &descriptor) == ERROR_SUCCESS,
          "qualification-isolation-invalid");
  std::unique_ptr<void, decltype(&LocalFree)> guard(descriptor, &LocalFree);
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  require(GetSecurityDescriptorControl(descriptor, &control, &revision) &&
              (control & SE_DACL_PROTECTED),
          "qualification-isolation-invalid");
  auto sid = logonSid();
  auto userBytes = tokenInfo(TokenUser);
  auto user = reinterpret_cast<TOKEN_USER*>(userBytes.data());
  require(owner && EqualSid(owner, user->User.Sid) && dacl &&
              dacl->AceCount == (immutableRoot ? 2 : 1),
          "qualification-isolation-invalid");
  void* raw = nullptr;
  if (immutableRoot) {
    require(GetAce(dacl, 0, &raw) != FALSE, "qualification-isolation-invalid");
    auto deny = static_cast<ACCESS_DENIED_ACE*>(raw);
    BYTE ownerRights[SECURITY_MAX_SID_SIZE]{};
    DWORD ownerRightsBytes = sizeof(ownerRights);
    require(
        CreateWellKnownSid(WinCreatorOwnerRightsSid, nullptr, ownerRights,
                           &ownerRightsBytes) &&
            deny->Header.AceType == ACCESS_DENIED_ACE_TYPE &&
            deny->Header.AceFlags == 0 &&
            deny->Mask == (FILE_WRITE_ATTRIBUTES | WRITE_DAC | WRITE_OWNER) &&
            EqualSid(&deny->SidStart, ownerRights),
        "qualification-isolation-invalid");
  }
  require(GetAce(dacl, immutableRoot ? 1 : 0, &raw) != FALSE,
          "qualification-isolation-invalid");
  auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
  require(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE &&
              ace->Header.AceFlags ==
                  (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) &&
              EqualSid(&ace->SidStart, sid.data()) &&
              ace->Mask == FILE_ALL_ACCESS,
          "qualification-isolation-invalid");
}
inline std::string fileId(HANDLE h, bool directory = false) {
  FILE_ATTRIBUTE_TAG_INFO attr{};
  FILE_ID_INFO id{};
  require(GetFileInformationByHandleEx(h, FileAttributeTagInfo, &attr,
                                       sizeof(attr)) &&
              GetFileInformationByHandleEx(h, FileIdInfo, &id, sizeof(id)) &&
              !(attr.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
              (!directory || (attr.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)),
          "qualification-isolation-invalid");
  return hex(id.VolumeSerialNumber) + ":" + hexBytes(id.FileId.Identifier, 16);
}
inline Handle openAttributes(const std::wstring& path) {
  Handle h(CreateFileW(
      path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  require(h.valid(), "qualification-isolation-invalid");
  nonInherited(h.value);
  return h;
}
inline Handle openRootPin(const std::wstring& path) {
  Handle h(CreateFileW(
      path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  require(h.valid(), "qualification-isolation-invalid");
  nonInherited(h.value);
  verifyRootAcl(h.value);
  fileId(h.value, true);
  return h;
}
inline bool emptyDirectory(const std::wstring& path) {
  WIN32_FIND_DATAW data{};
  HANDLE find = FindFirstFileW((path + L"\\*").c_str(), &data);
  require(find != INVALID_HANDLE_VALUE, "qualification-isolation-invalid");
  bool empty = true;
  do {
    if (wcscmp(data.cFileName, L".") && wcscmp(data.cFileName, L".."))
      empty = false;
  } while (FindNextFileW(find, &data));
  DWORD error = GetLastError();
  bool closed = FindClose(find) != FALSE;
  require(error == ERROR_NO_MORE_FILES && closed,
          "qualification-isolation-invalid");
  return empty;
}
inline const std::array<std::pair<const char*, const wchar_t*>, 6> rootNames{
    {{"appDataRoot", L"appdata"},
     {"localAppDataRoot", L"localappdata"},
     {"processTempRoot", L"process-temp"},
     {"runRoot", L""},
     {"userDataRoot", L"user-data"},
     {"watchTempRoot", L"watch-temp"}}};
struct Roots {
  std::wstring root;
  std::string runId;
  std::map<std::string, std::wstring> paths;
  std::map<std::string, std::string> ids;
  std::vector<Handle> pins;
  void pin(const std::wstring& base, bool allEmpty) {
    strictLocalPath(base);
    root = base;
    auto name = base.substr(base.find_last_of(L'\\') + 1);
    require(name.size() == 30 && name.substr(0, 4) == L"run-",
            "qualification-isolation-invalid");
    for (wchar_t c : name.substr(4))
      require((c >= L'A' && c <= L'Z') || (c >= L'2' && c <= L'7'),
              "qualification-isolation-invalid");
    require(name.back() == L'A' || name.back() == L'E' || name.back() == L'I' ||
                name.back() == L'M' || name.back() == L'Q' ||
                name.back() == L'U' || name.back() == L'Y' ||
                name.back() == L'4',
            "qualification-isolation-invalid");
    runId = utf8(name.substr(4));
    std::wstring ancestor = base;
    while (ancestor.size() > 3) {
      auto h = openAttributes(ancestor);
      fileId(h.value, true);
      pins.push_back(std::move(h));
      ancestor = parentPath(ancestor);
      if (ancestor.size() == 2) break;
    }
    auto volume = openAttributes(base.substr(0, 3));
    fileId(volume.value, true);
    pins.push_back(std::move(volume));
    for (const auto& [key, leaf] : rootNames) {
      std::wstring path = base + (leaf[0] ? L"\\" + std::wstring(leaf) : L"");
      auto h = openRootPin(path);
      ids[key] = fileId(h.value, true);
      paths[key] = path;
      pins.push_back(std::move(h));
      if (leaf[0] && (allEmpty || std::wstring(leaf) == L"user-data" ||
                      std::wstring(leaf) == L"watch-temp"))
        require(emptyDirectory(path), "qualification-isolation-invalid");
    }
    std::set<std::wstring> children;
    for (const auto& [key, leaf] : rootNames)
      if (leaf[0]) children.insert(leaf);
    WIN32_FIND_DATAW entry{};
    HANDLE enumeration = FindFirstFileW((base + L"\\*").c_str(), &entry);
    require(enumeration != INVALID_HANDLE_VALUE,
            "qualification-isolation-invalid");
    bool valid = true;
    do {
      if (wcscmp(entry.cFileName, L".") && wcscmp(entry.cFileName, L"..")) {
        if (children.erase(entry.cFileName) != 1) valid = false;
      }
    } while (FindNextFileW(enumeration, &entry));
    DWORD error = GetLastError();
    BOOL closed = FindClose(enumeration);
    require(valid && children.empty() && error == ERROR_NO_MORE_FILES && closed,
            "qualification-isolation-invalid");
  }
};
inline DWORD directParent(DWORD pid) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require(snapshot.valid(), "qualification-peer-invalid");
  PROCESSENTRY32W p{sizeof(p)};
  require(Process32FirstW(snapshot.value, &p) != FALSE,
          "qualification-peer-invalid");
  do {
    if (p.th32ProcessID == pid) return p.th32ParentProcessID;
  } while (Process32NextW(snapshot.value, &p));
  throw Failure("qualification-peer-invalid");
}
inline std::wstring pipeName(DWORD pid) {
  return L"\\\\.\\pipe\\LOCAL\\AIbrowse.H3b.telemetry." + std::to_wstring(pid);
}
inline std::wstring cwd() {
  DWORD n = GetCurrentDirectoryW(0, nullptr);
  require(n > 1 && n < 32768, "qualification-launch-invalid");
  std::wstring out(n, 0);
  require(GetCurrentDirectoryW(n, out.data()) == n - 1,
          "qualification-launch-invalid");
  out.resize(n - 1);
  return out;
}
inline std::wstring exePath() {
  std::wstring out(32768, 0);
  DWORD n =
      GetModuleFileNameW(nullptr, out.data(), static_cast<DWORD>(out.size()));
  require(n && n < out.size(), "qualification-launch-invalid");
  out.resize(n);
  return out;
}
inline std::string sha256(const std::wstring& path) {
  Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                          OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  require(file.valid(), "qualification-launch-invalid");
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  require(BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr,
                                      0) == 0,
          "qualification-launch-invalid");
  std::array<BYTE, 32> digest{};
  bool ok = BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0;
  std::array<BYTE, 65536> buffer{};
  DWORD n = 0;
  while (ok) {
    if (!ReadFile(file.value, buffer.data(), static_cast<DWORD>(buffer.size()),
                  &n, nullptr)) {
      ok = false;
      break;
    }
    if (!n) break;
    ok = BCryptHashData(hash, buffer.data(), n, 0) == 0;
  }
  if (ok)
    ok = BCryptFinishHash(hash, digest.data(),
                          static_cast<ULONG>(digest.size()), 0) == 0;
  if (hash) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(alg, 0);
  require(ok, "qualification-launch-invalid");
  return hexBytes(digest.data(), digest.size());
}
}  // namespace h3b
