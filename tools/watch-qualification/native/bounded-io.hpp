#pragma once
#include "windows.hpp"
#include <array>
#include <memory>

namespace collector {
using namespace h3b;
struct Io {
  OVERLAPPED overlapped{};
  Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  std::array<char, 65536> buffer{};
  HANDLE submittedPipe = INVALID_HANDLE_VALUE;
  bool submittedToKernel = false;
  Io() {
    require(event.valid(), "collector-event-invalid");
    overlapped.hEvent = event.value;
  }
  void arm(HANDLE pipe) noexcept { submittedPipe = pipe; }
  void submissionResult(BOOL success, DWORD error) noexcept {
    submittedToKernel = success || error == ERROR_IO_PENDING;
  }
  ~Io() noexcept {
    if (!submittedToKernel || HasOverlappedIoCompleted(&overlapped)) return;
    // Protect exceptions between submission and finishIo, e.g. ResumeThread failure.
    if (submittedPipe != INVALID_HANDLE_VALUE) CancelIoEx(submittedPipe, &overlapped);
    auto begin = GetTickCount64();
    while (!HasOverlappedIoCompleted(&overlapped)) {
      DWORD bytes = 0;
      if (submittedPipe != INVALID_HANDLE_VALUE &&
          GetOverlappedResult(submittedPipe, &overlapped, &bytes, FALSE)) return;
      if (GetTickCount64() - begin >= 2000) {
        TerminateProcess(GetCurrentProcess(), 78);
        std::terminate();
      }
      auto result = WaitForSingleObject(event.value, 1);
      if (result != WAIT_TIMEOUT) Sleep(1);
    }
  }
};
struct WindowsIoApi {
  DWORD lastError = ERROR_SUCCESS;
  bool result(HANDLE pipe, Io& io, DWORD& bytes) noexcept {
    auto success = GetOverlappedResult(pipe, &io.overlapped, &bytes, FALSE);
    lastError = success ? ERROR_SUCCESS : GetLastError();
    return success != FALSE;
  }
  bool completed(const Io& io) const noexcept { return HasOverlappedIoCompleted(&io.overlapped); }
  bool clock(uint64_t& ticks) noexcept {
    LARGE_INTEGER value{};
    if (!QueryPerformanceCounter(&value) || value.QuadPart < 0) return false;
    ticks = static_cast<uint64_t>(value.QuadPart); return true;
  }
  uint64_t milliseconds() const noexcept { return GetTickCount64(); }
  bool cancel(HANDLE pipe, Io& io) noexcept {
    auto success = CancelIoEx(pipe, &io.overlapped);
    lastError = success ? ERROR_SUCCESS : GetLastError();
    return success != FALSE;
  }
  DWORD wait(const Io& io) noexcept { return WaitForSingleObject(io.event.value, 1); }
  void pause() const noexcept { Sleep(1); }
  [[noreturn]] void teardown(std::unique_ptr<Io>& io) const noexcept {
    io.release();
    TerminateProcess(GetCurrentProcess(), 78);
    std::terminate();
  }
};

template<class Api>
DWORD finishIoWith(HANDLE pipe, std::unique_ptr<Io>& io, uint64_t deadline,
                   uint64_t /*freq*/, bool& eof, Api& api) {
  const char* failure = nullptr;
  bool cancellationStarted = false;
  uint64_t cancellationStartedMs = 0;
  DWORD n = 0;
  for (;;) {
    if (api.result(pipe, *io, n)) {
      if (failure) throw Failure(failure);
      return n;
    }
    DWORD error = api.lastError;
    // A failed query alone is not proof that the kernel stopped using this buffer.
    if (error != ERROR_IO_INCOMPLETE && api.completed(*io)) {
      if (failure) throw Failure(failure);
      if (error == ERROR_BROKEN_PIPE) { eof = true; return 0; }
      throw Failure("collector-io-failed");
    }
    if (!failure) {
      uint64_t now = 0;
      if (error != ERROR_IO_INCOMPLETE) failure = "collector-io-query-failed";
      else if (!api.clock(now)) failure = "collector-qpc-failed";
      else if (now >= deadline) failure = "collector-io-timeout";
    }
    if (failure && !cancellationStarted) {
      cancellationStarted = true; cancellationStartedMs = api.milliseconds();
      if (!api.cancel(pipe, *io) && api.lastError != ERROR_NOT_FOUND)
        failure = "collector-cancel-failed";
    }
    // GetTickCount64 keeps teardown bounded even when the QPC query itself failed.
    if (cancellationStarted && api.milliseconds() - cancellationStartedMs >= 2000)
      api.teardown(io);
    auto wait = api.wait(*io);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) {
      if (!failure) failure = "collector-wait-failed";
      api.pause();
    }
  }
}
inline DWORD finishIo(HANDLE pipe, std::unique_ptr<Io>& io, uint64_t deadline,
                      uint64_t freq, bool& eof) {
  WindowsIoApi api;
  return finishIoWith(pipe, io, deadline, freq, eof, api);
}
}
