#include "metrics.hpp"
#include "process.hpp"
#include "scanner.hpp"
#include "telemetry.hpp"
#include "battery.hpp"
#include "released.hpp"
#include <filesystem>
#include <iostream>
#include <sstream>

namespace {
using namespace h3b;
using namespace resource;
template<class Operation> void rejects(Operation operation) {
  bool failed = false;
  try { operation(); } catch (const Failure&) { failed = true; }
  require(failed, "test-expected-rejection");
}
void wait(Child& child) {
  auto until = GetTickCount64() + 10000;
  while (WaitForSingleObject(child.process.value, 0) == WAIT_TIMEOUT) {
    child.out.poll(); child.err.poll();
    require(GetTickCount64() < until, "test-child-timeout"); Sleep(1);
  }
  child.out.poll(); child.err.poll();
  DWORD code = 0;
  require(GetExitCodeProcess(child.process.value, &code) && code == 0, "test-child-failed");
}
void launchChild(Child& child, const std::wstring& args, HANDLE owner) {
  auto exe = exePath();
  child.launch(exe, quote(exe) + L" " + args, cwd());
  assign(owner, child.process.value); child.resume();
}
int run(int argc, wchar_t** argv) {
  if (argc > 1 && std::wstring(argv[1]) == L"--containment-suspended") {
    LaunchContainment containment;
    Child child;
    child.launch(exePath(), quote(exePath()) + L" --wait", cwd());
    std::cout << child.pid << ' ' << creation(child.process.value) << '\n'; std::cout.flush();
    Sleep(30000);
    return 1;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--containment-clean") {
    LaunchContainment containment; containment.release(); return 0;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--burn") {
    auto until = qpc() + frequency() / 3;
    while (qpc() < until) YieldProcessor();
    return 0;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--spawn") {
    Child child;
    child.launch(exePath(), quote(exePath()) + L" --burn", cwd());
    child.resume(); wait(child);
    return 0;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--wait") { Sleep(30000); return 0; }
  if (argc == 3 && std::wstring(argv[1]) == L"--pipe-writer") {
    Handle connection(CreateFileW(argv[2], FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                  0, nullptr, OPEN_EXISTING, 0, nullptr));
    require(connection.valid(), "test-writer-connect-failed");
    DWORD count = 0;
    require(WriteFile(connection.value, "test\n", 5, &count, nullptr) && count == 5,
            "test-writer-write-failed");
    return 0;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--breakaway") {
    auto executable = exePath(); auto command = quote(executable) + L" --burn";
    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION info{};
    auto success = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
                                  CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED | CREATE_NO_WINDOW,
                                  nullptr, nullptr, &startup, &info);
    if (success) {
      TerminateProcess(info.hProcess, 0); WaitForSingleObject(info.hProcess, 2000);
      CloseHandle(info.hThread); CloseHandle(info.hProcess);
    }
    require(!success && GetLastError() == ERROR_ACCESS_DENIED, "test-breakaway-allowed");
    return 0;
  }
  auto owner = job();
  Child root;
  launchChild(root, L"--spawn", owner.value);
  auto initial = memory(owner.value);
  require(!initial.at("members").array().empty(), "test-active-members-missing");
  wait(root);
  auto completed = cpu(owner.value);
  auto cumulative = std::stoull(completed.at("total100ns").string());
  FILETIME created{}, exited{}, kernel{}, user{};
  require(GetProcessTimes(root.process.value, &created, &exited, &kernel, &user), "test-root-time-failed");
  auto rootCpu = fileTime(kernel) + fileTime(user);
  require(members(owner.value).empty() && cumulative > rootCpu + 500000,
          "test-exited-child-cpu-missing");
  require(std::stoull(cpu(owner.value).at("total100ns").string()) >= cumulative,
          "test-job-cpu-regressed");
  auto collectorExe = std::filesystem::path(exePath()).parent_path().wstring() + L"\\collector.exe";
  Child worker;
  worker.launch(collectorExe, quote(collectorExe) + L" --worker cpu 0 measurement --job", cwd(), nullptr, owner.value);
  worker.resume(); wait(worker);
  auto observed = collector::Scanner(worker.out.pending).parse();
  require(observed.at("status").string() == "ok" &&
              std::stoull(observed.at("total100ns").string()) >= cumulative,
          "test-worker-cpu-invalid");
  Child wrongWorker;
  wrongWorker.launch(collectorExe, quote(collectorExe) + L" --worker cpu 0 measurement --job", cwd(), nullptr, root.process.value);
  wrongWorker.resume(); wait(wrongWorker);
  auto rejected = collector::Scanner(wrongWorker.out.pending).parse();
  require(rejected.at("status").string() == "invalid" &&
              rejected.object().find(L"total100ns") == rejected.object().end(), "test-worker-failure-zero-filled");
  std::cout << "已退出子进程CPU仍计入Job累计，存活成员不会伪造退出成员零值。\n";

  Child residual;
  launchChild(residual, L"--wait", owner.value);
  verifyProcess(residual.process.value, owner.value, residual.pid, creation(residual.process.value));
  rejects([&] { verifyProcess(residual.process.value, owner.value, residual.pid, creation(residual.process.value) + 1); });
  require(members(owner.value).size() == 1 && !memory(owner.value).at("members").array().empty(),
          "test-residual-child-hidden");
  {
    Telemetry server;
    server.connect(residual.pid);
    Child impostor;
    launchChild(impostor, L"--pipe-writer " + quote(pipeName(residual.pid)), owner.value);
    bool refused = false;
    auto deadline = GetTickCount64() + 5000;
    while (!refused && GetTickCount64() < deadline) {
      try { server.poll(residual.pid, residual.process.value); }
      catch (const Failure& error) { refused = std::string(error.what()) == "telemetry-writer-invalid"; }
      Sleep(1);
    }
    require(refused, "test-impostor-writer-accepted");
    wait(impostor);
  }
  require(TerminateProcess(residual.process.value, 0) &&
              WaitForSingleObject(residual.process.value, 2000) == WAIT_OBJECT_0, "test-child-cleanup-failed");
  Child escape;
  launchChild(escape, L"--breakaway", owner.value); wait(escape);
  Child contained;
  launchChild(contained, L"--containment-suspended", owner.value);
  auto containmentDeadline = GetTickCount64() + 5000;
  while (contained.out.pending.find('\n') == std::string::npos) {
    contained.out.poll();
    require(GetTickCount64() < containmentDeadline, "test-containment-timeout"); Sleep(1);
  }
  DWORD grandchild = 0; uint64_t grandchildBirth = 0;
  std::istringstream identityText(contained.out.pending); identityText >> grandchild >> grandchildBirth;
  Handle suspended(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, grandchild));
  require(suspended.valid() && creation(suspended.value) == grandchildBirth &&
              WaitForSingleObject(suspended.value, 0) == WAIT_TIMEOUT, "test-suspended-child-identity");
  require(TerminateProcess(contained.process.value, 79) &&
              WaitForSingleObject(contained.process.value, 2000) == WAIT_OBJECT_0 &&
              WaitForSingleObject(suspended.value, 2000) == WAIT_OBJECT_0, "test-watchdog-orphaned-suspended-child");
  Child normalContainment;
  launchChild(normalContainment, L"--containment-clean", owner.value); wait(normalContainment);
  std::cout << "启动前外层Job在父进程被终止时收口暂停子进程；正常空树可退出。\n";

  require(documentedAbsence(false, ERROR_FILE_NOT_FOUND, BATTERY_TAG_INVALID, 99), "test-battery-absence");
  require(!documentedAbsence(true, ERROR_SUCCESS, 17, sizeof(ULONG)), "test-battery-valid-tag");
  rejects([&] { documentedAbsence(true, ERROR_SUCCESS, BATTERY_TAG_INVALID, sizeof(ULONG)); });
  rejects([&] { documentedAbsence(false, ERROR_NO_SUCH_DEVICE, BATTERY_TAG_INVALID, 0); });
  rejects([&] { documentedAbsence(false, ERROR_FILE_NOT_FOUND, 17, 0); });
  rejects([&] { documentedAbsence(true, ERROR_SUCCESS, 17, sizeof(ULONG) - 1); });
  rejects([&] { documentedAbsence(true, ERROR_SUCCESS, 17, sizeof(ULONG) + 1); });
  batterySizes(sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W), 2, 0);
  rejects([&] { batterySizes(65537, 2, 0); });
  rejects([&] { batterySizes(sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W), 32769, 0); });
  rejects([&] { batterySizes(sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W), 2, 64); });
  unsigned closeCalls = 0;
  bool cleanupComplete = true;
  {
    auto failingClose = [&](int) { ++closeCalls; return false; };
    OnceCleanup guard{1, -1, failingClose, cleanupComplete};
    guard.finish(); guard.finish();
  }
  require(closeCalls == 1 && !cleanupComplete, "test-battery-cleanup-retried");
  std::cout << "电池tag文档化absence、精确尺寸、有界分配及失败清理仅一次反例通过。\n";

  auto tempBase = std::filesystem::path(exePath()).parent_path().wstring();
  auto testRoot = tempBase + L"\\synthetic-" + wide(hex(qpc()));
  require(CreateDirectoryW(testRoot.c_str(), nullptr), "test-root-create-failed");
  auto temp = testRoot + L"\\temp", userRoot = testRoot + L"\\user";
  require(CreateDirectoryW(temp.c_str(), nullptr) && CreateDirectoryW(userRoot.c_str(), nullptr), "test-dir-create-failed");
  auto watch = userRoot + L"\\watch";
  require(CreateDirectoryW(watch.c_str(), nullptr), "test-watch-dir-create-failed");
  const auto path = watch + L"\\watch.db";
  Handle createdFile(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(createdFile.valid(), "test-file-create-failed");
  createdFile.checkedClose();
  auto identity = openAttributes(path); auto id = fileId(identity.value); identity.checkedClose();
  require(exclusive(path, id), "test-exclusive-baseline");
  for (DWORD access : {DWORD(GENERIC_READ), DWORD(GENERIC_WRITE), DWORD(DELETE)}) {
    Handle held(CreateFileW(path.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    require(held.valid() && !exclusive(path, id), "test-held-file-false-release");
  }
  require(exclusive(path, id), "test-exclusive-after-close");
  rejects([&] { exclusive(path, "wrong-identity"); });
  auto tempPin = openAttributes(temp), userPin = openAttributes(userRoot);
  auto tempId = fileId(tempPin.value, true), userId = fileId(userPin.value, true);
  auto clean = files(temp, tempId, userRoot, userId, true, id);
  require(clean.at("tempEntries").number() == 0 && std::get<bool>(clean.at("dbExclusive").data),
          "test-file-baseline");
  auto residue = temp + L"\\retained.tmp";
  Handle residualFile(CreateFileW(residue.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                 nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(residualFile.valid() && files(temp, tempId, userRoot, userId, true, id).at("tempEntries").number() == 1,
          "test-temp-residue-hidden");
  rejects([&] { files(temp, "wrong-identity", userRoot, userId, true, id); });
  residualFile.checkedClose(); require(DeleteFileW(residue.c_str()), "test-residue-delete-failed");
  std::cout << "普通读/写/DELETE共享句柄均阻止独占释放；temp残留和身份替换不会通过。\n";

  if (argc == 2) {
    const std::wstring node = argv[1];
    Child sqlite;
    const auto script = L"const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('create table probe(id integer)');process.stdout.write('ready');setTimeout(()=>db.close(),30000)";
    sqlite.launch(node, quote(node) + L" --no-warnings -e " + quote(script) + L" " + quote(path), cwd());
    assign(owner.value, sqlite.process.value); sqlite.resume();
    auto deadline = GetTickCount64() + 5000;
    while (sqlite.out.pending != "ready") {
      sqlite.out.poll(); sqlite.err.poll();
      require(GetTickCount64() < deadline && WaitForSingleObject(sqlite.process.value, 0) == WAIT_TIMEOUT,
              "test-sqlite-ready-failed"); Sleep(1);
    }
    require(!exclusive(path, id), "test-sqlite-false-release");
    require(TerminateProcess(sqlite.process.value, 0) && WaitForSingleObject(sqlite.process.value, 2000) == WAIT_OBJECT_0,
            "test-sqlite-cleanup-failed");
    require(exclusive(path, id), "test-sqlite-close-not-released");
    std::cout << "真实node:sqlite未关闭连接的独占检查反例通过。\n";
  }
  tempPin.checkedClose(); userPin.checkedClose();
  require(DeleteFileW(path.c_str()) && RemoveDirectoryW(temp.c_str()) && RemoveDirectoryW(watch.c_str()) && RemoveDirectoryW(userRoot.c_str()) &&
              RemoveDirectoryW(testRoot.c_str()), "test-owned-cleanup-failed");
  std::cout << "Windows合成资源验证通过。\n";
  return 0;
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  try { return run(argc, argv); }
  catch (const std::exception& error) {
    std::cerr << "合成验证失败：" << error.what() << '\n'; return 1;
  }
}
