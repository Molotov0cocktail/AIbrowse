#include "process.hpp"
#include "metrics.hpp"
#include "scanner.hpp"
#include <iostream>

namespace {
using namespace h3b;
using namespace resource;

std::string runId() {
  std::array<BYTE, 16> bytes{};
  require(BCryptGenRandom(nullptr, bytes.data(), DWORD(bytes.size()),
                         BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, "fixture-id-failed");
  constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  std::string result;
  unsigned accumulator = 0, bits = 0;
  for (auto byte : bytes) {
    accumulator = (accumulator << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += alphabet[(accumulator >> bits) & 31]; }
  }
  if (bits) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}

std::vector<wchar_t> fixtureEnvironment(const Roots& roots) {
  std::map<std::wstring, std::wstring> values;
  for (const wchar_t* key : {L"SystemRoot", L"WINDIR", L"SystemDrive", L"PATH", L"COMSPEC",
                            L"USERPROFILE", L"HOMEDRIVE", L"HOMEPATH", L"USERNAME",
                            L"PROCESSOR_ARCHITECTURE", L"NUMBER_OF_PROCESSORS"}) {
    if (GetEnvironmentVariableW(key, nullptr, 0) > 1) values[key] = environment(key);
  }
  values[L"APPDATA"] = roots.paths.at("appDataRoot");
  values[L"LOCALAPPDATA"] = roots.paths.at("localAppDataRoot");
  values[L"TEMP"] = roots.paths.at("processTempRoot");
  values[L"TMP"] = roots.paths.at("processTempRoot");
  std::vector<wchar_t> output;
  for (const auto& [key, value] : values) {
    const auto entry = key + L"=" + value;
    output.insert(output.end(), entry.begin(), entry.end()); output.push_back(0);
  }
  output.push_back(0);
  return output;
}

int run(int argc, wchar_t** argv) {
  require(argc == 4 || (argc == 5 && std::wstring(argv[4]) == L"--product-smoke"), "fixture-arguments-invalid");
  const bool productSmoke = argc == 5;
  const std::wstring repo = argv[1], parent = argv[2], output = argv[3];
  strictLocalPath(repo); strictLocalPath(parent); strictLocalPath(output);
  const auto parentPin = openAttributes(parent), outputPin = openAttributes(output);
  fileId(parentPin.value, true); fileId(outputPin.value, true);
  const auto id = runId();
  const auto root = parent + L"\\run-" + wide(id);
  Security security(false, true);
  require(CreateDirectoryW(root.c_str(), &security.attributes), "fixture-root-create-failed");
  for (const auto& [key, leaf] : rootNames) {
    (void)key;
    if (leaf[0]) require(CreateDirectoryW((root + L"\\" + leaf).c_str(), &security.attributes),
                         "fixture-root-create-failed");
  }
  Roots roots; roots.pin(root, true);
  const auto exe = repo + L"\\node_modules\\electron\\dist\\electron.exe";
  const auto entry = repo + L"\\tools\\watch-qualification\\blank-feasibility.cjs";
  const auto exePin = immutableArtifact(exe), entryPin = immutableArtifact(entry);
  const auto bundle = repo + L"\\log\\watch-qualification-build\\browser-smoke.cjs";
  Handle bundlePin;
  if (productSmoke) bundlePin = immutableArtifact(bundle);
  const auto prefix = productSmoke ? L"\\browser-smoke-" : L"\\blank-";
  const auto environment = fixtureEnvironment(roots);
  Output stdoutFile(output + prefix + wide(id) + L".stdout.jsonl");
  Output stderrFile(output + prefix + wide(id) + L".stderr.txt");
  Output observations(output + prefix + wide(id) + L".observations.jsonl");
  auto owner = job();
  Child child;
  child.launch(exe, quote(exe) + L" " + quote(entry) +
      (productSmoke ? L" --aibrowse-browser-smoke " : L" --aibrowse-blank-feasibility ") +
      quote(L"--user-data-dir=" + roots.paths.at("userDataRoot")), repo, &environment);
  assign(owner.value, child.process.value);
  Value::Object ids;
  for (const auto& [key, identity] : roots.ids) ids.emplace(wide(key), Value(identity));
  observations.line(object({{L"kind", Value("meta")}, {L"runId", Value(id)},
      {L"mainPid", Value(uint64_t(child.pid))},
      {L"mainCreationFileTime", Value(hex(creation(child.process.value)))},
      {L"rootFileIds", Value(ids)}, {L"qpcFrequency", Value(frequency())},
      {L"entrySha256", Value(sha256(entry))}, {L"exeSha256", Value(sha256(exe))},
      {L"productBundleSha256", productSmoke ? Value(sha256(bundle)) : Value()}}));
  child.resume();
  const auto started = qpc(), freq = frequency();
  std::string lines;
  bool productComplete = false;
  while (true) {
    require(qpc() - started <= freq * 110, "fixture-deadline");
    child.out.poll(); child.err.poll();
    if (!child.err.pending.empty()) {
      stderrFile.write(child.err.pending); child.err.pending.clear();
    }
    if (!child.out.pending.empty()) {
      stdoutFile.write(child.out.pending); lines += child.out.pending; child.out.pending.clear();
    }
    require(lines.size() <= 65536, "fixture-line-budget");
    size_t newline = 0;
    while ((newline = lines.find('\n')) != std::string::npos) {
      auto line = lines.substr(0, newline + 1); lines.erase(0, newline + 1);
      if (line == "\n" || line == "\r\n") continue;
      // Product logger lines remain in raw stdout; only canonical smoke receipts
      // drive this focused oracle. The final product receipt is mandatory below.
      if (productSmoke && !line.starts_with("{")) continue;
      // Only this immutable, synthetic fixture writes the phase receipt.
      const auto phase = collector::Scanner(line).parse();
      if (productSmoke && phase.at("kind").string() == "浏览器产品冒烟通过")
        productComplete = phase.at("scenarios").number() == 8 &&
            std::get<bool>(phase.at("allOwnedDestroyed").data);
      const auto begin = qpc();
      try {
        const auto members = memory(owner.value);
        const auto end = qpc();
        observations.line(object({{L"kind", Value("phase-members")}, {L"fixture", phase},
            {L"beginQpc", decimal(begin)}, {L"endQpc", decimal(end)},
            {L"status", Value(end - begin <= freq * 2 ? "ok" : "invalid")},
            {L"membership", members}}));
      } catch (const Failure& error) {
        observations.line(object({{L"kind", Value("phase-members")}, {L"fixture", phase},
            {L"beginQpc", decimal(begin)}, {L"endQpc", decimal(qpc())},
            {L"status", Value("invalid")}, {L"error", Value(error.what())}}));
      }
    }
    const auto active = members(owner.value);
    if (WaitForSingleObject(child.process.value, 0) == WAIT_OBJECT_0 && active.empty() &&
        child.out.eof && child.err.eof) break;
    Sleep(10);
  }
  DWORD exitCode = 0;
  require(lines.empty() && GetExitCodeProcess(child.process.value, &exitCode), "fixture-exit-invalid");
  observations.line(object({{L"kind", Value("exit")}, {L"exitCode", Value(uint64_t(exitCode))},
      {L"activeProcesses", Value(uint64_t(0))}, {L"stdoutEof", Value(true)},
      {L"stderrEof", Value(true)}}));
  require(exitCode == 0, "fixture-nonzero-exit");
  require(!productSmoke || productComplete, "fixture-product-receipt-missing");
  std::cout << "空白页实验已完成，原始证据保留。\n";
  return 0;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    resource::LaunchContainment containment;
    try {
      const auto result = run(argc, argv); containment.release(); return result;
    } catch (const h3b::Failure& error) {
      std::cerr << "空白页实验未完成：" << error.what() << "；保留原始证据并收口本次进程树。\n";
      std::cerr.flush(); containment.abort();
    } catch (const std::exception&) {
      std::cerr << "空白页实验未完成，保留原始证据并收口本次进程树。\n";
      std::cerr.flush(); containment.abort();
    }
  } catch (const std::exception&) {
    std::cerr << "空白页实验启动失败。\n";
    return 79;
  }
}
