#pragma once
#include "windows.hpp"

namespace h3b {
struct WriteCompletion {
  DWORD bytes;
  uint64_t observed;
};

// No failure may escape while Windows can still access the OVERLAPPED or buffer.
// Api methods do not throw in production; the owner below also protects unwinding.
template <typename Api>
WriteCompletion finishWriteWith(Api& api, uint64_t enqueued, uint64_t freq) {
  const char* failure = nullptr;
  bool cancelling = false;
  uint64_t cancellationMs = 0;
  DWORD bytes = 0;
  for (;;) {
    if (api.result(bytes)) {
      if (failure) throw Failure(failure);
      uint64_t now = 0;
      require(api.clock(now) && now >= enqueued, "qualification-qpc-invalid");
      require(now - enqueued <= freq * 2, "qualification-io-timeout");
      return {bytes, now};
    }
    const DWORD error = api.lastError;
    if (error != ERROR_IO_INCOMPLETE && api.completed())
      throw Failure(failure ? failure : "qualification-io-failed");
    if (!failure) {
      uint64_t now = 0;
      if (error != ERROR_IO_INCOMPLETE)
        failure = "qualification-io-failed";
      else if (!api.clock(now) || now < enqueued)
        failure = "qualification-qpc-invalid";
      else if (now - enqueued >= freq * 2)
        failure = "qualification-io-timeout";
    }
    if (failure && !cancelling) {
      cancelling = true;
      cancellationMs = api.milliseconds();
      // Even a failed cancellation or ERROR_NOT_FOUND does not prove completion.
      api.cancel();
    }
    if (cancelling && api.milliseconds() - cancellationMs >= 2000)
      api.teardown();
    const DWORD wait = api.wait();
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) {
      if (!failure) failure = "qualification-io-failed";
      api.pause();
    }
  }
}

struct PendingWrite {
  OVERLAPPED overlapped{};
  Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  HANDLE pipe;
  bool submitted = false;
  DWORD lastError = ERROR_SUCCESS;

  explicit PendingWrite(HANDLE target) : pipe(target) {
    require(event.valid(), "qualification-io-failed");
    overlapped.hEvent = event.value;
  }
  PendingWrite(const PendingWrite&) = delete;
  PendingWrite& operator=(const PendingWrite&) = delete;
  void submit(const char* data, DWORD length) {
    DWORD bytes = 0;
    const BOOL success = WriteFile(pipe, data, length, &bytes, &overlapped);
    const DWORD error = success ? ERROR_SUCCESS : GetLastError();
    submitted = success || error == ERROR_IO_PENDING;
    require(submitted, "qualification-io-failed");
  }
  bool result(DWORD& bytes) noexcept {
    const BOOL success = GetOverlappedResult(pipe, &overlapped, &bytes, FALSE);
    lastError = success ? ERROR_SUCCESS : GetLastError();
    return success != FALSE;
  }
  bool completed() const noexcept {
    return !submitted || HasOverlappedIoCompleted(&overlapped);
  }
  bool clock(uint64_t& ticks) const noexcept {
    LARGE_INTEGER value{};
    if (!QueryPerformanceCounter(&value) || value.QuadPart < 0) return false;
    ticks = static_cast<uint64_t>(value.QuadPart);
    return true;
  }
  uint64_t milliseconds() const noexcept { return GetTickCount64(); }
  void cancel() noexcept { CancelIoEx(pipe, &overlapped); }
  DWORD wait() const noexcept { return WaitForSingleObject(event.value, 1); }
  void pause() const noexcept { Sleep(1); }
  [[noreturn]] void teardown() const noexcept {
    // The stack still owns the event/OVERLAPPED and the caller still owns bytes.
    // Do not allocate, move, free or unwind any of them before process teardown.
    TerminateProcess(GetCurrentProcess(), 76);
    std::terminate();
  }
  ~PendingWrite() noexcept {
    if (completed()) return;
    cancel();
    const auto begin = milliseconds();
    while (!completed()) {
      DWORD bytes = 0;
      if (result(bytes) || completed()) return;
      if (milliseconds() - begin >= 2000) teardown();
      if (wait() != WAIT_TIMEOUT) pause();
    }
  }
};
}  // namespace h3b
