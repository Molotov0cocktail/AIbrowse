#include "process.hpp"
#include "telemetry.hpp"
#include "metrics.hpp"
#include "scanner.hpp"
#include "stream.hpp"
#include <iostream>

namespace {
using namespace h3b;
using namespace resource;

std::string randomId() {
  std::array<BYTE, 16> bytes{};
  require(BCryptGenRandom(nullptr, bytes.data(), DWORD(bytes.size()),
                         BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, "startup-id-failed");
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
std::unique_ptr<Roots> freshRoots(const std::wstring& parent) {
  const auto root = parent + L"\\run-" + wide(randomId());
  Security security(false, true);
  require(CreateDirectoryW(root.c_str(), &security.attributes), "startup-root-create-failed");
  for (const auto& [key, leaf] : rootNames) {
    (void)key;
    if (leaf[0]) require(CreateDirectoryW((root + L"\\" + leaf).c_str(), &security.attributes),
                         "startup-root-create-failed");
  }
  // Use the exact fresh userData directory before any pin exists as the positive
  // control. A descendant of an already pinned appData root is not independent.
  const auto userData = root + L"\\user-data", renamed = root + L"\\user-data-control";
  strictLocalPath(userData); strictLocalPath(renamed);
  require(parentPath(userData) == root && parentPath(renamed) == root,
          "startup-positive-scope-invalid");
  require(MoveFileW(userData.c_str(), renamed.c_str()), "startup-unpinned-rename-failed");
  require(MoveFileW(renamed.c_str(), userData.c_str()), "startup-unpinned-restore-failed");
  auto roots = std::make_unique<Roots>(); roots->pin(root, true); return roots;
}
std::vector<wchar_t> environmentFor(const Roots& roots, const std::wstring& observer,
                                  const std::string& mode, bool observed) {
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
  if (observed) {
    // Do not inherit NODE_OPTIONS. Only this pinned observer may be injected.
    auto optionPath = observer;
    std::replace(optionPath.begin(), optionPath.end(), L'\\', L'/');
    values[L"NODE_OPTIONS"] = L"--require " + quote(optionPath);
    values[L"STARTUP_CHECK_CASE"] = wide(mode);
  }
  std::vector<wchar_t> output;
  for (const auto& [key, value] : values) {
    const auto entry = key + L"=" + value;
    output.insert(output.end(), entry.begin(), entry.end()); output.push_back(0);
  }
  output.push_back(0); return output;
}
void swapRejected(const Roots& roots, Output& records, const char* phase) {
  const auto& target = roots.paths.at("userDataRoot");
  // The first rename must fail; a successful rename is retained as failure evidence.
  SetLastError(ERROR_SUCCESS);
  const bool renamed = MoveFileW(target.c_str(), (target + L"-moved").c_str()) != FALSE;
  const auto error = GetLastError();
  records.line(object({{L"kind", Value("root-swap")}, {L"phase", Value(phase)},
      {L"renamed", Value(renamed)}, {L"win32Error", Value(uint64_t(error))}}));
  require(!renamed && (error == ERROR_SHARING_VIOLATION || error == ERROR_ACCESS_DENIED),
          "startup-root-swap-not-rejected");
  auto current = openAttributes(target);
  require(fileId(current.value, true) == roots.ids.at("userDataRoot"), "startup-root-identity-changed");
}
bool businessFilesAbsent(const Roots& roots) {
  for (const wchar_t* suffix : {L"\\watch\\watch.db", L"\\sources\\sources.db", L"\\research\\research.db",
                               L"\\credentials.json"}) {
    SetLastError(ERROR_SUCCESS);
    const auto attr = GetFileAttributesW((roots.paths.at("userDataRoot") + suffix).c_str());
    const auto error = GetLastError();
    if (attr != INVALID_FILE_ATTRIBUTES ||
        (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)) return false;
  }
  return true;
}
void runCase(const std::wstring& repo, const std::wstring& parent, const std::wstring& output,
             const std::string& mode) {
  const bool positive = mode == "positive", observed = mode != "native-normal";
  const bool success = mode == "normal" || mode == "delayed" || mode == "native-normal";
  const bool normalBuild = mode == "normal-build";
  auto roots = freshRoots(parent);
  std::unique_ptr<Roots> alternate;
  if (mode == "wrong-root" || mode == "duplicate") alternate = freshRoots(parent);
  const auto exe = repo + L"\\node_modules\\electron\\dist\\electron.exe";
  const auto observer = repo + L"\\tools\\watch-qualification\\startup-check-observer.cjs";
  const std::wstring entry = positive ? L"tools/watch-qualification/startup-check-positive.cjs" :
      normalBuild ? L"out/main/index.js" : L"out/qualification-diagnostic/main/index.js";
  auto fullEntry = repo + L"\\" + entry;
  std::replace(fullEntry.begin(), fullEntry.end(), L'/', L'\\');
  const auto exePin = immutableArtifact(exe), entryPin = immutableArtifact(fullEntry),
             observerPin = immutableArtifact(observer);
  const auto mainDirectory = parentPath(fullEntry);
  auto directoryPin = openAttributes(mainDirectory);
  Handle addonPin;
  if (!positive && !normalBuild) addonPin = immutableArtifact(mainDirectory + L"\\watch-qualification.node");
  Output records(output + L"\\startup-" + wide(mode) + L"-" + wide(roots->runId) + L".jsonl");
  Output stdoutFile(output + L"\\startup-" + wide(mode) + L"-" + wide(roots->runId) + L".stdout.txt");
  Output stderrFile(output + L"\\startup-" + wide(mode) + L"-" + wide(roots->runId) + L".stderr.txt");
  if (positive) {
    Output canary(roots->paths.at("appDataRoot") + L"\\credentials.synthetic");
    canary.write("STARTUP_CHECK_SYNTHETIC_ONLY\n");
  }
  const auto env = environmentFor(*roots, observer, mode, observed);
  auto command = quote(exe) + L" " + quote(entry);
  if (!positive) command += L" --aibrowse-watch-resource-qualification";
  command += L" " + quote(qualificationUserDataArgument(
      mode == "wrong-root" ? alternate->paths.at("userDataRoot") : roots->paths.at("userDataRoot")));
  if (mode == "duplicate") command += L" " + quote(qualificationUserDataArgument(alternate->paths.at("userDataRoot")));
  if (mode == "extra") command += L" --startup-check-extra";
  auto owner = job();
  Child child; child.launch(exe, command, repo, &env); assign(owner.value, child.process.value);
  const auto birth = creation(child.process.value), freq = frequency();
  const auto expectedMain = sha256(fullEntry), expectedExe = sha256(exe);
  Value::Object ids;
  for (const auto& [key, id] : roots->ids) ids.emplace(wide(key), Value(id));
  records.line(object({{L"kind", Value("meta")}, {L"mode", Value(mode)},
      {L"runId", Value(roots->runId)}, {L"mainPid", Value(uint64_t(child.pid))},
      {L"mainCreationFileTime", Value(hex(birth))}, {L"rootFileIds", Value(ids)},
      {L"entrySha256", Value(expectedMain)}, {L"exeSha256", Value(expectedExe)},
      {L"addonSha256", addonPin.valid() ? Value(sha256(mainDirectory + L"\\watch-qualification.node")) : Value()},
      {L"observerSha256", Value(sha256(observer))}, {L"observed", Value(observed)},
      {L"qpcFrequency", Value(freq)}, {L"sameUserDataRenameBeforePins", Value(true)}}));
  swapRejected(*roots, records, "before-resume");
  std::unique_ptr<Telemetry> telemetry;
  if (success && mode != "delayed") {
    telemetry = std::make_unique<Telemetry>(); telemetry->connect(child.pid);
  }
  child.resume();
  const auto start = qpc();
  uint64_t authenticateStarted = 0;
  bool hook = false, prepared = false, authenticated = false, earlyMatch = false;
  bool positiveModule = false, positiveRead = false, rejected = false, ready = false, complete = false;
  std::string rejection;
  bool swappedDuringWait = false;
  uint64_t frames = 0, observerSequence = 0;
  std::string lines;
  while (true) {
    const auto now = qpc();
    require(now - start <= freq * (success ? 100ULL : 15ULL), "startup-case-deadline");
    child.out.poll(); child.err.poll();
    if (!child.err.pending.empty()) { stderrFile.write(child.err.pending); child.err.pending.clear(); }
    if (!child.out.pending.empty()) {
      stdoutFile.write(child.out.pending); lines += child.out.pending; child.out.pending.clear();
    }
    require(lines.size() <= 262144, "startup-line-budget");
    size_t newline = 0;
    while ((newline = lines.find('\n')) != std::string::npos) {
      const auto line = lines.substr(0, newline); lines.erase(0, newline + 1);
      if (line.starts_with("STARTUP_CHECK ")) {
        const auto observation = collector::Scanner(line.substr(14) + "\n").parse();
        require(observation.at("sequence").number() == ++observerSequence, "startup-observer-sequence");
        records.line(object({{L"kind", Value("observer")}, {L"qpc", decimal(qpc())},
                             {L"observation", observation}}));
        const auto kind = observation.at("kind").string();
        if (kind == "observer-start") {
          hook = true;
          require(observation.at("electron").string() == "43.4.0", "startup-electron-version");
        } else if (kind == "electron-bound") {
          earlyMatch = std::get<bool>(observation.at("userDataMatches").data) &&
                       std::get<bool>(observation.at("sessionDataMatches").data);
        } else if (kind == "prepared") prepared = true;
        else if (kind == "authenticate-start") authenticateStarted = qpc();
        else if (kind == "authenticated") authenticated = true;
        else if (kind == "prepare-rejected" || kind == "authenticate-rejected") {
          rejected = true; rejection = observation.at("classification").string();
        }
        else if (kind == "credential-read") {
          require(std::get<bool>(observation.at("synthetic").data), "startup-nonsynthetic-credential-attempt");
          if (!std::get<bool>(observation.at("authenticated").data)) {
            require(positive, "startup-premature-credential-read"); positiveRead = true;
          }
        } else if (kind == "module-load") {
          const auto category = observation.at("category").string();
          if (category == "synthetic-positive") positiveModule = true;
          if (normalBuild) require(category != "qualification-addon", "startup-normal-addon-reachable");
        }
      } else if (line.find("资格早期路径核对") != std::string::npos) earlyMatch = true;
    }
    if (mode == "delayed" && authenticateStarted && !telemetry) {
      if (!swappedDuringWait) {
        require(prepared && !authenticated && !ready && businessFilesAbsent(*roots), "startup-delay-premature-business");
        swapRejected(*roots, records, "authentication-wait"); swappedDuringWait = true;
      }
      if (qpc() - authenticateStarted >= freq) {
        require(!authenticated && !ready && businessFilesAbsent(*roots), "startup-delay-premature-business");
        telemetry = std::make_unique<Telemetry>(); telemetry->connect(child.pid);
        records.line(object({{L"kind", Value("authentication-pipe-created")}, {L"qpc", decimal(qpc())}}));
      }
    }
    if (telemetry) {
      telemetry->poll(child.pid, child.process.value);
      while ((newline = telemetry->pending.find('\n')) != std::string::npos) {
        const auto line = telemetry->pending.substr(0, newline + 1); telemetry->pending.erase(0, newline + 1);
        const auto frame = collector::Scanner(line).parse(); validateFrame(frame);
        require(frame.at("qualificationRunId").string() == roots->runId &&
                    frame.at("sequence").number() == ++frames, "startup-telemetry-sequence");
        const auto kind = frame.at("kind").string();
        if (kind == "ready") {
          const auto& identity = frame.at("payload");
          require(frames == 1 && identity.at("mainPid").number() == child.pid &&
              identity.at("mainCreationFileTime").string() == hex(birth) &&
              identity.at("serverPid").number() == GetCurrentProcessId() &&
              identity.at("serverCreationFileTime").string() == hex(creation(GetCurrentProcess())) &&
              identity.at("qpcFrequency").number() == freq &&
              identity.at("mainEntrySha256").string() == expectedMain &&
              identity.at("processExecPathSha256").string() == expectedExe &&
              identity.at("appPathFileId").string() == fileId(directoryPin.value, true) &&
              identity.at("electronExeFileId").string() == fileId(exePin.value), "startup-ready-identity");
          for (const auto& [key, id] : roots->ids)
            require(identity.at("rootFileIds").at(key.c_str()).string() == id, "startup-ready-root-identity");
          ready = true;
        }
        if (kind == "complete") complete = true;
        records.line(object({{L"kind", Value("telemetry")}, {L"frame", frame}}));
      }
    }
    if (WaitForSingleObject(child.process.value, 0) == WAIT_OBJECT_0 &&
        members(owner.value).empty() && child.out.eof && child.err.eof &&
        (!telemetry || telemetry->eof)) break;
    Sleep(10);
  }
  DWORD exitCode = 0;
  require(GetExitCodeProcess(child.process.value, &exitCode), "startup-exit-unavailable");
  records.line(object({{L"kind", Value("exit")}, {L"exitCode", Value(uint64_t(exitCode))},
      {L"ready", Value(ready)}, {L"complete", Value(complete)}, {L"hook", Value(hook)},
      {L"prepared", Value(prepared)}, {L"authenticated", Value(authenticated)},
      {L"earlyPathsMatch", Value(earlyMatch)},
      {L"activeProcesses", Value(uint64_t(0))}, {L"stdoutEof", Value(true)}, {L"stderrEof", Value(true)},
      {L"businessFilesAbsent", Value(businessFilesAbsent(*roots))}}));
  require(lines.empty() && (!observed || hook), "startup-observer-unavailable");
  if (positive) require(exitCode == 0 && positiveModule && positiveRead && !authenticated, "startup-positive-not-detected");
  else if (success) require(exitCode == 0 && ready && complete && earlyMatch &&
      (!observed || (prepared && authenticated)) && (mode != "delayed" || swappedDuringWait), "startup-success-oracle-failed");
  else {
    require(exitCode != 0 && !ready && !authenticated && businessFilesAbsent(*roots) &&
        (normalBuild || rejected), "startup-rejection-oracle-failed");
    if (mode == "missing") require(prepared && earlyMatch && authenticateStarted &&
        rejection == "qualification-io-timeout", "startup-auth-rejection-classification");
    else if (!normalBuild) require(!prepared && rejection == "qualification-launch-invalid",
                                  "startup-argument-rejection-classification");
  }
  std::cout << "启动专项完成一个有界场景：" << mode << '\n';
}
int run(int argc, wchar_t** argv) {
  require(argc == 5 && std::wstring(argv[4]) == L"--window-ended", "startup-arguments-invalid");
  const std::wstring repo = argv[1], parent = argv[2], output = argv[3];
  strictLocalPath(repo); strictLocalPath(parent); strictLocalPath(output);
  auto parentPin = openAttributes(parent), outputPin = openAttributes(output);
  fileId(parentPin.value, true); fileId(outputPin.value, true);
  // Missing/empty user-data arguments are never launched; native pure tests cover them.
  for (const auto* mode : {"positive", "native-normal", "normal", "delayed", "missing",
                          "wrong-root", "duplicate", "extra", "normal-build"})
    runCase(repo, parent, output, mode);
  return 0;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    LaunchContainment containment;
    try { const auto result = run(argc, argv); containment.release(); return result; }
    catch (const std::exception& error) {
      std::cerr << "启动专项停止，原件保留：" << error.what() << '\n';
      std::cerr.flush(); containment.abort();
    }
  } catch (const std::exception&) {
    std::cerr << "启动专项进程树容器不可用。\n"; return 79;
  }
}
