#pragma once
#include "metrics.hpp"
#include "process.hpp"
#include "scanner.hpp"

namespace resource {
inline Value readRootIds(const std::wstring& path) {
  auto input = immutableArtifact(path);
  LARGE_INTEGER bytes{};
  require(GetFileSizeEx(input.value, &bytes) && bytes.QuadPart > 0 && bytes.QuadPart <= 16384,
          "released-identity-file-size");
  std::string content(static_cast<size_t>(bytes.QuadPart), 0);
  DWORD count = 0;
  require(ReadFile(input.value, content.data(), DWORD(content.size()), &count, nullptr) &&
              count == content.size(), "released-identity-file-read");
  auto identities = collector::Scanner(content).parse();
  keys(identities, {"appDataRoot", "localAppDataRoot", "processTempRoot", "runRoot", "userDataRoot", "watchTempRoot"});
  for (const auto& [name, id] : identities.object()) {
    (void)name;
    require(matches(id, "[0-9a-f]{16}:[0-9a-f]{32}"), "released-identity-invalid");
  }
  return identities;
}
inline Value verifyReleased(const std::wstring& root, const Value& expected,
                            const std::string& watchId, const std::string& dbId) {
  strictLocalPath(root);
  auto leaf = utf8(root.substr(root.find_last_of(L'\\') + 1));
  require(std::regex_match(leaf, std::regex("run-[A-Z2-7]{25}[AEIMQUY4]")), "released-root-name-invalid");
  require(std::regex_match(watchId, std::regex("[0-9a-f]{16}:[0-9a-f]{32}")) &&
              std::regex_match(dbId, std::regex("[0-9a-f]{16}:[0-9a-f]{32}")),
          "released-file-identity-invalid");
  std::vector<Handle> pins;
  auto ancestor = parentPath(root);
  while (ancestor.size() > 3) {
    auto pin = openAttributes(ancestor); fileId(pin.value, true);
    pins.push_back(std::move(pin)); ancestor = parentPath(ancestor);
  }
  auto volume = openAttributes(root.substr(0, 3)); fileId(volume.value, true);
  pins.push_back(std::move(volume));
  for (const auto& [key, child] : rootNames) {
    auto path = root + (child[0] ? L"\\" + std::wstring(child) : L"");
    auto pin = openRootPin(path);
    require(fileId(pin.value, true) == expected.at(key).string(), "released-root-identity-changed");
    pins.push_back(std::move(pin));
  }
  auto observation = files(root + L"\\watch-temp", expected.at("watchTempRoot").string(),
                           root + L"\\user-data", expected.at("userDataRoot").string(), true, dbId);
  require(observation.at("watchDirectoryFileId").string() == watchId, "released-watch-identity-changed");
  return observation;
}
inline bool releasedFiles(const Value& observation) {
  return std::get<bool>(observation.at("dbExists").data) &&
      !observation.at("dbExclusive").isNull() && std::get<bool>(observation.at("dbExclusive").data) &&
      !std::get<bool>(observation.at("walExists").data) && !std::get<bool>(observation.at("shmExists").data) &&
      observation.at("tempEntries").number() == 0;
}
}  // namespace resource
