#pragma once
#include "wire.hpp"

namespace h3b {
// A sample observes one synchronous main prefix; subsequent events never wait
// for pipe completion and are not part of that sample's registry state.
struct TelemetryStream {
  uint64_t sequence = 0;
  bool setup = false, stopped = false, complete = false;

  void accept(const Value& frame) {
    validateFrame(frame);
    const auto kind = frame.at("kind").string();
    const auto next = frame.at("sequence").number();
    const auto& payload = frame.at("payload");
    require(!complete && next == sequence + 1 &&
                ((next == 1) == (kind == "ready")),
            "qualification-sequence-invalid");
    require(kind != "sample-closed" && kind != "sample-resumed",
            "qualification-sequence-invalid");
    if (kind == "setup") {
      require(!setup && !stopped, "qualification-sequence-invalid");
      setup = true;
    }
    if (kind == "sample")
      require(setup && payload.at("registryPrefixSequence").number() == next - 1 &&
                  ((payload.at("phase").string() == "drain") == stopped),
              "qualification-sequence-invalid");
    if (kind == "stop") {
      require(setup && !stopped, "qualification-sequence-invalid");
      stopped = true;
    }
    if (kind == "complete") {
      require(stopped, "qualification-sequence-invalid");
      complete = true;
    }
    sequence = next;
  }
};

inline bool qualificationEntryArgument(const std::wstring& value) {
  return value == L"out/qualification/main/index.js" ||
         value == L"out/qualification-diagnostic/main/index.js" ||
         value == L"out/qualification-load-diagnostic/main/index.js";
}
}  // namespace h3b
