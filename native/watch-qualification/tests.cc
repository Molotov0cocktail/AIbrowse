#include "wire.hpp"
#include "stream.hpp"
#include <functional>
#include <iostream>

using namespace h3b;
Value grant(unsigned attempt, unsigned host, unsigned round) {
  return object(
      {{L"kind", Value("register")},
       {L"payload",
        object({{L"detail",
                 object({{L"attemptOrdinal",
                          Value(static_cast<uint64_t>(attempt))},
                         {L"entryIndex", Value(uint64_t(1))},
                         {L"grantElapsedMs", Value(uint64_t(0))},
                         {L"hostSlot", Value(static_cast<uint64_t>(host))},
                         {L"phase", Value("measurement")},
                         {L"round", Value(static_cast<uint64_t>(round))},
                         {L"waitedForGap", Value(false)}})},
                {L"identity", Value("host-grant:1")},
                {L"registry", Value("host-grant")}})},
       {L"qualificationRunId", Value("AAAAAAAAAAAAAAAAAAAAAAAAAA")},
       {L"sequence", Value(uint64_t(3))},
       {L"slotIndex", Value(nullptr)},
       {L"version", Value(uint64_t(2))}});
}
Value sample(uint64_t sequence, uint64_t prefix, const char* phase = "measurement") {
  Value::Array live;
  for (const auto* name : registries)
    live.push_back(object({{L"registry", Value(name)},
                          {L"identities", Value(Value::Array{})}}));
  return object({
      {L"kind", Value("sample")},
      {L"qualificationRunId", Value("AAAAAAAAAAAAAAAAAAAAAAAAAA")},
      {L"sequence", Value(sequence)}, {L"slotIndex", Value(uint64_t(0))},
      {L"version", Value(uint64_t(2))},
      {L"payload", object({
          {L"counters", object({{L"duplicateTerminalAttemptTotal", Value(uint64_t(0))},
              {L"uncaughtExceptionTotal", Value(uint64_t(0))},
              {L"unhandledRejectionTotal", Value(uint64_t(0))}})},
          {L"mainHeapUsedBytes", Value(uint64_t(1))},
          {L"nodeActiveByType", Value(Value::Array{})}, {L"phase", Value(phase)},
          {L"registryLive", Value(live)}, {L"registryPrefixSequence", Value(prefix)},
          {L"sampleToken", Value("AAAAAAAAAAAAAAAAAAAAAAAAAA")},
          {L"taskTabBindings", Value(Value::Array{})},
          {L"timing", object({{L"linearizedQpcTicks", Value("0000000000000001")},
              {L"slotQpcTicks", Value("0000000000000001")},
              {L"snapshotQpcTicks", Value("0000000000000002")},
              {L"triggerQpcTicks", Value("0000000000000001")}})},
          {L"watchLogicalDbBytes", Value(uint64_t(1))},
          {L"webContentsIds", Value(Value::Array{})}})}});
}
int main() {
  unsigned passed = 0, failed = 0;
  auto test = [&](const char* name, bool rejects,
                  const std::function<void()>& action) {
    bool threw = false;
    try {
      action();
    } catch (const Failure&) {
      threw = true;
    }
    if (threw == rejects) {
      ++passed;
      std::cout << "PASS " << name << '\n';
    } else {
      ++failed;
      std::cout << "FAIL " << name << '\n';
    }
  };
  auto gpuFrame = [](Value devices, Value software) {
    return object({{L"kind", Value("gpu-info")},
      {L"payload", object({{L"beginQpcTicks", Value("0000000000000001")},
        {L"endQpcTicks", Value("0000000000000002")},
        {L"devices", devices}, {L"softwareRendering", software}})},
      {L"qualificationRunId", Value("AAAAAAAAAAAAAAAAAAAAAAAAAA")},
      {L"sequence", Value(uint64_t(2))}, {L"slotIndex", Value(nullptr)}, {L"version", Value(uint64_t(2))}});
  };
  auto gpuDevice = object({{L"active", Value(true)}, {L"vendorId", Value(uint64_t(4318))}, {L"deviceId", Value(uint64_t(10464))}});
  test("gpu-info-valid", false, [&] { validateFrame(gpuFrame(Value(Value::Array{gpuDevice}), Value(false))); });
  test("gpu-info-unknown", false, [&] { validateFrame(gpuFrame(Value(Value::Array{}), Value(nullptr))); });
  test("gpu-info-device-bound", true, [&] { validateFrame(gpuFrame(Value(Value::Array(9, gpuDevice)), Value(false))); });
  test("gpu-info-boolean-required", true, [&] { validateFrame(gpuFrame(Value(Value::Array{gpuDevice}), Value(uint64_t(0)))); });
  test("fixed-grant-valid", false, [] { validateFrame(grant(1, 1, 0)); });
  test("nonpause-sample-then-event-without-write-receipt", false, [] {
    TelemetryStream stream;
    stream.sequence = 2;
    stream.setup = true;
    stream.accept(sample(3, 2));
    auto event = grant(1, 1, 0);
    std::get<Value::Object>(event.data)[L"sequence"] = Value(uint64_t(4));
    stream.accept(event);
    stream.accept(sample(5, 4));
  });
  test("nonpause-sample-wrong-prefix", true, [] {
    TelemetryStream stream;
    stream.sequence = 2;
    stream.setup = true;
    stream.accept(sample(3, 1));
  });
  test("measurement-after-stop-rejected", true, [] {
    TelemetryStream stream;
    stream.sequence = 2;
    stream.setup = stream.stopped = true;
    stream.accept(sample(3, 2));
  });
  test("drain-after-stop-accepted", false, [] {
    TelemetryStream stream;
    stream.sequence = 2;
    stream.setup = stream.stopped = true;
    stream.accept(sample(3, 2, "drain"));
  });
  test("qualification-build-entry-whitelist", false, [] {
    require(qualificationEntryArgument(L"out/qualification/main/index.js") &&
                qualificationEntryArgument(L"out/qualification-diagnostic/main/index.js") &&
                qualificationEntryArgument(L"out/qualification-load-diagnostic/main/index.js") &&
                !qualificationEntryArgument(L".") &&
                !qualificationEntryArgument(L"out/main/index.js") &&
                !qualificationEntryArgument(L"out/qualification/../main/index.js"),
            "entry-whitelist-invalid");
  });
  const std::wstring launchExe = L"D:\\synthetic app\\electron.exe";
  const std::wstring userData = L"D:\\synthetic work\\run-AAAAAAAAAAAAAAAAAAAAAAAAAA\\user-data";
  const std::vector<std::wstring> launchArguments{
      launchExe, L"out/qualification/main/index.js",
      L"--aibrowse-watch-resource-qualification",
      L"--user-data-dir=D:\\synthetic work\\run-AAAAAAAAAAAAAAAAAAAAAAAAAA\\user-data"};
  test("qualification-launch-exact-four-arguments", false, [&] {
    for (const auto* entry : {L"out/qualification/main/index.js",
                             L"out/qualification-diagnostic/main/index.js",
                             L"out/qualification-load-diagnostic/main/index.js"}) {
      auto arguments = launchArguments;
      arguments[1] = entry;
      require(qualificationLaunchArguments(arguments, launchExe, userData), "launch-invalid");
    }
  });
  auto rejectLaunch = [&](const char* name, std::vector<std::wstring> arguments) {
    test(name, true, [&] {
      require(qualificationLaunchArguments(arguments, launchExe, userData), "launch-invalid");
    });
  };
  auto absent = launchArguments;
  absent.pop_back();
  rejectLaunch("qualification-user-data-required", absent);
  auto duplicate = launchArguments;
  duplicate.push_back(launchArguments[3]);
  rejectLaunch("qualification-user-data-duplicate-rejected", duplicate);
  auto split = launchArguments;
  split[3] = L"--user-data-dir";
  split.push_back(userData);
  rejectLaunch("qualification-user-data-split-rejected", split);
  auto empty = launchArguments;
  empty[3] = L"--user-data-dir=";
  rejectLaunch("qualification-user-data-empty-rejected", empty);
  auto wrongRoot = launchArguments;
  wrongRoot[3] = L"--user-data-dir=D:\\synthetic other\\user-data";
  rejectLaunch("qualification-user-data-wrong-root-rejected", wrongRoot);
  auto alias = launchArguments;
  alias[3] = qualificationUserDataArgument(userData + L"\\.");
  rejectLaunch("qualification-user-data-alias-rejected", alias);
  auto caseVariant = launchArguments;
  caseVariant[3] = L"--user-data-dir=d:\\synthetic work\\run-AAAAAAAAAAAAAAAAAAAAAAAAAA\\user-data";
  rejectLaunch("qualification-user-data-case-mismatch-rejected", caseVariant);
  auto additional = launchArguments;
  additional.push_back(L"--disable-web-security");
  rejectLaunch("qualification-extra-switch-rejected", additional);
  auto wrongExe = launchArguments;
  wrongExe[0] = L"D:\\other\\electron.exe";
  rejectLaunch("qualification-exe-mismatch-rejected", wrongExe);
  auto wrongEntry = launchArguments;
  wrongEntry[1] = L"out/main/index.js";
  rejectLaunch("qualification-entry-mismatch-rejected", wrongEntry);
  auto wrongQualifier = launchArguments;
  wrongQualifier[2] = L"--aibrowse-watch-resource-qualification=1";
  rejectLaunch("qualification-qualifier-mismatch-rejected", wrongQualifier);
  test("retry-attempt-rejected", true, [] { validateFrame(grant(2, 1, 0)); });
  test("fifth-host-rejected", true, [] { validateFrame(grant(1, 4, 0)); });
  test("fifth-round-rejected", true, [] { validateFrame(grant(1, 1, 4)); });
  test("negative-qpc-rejected", true,
       [] { ticksField(Value("8000000000000000")); });
  test("nfc-required", true,
       [] { canonical(Value(std::wstring(L"e\u0301"))); });
  test("lone-surrogate-rejected", true,
       [] { canonical(Value(std::wstring(1, 0xd800))); });
  test("c1-control-rejected", true,
       [] { canonical(Value(std::wstring(1, 0x0085))); });
  test("canonical-utf16-key-order", false, [] {
    auto v = object({{std::wstring(L"\ue000"), Value(uint64_t(1))},
                     {std::wstring(L"\U00010000"), Value(uint64_t(2))}});
    require(canonical(v) == "{\"\xf0\x90\x80\x80\":2,\"\xee\x80\x80\":1}",
            "golden-mismatch");
  });
  test("unsafe-integer-rejected", true,
       [] { canonical(Value(9007199254740992ULL)); });
  test("identity-overflow-rejected", true, [] {
    identity(Value("host-grant:18446744073709551616"), "host-grant");
  });
  test("identity-leading-zero-rejected", true,
       [] { identity(Value("host-grant:01"), "host-grant"); });
  test("identity-uint64-max-accepted", false, [] {
    require(identity(Value("host-grant:18446744073709551615"), "host-grant") ==
                UINT64_MAX,
            "identity-max");
  });
  test("device-path-rejected", true,
       [] { strictLocalPath(L"\\\\?\\D:\\run-AAAAAAAAAAAAAAAAAAAAAAAAAA"); });
  test("unc-path-rejected", true,
       [] { strictLocalPath(L"\\\\host\\share\\root"); });
  test("dot-segment-rejected", true,
       [] { strictLocalPath(L"D:\\root\\..\\root"); });
  test("alternate-stream-rejected", true,
       [] { strictLocalPath(L"D:\\root:stream"); });
  test("empty-segment-rejected", true,
       [] { strictLocalPath(L"D:\\root\\\\leaf"); });
  test("trailing-space-rejected", true, [] { strictLocalPath(L"D:\\root "); });
  test("qpc-monotonic", false, [] {
    auto f = frequency();
    auto start = qpc();
    require(f > 0 && qpc() >= start, "qpc-invalid");
  });
  std::cout << "原生聚焦验证 " << passed << " PASS / " << failed << " FAIL\n";
  return failed ? 1 : 0;
}
