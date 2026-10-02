#include "metrics.hpp"
#include "process.hpp"
#include "released.hpp"
#include <winioctl.h>
#include <batclass.h>
#include <devguid.h>
#include <setupapi.h>
#include <filesystem>
#include <iostream>

namespace mock {
std::string fault;
unsigned deviceOpens = 0, deviceCloses = 0, listCloses = 0, informationCalls = 0, statusCalls = 0;
BOOL fail(DWORD error) { SetLastError(error); return FALSE; }
BOOL WINAPI system(LPSYSTEM_POWER_STATUS out) {
  if (fault == "system") return fail(ERROR_ACCESS_DENIED);
  *out = {}; out->ACLineStatus = 1; out->BatteryFlag = 1; out->BatteryLifePercent = 50; return TRUE;
}
HDEVINFO WINAPI open(const GUID*, PCWSTR, HWND, DWORD) {
  if (fault == "list-open") { SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE; }
  return reinterpret_cast<HDEVINFO>(1);
}
BOOL WINAPI enumerate(HDEVINFO, PSP_DEVINFO_DATA, const GUID*, DWORD index, PSP_DEVICE_INTERFACE_DATA) {
  if (fault == "enumerate") return fail(ERROR_ACCESS_DENIED);
  if (index > (fault == "duplicate" ? 1U : 0U)) return fail(ERROR_NO_MORE_ITEMS);
  return TRUE;
}
BOOL WINAPI detail(HDEVINFO, PSP_DEVICE_INTERFACE_DATA, PSP_DEVICE_INTERFACE_DETAIL_DATA_W out,
                   DWORD size, PDWORD required, PSP_DEVINFO_DATA) {
  constexpr DWORD bytes = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W) + 16;
  *required = bytes;
  if (!out) {
    if (fault == "detail-short") *required = 1;
    if (fault == "detail-long") *required = 65537;
    if (fault == "detail-sizing-success") return TRUE;
    return fail(ERROR_INSUFFICIENT_BUFFER);
  }
  h3b::require(size == bytes && out->cbSize == sizeof(*out), "mock-detail-input");
  if (fault == "detail-read") return fail(ERROR_ACCESS_DENIED);
  if (fault == "detail-actual") ++*required;
  wcscpy_s(out->DevicePath, 9, L"mock"); return TRUE;
}
BOOL WINAPI instance(HDEVINFO, PSP_DEVINFO_DATA, PWSTR out, DWORD size, PDWORD required) {
  *required = 5;
  if (!out) return fail(ERROR_INSUFFICIENT_BUFFER);
  h3b::require(size == 5, "mock-instance-input");
  wcscpy_s(out, size, L"MOCK");
  if (fault == "instance-read") return fail(ERROR_ACCESS_DENIED);
  return TRUE;
}
HANDLE WINAPI device(LPCWSTR, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES,
                    DWORD disposition, DWORD flags, HANDLE) {
  h3b::require(access == (GENERIC_READ | GENERIC_WRITE) && share == (FILE_SHARE_READ | FILE_SHARE_WRITE) &&
                   disposition == OPEN_EXISTING && flags == 0, "mock-device-input");
  if (fault == "device-open") { SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE; }
  ++deviceOpens;
  return reinterpret_cast<HANDLE>(2);
}
BOOL WINAPI ioctl(HANDLE, DWORD code, LPVOID input, DWORD inBytes, LPVOID output,
                  DWORD outBytes, LPDWORD returned, LPOVERLAPPED overlap) {
  h3b::require(overlap == nullptr, "mock-overlap-input");
  if (code == IOCTL_BATTERY_QUERY_TAG) {
    h3b::require(inBytes == sizeof(ULONG) && outBytes == sizeof(ULONG) &&
                     *static_cast<ULONG*>(input) == 0 && *static_cast<ULONG*>(output) == BATTERY_TAG_INVALID,
                 "mock-tag-input");
    *returned = sizeof(ULONG);
    if (fault == "absence") { *returned = 99; return fail(ERROR_FILE_NOT_FOUND); }
    if (fault == "tag-removed") return fail(ERROR_NO_SUCH_DEVICE);
    if (fault != "tag-zero") *static_cast<ULONG*>(output) = 17;
    if (fault == "tag-short") --*returned;
    if (fault == "tag-long") ++*returned;
    return TRUE;
  }
  if (code == IOCTL_BATTERY_QUERY_INFORMATION) {
    ++informationCalls;
    auto query = static_cast<BATTERY_QUERY_INFORMATION*>(input);
    h3b::require(inBytes == sizeof(*query) && outBytes == sizeof(BATTERY_INFORMATION) &&
                     query->BatteryTag == 17 && query->InformationLevel == BatteryInformation && query->AtRate == 0,
                 "mock-information-input");
    *returned = sizeof(BATTERY_INFORMATION);
    if (fault == "info-stale") return fail(ERROR_NO_SUCH_DEVICE);
    if (fault == "info-absent") return fail(ERROR_FILE_NOT_FOUND);
    if (fault == "info-short") --*returned;
    if (fault == "info-long") ++*returned;
    auto info = static_cast<BATTERY_INFORMATION*>(output);
    info->Capabilities = BATTERY_SYSTEM_BATTERY; info->FullChargedCapacity = 50000; return TRUE;
  }
  h3b::require(code == IOCTL_BATTERY_QUERY_STATUS, "mock-unexpected-ioctl");
  ++statusCalls;
  auto wait = static_cast<BATTERY_WAIT_STATUS*>(input);
  h3b::require(inBytes == sizeof(*wait) && outBytes == sizeof(BATTERY_STATUS) && wait->BatteryTag == 17 &&
                   wait->Timeout == 0 && wait->PowerState == 0 && wait->LowCapacity == 0 && wait->HighCapacity == 0,
               "mock-status-input");
  *returned = sizeof(BATTERY_STATUS);
  if (fault == "status-stale") return fail(ERROR_NO_SUCH_DEVICE);
  if (fault == "status-absent") return fail(ERROR_FILE_NOT_FOUND);
  if (fault == "status-short") --*returned;
  if (fault == "status-long") ++*returned;
  auto status = static_cast<BATTERY_STATUS*>(output);
  status->Capacity = 25000; status->PowerState = BATTERY_POWER_ON_LINE; status->Rate = BATTERY_UNKNOWN_RATE;
  return TRUE;
}
BOOL WINAPI closeDevice(HANDLE) { ++deviceCloses; return fault == "device-close" ? fail(ERROR_ACCESS_DENIED) : TRUE; }
BOOL WINAPI closeList(HDEVINFO) { ++listCloses; return fault == "list-close" ? fail(ERROR_ACCESS_DENIED) : TRUE; }
}
#define GetSystemPowerStatus mock::system
#define SetupDiGetClassDevsW mock::open
#define SetupDiEnumDeviceInterfaces mock::enumerate
#define SetupDiGetDeviceInterfaceDetailW mock::detail
#define SetupDiGetDeviceInstanceIdW mock::instance
#define CreateFileW mock::device
#define DeviceIoControl mock::ioctl
#define CloseHandle mock::closeDevice
#define SetupDiDestroyDeviceInfoList mock::closeList
#include "battery.hpp"
#undef GetSystemPowerStatus
#undef SetupDiGetClassDevsW
#undef SetupDiEnumDeviceInterfaces
#undef SetupDiGetDeviceInterfaceDetailW
#undef SetupDiGetDeviceInstanceIdW
#undef CreateFileW
#undef DeviceIoControl
#undef CloseHandle
#undef SetupDiDestroyDeviceInfoList

using namespace h3b;
using namespace resource;
template<class F> void rejects(F f) { bool rejected = false; try { f(); } catch (const Failure&) { rejected = true; }
  require(rejected, "independent-counterexample-accepted"); }
void put(const std::wstring& path, const std::string& bytes) {
  Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(file.valid(), "independent-file-create"); DWORD count = 0;
  require(WriteFile(file.value, bytes.data(), DWORD(bytes.size()), &count, nullptr) && count == bytes.size(), "independent-file-write");
}
std::string id(const std::wstring& path, bool directory = false) { auto pin = openAttributes(path); return fileId(pin.value, directory); }
void releasedMatrix() {
  auto parent = std::filesystem::path(exePath()).parent_path().wstring() + L"\\released-review-" + wide(hex(qpc()));
  require(CreateDirectoryW(parent.c_str(), nullptr), "independent-parent-create");
  auto root = parent + L"\\run-AAAAAAAAAAAAAAAAAAAAAAAAAA";
  Security security(false, true);
  Value::Object roots;
  require(CreateDirectoryW(root.c_str(), &security.attributes), "independent-root-create");
  for (const auto& [key, child] : rootNames) {
    auto path = root + (child[0] ? L"\\" + std::wstring(child) : L"");
    if (child[0]) require(CreateDirectoryW(path.c_str(), &security.attributes), "independent-child-create");
    roots.emplace(wide(key), Value(id(path, true)));
  }
  auto watch = root + L"\\user-data\\watch", db = watch + L"\\watch.db";
  require(CreateDirectoryW(watch.c_str(), nullptr), "independent-watch-create");
  put(db, "synthetic database sentinel");
  put(root + L"\\user-data\\preserve.txt", "must survive verification");
  auto watchId = id(watch, true), dbId = id(db);
  auto observe = [&] { return verifyReleased(root, Value(roots), watchId, dbId); };
  require(releasedFiles(observe()), "independent-nonempty-userdata-rejected");
  for (const auto& [key, value] : roots) {
    auto wrong = roots; wrong[key] = Value(std::string(16, '0') + ":" + std::string(32, '0'));
    rejects([&] { verifyReleased(root, Value(wrong), watchId, dbId); });
    (void)value;
  }
  auto falseId = std::string(16, '0') + ":" + std::string(32, '0');
  rejects([&] { verifyReleased(root, Value(roots), falseId, dbId); });
  rejects([&] { verifyReleased(root, Value(roots), watchId, falseId); });
  for (DWORD access : {DWORD(GENERIC_READ), DWORD(GENERIC_WRITE), DWORD(DELETE)}) {
    Handle held(CreateFileW(db.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    require(held.valid() && !releasedFiles(observe()), "independent-held-file-accepted");
  }
  for (const auto& residue : {db + L"-wal", db + L"-shm", root + L"\\watch-temp\\owned.tmp"}) {
    put(residue, "retain"); require(!releasedFiles(observe()), "independent-residue-accepted");
    require(DeleteFileW(residue.c_str()), "independent-own-residue-cleanup");
  }
  require(MoveFileW(watch.c_str(), (watch + L"-saved").c_str()), "independent-watch-move");
  require(CreateDirectoryW(watch.c_str(), nullptr), "independent-watch-replacement");
  put(db, "replacement");
  rejects([&] { observe(); });
  require(DeleteFileW(db.c_str()) && RemoveDirectoryW(watch.c_str()) &&
              MoveFileW((watch + L"-saved").c_str(), watch.c_str()), "independent-watch-restore");
  require(releasedFiles(observe()) && id(db) == dbId && exists(root + L"\\user-data\\preserve.txt"),
          "independent-verification-mutated-root");
  auto identityFile = parent + L"\\ids.json"; put(identityFile, canonical(Value(roots)) + "\n");
  require(canonical(readRootIds(identityFile)) == canonical(Value(roots)), "independent-rootids-read");
  auto extra = roots; extra.emplace(L"unknown", Value(falseId));
  auto malformed = parent + L"\\invalid.json"; put(malformed, canonical(Value(extra)) + "\n");
  rejects([&] { readRootIds(malformed); });
  put(parent + L"\\request.json", canonical(object({{L"root", Value(root)}, {L"rootIds", Value(identityFile)},
      {L"watchId", Value(watchId)}, {L"dbId", Value(dbId)}})) + "\n");
  std::cout << "只读释放校验：非空userData、六根/Watch/DB身份、读写DELETE占用、WAL/SHM/temp残留及目录替换反例通过；合成原件保留。\n";
}
int main(int argc, char**) {
  try {
    for (const auto& fault : {"", "absence", "system", "list-open", "enumerate", "detail-short", "detail-long",
                             "detail-sizing-success", "detail-read", "detail-actual", "instance-read", "device-open",
                             "tag-removed", "tag-zero", "tag-short", "tag-long", "info-stale", "info-absent",
                             "info-short", "info-long", "status-stale", "status-absent", "status-short", "status-long",
                             "device-close", "list-close", "duplicate"}) {
      mock::fault = fault; mock::deviceOpens = mock::deviceCloses = mock::listCloses = mock::informationCalls = mock::statusCalls = 0;
      auto observed = battery();
      bool expectedSuccess = mock::fault.empty() || mock::fault == "absence";
      require(observed.error.empty() == expectedSuccess, "independent-battery-classification");
      require(mock::deviceCloses <= 1 && mock::listCloses <= 1, "independent-battery-double-cleanup");
      require(mock::deviceCloses == mock::deviceOpens, "independent-battery-device-leak");
      bool listOpened = mock::fault != "system" && mock::fault != "list-open";
      require(mock::listCloses == (listOpened ? 1U : 0U), "independent-battery-list-leak");
      if (mock::fault == "absence") {
        require(mock::informationCalls == 0 && mock::statusCalls == 0 &&
                    observed.fields.at("ports").array()[0].at("tagReturnedBytes").number() == 99,
                "independent-absence-not-terminal");
      }
      if (mock::fault == "device-close" || mock::fault == "list-close")
        require(!std::get<bool>(observed.fields.at("cleanupComplete").data), "independent-cleanup-failure-hidden");
    }
    std::cout << "电池API精确输入输出、初始absence/后续stale、27种成功失败路径与一次清理反例通过。\n";
    releasedMatrix();
    if (argc > 1) {
      require(batteryIdentity(L"PORT-\u00e9") == batteryIdentity(L"PORT-e\u0301"), "independent-nfc-identity-changed");
      std::cout << "等价NFC identity一致。\n";
    }
    return 0;
  } catch (const std::exception& error) { std::cerr << "独立扩展验证失败：" << error.what() << '\n'; return 1; }
}
