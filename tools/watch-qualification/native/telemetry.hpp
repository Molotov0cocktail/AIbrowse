#pragma once
#include "bounded-io.hpp"

namespace resource {
using namespace h3b;
struct Telemetry {
  Handle pipe;
  std::unique_ptr<collector::Io> operation;
  bool connected = false, eof = false;
  std::string pending;
  void connect(DWORD pid) {
    Security security(true);
    pipe = Handle(CreateNamedPipeW(pipeName(pid).c_str(), PIPE_ACCESS_INBOUND |
          FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
          PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
          1, 262144, 262144, 0, &security.attributes));
    require(pipe.valid(), "telemetry-create-failed");
    operation = std::make_unique<collector::Io>(); operation->arm(pipe.value);
    auto ok = ConnectNamedPipe(pipe.value, &operation->overlapped);
    auto error = ok ? ERROR_SUCCESS : GetLastError();
    operation->submissionResult(ok, error);
    require(ok || error == ERROR_IO_PENDING || error == ERROR_PIPE_CONNECTED,
            "telemetry-connect-failed");
    if (ok || error == ERROR_PIPE_CONNECTED) { operation.reset(); connected = true; }
  }
  bool poll(DWORD pid, HANDLE process) {
    if (eof) return false;
    if (operation) {
      DWORD bytes = 0;
      if (!GetOverlappedResult(pipe.value, &operation->overlapped, &bytes, FALSE)) {
        auto error = GetLastError();
        if (error == ERROR_IO_INCOMPLETE) return false;
        require(error == ERROR_BROKEN_PIPE, "telemetry-read-failed");
        operation.reset(); eof = true; return false;
      }
      if (!connected) connected = true;
      else {
        require(bytes > 0, "telemetry-zero-read");
        pending.append(operation->buffer.data(), bytes);
        require(pending.size() <= 524288, "telemetry-budget-exhausted");
      }
      operation.reset();
    }
    ULONG writer = 0;
    require(GetNamedPipeClientProcessId(pipe.value, &writer) && writer == pid &&
                GetProcessId(process) == pid, "telemetry-writer-invalid");
    operation = std::make_unique<collector::Io>(); operation->arm(pipe.value);
    DWORD bytes = 0;
    auto ok = ReadFile(pipe.value, operation->buffer.data(), DWORD(operation->buffer.size()),
                       &bytes, &operation->overlapped);
    auto error = ok ? ERROR_SUCCESS : GetLastError();
    operation->submissionResult(ok, error);
    if (!ok && error == ERROR_BROKEN_PIPE) { operation.reset(); eof = true; }
    else require(ok || error == ERROR_IO_PENDING, "telemetry-read-failed");
    return true;
  }
};
}  // namespace resource
