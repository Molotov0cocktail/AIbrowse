#include "write-io.hpp"
#include <iostream>

using namespace h3b;

struct Teardown {};
struct InjectedApi {
  DWORD lastError = ERROR_SUCCESS;
  DWORD pendingError = ERROR_IO_INCOMPLETE;
  DWORD terminalError = ERROR_OPERATION_ABORTED;
  DWORD waitReturn = WAIT_TIMEOUT;
  DWORD cancelError = ERROR_SUCCESS;
  unsigned polls = 0, terminalAfter = 5, cancels = 0, pauses = 0;
  bool finalObserved = false, goodClock = true, teardownObserved = false;
  uint64_t ticks = 10, ms = 0;
  bool result(DWORD& bytes) {
    ++polls;
    if (polls >= terminalAfter) {
      finalObserved = true;
      bytes = 7;
      lastError = terminalError;
      return terminalError == ERROR_SUCCESS;
    }
    lastError = pendingError;
    return false;
  }
  bool completed() const { return finalObserved; }
  bool clock(uint64_t& out) const { out = ticks; return goodClock; }
  uint64_t milliseconds() { ms += 100; return ms; }
  void cancel() { ++cancels; lastError = cancelError; }
  DWORD wait() const { return waitReturn; }
  void pause() { ++pauses; }
  [[noreturn]] void teardown() { teardownObserved = true; throw Teardown{}; }
};

int main() {
  unsigned passed = 0, failed = 0;
  auto check = [&](const char* name, bool ok) {
    if (ok) ++passed; else ++failed;
    std::cout << (ok ? "PASS " : "FAIL ") << name << '\n';
  };
  auto rejectedAfterReap = [](InjectedApi& api, uint64_t enqueued,
                              const char* expected) {
    try { finishWriteWith(api, enqueued, 100); }
    catch (const Failure& error) {
      return api.finalObserved && !api.teardownObserved &&
             std::string(error.what()) == expected;
    } catch (const Teardown&) {}
    return false;
  };
  InjectedApi normal;
  normal.terminalError = ERROR_SUCCESS;
  auto done = finishWriteWith(normal, 10, 100);
  check("正常完成保留传输字节与时间", done.bytes == 7 && done.observed == 10 && !normal.cancels);
  InjectedApi cancelBad;
  cancelBad.ticks = 210; cancelBad.cancelError = ERROR_ACCESS_DENIED;
  check("取消拒绝后必须观察完成才报超时", rejectedAfterReap(cancelBad, 10, "qualification-io-timeout") && cancelBad.cancels == 1);
  InjectedApi cancelRace;
  cancelRace.ticks = 210; cancelRace.cancelError = ERROR_NOT_FOUND;
  check("取消未找到不是完成证据", rejectedAfterReap(cancelRace, 10, "qualification-io-timeout") && cancelRace.cancels == 1);
  InjectedApi waitBad;
  waitBad.waitReturn = WAIT_FAILED;
  check("等待失败仍须完成回收", rejectedAfterReap(waitBad, 10, "qualification-io-failed") && waitBad.cancels == 1 && waitBad.pauses > 0);
  InjectedApi abandoned;
  abandoned.waitReturn = WAIT_ABANDONED;
  check("异常等待返回仍须完成回收", rejectedAfterReap(abandoned, 10, "qualification-io-failed"));
  InjectedApi queryBad;
  queryBad.pendingError = ERROR_INVALID_HANDLE;
  check("查询错误不能证明完成", rejectedAfterReap(queryBad, 10, "qualification-io-failed") && queryBad.cancels == 1);
  InjectedApi broken;
  broken.pendingError = ERROR_BROKEN_PIPE;
  check("未完成断管仍须回收", rejectedAfterReap(broken, 10, "qualification-io-failed"));
  InjectedApi clockBad;
  clockBad.goodClock = false;
  check("计时失败仍须完成回收", rejectedAfterReap(clockBad, 10, "qualification-qpc-invalid") && clockBad.cancels == 1);
  InjectedApi clockBackwards;
  clockBackwards.ticks = 9;
  check("时钟倒退仍须完成回收", rejectedAfterReap(clockBackwards, 10, "qualification-qpc-invalid"));
  InjectedApi lateSuccess;
  lateSuccess.ticks = 210; lateSuccess.terminalError = ERROR_SUCCESS;
  check("迟到成功不覆盖原始超时", rejectedAfterReap(lateSuccess, 10, "qualification-io-timeout"));
  InjectedApi waitLateSuccess;
  waitLateSuccess.waitReturn = WAIT_FAILED; waitLateSuccess.terminalError = ERROR_SUCCESS;
  check("迟到成功不覆盖原始等待失败", rejectedAfterReap(waitLateSuccess, 10, "qualification-io-failed"));
  InjectedApi terminal;
  terminal.terminalAfter = 1;
  check("已完成错误可直接报告", rejectedAfterReap(terminal, 10, "qualification-io-failed") && !terminal.cancels);
  InjectedApi completedClockBad;
  completedClockBad.terminalAfter = 1; completedClockBad.terminalError = ERROR_SUCCESS;
  completedClockBad.goodClock = false;
  check("完成后仍验证计时有效性", rejectedAfterReap(completedClockBad, 10, "qualification-qpc-invalid") && !completedClockBad.cancels);
  InjectedApi completedLate;
  completedLate.terminalAfter = 1; completedLate.terminalError = ERROR_SUCCESS; completedLate.ticks = 211;
  check("完成后仍验证原两秒上限", rejectedAfterReap(completedLate, 10, "qualification-io-timeout"));
  InjectedApi forever;
  forever.terminalAfter = UINT_MAX; forever.ticks = 210; forever.cancelError = ERROR_ACCESS_DENIED;
  bool bounded = false;
  try { finishWriteWith(forever, 10, 100); }
  catch (const Teardown&) {
    bounded = forever.teardownObserved && !forever.finalObserved &&
              forever.cancels == 1 && forever.ms == 2100;
  } catch (const Failure&) {}
  check("无法回收时在两秒取消预算内进入硬终止", bounded);

  try {
    const auto name = L"\\\\.\\pipe\\aibrowse-product-write-test-" +
        std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(qpc());
    Handle server(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, nullptr));
    require(server.valid(), "test-pipe-create");
    Handle writer(CreateFileW(name.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
    require(writer.valid(), "test-pipe-writer");
    require(!ConnectNamedPipe(server.value, nullptr) && GetLastError() == ERROR_PIPE_CONNECTED, "test-pipe-connect");
    const std::string payload = "payload";
    {
      PendingWrite operation(writer.value);
      const auto start = qpc();
      operation.submit(payload.data(), static_cast<DWORD>(payload.size()));
      auto result = finishWriteWith(operation, start, frequency());
      check("真实管道成功完成", result.bytes == payload.size() && operation.completed());
      std::array<char, 7> received{}; DWORD count = 0;
      require(ReadFile(server.value, received.data(), DWORD(received.size()), &count, nullptr), "test-pipe-read");
      check("接收端核对实际写入字节", count == payload.size() && std::string(received.data(), count) == payload);
    }
    const std::string large(1024 * 1024, 'x');
    {
      PendingWrite operation(writer.value);
      operation.submit(large.data(), static_cast<DWORD>(large.size()));
      require(!operation.completed(), "test-real-write-must-pend");
      bool reaped = false;
      const auto freq = frequency();
      const auto before = qpc();
      try { finishWriteWith(operation, before - freq * 2, freq); }
      catch (const Failure& error) {
        reaped = operation.completed() && std::string(error.what()) == "qualification-io-timeout";
      }
      check("真实待完成写入取消后才抛出", reaped);
      check("真实取消仍遵守两秒预算", qpc() - before <= freq * 2);
    }
    Handle eventCopy;
    bool unwindStarted = false;
    try {
      PendingWrite operation(writer.value);
      HANDLE duplicate = nullptr;
      require(DuplicateHandle(GetCurrentProcess(), operation.event.value, GetCurrentProcess(), &duplicate,
          SYNCHRONIZE, FALSE, 0), "test-event-duplicate");
      eventCopy = Handle(duplicate);
      operation.submit(large.data(), static_cast<DWORD>(large.size()));
      require(!operation.completed(), "test-real-unwind-must-pend");
      unwindStarted = true;
      throw Failure("test-exception-before-finish");
    } catch (const Failure&) {}
    check("进入等待前抛出异常也先回收真实写入", unwindStarted && WaitForSingleObject(eventCopy.value, 0) == WAIT_OBJECT_0);
  } catch (const std::exception& error) {
    ++failed; std::cerr << "真实写入验证失败：" << error.what() << '\n';
  }
  std::cout << "产品写入生命周期：" << passed << " PASS / " << failed << " FAIL\n";
  return failed ? 1 : 0;
}
