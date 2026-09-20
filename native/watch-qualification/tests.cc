#include "wire.hpp"
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
