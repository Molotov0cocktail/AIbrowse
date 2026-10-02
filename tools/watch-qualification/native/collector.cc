#include "metrics.hpp"
#include "process.hpp"
#include "scanner.hpp"
#include "telemetry.hpp"
#include "battery.hpp"
#include "released.hpp"
#include <powrprof.h>
#include <atomic>
#include <fcntl.h>
#include <io.h>
#include <iostream>

namespace {
using namespace h3b;
using namespace resource;
using collector::Scanner;
struct AwakeRequest {
  bool active = false;
  AwakeRequest() {
    require(SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) != 0,
            "awake-request-unavailable");
    active = true;
  }
  void release() {
    if (!active) return;
    require(SetThreadExecutionState(ES_CONTINUOUS) != 0, "awake-request-release-failed");
    active = false;
  }
  ~AwakeRequest() { if (active) SetThreadExecutionState(ES_CONTINUOUS); }
};
struct PowerMonitor {
  std::atomic<uint64_t> transitions{0};
  HPOWERNOTIFY subscription = nullptr;
  DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS parameters{};
  static ULONG CALLBACK callback(PVOID context, ULONG type, PVOID) {
    if (type == PBT_APMSUSPEND || type == PBT_APMRESUMEAUTOMATIC || type == PBT_APMRESUMESUSPEND)
      static_cast<PowerMonitor*>(context)->transitions.fetch_add(1);
    return ERROR_SUCCESS;
  }
  PowerMonitor() {
    parameters.Callback = callback;
    parameters.Context = this;
    require(PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK, &parameters,
                &subscription) == ERROR_SUCCESS, "power-notification-unavailable");
  }
  ~PowerMonitor() { if (subscription) PowerUnregisterSuspendResumeNotification(subscription); }
};
uint64_t integer(const std::wstring& text) {
  require(!text.empty() && text.find_first_not_of(L"0123456789") == std::wstring::npos,
          "argument-integer-invalid");
  size_t used = 0;
  auto value = std::stoull(text, &used);
  require(used == text.size(), "argument-integer-invalid");
  return value;
}
uint64_t ticks(const Value& value) {
  hexField(value, 16);
  return std::stoull(value.string(), nullptr, 16);
}
Value envelope(const std::string& kind, uint64_t slot, const std::string& phase,
               uint64_t begin, uint64_t end, const Value& fields, const char* error = nullptr) {
  auto result = fields.object();
  result.emplace(L"version", Value(uint64_t(1)));
  result.emplace(L"kind", Value(kind));
  result.emplace(L"slot", Value(slot));
  result.emplace(L"phase", Value(phase));
  result.emplace(L"beginQpc", decimal(begin));
  result.emplace(L"endQpc", decimal(end));
  result.emplace(L"status", Value(error ? "invalid" : "ok"));
  if (error) result.emplace(L"error", Value(error));
  return Value(result);
}
int worker(int argc, wchar_t** argv) {
  require(_setmode(_fileno(stdout), _O_BINARY) != -1, "worker-stdout-mode-failed");
  require(argc >= 7, "worker-arguments-invalid");
  const auto kind = utf8(argv[2]), phase = utf8(argv[4]);
  auto slot = integer(argv[3]);
  auto handle = reinterpret_cast<HANDLE>(uintptr_t(integer(argv[argc - 1])));
  uint64_t begin = qpc();
  uint64_t queryEnd = 0;
  Value value = object({});
  const char* failed = nullptr;
  std::string reason;
  try {
    if (kind == "cpu") value = cpu(handle, &queryEnd);
    else if (kind == "battery") {
      auto observation = battery(); value = observation.fields;
      if (!observation.error.empty()) { reason = observation.error; failed = reason.c_str(); }
    }
    else if (kind == "members") {
      try { value = memory(handle); }
      catch (const Failure&) { value = memory(handle); }
    } else if (kind == "files") {
      require(argc == 13, "worker-arguments-invalid");
      value = files(argv[5], utf8(argv[6]), argv[7], utf8(argv[8]),
                    std::wstring(argv[9]) == L"1", std::wstring(argv[10]) == L"-" ? "" : utf8(argv[10]));
    } else if (kind == "exit") {
      require(argc == 13, "worker-arguments-invalid");
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      require(QueryInformationJobObject(handle, JobObjectBasicAccountingInformation,
                  &accounting, sizeof(accounting), nullptr), "exit-query-failed");
      value = object({{L"rootExited", Value(integer(argv[5]) != 0)},
          {L"rootExitCode", std::wstring(argv[6]) == L"-" ? Value() : Value(integer(argv[6]))},
          {L"stdoutEof", Value(integer(argv[7]) != 0)},
          {L"stderrEof", Value(integer(argv[8]) != 0)},
          {L"telemetryEof", Value(integer(argv[9]) != 0)},
          {L"activeProcesses", Value(uint64_t(accounting.ActiveProcesses))}});
      begin = integer(argv[10]);
    } else throw Failure("worker-kind-invalid");
  } catch (const Failure& error) { reason = error.what(); failed = reason.c_str(); }
  std::cout << canonical(envelope(kind, slot, phase, begin, failed || !queryEnd ? qpc() : queryEnd, value, failed)) << '\n';
  return 0;
}
struct Pending {
  std::unique_ptr<Child> child;
  std::string kind, phase;
  uint64_t slot = 0, begin = 0, deadline = 0;
};
std::vector<wchar_t> applicationEnvironment(const Roots& roots) {
  std::map<std::wstring, std::wstring> values;
  for (const wchar_t* key : {L"SystemRoot", L"WINDIR", L"SystemDrive", L"PATH", L"COMSPEC",
                            L"USERPROFILE", L"HOMEDRIVE", L"HOMEPATH", L"USERNAME",
                            L"PROCESSOR_ARCHITECTURE", L"NUMBER_OF_PROCESSORS"}) {
    auto n = GetEnvironmentVariableW(key, nullptr, 0);
    if (n > 1) values[key] = environment(key);
  }
  values[L"APPDATA"] = roots.paths.at("appDataRoot");
  values[L"LOCALAPPDATA"] = roots.paths.at("localAppDataRoot");
  values[L"TEMP"] = roots.paths.at("processTempRoot");
  values[L"TMP"] = roots.paths.at("processTempRoot");
  std::vector<wchar_t> output;
  for (const auto& [key, value] : values) {
    auto entry = key + L"=" + value;
    output.insert(output.end(), entry.begin(), entry.end()); output.push_back(0);
  }
  output.push_back(0);
  return output;
}
std::string randomId() {
  std::array<BYTE, 16> bytes{};
  require(BCryptGenRandom(nullptr, bytes.data(), DWORD(bytes.size()),
                         BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, "run-id-failed");
  const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  std::string result;
  unsigned accumulator = 0, bits = 0;
  for (auto b : bytes) {
    accumulator = (accumulator << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; result += alphabet[(accumulator >> bits) & 31]; }
  }
  if (bits) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}

int launch(int argc, wchar_t** argv) {
  require(argc == 7 && std::wstring(argv[1]) == L"--launch" &&
              std::wstring(argv[6]) == L"--environment-approved", "launch-arguments-invalid");
  std::wstring repo = argv[2], parent = argv[3], output = argv[4];
  bool formal = std::wstring(argv[5]) == L"formal";
  require(formal || std::wstring(argv[5]) == L"short", "launch-mode-invalid");
  strictLocalPath(repo); strictLocalPath(parent); strictLocalPath(output);
  auto parentPin = openAttributes(parent), outputPin = openAttributes(output);
  fileId(parentPin.value, true); fileId(outputPin.value, true);
  auto runId = randomId();
  auto root = parent + L"\\run-" + wide(runId);
  Security rootSecurity(false, true);
  require(CreateDirectoryW(root.c_str(), &rootSecurity.attributes), "root-create-failed");
  for (const auto& [key, leaf] : rootNames) {
    (void)key;
    if (leaf[0]) require(CreateDirectoryW((root + L"\\" + leaf).c_str(), &rootSecurity.attributes),
                         "root-create-failed");
  }
  Roots roots; roots.pin(root, true);
  Output observations(output + L"\\observations-" + wide(runId) + L".jsonl");
  Output frames(output + L"\\telemetry-" + wide(runId) + L".jsonl");
  Output stdoutFile(output + L"\\stdout-" + wide(runId) + L".txt");
  Output stderrFile(output + L"\\stderr-" + wide(runId) + L".txt");
  Output workerRaw(output + L"\\workers-" + wide(runId) + L".txt");
  AwakeRequest awake;
  PowerMonitor power;
  auto environment = applicationEnvironment(roots);
  auto exe = repo + L"\\node_modules\\electron\\dist\\electron.exe";
  auto exePin = immutableArtifact(exe);
  const std::wstring entry = formal ? L"out/qualification/main/index.js" : L"out/qualification-load-diagnostic/main/index.js";
  auto mainDirectory = formal ? repo + L"\\out\\qualification\\main" : repo + L"\\out\\qualification-load-diagnostic\\main";
  auto repoPin = openAttributes(mainDirectory);
  auto mainPin = immutableArtifact(mainDirectory + L"\\index.js");
  auto addonPin = immutableArtifact(mainDirectory + L"\\watch-qualification.node");
  auto expectedExe = sha256(exe), expectedMain = sha256(mainDirectory + L"\\index.js");
  auto applicationJob = job(), workerJob = job();
  Child application;
  application.launch(exe, quote(exe) + L" " + quote(entry) + L" --aibrowse-watch-resource-qualification", repo, &environment);
  auto rootCreation = creation(application.process.value);
  assign(applicationJob.value, application.process.value);
  Telemetry telemetry; telemetry.connect(application.pid);
  application.resume();
  const auto freq = frequency(), started = qpc();
  const auto processors = GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
  require(processors > 0, "processors-invalid");
  uint64_t sequence = 0, m0 = 0, m1 = 0, shortStart = 0, stop = 0;
  bool complete = false, ready = false, metaWritten = false;
  uint64_t measurementSlot = 0, drainSlot = 0;
  std::string dbId, databaseDirectoryId;
  std::vector<Pending> pending;
  auto executable = exePath();
  bool finished = false;
  try {
    while (!finished) {
      auto now = qpc();
      require(now - started < freq * (formal ? 6600ULL : 600ULL), "run-deadline");
      application.out.poll(); application.err.poll();
      if (!application.out.pending.empty()) { stdoutFile.write(application.out.pending); application.out.pending.clear(); }
      if (!application.err.pending.empty()) { stderrFile.write(application.err.pending); application.err.pending.clear(); }
      telemetry.poll(application.pid, application.process.value);
      size_t newline = 0;
      while ((newline = telemetry.pending.find('\n')) != std::string::npos) {
        auto line = telemetry.pending.substr(0, newline + 1);
        telemetry.pending.erase(0, newline + 1);
        // Preserve rejected frames as evidence before validating their bounded content.
        frames.write(line);
        auto frame = Scanner(line).parse(); validateFrame(frame);
        require(!complete && frame.at("qualificationRunId").string() == runId &&
                    frame.at("sequence").number() == ++sequence, "telemetry-sequence-invalid");
        auto kind = frame.at("kind").string();
        require((sequence == 1) == (kind == "ready"), "telemetry-ready-order");
        if (kind == "ready") {
          const auto& id = frame.at("payload");
          require(id.at("mainPid").number() == application.pid &&
              id.at("mainCreationFileTime").string() == hex(rootCreation) &&
              id.at("serverPid").number() == GetCurrentProcessId() &&
              id.at("serverCreationFileTime").string() == hex(creation(GetCurrentProcess())) &&
              id.at("qpcFrequency").number() == freq &&
              id.at("mainEntrySha256").string() == expectedMain &&
              id.at("processExecPathSha256").string() == expectedExe &&
              id.at("appPathFileId").string() == fileId(repoPin.value, true) &&
              id.at("electronExeFileId").string() == fileId(exePin.value), "telemetry-ready-identity");
          for (const auto& [key, idValue] : roots.ids)
            require(id.at("rootFileIds").at(key.c_str()).string() == idValue, "telemetry-root-identity");
          ready = true; shortStart = qpc();
        } else if (kind == "setup") {
          require(!m0, "telemetry-setup-duplicate");
          m0 = ticks(frame.at("payload").at("m0QpcTicks")); m1 = m0 + 3600 * freq;
        } else if (kind == "stop") {
          require(!stop, "telemetry-stop-duplicate");
          stop = ticks(frame.at("payload").at("admissionClosedQpcTicks"));
        } else if (kind == "complete") complete = true;
        else require(kind != "sample-closed" && kind != "sample-resumed", "telemetry-old-freeze");
      }
      if (telemetry.eof) require(complete && telemetry.pending.empty(), "telemetry-incomplete-eof");
      require(ready || now - started <= freq * 15, "telemetry-ready-timeout");
      if (!metaWritten && (formal ? m0 != 0 : stop != 0)) {
        observations.line(object({{L"version", Value(uint64_t(1))}, {L"kind", Value("meta")},
            {L"runId", Value(runId)}, {L"qpcFrequency", Value(freq)},
            {L"powerNotifications", Value(true)},
            {L"awakeRequest", Value(true)},
            {L"processors", Value(uint64_t(processors))}, {L"m0", decimal(formal ? m0 : shortStart)},
            {L"m1", decimal(formal ? m1 : stop)}, {L"mode", Value(formal ? "formal" : "short")}}));
        metaWritten = true;
      }
      for (auto it = pending.begin(); it != pending.end();) {
        auto& item = *it;
        item.child->out.poll(); item.child->err.poll();
        bool exited = WaitForSingleObject(item.child->process.value, 0) == WAIT_OBJECT_0;
        bool done = exited && item.child->out.eof && item.child->err.eof;
        bool timeout = qpc() > item.deadline;
        if (!done && !timeout) { ++it; continue; }
        workerRaw.write(item.kind + " " + item.phase + " " + std::to_string(item.slot) + "\n");
        if (timeout) {
          if (!exited) require(TerminateProcess(item.child->process.value, 79), "worker-cancel-failed");
          require(WaitForSingleObject(item.child->process.value, 2000) == WAIT_OBJECT_0, "worker-cancel-timeout");
          item.child->out.poll(); item.child->err.poll();
          workerRaw.write(item.child->out.pending); workerRaw.write(item.child->err.pending);
          observations.line(envelope(item.kind, item.slot, item.phase, item.begin, qpc(), object({}), "worker-timeout"));
        } else {
          workerRaw.write(item.child->out.pending); workerRaw.write(item.child->err.pending);
          try {
          DWORD code = 0;
          require(GetExitCodeProcess(item.child->process.value, &code) && code == 0 &&
                      item.child->err.pending.empty(), "worker-failed");
          auto parsed = Scanner(item.child->out.pending).parse();
          require(parsed.at("kind").string() == item.kind && parsed.at("slot").number() == item.slot &&
                      parsed.at("phase").string() == item.phase, "worker-response-invalid");
          if (item.kind == "files" && parsed.at("status").string() == "ok") {
            auto nextDirectoryId = parsed.at("watchDirectoryFileId").string();
            require(databaseDirectoryId.empty() || databaseDirectoryId == nextDirectoryId,
                    "files-directory-identity-changed");
            databaseDirectoryId = nextDirectoryId;
            if (!parsed.at("dbFileId").isNull()) {
              auto nextId = parsed.at("dbFileId").string();
              require(dbId.empty() || dbId == nextId, "files-db-identity-changed"); dbId = nextId;
            }
          }
          observations.write(item.child->out.pending);
          } catch (const Failure&) {
            observations.line(envelope(item.kind, item.slot, item.phase, item.begin, qpc(), object({}), "worker-response-invalid"));
          }
        }
        it = pending.erase(it);
      }
      uint64_t base = formal ? m0 : shortStart;
      uint64_t end = formal ? m1 : stop;
      auto schedule = [&](const std::string& phase, uint64_t slot) {
        auto begin = qpc();
        observations.line(envelope("attempt", slot, phase, begin, begin,
            object({{L"powerTransitionCount", Value(power.transitions.load())},
                    {L"tickCount64", decimal(GetTickCount64())}})));
        std::vector<std::string> kinds{"cpu", "members", "files", "exit"};
        if (formal && phase == "measurement") kinds.push_back("battery");
        for (const auto& kind : kinds) {
          auto child = std::make_unique<Child>();
          auto command = quote(executable) + L" --worker " + wide(kind) + L" " + std::to_wstring(slot) + L" " + wide(phase);
          if (kind == "files") command += L" " + quote(roots.paths.at("watchTempRoot")) + L" " + wide(roots.ids.at("watchTempRoot")) +
              L" " + quote(roots.paths.at("userDataRoot")) + L" " + wide(roots.ids.at("userDataRoot")) +
              L" " + (phase == "drain" ? L"1" : L"0") + L" " + (dbId.empty() ? L"-" : wide(dbId));
          if (kind == "exit") {
            bool exited = WaitForSingleObject(application.process.value, 0) == WAIT_OBJECT_0;
            DWORD code = 0;
            if (exited) require(GetExitCodeProcess(application.process.value, &code), "root-exit-query-failed");
            command += L" " + std::to_wstring(exited ? 1 : 0) + L" " + (exited ? std::to_wstring(code) : L"-") +
                L" " + std::to_wstring(application.out.eof ? 1 : 0) + L" " + std::to_wstring(application.err.eof ? 1 : 0) +
                L" " + std::to_wstring(telemetry.eof ? 1 : 0) + L" " + std::to_wstring(begin);
          }
          command += L" --job";
          child->launch(executable, command, repo, nullptr, applicationJob.value);
          assign(workerJob.value, child->process.value); child->resume();
          pending.push_back(Pending{std::move(child), kind, phase, slot, begin, begin + freq * 2});
        }
      };
      if (base && (!end || now < end)) {
        auto target = base + measurementSlot * 10 * freq;
        auto fire = formal && measurementSlot == 360 ? target - freq : target;
        if (measurementSlot <= (formal ? 360ULL : 60ULL) && now >= fire) {
          schedule("measurement", measurementSlot++);
        }
      }
      const auto drainLast = formal ? 60ULL : 6ULL;
      auto drainTarget = end + drainSlot * 10 * freq;
      if (drainSlot == drainLast) drainTarget -= freq;
      if (end && now >= end && drainSlot <= drainLast && now >= drainTarget)
        schedule("drain", drainSlot++);
      if (end && drainSlot > (formal ? 60ULL : 6ULL) && pending.empty() &&
          now >= end + (formal ? 600ULL : 60ULL) * freq) {
        require(complete && telemetry.eof && application.out.eof && application.err.eof &&
                    WaitForSingleObject(application.process.value, 0) == WAIT_OBJECT_0,
                "exit-evidence-incomplete");
        DWORD code = 0;
        require(GetExitCodeProcess(application.process.value, &code) && code == 0,
                "root-exit-nonzero");
        require(members(applicationJob.value).empty(), "job-residual-processes");
        finished = true;
      }
      Sleep(2);
    }
  } catch (const std::exception& error) {
    TerminateJobObject(applicationJob.value, 79);
    TerminateJobObject(workerJob.value, 79);
    observations.line(object({{L"version", Value(uint64_t(1))}, {L"kind", Value("abort")},
        {L"qpc", decimal(qpc())}, {L"reason", Value(dynamic_cast<const Failure*>(&error) ? error.what() : "collector-failed")}}));
    throw;
  }
  FILETIME created{}, exited{}, kernel{}, user{};
  PROCESS_MEMORY_COUNTERS_EX parentMemory{}; parentMemory.cb = sizeof(parentMemory);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION workerMemory{};
  if (GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user) &&
      GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&parentMemory), sizeof(parentMemory)) &&
      QueryInformationJobObject(workerJob.value, JobObjectExtendedLimitInformation, &workerMemory, sizeof(workerMemory), nullptr)) {
    observations.line(object({{L"version", Value(uint64_t(1))}, {L"kind", Value("observer-summary")},
        {L"parentCpu100ns", decimal(fileTime(kernel) + fileTime(user))},
        {L"parentWorkingSetBytes", Value(uint64_t(parentMemory.WorkingSetSize))},
        {L"parentPrivateBytes", Value(uint64_t(parentMemory.PrivateUsage))},
        {L"workerCpu100ns", cpu(workerJob.value).at("total100ns")},
        {L"workerPeakJobMemoryBytes", Value(uint64_t(workerMemory.PeakJobMemoryUsed))}}));
  }
  awake.release();
  std::cout << "采集完成；结果须独立复算，原始目录保留。\n";
  return 0;
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc > 1 && std::wstring(argv[1]) == L"--worker") return worker(argc, argv);
    if (argc > 1 && std::wstring(argv[1]) == L"--verify-released") {
      require(argc == 6 && _setmode(_fileno(stdout), _O_BINARY) != -1, "released-arguments-invalid");
      auto begin = qpc();
      auto value = verifyReleased(argv[2], readRootIds(argv[3]), utf8(argv[4]), utf8(argv[5]));
      bool released = releasedFiles(value);
      auto fields = value.object();
      fields.emplace(L"version", Value(uint64_t(1)));
      fields.emplace(L"kind", Value("released-verification"));
      fields.emplace(L"status", Value(released ? "ok" : "invalid"));
      if (!released) fields.emplace(L"error", Value("released-files-still-owned"));
      fields.emplace(L"beginQpc", decimal(begin)); fields.emplace(L"endQpc", decimal(qpc()));
      std::cout << canonical(Value(fields)) << '\n';
      return released ? 0 : 79;
    }
    LaunchContainment containment;
    try {
      auto result = launch(argc, argv);
      containment.release();
      return result;
    } catch (const Failure& error) {
      std::cerr << "采集器未通过：" << error.what() << "；本轮进程树将收口。\n";
      std::cerr.flush(); containment.abort();
    } catch (...) {
      std::cerr << "采集器未通过；本轮进程树将收口。\n";
      std::cerr.flush(); containment.abort();
    }
  } catch (const Failure& error) {
    std::cerr << "采集器未通过：" << error.what() << "；检查保留的原始证据。\n";
    return 79;
  } catch (const std::exception&) {
    std::cerr << "采集器未通过；检查保留的原始证据。\n";
    return 79;
  }
}
