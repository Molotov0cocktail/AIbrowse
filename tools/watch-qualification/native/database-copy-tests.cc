#include "database-copy.hpp"
#include <filesystem>
#include <iostream>
#include <winioctl.h>

namespace {
using namespace h3b;
using namespace resource;
using namespace resource::databasecopy;
template<class Action> void reject(Action action, const char* code) {
  bool rejected = false;
  try { action(); } catch (const Failure& failure) { rejected = std::string(failure.what()) == code; }
  require(rejected, "copy-test-expected-rejection");
}
void createFile(const std::wstring& path, const std::string& bytes) {
  Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                          FILE_ATTRIBUTE_NORMAL, nullptr));
  require(file.valid(), "copy-test-create-file");
  DWORD written = 0;
  require(WriteFile(file.value, bytes.data(), DWORD(bytes.size()), &written, nullptr) &&
              written == bytes.size(), "copy-test-write-file");
}
std::string identity(const std::wstring& path, bool directory = false) {
  auto file = openAttributes(path); return fileId(file.value, directory);
}
Contents digest(const std::wstring& path) {
  auto file = immutableArtifact(path); return contents(file.value);
}
struct Fixture {
  std::wstring base, repo, root, watchPath, sourcesPath;
  std::string watchDirectory, watchFile;
  Value roots;
  explicit Fixture(const wchar_t* label) {
    auto build = std::filesystem::path(exePath()).parent_path().wstring();
    auto stamp = hex(qpc()); std::string runId = "AAAAAAAAA";
    for (auto c : stamp) runId += char('A' + (c <= '9' ? c - '0' : c - 'a' + 10));
    runId += 'A';
    base = build + L"\\copy-fixture-" + label + L"-" + wide(stamp);
    repo = base + L"\\repository"; root = base + L"\\run-" + wide(runId);
    require(CreateDirectoryW(base.c_str(), nullptr) && CreateDirectoryW(repo.c_str(), nullptr) &&
                CreateDirectoryW((repo + L"\\log").c_str(), nullptr), "copy-test-create-base");
    Security security(false, true);
    require(CreateDirectoryW(root.c_str(), &security.attributes), "copy-test-create-root");
    Value::Object ids;
    for (const auto& [key, leaf] : rootNames) {
      auto path = root + (leaf[0] ? L"\\" + std::wstring(leaf) : L"");
      if (leaf[0]) require(CreateDirectoryW(path.c_str(), &security.attributes), "copy-test-create-child");
      ids.emplace(wide(key), Value(identity(path, true)));
    }
    roots = Value(ids);
    auto watch = root + L"\\user-data\\watch", sources = root + L"\\user-data\\sources";
    require(CreateDirectoryW(watch.c_str(), nullptr) && CreateDirectoryW(sources.c_str(), nullptr),
            "copy-test-create-db-directories");
    watchPath = watch + L"\\watch.db"; sourcesPath = sources + L"\\sources.db";
    // These are bounded transport fixtures, not SQLite integrity evidence.
    createFile(watchPath, std::string(4096, 'W'));
    createFile(sourcesPath, std::string(8192, 'S'));
    watchDirectory = identity(watch, true); watchFile = identity(watchPath);
  }
  Value copy() { return copyDatabases(repo, root, roots, watchDirectory, watchFile); }
};
void mountPoint(const std::wstring& path, const std::wstring& target) {
  struct Reparse {
    ULONG tag; USHORT length; USHORT reserved;
    USHORT substituteOffset, substituteLength, printOffset, printLength;
    wchar_t names[2048];
  } value{};
  auto substitute = L"\\??\\" + target;
  require(substitute.size() + target.size() + 2 <= 2048, "copy-test-junction-length");
  value.tag = IO_REPARSE_TAG_MOUNT_POINT;
  value.substituteLength = USHORT(substitute.size() * sizeof(wchar_t));
  value.printOffset = USHORT((substitute.size() + 1) * sizeof(wchar_t));
  value.printLength = USHORT(target.size() * sizeof(wchar_t));
  std::copy(substitute.begin(), substitute.end(), value.names);
  std::copy(target.begin(), target.end(), value.names + substitute.size() + 1);
  value.length = USHORT(8 + (substitute.size() + target.size() + 2) * sizeof(wchar_t));
  Handle directory(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  DWORD returned = 0;
  require(directory.valid() && DeviceIoControl(directory.value, FSCTL_SET_REPARSE_POINT,
      &value, DWORD(value.length) + 8, nullptr, 0, &returned, nullptr), "copy-test-junction-create");
}
int run() {
  Fixture clean(L"clean");
  auto watchBefore = digest(clean.watchPath), sourcesBefore = digest(clean.sourcesPath);
  auto result = clean.copy();
  require(result.at("status").string() == "ok" && result.at("files").array().size() == 2 &&
              result.at("sourcesIdentityBoundary").string() == "first-exclusive-open", "copy-test-receipt");
  auto output = std::get<std::wstring>(result.at("destinationRoot").data);
  sameContents(watchBefore, digest(output + L"\\user-data\\watch\\watch.db"));
  sameContents(sourcesBefore, digest(output + L"\\user-data\\sources\\sources.db"));
  sameContents(watchBefore, digest(clean.watchPath)); sameContents(sourcesBefore, digest(clean.sourcesPath));
  require(!exists(clean.watchPath + L"-wal") && !exists(clean.watchPath + L"-shm") &&
              !exists(clean.sourcesPath + L"-wal") && !exists(clean.sourcesPath + L"-shm"),
          "copy-test-created-source-sidecars");
  auto second = clean.copy();
  require(second.at("destinationRoot").string() != result.at("destinationRoot").string(),
          "copy-test-reused-destination");
  std::cout << "两库副本与源库前后hash一致；源库无新sidecar；每次目标全新。\n";
  for (const auto& path : {clean.watchPath, clean.sourcesPath}) {
    for (DWORD access : {DWORD(GENERIC_READ), DWORD(GENERIC_WRITE), DWORD(DELETE)}) {
      Handle held(CreateFileW(path.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             nullptr, OPEN_EXISTING, 0, nullptr));
      require(held.valid(), "copy-test-held-open");
      reject([&] { clean.copy(); }, "copy-database-exclusive-failed");
    }
  }
  for (const auto& path : {clean.watchPath, clean.sourcesPath}) {
    for (const wchar_t* suffix : {L"-wal", L"-shm"}) {
      auto sidecar = path + suffix; createFile(sidecar, "retained");
      reject([&] { clean.copy(); }, "copy-sidecar-present");
      require(DeleteFileW(sidecar.c_str()), "copy-test-remove-owned-sidecar");
    }
  }
  createFile(clean.root + L"\\watch-temp\\retained.tmp", "retained");
  reject([&] { clean.copy(); }, "copy-temp-not-empty");
  std::cout << "两库读/写/DELETE残留句柄、WAL/SHM与temp残留均阻止复制。\n";

  Fixture pinning(L"pinning");
  {
    OwnedSource source(pinning.root, pinning.roots);
    SourceDatabase held(source.userData, "watch", L"watch", L"watch.db", pinning.watchDirectory, pinning.watchFile);
    Handle writer(CreateFileW(pinning.watchPath.c_str(), GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
    require(!writer.valid() && GetLastError() == ERROR_SHARING_VIOLATION, "copy-test-source-write-allowed");
    require(!MoveFileW(pinning.watchPath.c_str(), (pinning.watchPath + L".moved").c_str()),
            "copy-test-source-rename-allowed");
  }
  reject([&] { copyDatabases(pinning.repo, pinning.root, pinning.roots, "wrong", pinning.watchFile); },
         "copy-expected-identity-invalid");
  for (const std::string bad : {std::string(), std::string("wrong"), std::string(49, '0')}) {
    reject([&] { copyDatabases(pinning.repo, pinning.root, pinning.roots, bad, pinning.watchFile); },
           "copy-expected-identity-invalid");
    reject([&] { copyDatabases(pinning.repo, pinning.root, pinning.roots, pinning.watchDirectory, bad); },
           "copy-expected-identity-invalid");
  }
  const std::string differentId = "0000000000000000:00000000000000000000000000000000";
  reject([&] { copyDatabases(pinning.repo, pinning.root, pinning.roots, differentId, pinning.watchFile); },
         "copy-database-identity-changed");
  auto wrongIds = pinning.roots.object(); wrongIds[L"runRoot"] = Value("wrong");
  reject([&] { copyDatabases(pinning.repo, pinning.root, Value(wrongIds), pinning.watchDirectory, pinning.watchFile); },
         "copy-root-identity-changed");
  reject([&] { copyDatabases(pinning.root, pinning.root, pinning.roots, pinning.watchDirectory, pinning.watchFile); },
         "copy-roots-overlap");
  Fixture linked(L"hardlink");
  require(CreateHardLinkW((linked.base + L"\\alias.db").c_str(), linked.sourcesPath.c_str(), nullptr),
          "copy-test-create-hardlink");
  reject([&] { linked.copy(); }, "copy-database-shape-invalid");
  Fixture junction(L"junction");
  auto sourcesDirectory = junction.root + L"\\user-data\\sources";
  auto moved = junction.root + L"\\user-data\\sources-owned";
  require(MoveFileW(sourcesDirectory.c_str(), moved.c_str()) && CreateDirectoryW(sourcesDirectory.c_str(), nullptr),
          "copy-test-prepare-junction");
  mountPoint(sourcesDirectory, moved);
  reject([&] { junction.copy(); }, "qualification-isolation-invalid");
  std::cout << "源句柄阻止写与rename；伪身份、hardlink、reparse和源/副本重叠均拒绝。\n";
  std::cout << "受控副本反例完成；合成原件保留于本次构建目录。\n";
  return 0;
}
}  // namespace
int wmain() {
  try { return run(); }
  catch (const std::exception& error) { std::cerr << "副本验证失败：" << error.what() << '\n'; return 1; }
}
