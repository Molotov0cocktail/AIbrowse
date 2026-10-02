#pragma once
#include "released.hpp"
#include <winternl.h>

namespace resource::databasecopy {
// The helper only knows these two closed application databases. It never opens
// SQLite and never creates, checkpoints, removes, or truncates a source file.
constexpr uint64_t maximumDatabaseBytes = 512ULL * 1024 * 1024;
struct OwnedSource {
  std::wstring root;
  std::string runId;
  std::vector<Handle> pins;
  Value expected;
  HANDLE userData = INVALID_HANDLE_VALUE;
  OwnedSource(const std::wstring& path, const Value& ids) : root(path), expected(ids) {
    strictLocalPath(path);
    auto leaf = utf8(path.substr(path.find_last_of(L'\\') + 1));
    require(std::regex_match(leaf, std::regex("run-[A-Z2-7]{25}[AEIMQUY4]")), "copy-root-name-invalid");
    runId = leaf.substr(4);
    keys(ids, {"appDataRoot", "localAppDataRoot", "processTempRoot", "runRoot", "userDataRoot", "watchTempRoot"});
    auto ancestor = parentPath(path);
    while (ancestor.size() > 3) {
      auto pin = openAttributes(ancestor); fileId(pin.value, true);
      pins.push_back(std::move(pin)); ancestor = parentPath(ancestor);
    }
    auto volume = openAttributes(path.substr(0, 3)); fileId(volume.value, true);
    pins.push_back(std::move(volume));
    for (const auto& [name, child] : rootNames) {
      auto location = path + (child[0] ? L"\\" + std::wstring(child) : L"");
      auto pin = openRootPin(location);
      require(fileId(pin.value, true) == ids.at(name).string(), "copy-root-identity-changed");
      if (std::string(name) == "userDataRoot") userData = pin.value;
      pins.push_back(std::move(pin));
    }
  }
};
inline Handle relativeOpen(HANDLE parent, const wchar_t* leaf, ACCESS_MASK access,
                           ULONG sharing, bool directory, ULONG disposition = FILE_OPEN) {
  auto length = wcslen(leaf);
  require(length > 0 && length < 128 && std::wstring(leaf).find_first_of(L"\\/:.") == std::wstring::npos,
          "copy-relative-name-invalid");
  UNICODE_STRING name{};
  name.Buffer = const_cast<PWSTR>(leaf);
  name.Length = static_cast<USHORT>(length * sizeof(wchar_t)); name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes); attributes.RootDirectory = parent;
  attributes.ObjectName = &name; attributes.Attributes = OBJ_CASE_INSENSITIVE;
  Security creationSecurity(false, true);
  if (disposition == FILE_CREATE) attributes.SecurityDescriptor = creationSecurity.descriptor;
  IO_STATUS_BLOCK io{}; Handle result;
  auto status = NtCreateFile(&result.value, access | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
      &attributes, &io, nullptr, directory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL,
      sharing, disposition, FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT |
      (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE), nullptr, 0);
  require(status == 0 && result.valid() && (disposition != FILE_CREATE || io.Information == FILE_CREATED),
          "copy-relative-open-failed");
  nonInherited(result.value); fileId(result.value, directory);
  FILE_STANDARD_INFO info{};
  require(GetFileInformationByHandleEx(result.value, FileStandardInfo, &info, sizeof(info)) &&
              !!info.Directory == directory && (directory || info.NumberOfLinks == 1),
          "copy-object-shape-invalid");
  return result;
}
inline Handle databaseOpen(HANDLE parent, const wchar_t* name, ACCESS_MASK access,
                           ULONG disposition = FILE_OPEN) {
  require(std::wstring(name) == L"watch.db" || std::wstring(name) == L"sources.db", "copy-database-name-invalid");
  UNICODE_STRING leaf{};
  leaf.Buffer = const_cast<PWSTR>(name);
  leaf.Length = static_cast<USHORT>(wcslen(name) * sizeof(wchar_t)); leaf.MaximumLength = leaf.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes); attributes.RootDirectory = parent;
  attributes.ObjectName = &leaf; attributes.Attributes = OBJ_CASE_INSENSITIVE;
  IO_STATUS_BLOCK io{}; Handle result;
  auto status = NtCreateFile(&result.value, access | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      &attributes, &io, nullptr, FILE_ATTRIBUTE_NORMAL, 0, disposition,
      FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE,
      nullptr, 0);
  require(status == 0 && result.valid() && (disposition != FILE_CREATE || io.Information == FILE_CREATED),
          "copy-database-exclusive-failed");
  nonInherited(result.value); fileId(result.value);
  FILE_STANDARD_INFO info{};
  require(GetFileInformationByHandleEx(result.value, FileStandardInfo, &info, sizeof(info)) &&
              !info.Directory && info.NumberOfLinks == 1 && info.EndOfFile.QuadPart >= 0 &&
              uint64_t(info.EndOfFile.QuadPart) <= maximumDatabaseBytes,
          "copy-database-shape-invalid");
  return result;
}
struct SourceDatabase {
  std::string kind;
  const wchar_t* filename;
  Handle directory, file;
  std::string directoryId, id;
  SourceDatabase(HANDLE user, const char* type, const wchar_t* folder, const wchar_t* name,
                 const std::string& expectedDirectory = {}, const std::string& expectedFile = {})
      : kind(type), filename(name),
        directory(relativeOpen(user, folder, FILE_LIST_DIRECTORY, FILE_SHARE_READ, true)),
        file(databaseOpen(directory.value, name, GENERIC_READ)),
        directoryId(fileId(directory.value, true)), id(fileId(file.value)) {
    require((expectedDirectory.empty() || expectedDirectory == directoryId) &&
                (expectedFile.empty() || expectedFile == id), "copy-database-identity-changed");
  }
};
inline void sidecarsAbsent(HANDLE directory, const std::wstring& database) {
  std::vector<BYTE> buffer(65536); bool restart = true;
  size_t observed = 0;
  for (;;) {
    BOOL read = GetFileInformationByHandleEx(directory,
        restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        buffer.data(), DWORD(buffer.size()));
    auto error = read ? ERROR_SUCCESS : GetLastError(); restart = false;
    if (!read) { require(error == ERROR_NO_MORE_FILES, "copy-directory-enumeration-failed"); break; }
    size_t offset = 0;
    for (;;) {
      constexpr size_t prefix = offsetof(FILE_ID_BOTH_DIR_INFO, FileName);
      require(offset + prefix <= buffer.size(), "copy-directory-frame-invalid");
      auto row = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
      require(row->FileNameLength % sizeof(wchar_t) == 0 && row->FileNameLength <= 510 &&
                  offset + prefix + row->FileNameLength <= buffer.size() && ++observed <= 4096,
              "copy-directory-frame-invalid");
      std::wstring name(row->FileName, row->FileNameLength / sizeof(wchar_t));
      require(_wcsicmp(name.c_str(), (database + L"-wal").c_str()) != 0 &&
                  _wcsicmp(name.c_str(), (database + L"-shm").c_str()) != 0,
              "copy-sidecar-present");
      if (!row->NextEntryOffset) break;
      require(row->NextEntryOffset >= prefix && offset + row->NextEntryOffset > offset &&
                  offset + row->NextEntryOffset < buffer.size(), "copy-directory-offset-invalid");
      offset += row->NextEntryOffset;
    }
  }
}
inline void tempEmpty(const OwnedSource& source) {
  auto pin = openAttributes(source.root + L"\\watch-temp");
  require(fileId(pin.value, true) == source.expected.at("watchTempRoot").string() &&
              emptyDirectory(source.root + L"\\watch-temp"), "copy-temp-not-empty");
}
class Hash {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
 public:
  Hash() {
    require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0,
            "copy-hash-open");
    if (BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) != 0) {
      BCryptCloseAlgorithmProvider(algorithm, 0); algorithm = nullptr;
      throw Failure("copy-hash-create");
    }
  }
  Hash(const Hash&) = delete;
  Hash& operator=(const Hash&) = delete;
  ~Hash() { if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); }
  void update(BYTE* bytes, DWORD length) {
    require(BCryptHashData(hash, bytes, length, 0) == 0, "copy-hash-update");
  }
  std::string finish() {
    std::array<BYTE, 32> result{};
    require(BCryptFinishHash(hash, result.data(), DWORD(result.size()), 0) == 0, "copy-hash-finish");
    return hexBytes(result.data(), result.size());
  }
};
struct Contents { uint64_t bytes; std::string sha256; };
inline Contents contents(HANDLE source, HANDLE destination = INVALID_HANDLE_VALUE) {
  LARGE_INTEGER length{}, zero{};
  require(GetFileSizeEx(source, &length) && length.QuadPart > 0 &&
              uint64_t(length.QuadPart) <= maximumDatabaseBytes &&
              SetFilePointerEx(source, zero, nullptr, FILE_BEGIN), "copy-source-size-invalid");
  Hash hash; std::array<BYTE, 65536> buffer{}; uint64_t total = 0;
  while (total < uint64_t(length.QuadPart)) {
    DWORD read = 0;
    auto wanted = DWORD(std::min<uint64_t>(buffer.size(), uint64_t(length.QuadPart) - total));
    require(ReadFile(source, buffer.data(), wanted, &read, nullptr) && read > 0 && read <= wanted,
            "copy-source-read-failed");
    hash.update(buffer.data(), read);
    if (destination != INVALID_HANDLE_VALUE) {
      DWORD written = 0;
      require(WriteFile(destination, buffer.data(), read, &written, nullptr) && written == read,
              "copy-destination-write-failed");
    }
    total += read;
  }
  DWORD tail = 0;
  require(ReadFile(source, buffer.data(), 1, &tail, nullptr) && tail == 0, "copy-source-size-changed");
  return {total, hash.finish()};
}
inline void sameContents(const Contents& left, const Contents& right) {
  require(left.bytes == right.bytes && left.sha256 == right.sha256, "copy-contents-changed");
}
inline Value copyOne(SourceDatabase& source, HANDLE destinationDirectory) {
  auto before = contents(source.file.value);
  auto copy = databaseOpen(destinationDirectory, source.filename, GENERIC_READ | GENERIC_WRITE, FILE_CREATE);
  auto copied = contents(source.file.value, copy.value);
  require(FlushFileBuffers(copy.value), "copy-destination-flush-failed");
  auto destination = contents(copy.value);
  auto after = contents(source.file.value);
  sameContents(before, copied); sameContents(before, destination); sameContents(before, after);
  require(fileId(source.file.value) == source.id, "copy-source-identity-changed");
  auto result = object({{L"kind", Value(source.kind)}, {L"sourceDirectoryFileId", Value(source.directoryId)},
      {L"sourceFileId", Value(source.id)}, {L"sourceBytes", Value(before.bytes)},
      {L"sourceSha256Before", Value(before.sha256)}, {L"sourceSha256After", Value(after.sha256)},
      {L"copyFileId", Value(fileId(copy.value))}, {L"copyBytes", Value(destination.bytes)},
      {L"copySha256", Value(destination.sha256)}});
  copy.checkedClose();
  return result;
}
inline bool within(const std::wstring& parent, const std::wstring& child) {
  return child.size() >= parent.size() && _wcsnicmp(parent.c_str(), child.c_str(), parent.size()) == 0 &&
      (child.size() == parent.size() || child[parent.size()] == L'\\');
}
inline void secondRelease(const OwnedSource& source, SourceDatabase& watch, SourceDatabase& sources) {
  watch.file.checkedClose(); sources.file.checkedClose();
  auto watchAgain = databaseOpen(watch.directory.value, watch.filename, GENERIC_READ);
  auto sourcesAgain = databaseOpen(sources.directory.value, sources.filename, GENERIC_READ);
  require(fileId(watchAgain.value) == watch.id && fileId(sourcesAgain.value) == sources.id &&
              fileId(watch.directory.value, true) == watch.directoryId &&
              fileId(sources.directory.value, true) == sources.directoryId,
          "copy-release-identity-changed");
  sidecarsAbsent(watch.directory.value, watch.filename);
  sidecarsAbsent(sources.directory.value, sources.filename);
  tempEmpty(source);
}
inline Value copyDatabases(const std::wstring& repo, const std::wstring& root,
                           const Value& rootIds, const std::string& watchDirectory,
                           const std::string& watchFile) {
  auto begin = qpc(); strictLocalPath(repo);
  const std::regex identity("[0-9a-f]{16}:[0-9a-f]{32}");
  require(std::regex_match(watchDirectory, identity) && std::regex_match(watchFile, identity),
          "copy-expected-identity-invalid");
  auto copiesParent = repo + L"\\log\\watch-qualification-db-copies";
  require(!within(root, copiesParent) && !within(copiesParent, root), "copy-roots-overlap");
  OwnedSource source(root, rootIds);
  SourceDatabase watch(source.userData, "watch", L"watch", L"watch.db", watchDirectory, watchFile);
  SourceDatabase sources(source.userData, "sources", L"sources", L"sources.db");
  sidecarsAbsent(watch.directory.value, watch.filename); sidecarsAbsent(sources.directory.value, sources.filename);
  tempEmpty(source);
  std::vector<Handle> outputPins;
  auto ancestor = parentPath(copiesParent);
  while (ancestor.size() > 3) {
    auto pin = openAttributes(ancestor); fileId(pin.value, true);
    outputPins.push_back(std::move(pin)); ancestor = parentPath(ancestor);
  }
  auto volume = openAttributes(copiesParent.substr(0, 3)); fileId(volume.value, true);
  outputPins.push_back(std::move(volume));
  Security security;
  if (!CreateDirectoryW(copiesParent.c_str(), &security.attributes))
    require(GetLastError() == ERROR_ALREADY_EXISTS, "copy-parent-create-failed");
  Handle copies(CreateFileW(copiesParent.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  require(copies.valid(), "copy-parent-pin-failed"); fileId(copies.value, true);
  std::wstring attempt = L"copy-" + wide(hex(qpc())) + L"-" + std::to_wstring(GetCurrentProcessId());
  auto attemptRoot = relativeOpen(copies.value, attempt.c_str(), FILE_LIST_DIRECTORY, FILE_SHARE_READ, true, FILE_CREATE);
  auto runLeaf = L"run-" + wide(source.runId);
  auto destination = relativeOpen(attemptRoot.value, runLeaf.c_str(), FILE_LIST_DIRECTORY, FILE_SHARE_READ, true, FILE_CREATE);
  auto user = relativeOpen(destination.value, L"user-data", FILE_LIST_DIRECTORY, FILE_SHARE_READ, true, FILE_CREATE);
  auto watchCopy = relativeOpen(user.value, L"watch", FILE_LIST_DIRECTORY, FILE_SHARE_READ, true, FILE_CREATE);
  auto sourcesCopy = relativeOpen(user.value, L"sources", FILE_LIST_DIRECTORY, FILE_SHARE_READ, true, FILE_CREATE);
  Value::Array files{copyOne(watch, watchCopy.value), copyOne(sources, sourcesCopy.value)};
  auto releaseBegin = qpc(); secondRelease(source, watch, sources);
  auto releaseEnd = qpc();
  auto result = object({{L"schema", Value("watch-database-copy-v1")}, {L"status", Value("ok")},
      {L"runId", Value(source.runId)}, {L"sourceRootFileIds", rootIds},
      {L"sourcesIdentityBoundary", Value("first-exclusive-open")},
      {L"destinationRoot", Value(copiesParent + L"\\" + attempt + L"\\" + runLeaf)},
      {L"destinationRootFileId", Value(fileId(destination.value, true))},
      {L"files", Value(files)}, {L"beginQpc", decimal(begin)}, {L"endQpc", decimal(releaseEnd)},
      {L"sourceRecheck", object({{L"beginQpc", decimal(releaseBegin)}, {L"endQpc", decimal(releaseEnd)},
          {L"bothDatabasesExclusive", Value(true)}, {L"bothWalShmAbsent", Value(true)}, {L"tempEntries", Value(uint64_t(0))}})}});
  // The receipt is outside the copy root consumed by SQLite, so later report
  // sidecars cannot alter the record of the original source verification.
  Output receipt(copiesParent + L"\\" + attempt + L"\\copy-receipt.json");
  receipt.line(result);
  return result;
}
}  // namespace resource::databasecopy
