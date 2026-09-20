#pragma once
#include <initializer_list>
#include <regex>
#include <variant>

#include "windows.hpp"

namespace h3b {
struct Value {
  using Object = std::map<std::wstring, Value>;
  using Array = std::vector<Value>;
  std::variant<std::nullptr_t, bool, uint64_t, std::wstring, Object, Array>
      data = nullptr;
  Value() = default;
  Value(std::nullptr_t) : data(nullptr) {}
  Value(bool x) : data(x) {}
  Value(uint64_t x) : data(x) {}
  Value(const std::wstring& x) : data(x) {}
  Value(const std::string& x) : data(wide(x)) {}
  Value(const char* x) : data(wide(x)) {}
  Value(const Object& x) : data(x) {}
  Value(const Array& x) : data(x) {}
  const Object& object() const {
    require(std::holds_alternative<Object>(data),
            "qualification-frame-invalid");
    return std::get<Object>(data);
  }
  const Array& array() const {
    require(std::holds_alternative<Array>(data), "qualification-frame-invalid");
    return std::get<Array>(data);
  }
  std::string string() const {
    require(std::holds_alternative<std::wstring>(data),
            "qualification-frame-invalid");
    return utf8(std::get<std::wstring>(data));
  }
  uint64_t number() const {
    require(std::holds_alternative<uint64_t>(data),
            "qualification-frame-invalid");
    return std::get<uint64_t>(data);
  }
  bool isNull() const { return std::holds_alternative<std::nullptr_t>(data); }
  const Value& at(const char* key) const {
    auto it = object().find(wide(key));
    require(it != object().end(), "qualification-frame-invalid");
    return it->second;
  }
};
inline Value object(
    std::initializer_list<std::pair<const std::wstring, Value>> values) {
  return Value(Value::Object(values));
}
inline std::string quoted(const std::wstring& s) {
  nfc(s);
  std::string out = "\"";
  for (char c : utf8(s)) {
    if (c == '"' || c == '\\') out += '\\';
    out += c;
  }
  return out + '"';
}
inline std::string canonical(const Value& v) {
  if (v.isNull()) return "null";
  if (auto p = std::get_if<bool>(&v.data)) return *p ? "true" : "false";
  if (auto p = std::get_if<uint64_t>(&v.data)) {
    require(*p <= 9007199254740991ULL, "qualification-frame-invalid");
    return std::to_string(*p);
  }
  if (auto p = std::get_if<std::wstring>(&v.data)) return quoted(*p);
  std::string out;
  if (auto p = std::get_if<Value::Array>(&v.data)) {
    out = "[";
    for (const auto& item : *p) {
      if (out.size() > 1) out += ',';
      out += canonical(item);
    }
    return out + ']';
  }
  out = "{";
  for (const auto& [key, value] : v.object()) {
    if (out.size() > 1) out += ',';
    out += quoted(key) + ':' + canonical(value);
  }
  return out + '}';
}
inline void keys(const Value& v, std::initializer_list<const char*> names) {
  require(v.object().size() == names.size(), "qualification-frame-invalid");
  for (const char* name : names) v.at(name);
}
inline bool matches(const Value& v, const char* pattern) {
  return std::regex_match(v.string(), std::regex(pattern));
}
inline void hexField(const Value& v, unsigned size) {
  auto s = v.string();
  require(s.size() == size &&
              s.find_first_not_of("0123456789abcdef") == std::string::npos,
          "qualification-frame-invalid");
}
inline void ticksField(const Value& v) {
  hexField(v, 16);
  require(v.string()[0] <= '7', "qualification-frame-invalid");
}
inline void fileIdField(const Value& v) {
  require(matches(v, "[0-9a-f]{16}:[0-9a-f]{32}"),
          "qualification-frame-invalid");
}
inline void bounded(const Value& v, uint64_t min = 0,
                    uint64_t max = 9007199254740991ULL) {
  auto n = v.number();
  require(n >= min && n <= max, "qualification-frame-invalid");
}
inline void choice(const Value& v, std::initializer_list<const char*> names) {
  auto s = v.string();
  require(std::find(names.begin(), names.end(), s) != names.end(),
          "qualification-frame-invalid");
}
inline void phaseField(const Value& v) {
  choice(v, {"warmup", "measurement", "drain"});
}
inline void tokenField(const Value& v) {
  require(matches(v, "[A-Z2-7]{25}[AEIMQUY4]"), "qualification-frame-invalid");
}
inline const std::array<const char*, 14> registries{
    {"host-grant", "coordinator-slot", "http-request", "http-response",
     "socket", "watch-timer", "digest-timer", "watch-owner-timer",
     "provider-attempt", "task-tab", "watch-async-operation", "watch-store",
     "watch-db", "watch-temp-lease"}};
inline size_t registryIndex(const Value& v) {
  auto s = v.string();
  auto it = std::find(registries.begin(), registries.end(), s);
  require(it != registries.end(), "qualification-frame-invalid");
  return it - registries.begin();
}
inline uint64_t identity(const Value& v, const std::string& registry) {
  auto s = v.string();
  auto prefix = registry + ":";
  require(s.starts_with(prefix), "qualification-frame-invalid");
  auto ordinal = s.substr(prefix.size());
  require(!ordinal.empty() && ordinal[0] >= '1' && ordinal[0] <= '9' &&
              ordinal.find_first_not_of("0123456789") == std::string::npos &&
              ordinal.size() <= 20,
          "qualification-frame-invalid");
  uint64_t result = 0;
  for (char c : ordinal) {
    require(result <= (UINT64_MAX - (c - '0')) / 10,
            "qualification-frame-invalid");
    result = result * 10 + c - '0';
  }
  return result;
}
inline void counters(const Value& v) {
  keys(v, {"duplicateTerminalAttemptTotal", "uncaughtExceptionTotal",
           "unhandledRejectionTotal"});
  for (const auto& [k, n] : v.object()) bounded(n);
}
inline void live(const Value& v) {
  require(v.array().size() == registries.size(), "qualification-frame-invalid");
  for (size_t i = 0; i < registries.size(); ++i) {
    const auto& row = v.array()[i];
    keys(row, {"registry", "identities"});
    require(registryIndex(row.at("registry")) == i,
            "qualification-frame-invalid");
    require(row.at("identities").array().size() <= 8192,
            "qualification-frame-invalid");
    uint64_t previous = 0;
    for (const auto& id : row.at("identities").array()) {
      auto n = identity(id, registries[i]);
      require(n > previous, "qualification-frame-invalid");
      previous = n;
    }
  }
}
inline void roots(const Value& v) {
  keys(v, {"appDataRoot", "localAppDataRoot", "processTempRoot", "runRoot",
           "userDataRoot", "watchTempRoot"});
  for (const auto& [k, id] : v.object()) fileIdField(id);
}
inline void validateFrame(const Value& v) {
  keys(v, {"kind", "payload", "qualificationRunId", "sequence", "slotIndex",
           "version"});
  bounded(v.at("version"), 2, 2);
  bounded(v.at("sequence"), 1);
  tokenField(v.at("qualificationRunId"));
  auto kind = v.at("kind").string();
  const auto& p = v.at("payload");
  bool sampleKind =
      kind == "sample" || kind == "sample-closed" || kind == "sample-resumed";
  if (sampleKind) {
    bounded(v.at("slotIndex"), 0, 360);
  } else
    require(v.at("slotIndex").isNull(), "qualification-frame-invalid");
  if (kind == "ready") {
    keys(p, {"appPathFileId", "electronExeFileId", "mainCreationFileTime",
             "mainEntrySha256", "mainPid", "processExecPathSha256",
             "processType", "qpcFrequency", "rootFileIds",
             "serverCreationFileTime", "serverPid"});
    fileIdField(p.at("appPathFileId"));
    fileIdField(p.at("electronExeFileId"));
    hexField(p.at("mainCreationFileTime"), 16);
    hexField(p.at("serverCreationFileTime"), 16);
    hexField(p.at("mainEntrySha256"), 64);
    hexField(p.at("processExecPathSha256"), 64);
    bounded(p.at("mainPid"), 1, UINT32_MAX);
    bounded(p.at("serverPid"), 1, UINT32_MAX);
    bounded(p.at("qpcFrequency"), 1);
    choice(p.at("processType"), {"browser"});
    roots(p.at("rootFileIds"));
  } else if (kind == "gpu-info") {
    keys(p, {"beginQpcTicks", "endQpcTicks", "devices", "softwareRendering"});
    ticksField(p.at("beginQpcTicks"));
    ticksField(p.at("endQpcTicks"));
    require(p.at("beginQpcTicks").string() <= p.at("endQpcTicks").string(), "qualification-frame-invalid");
    require(p.at("devices").array().size() <= 8, "qualification-frame-invalid");
    for (const auto& device : p.at("devices").array()) {
      keys(device, {"active", "deviceId", "vendorId"});
      require(std::holds_alternative<bool>(device.at("active").data), "qualification-frame-invalid");
      bounded(device.at("deviceId"), 0, UINT32_MAX);
      bounded(device.at("vendorId"), 0, UINT32_MAX);
    }
    require(p.at("softwareRendering").isNull() || std::holds_alternative<bool>(p.at("softwareRendering").data), "qualification-frame-invalid");
  } else if (kind == "setup") {
    keys(p, {"descriptorSha256", "expandedManifestSha256", "m0QpcTicks",
             "m0Utc", "qpcAnchorTicks", "utcAnchorMs"});
    hexField(p.at("descriptorSha256"), 64);
    hexField(p.at("expandedManifestSha256"), 64);
    ticksField(p.at("m0QpcTicks"));
    ticksField(p.at("qpcAnchorTicks"));
    bounded(p.at("utcAnchorMs"));
    require(matches(p.at("m0Utc"),
                    "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00\\.000Z"),
            "qualification-frame-invalid");
  } else if (kind == "heartbeat") {
    keys(p, {"qpcTicks"});
    ticksField(p.at("qpcTicks"));
  } else if (kind == "stop") {
    keys(p, {"admissionClosedQpcTicks", "observedQpcTicks", "reason"});
    ticksField(p.at("admissionClosedQpcTicks"));
    ticksField(p.at("observedQpcTicks"));
    choice(p.at("reason"), {"normal-exit"});
  } else if (kind == "register" || kind == "unregister") {
    keys(p, {"detail", "identity", "registry"});
    auto r = registryIndex(p.at("registry"));
    identity(p.at("identity"), registries[r]);
    const auto& d = p.at("detail");
    if (r == 0 || r == 1) {
      if (r == 0)
        keys(d, {"attemptOrdinal", "entryIndex", "grantElapsedMs", "hostSlot",
                 "phase", "round", "waitedForGap"});
      else
        keys(d, {"entryIndex", "hostSlot", "phase", "round"});
      bounded(d.at("entryIndex"), 0, 99);
      bounded(d.at("hostSlot"), 0, 3);
      choice(d.at("phase"), {"initialization", "warmup", "measurement"});
      if (d.at("phase").string() == "measurement")
        bounded(d.at("round"), 0, 3);
      else
        require(d.at("round").isNull(), "qualification-frame-invalid");
      if (r == 0) {
        bounded(d.at("attemptOrdinal"), 1, 1);
        bounded(d.at("grantElapsedMs"));
        require(std::holds_alternative<bool>(d.at("waitedForGap").data),
                "qualification-frame-invalid");
      }
    } else if (r == 7) {
      keys(d, {"ownerKind"});
      choice(d.at("ownerKind"),
             {"host-gate", "coordinator", "qualification-fixture"});
    } else if (r == 10 && !d.isNull()) {
      keys(d, {"cleanupOf"});
      auto s = d.at("cleanupOf").string();
      auto pos = s.find(':');
      require(pos != std::string::npos, "qualification-frame-invalid");
      auto name = s.substr(0, pos);
      require(std::find(registries.begin(), registries.end(), name) !=
                  registries.end(),
              "qualification-frame-invalid");
      identity(d.at("cleanupOf"), name);
    } else
      require(d.isNull(), "qualification-frame-invalid");
  } else if (kind == "sample") {
    keys(p, {"counters", "mainHeapUsedBytes", "nodeActiveByType", "phase",
             "registryLive", "registryPrefixSequence", "sampleToken",
             "taskTabBindings", "timing", "watchLogicalDbBytes",
             "webContentsIds"});
    counters(p.at("counters"));
    bounded(p.at("mainHeapUsedBytes"));
    bounded(p.at("watchLogicalDbBytes"));
    phaseField(p.at("phase"));
    live(p.at("registryLive"));
    bounded(p.at("registryPrefixSequence"));
    tokenField(p.at("sampleToken"));
    const auto& t = p.at("timing");
    keys(t, {"linearizedQpcTicks", "slotQpcTicks", "snapshotQpcTicks",
             "triggerQpcTicks"});
    for (const auto& [k, x] : t.object()) ticksField(x);
    require(p.at("nodeActiveByType").array().size() <= 1024,
            "qualification-frame-invalid");
    std::string previous;
    for (const auto& x : p.at("nodeActiveByType").array()) {
      keys(x, {"type", "count"});
      require(matches(x.at("type"), "[A-Za-z][A-Za-z0-9_.:-]{0,127}") &&
                  x.at("type").string() > previous,
              "qualification-frame-invalid");
      previous = x.at("type").string();
      bounded(x.at("count"), 1);
    }
    uint64_t prev = 0;
    require(p.at("webContentsIds").array().size() <= 1024,
            "qualification-frame-invalid");
    for (const auto& x : p.at("webContentsIds").array()) {
      bounded(x, 1, INT32_MAX);
      require(x.number() > prev, "qualification-frame-invalid");
      prev = x.number();
    }
    prev = 0;
    require(p.at("taskTabBindings").array().size() <= 1024,
            "qualification-frame-invalid");
    for (const auto& x : p.at("taskTabBindings").array()) {
      keys(x, {"identity", "tabId", "webContentsId"});
      auto n = identity(x.at("identity"), "task-tab");
      require(n > prev, "qualification-frame-invalid");
      prev = n;
      require(matches(x.at("tabId"), "[A-Za-z0-9_-]{1,128}"),
              "qualification-frame-invalid");
      bounded(x.at("webContentsId"), 1, INT32_MAX);
    }
  } else if (kind == "sample-closed") {
    keys(p, {"closeQpcTicks", "phase", "registryPrefixSequence", "sampleToken",
             "sampleWriteCompletedQpcTicks"});
    ticksField(p.at("closeQpcTicks"));
    ticksField(p.at("sampleWriteCompletedQpcTicks"));
    phaseField(p.at("phase"));
    bounded(p.at("registryPrefixSequence"));
    tokenField(p.at("sampleToken"));
  } else if (kind == "sample-resumed") {
    keys(p, {"phase", "resumeQpcTicks", "sampleToken"});
    phaseField(p.at("phase"));
    ticksField(p.at("resumeQpcTicks"));
    tokenField(p.at("sampleToken"));
  } else if (kind == "complete") {
    keys(p, {"counters", "registryLive"});
    counters(p.at("counters"));
    live(p.at("registryLive"));
    for (const auto& x : p.at("registryLive").array())
      require(x.at("identities").array().empty(),
              "qualification-frame-invalid");
    for (const auto& [k, x] : p.at("counters").object()) bounded(x, 0, 0);
  } else
    throw Failure("qualification-frame-invalid");
}
}  // namespace h3b
