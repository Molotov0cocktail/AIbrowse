#pragma once
#include "metrics.hpp"
#include <winioctl.h>
#include <batclass.h>
#include <devguid.h>
#include <setupapi.h>

namespace resource {
// Only raw bounded API observations live here. Statistical and power-state
// interpretation belongs to the independent TypeScript reporter.
struct BatteryAudit {
  Value::Array rows;
  bool cleanupComplete = true;
  void record(const char* name, uint64_t begin, bool success, DWORD error) {
    rows.push_back(object({{L"api", Value(name)}, {L"beginQpc", decimal(begin)},
        {L"endQpc", decimal(qpc())}, {L"success", Value(success)},
        {L"error", Value(uint64_t(error))}}));
  }
  template<class Operation> bool call(const char* name, Operation operation) {
    auto begin = qpc(); SetLastError(ERROR_SUCCESS);
    bool success = operation() != FALSE;
    DWORD error = success ? ERROR_SUCCESS : GetLastError();
    record(name, begin, success, error);
    SetLastError(error);
    return success;
  }
};
template<class T, class Close> struct OnceCleanup {
  T value;
  T invalid;
  Close close;
  bool& complete;
  void finish() noexcept {
    if (value == invalid) return;
    T owned = value; value = invalid;
    try { if (!close(owned)) complete = false; }
    catch (...) { complete = false; }
  }
  ~OnceCleanup() { finish(); }
};
inline bool documentedAbsence(bool success, DWORD error, ULONG tag, DWORD bytes) {
  if (!success && error == ERROR_FILE_NOT_FOUND && tag == BATTERY_TAG_INVALID) return true;
  require(success && bytes == sizeof(ULONG) && tag != BATTERY_TAG_INVALID,
          "battery-tag-api-invalid");
  return false;
}
inline void batterySizes(DWORD detailBytes, DWORD instanceCharacters, size_t ports) {
  require(detailBytes >= sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W) && detailBytes <= 65536 &&
              instanceCharacters > 1 && instanceCharacters <= 32768 && ports < 64,
          "battery-enumeration-budget");
}
inline std::string batteryIdentity(const std::wstring& instance) {
  require(!instance.empty() && instance.size() <= 32768, "battery-identity-invalid");
  int capacity = NormalizeString(NormalizationC, instance.data(), static_cast<int>(instance.size()), nullptr, 0);
  require(capacity > 0 && capacity <= 32768, "battery-identity-invalid");
  std::wstring normalized(static_cast<size_t>(capacity), L'\0');
  int length = NormalizeString(NormalizationC, instance.data(), static_cast<int>(instance.size()), normalized.data(), capacity);
  require(length > 0 && length <= capacity, "battery-identity-invalid");
  normalized.resize(static_cast<size_t>(length));
  nfc(normalized);
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::array<BYTE, 32> result{};
  require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0,
          "battery-hash-open");
  bool success = BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) == 0;
  if (success) success = BCryptHashData(hash,
      reinterpret_cast<BYTE*>(normalized.data()),
      static_cast<ULONG>(normalized.size() * sizeof(wchar_t)), 0) == 0;
  if (success) success = BCryptFinishHash(hash, result.data(), ULONG(result.size()), 0) == 0;
  if (hash) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  require(success, "battery-hash-failed");
  return hexBytes(result.data(), result.size());
}
struct BatteryObservation { Value fields; std::string error; };
inline BatteryObservation battery() {
  BatteryAudit audit;
  Value systemValue;
  Value::Array ports;
  bool completeEnumeration = false;
  std::string error;
  try {
    SYSTEM_POWER_STATUS system{};
    require(audit.call("GetSystemPowerStatus", [&] { return GetSystemPowerStatus(&system); }),
            "battery-system-api");
    systemValue = object({{L"acLineStatus", Value(uint64_t(system.ACLineStatus))},
        {L"batteryFlag", Value(uint64_t(system.BatteryFlag))},
        {L"batteryLifePercent", Value(uint64_t(system.BatteryLifePercent))}});
    auto begin = qpc();
    HDEVINFO devices = SetupDiGetClassDevsW(&GUID_DEVCLASS_BATTERY, nullptr, nullptr,
                                          DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    auto openError = devices == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    audit.record("SetupDiGetClassDevsW", begin, devices != INVALID_HANDLE_VALUE, openError);
    require(devices != INVALID_HANDLE_VALUE, "battery-enumeration-open");
    auto closeDevices = [&](HDEVINFO owned) {
      return audit.call("SetupDiDestroyDeviceInfoList", [&] { return SetupDiDestroyDeviceInfoList(owned); });
    };
    OnceCleanup deviceList{devices, HDEVINFO(INVALID_HANDLE_VALUE), closeDevices, audit.cleanupComplete};
    std::set<std::string> identities;
    for (DWORD index = 0; ; ++index) {
      SP_DEVICE_INTERFACE_DATA interfaceData{}; interfaceData.cbSize = sizeof(interfaceData);
      if (!audit.call("SetupDiEnumDeviceInterfaces", [&] {
            return SetupDiEnumDeviceInterfaces(devices, nullptr, &GUID_DEVCLASS_BATTERY, index, &interfaceData);
          })) {
        require(GetLastError() == ERROR_NO_MORE_ITEMS, "battery-enumeration-failed");
        completeEnumeration = true; break;
      }
      require(ports.size() < 64, "battery-port-budget");
      DWORD required = 0;
      auto sized = audit.call("SetupDiGetDeviceInterfaceDetailW.sizing", [&] {
        return SetupDiGetDeviceInterfaceDetailW(devices, &interfaceData, nullptr, 0, &required, nullptr);
      });
      require(!sized && GetLastError() == ERROR_INSUFFICIENT_BUFFER &&
                  required >= sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W) && required <= 65536,
              "battery-detail-sizing");
      std::vector<BYTE> detailBytes(required);
      auto detail = reinterpret_cast<SP_DEVICE_INTERFACE_DETAIL_DATA_W*>(detailBytes.data());
      detail->cbSize = sizeof(*detail);
      SP_DEVINFO_DATA deviceInfo{}; deviceInfo.cbSize = sizeof(deviceInfo);
      DWORD actual = 0;
      require(audit.call("SetupDiGetDeviceInterfaceDetailW", [&] {
        return SetupDiGetDeviceInterfaceDetailW(devices, &interfaceData, detail, required, &actual, &deviceInfo);
      }) && actual == required, "battery-detail-read");
      // Reject missing terminators before passing a driver-provided path to CreateFile.
      size_t maximumPath = (required - offsetof(SP_DEVICE_INTERFACE_DETAIL_DATA_W, DevicePath)) / sizeof(wchar_t);
      require(wcsnlen_s(detail->DevicePath, maximumPath) < maximumPath, "battery-detail-termination");
      DWORD instanceLength = 0;
      auto instanceSized = audit.call("SetupDiGetDeviceInstanceIdW.sizing", [&] {
        return SetupDiGetDeviceInstanceIdW(devices, &deviceInfo, nullptr, 0, &instanceLength);
      });
      require(!instanceSized && GetLastError() == ERROR_INSUFFICIENT_BUFFER, "battery-instance-sizing");
      batterySizes(required, instanceLength, ports.size());
      std::wstring instance(instanceLength, 0);
      require(audit.call("SetupDiGetDeviceInstanceIdW", [&] {
        return SetupDiGetDeviceInstanceIdW(devices, &deviceInfo, instance.data(), instanceLength, &actual);
      }) && actual == instanceLength && instance.back() == 0 &&
          wcsnlen_s(instance.data(), instanceLength) == instanceLength - 1, "battery-instance-read");
      instance.resize(instanceLength - 1);
      auto identity = batteryIdentity(instance);
      require(identities.insert(identity).second, "battery-duplicate-port");
      begin = qpc();
      HANDLE opened = CreateFileW(detail->DevicePath, GENERIC_READ | GENERIC_WRITE,
          FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
      openError = opened == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
      audit.record("CreateFileW.battery", begin, opened != INVALID_HANDLE_VALUE, openError);
      require(opened != INVALID_HANDLE_VALUE, "battery-device-open");
      auto closeDevice = [&](HANDLE owned) {
        return audit.call("CloseHandle.battery", [&] { return CloseHandle(owned); });
      };
      OnceCleanup device{opened, HANDLE(INVALID_HANDLE_VALUE), closeDevice, audit.cleanupComplete};
      ULONG timeout = 0, tag = BATTERY_TAG_INVALID;
      DWORD bytes = 0;
      bool tagSuccess = audit.call("DeviceIoControl.IOCTL_BATTERY_QUERY_TAG", [&] {
        return DeviceIoControl(opened, IOCTL_BATTERY_QUERY_TAG, &timeout, sizeof(timeout),
                               &tag, sizeof(tag), &bytes, nullptr);
      });
      DWORD tagError = tagSuccess ? ERROR_SUCCESS : GetLastError();
      bool absent = documentedAbsence(tagSuccess, tagError, tag, bytes);
      Value::Object port{{L"instanceSha256", Value(identity)},
          {L"status", Value(absent ? "documented-absence" : "present")},
          {L"tag", Value(uint64_t(tag))}, {L"tagSuccess", Value(tagSuccess)},
          {L"tagError", Value(uint64_t(tagError))}, {L"tagReturnedBytes", Value(uint64_t(bytes))}};
      if (!absent) {
        BATTERY_QUERY_INFORMATION query{};
        query.BatteryTag = tag; query.InformationLevel = BatteryInformation; query.AtRate = 0;
        BATTERY_INFORMATION information{};
        require(audit.call("DeviceIoControl.IOCTL_BATTERY_QUERY_INFORMATION", [&] {
          return DeviceIoControl(opened, IOCTL_BATTERY_QUERY_INFORMATION, &query, sizeof(query),
                                 &information, sizeof(information), &bytes, nullptr);
        }) && bytes == sizeof(information), "battery-information-invalid");
        DWORD informationBytes = bytes;
        BATTERY_WAIT_STATUS wait{}; wait.BatteryTag = tag;
        BATTERY_STATUS status{};
        require(audit.call("DeviceIoControl.IOCTL_BATTERY_QUERY_STATUS", [&] {
          return DeviceIoControl(opened, IOCTL_BATTERY_QUERY_STATUS, &wait, sizeof(wait),
                                 &status, sizeof(status), &bytes, nullptr);
        }) && bytes == sizeof(status), "battery-status-invalid");
        bool known = status.Rate != BATTERY_UNKNOWN_RATE;
        port.emplace(L"capabilities", Value(uint64_t(information.Capabilities)));
        port.emplace(L"powerState", Value(uint64_t(status.PowerState)));
        port.emplace(L"capacityMWh", Value(uint64_t(status.Capacity)));
        port.emplace(L"fullChargedCapacityMWh", Value(uint64_t(information.FullChargedCapacity)));
        port.emplace(L"rateKnown", Value(known));
        port.emplace(L"rateSign", Value(!known ? "unknown" : status.Rate < 0 ? "negative" : status.Rate > 0 ? "positive" : "zero"));
        port.emplace(L"absoluteRateMW", known ? Value(uint64_t(status.Rate < 0 ? -int64_t(status.Rate) : status.Rate)) : Value());
        port.emplace(L"informationReturnedBytes", Value(uint64_t(informationBytes)));
        port.emplace(L"statusReturnedBytes", Value(uint64_t(bytes)));
        port.emplace(L"detailRequiredBytes", Value(uint64_t(required)));
        port.emplace(L"detailStructBytes", Value(uint64_t(sizeof(*detail))));
        port.emplace(L"queryTagInputBytes", Value(uint64_t(sizeof(timeout))));
        port.emplace(L"queryInformationInputBytes", Value(uint64_t(sizeof(query))));
        port.emplace(L"queryStatusInputBytes", Value(uint64_t(sizeof(wait))));
      }
      ports.push_back(Value(port));
      device.finish();
      require(audit.cleanupComplete, "battery-device-close-failed");
    }
    deviceList.finish();
    require(audit.cleanupComplete, "battery-enumeration-close-failed");
  } catch (const Failure& failure) { error = failure.what(); }
  if (!audit.cleanupComplete && error.empty()) error = "battery-cleanup-failed";
  std::sort(ports.begin(), ports.end(), [](const Value& left, const Value& right) {
    return left.at("instanceSha256").string() < right.at("instanceSha256").string();
  });
  return {object({{L"system", systemValue}, {L"ports", Value(ports)},
      {L"enumerationComplete", Value(completeEnumeration)},
      {L"cleanupComplete", Value(audit.cleanupComplete)}, {L"api", Value(audit.rows)}}), error};
}
}  // namespace resource
