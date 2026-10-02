#pragma once
#include "wire.hpp"
#include <psapi.h>

namespace resource {
using namespace h3b;
inline Value decimal(uint64_t n) { return Value(std::to_string(n)); }
inline std::vector<DWORD> members(HANDLE job) {
  // A fixed upper bound fails closed rather than returning a truncated list.
  constexpr size_t capacity = 1024;
  std::vector<uint64_t> storage((sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) +
                               capacity * sizeof(ULONG_PTR) + 7) / 8);
  auto list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
  require(QueryInformationJobObject(job, JobObjectBasicProcessIdList, list,
              static_cast<DWORD>(storage.size() * 8), nullptr) != FALSE,
          "members-query-failed");
  require(list->NumberOfAssignedProcesses == list->NumberOfProcessIdsInList &&
              list->NumberOfProcessIdsInList <= capacity, "members-incomplete");
  std::vector<DWORD> ids;
  for (DWORD i = 0; i < list->NumberOfProcessIdsInList; ++i) {
    require(list->ProcessIdList[i] > 0 && list->ProcessIdList[i] <= MAXDWORD,
            "members-pid-invalid");
    ids.push_back(static_cast<DWORD>(list->ProcessIdList[i]));
  }
  std::sort(ids.begin(), ids.end());
  require(std::adjacent_find(ids.begin(), ids.end()) == ids.end(), "members-duplicate");
  return ids;
}
inline Value cpu(HANDLE job, uint64_t* queryEnd = nullptr) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  require(QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
              &accounting, sizeof(accounting), nullptr) != FALSE,
          "cpu-query-failed");
  if (queryEnd) *queryEnd = qpc();
  require(accounting.TotalKernelTime.QuadPart >= 0 && accounting.TotalUserTime.QuadPart >= 0,
          "cpu-counter-invalid");
  auto kernel = static_cast<uint64_t>(accounting.TotalKernelTime.QuadPart);
  auto user = static_cast<uint64_t>(accounting.TotalUserTime.QuadPart);
  require(UINT64_MAX - kernel >= user, "cpu-counter-overflow");
  return object({{L"total100ns", decimal(kernel + user)}});
}
inline void verifyProcess(HANDLE process, HANDLE job, DWORD pid, uint64_t birth) {
  BOOL member = FALSE;
  require(WaitForSingleObject(process, 0) == WAIT_TIMEOUT && GetProcessId(process) == pid &&
              creation(process) == birth && IsProcessInJob(process, job, &member) && member,
          "members-identity-changed");
}
inline Value memory(HANDLE job) {
  auto before = members(job);
  std::vector<Handle> handles;
  std::vector<uint64_t> births;
  Value::Array rows;
  Value::Array identities;
  for (auto pid : before) {
    Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE,
                               FALSE, pid));
    require(process.valid(), "members-open-failed");
    BOOL member = FALSE;
    require(GetProcessId(process.value) == pid &&
                IsProcessInJob(process.value, job, &member) && member &&
                WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT,
            "members-identity-changed");
    auto birth = creation(process.value);
    PROCESS_MEMORY_COUNTERS_EX counters{};
    counters.cb = sizeof(counters);
    DWORD count = 0;
    require(GetProcessMemoryInfo(process.value,
                reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters), sizeof(counters)) &&
                GetProcessHandleCount(process.value, &count), "members-metrics-failed");
    rows.push_back(object({{L"pid", Value(uint64_t(pid))},
        {L"inJob", Value(true)},
        {L"creationFileTime", Value(hex(birth))},
        {L"rssBytes", Value(uint64_t(counters.WorkingSetSize))},
        {L"privateBytes", Value(uint64_t(counters.PrivateUsage))},
        {L"handles", Value(uint64_t(count))}}));
    identities.push_back(object({{L"pid", Value(uint64_t(pid))},
        {L"creationFileTime", Value(hex(birth))}}));
    births.push_back(birth);
    handles.push_back(std::move(process));
  }
  require(before == members(job), "members-changed");
  for (size_t i = 0; i < handles.size(); ++i) {
    verifyProcess(handles[i].value, job, before[i], births[i]);
  }
  return object({{L"members", Value(rows)}, {L"stable", Value(true)},
      {L"before", Value(identities)}, {L"after", Value(identities)}});
}
inline bool exists(const std::wstring& path) {
  DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    require(GetLastError() == ERROR_FILE_NOT_FOUND, "files-attributes-failed");
    return false;
  }
  require(!(attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
              !(attributes & FILE_ATTRIBUTE_DIRECTORY), "files-type-invalid");
  return true;
}
inline bool exclusive(const std::wstring& path, const std::string& expectedId) {
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE, 0,
                         nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file.valid()) {
    require(GetLastError() == ERROR_SHARING_VIOLATION, "files-exclusive-failed");
    return false;
  }
  require(fileId(file.value) == expectedId, "files-identity-changed");
  return true;
}
inline Value files(const std::wstring& temp, const std::string& tempId,
                   const std::wstring& user, const std::string& userId,
                   bool released, const std::string& expectedDbId) {
  auto tempPin = openAttributes(temp), userPin = openAttributes(user);
  require(fileId(tempPin.value, true) == tempId && fileId(userPin.value, true) == userId,
          "files-root-identity-changed");
  WIN32_FIND_DATAW entry{};
  HANDLE search = FindFirstFileW((temp + L"\\*").c_str(), &entry);
  require(search != INVALID_HANDLE_VALUE, "files-temp-query-failed");
  uint64_t entries = 0;
  bool reparse = false;
  do {
    if (wcscmp(entry.cFileName, L".") && wcscmp(entry.cFileName, L"..")) {
      ++entries;
      reparse = reparse || (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    }
  } while (FindNextFileW(search, &entry));
  auto error = GetLastError();
  auto closed = FindClose(search);
  require(error == ERROR_NO_MORE_FILES && closed && !reparse, "files-temp-invalid");
  auto databaseDirectory = openAttributes(user + L"\\watch");
  const auto databaseDirectoryId = fileId(databaseDirectory.value, true);
  const auto db = user + L"\\watch\\watch.db";
  bool present = exists(db), wal = exists(db + L"-wal"), shm = exists(db + L"-shm");
  Value available;
  std::string observedDbId;
  if (present) {
    auto file = openAttributes(db);
    observedDbId = fileId(file.value);
    file.checkedClose();
    require(expectedDbId.empty() || expectedDbId == observedDbId, "files-db-identity-changed");
    if (released) available = Value(exclusive(db, observedDbId));
  }
  return object({{L"tempEntries", Value(entries)}, {L"dbExists", Value(present)},
      {L"dbExclusive", available}, {L"dbFileId", present ? Value(observedDbId) : Value()},
      {L"watchDirectoryFileId", Value(databaseDirectoryId)},
      {L"walExists", Value(wal)}, {L"shmExists", Value(shm)}});
}
}  // namespace resource
