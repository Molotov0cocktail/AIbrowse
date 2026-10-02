#pragma once
#include "windows.hpp"
#include <atomic>
#include <string_view>

namespace h3b {
enum class WorkKind { Connect, Write, Close };
enum class WriterFailureStage {
  Execute, Connect, Peer, EnqueueDeadline, Submit, AwaitCompletion, WriteResult,
  Cleanup, MainCompletion, MainCompletionFatal, Serialize, QueueLimit, Prepare
};
enum class WriterFailureCode {
  Unknown, IoTimeout, IoFailed, QpcInvalid, PeerInvalid, Closed, FrameInvalid,
  SequenceInvalid, QueueLimit, LaunchInvalid, IsolationInvalid, NativeUnavailable
};
inline WriterFailureCode writerFailureCode(std::string_view value) noexcept {
  constexpr std::array<std::string_view, 12> codes{
      "", "qualification-io-timeout", "qualification-io-failed",
      "qualification-qpc-invalid", "qualification-peer-invalid",
      "qualification-closed", "qualification-frame-invalid",
      "qualification-sequence-invalid", "qualification-queue-limit",
      "qualification-launch-invalid", "qualification-isolation-invalid",
      "qualification-native-unavailable"};
  for (size_t i = 1; i < codes.size(); ++i)
    if (value == codes[i]) return static_cast<WriterFailureCode>(i);
  return WriterFailureCode::Unknown;
}
inline WriterFailureCode currentWriterFailureCode() noexcept {
  try {
    throw;
  } catch (const Failure& error) {
    return writerFailureCode(error.what());
  } catch (...) {
    return WriterFailureCode::Unknown;
  }
}
inline uint64_t writerDiagnosticQpc() noexcept {
  LARGE_INTEGER value{};
  return QueryPerformanceCounter(&value) && value.QuadPart >= 0
             ? static_cast<uint64_t>(value.QuadPart) : 0;
}
struct WriterFailureSnapshot {
  WorkKind kind = WorkKind::Write;
  WriterFailureStage stage = WriterFailureStage::Execute;
  uint64_t sequence = 0, enqueued = 0, scheduled = 0, executeBegin = 0,
           executeEnd = 0, ioCompleted = 0, mainCompletion = 0;
};
struct FirstWriterFailure {
  std::atomic<bool> claimed{false};
  bool claim() noexcept {
    bool expected = false;
    return claimed.compare_exchange_strong(expected, true);
  }
};
// Every variable field is numeric. Zero means that a timestamp was unavailable.
// Record 1 is the first failure; record 2 adds its later main callback timestamp.
inline std::array<char, 768> formatWriterFailure(
    const WriterFailureSnapshot& snapshot, WriterFailureCode code,
    uint64_t frequency, uint64_t observed, bool completion) noexcept {
  std::array<char, 768> line{};
  std::snprintf(line.data(), line.size(),
      "资格原生首错 {\"record\":%u,\"code\":%u,\"stage\":%u,\"workKind\":%u,"
      "\"sequence\":%llu,\"frequency\":%llu,\"enqueuedQpc\":%llu,"
      "\"scheduledQpc\":%llu,\"executeBeginQpc\":%llu,\"executeEndQpc\":%llu,"
      "\"ioCompletedQpc\":%llu,\"mainCompletionQpc\":%llu,\"observedQpc\":%llu}\n",
      completion ? 2U : 1U, static_cast<unsigned>(code),
      static_cast<unsigned>(snapshot.stage), static_cast<unsigned>(snapshot.kind),
      static_cast<unsigned long long>(snapshot.sequence),
      static_cast<unsigned long long>(frequency),
      static_cast<unsigned long long>(snapshot.enqueued),
      static_cast<unsigned long long>(snapshot.scheduled),
      static_cast<unsigned long long>(snapshot.executeBegin),
      static_cast<unsigned long long>(snapshot.executeEnd),
      static_cast<unsigned long long>(snapshot.ioCompleted),
      static_cast<unsigned long long>(snapshot.mainCompletion),
      static_cast<unsigned long long>(observed));
  return line;
}
inline void emitWriterFailure(const WriterFailureSnapshot& snapshot,
                              WriterFailureCode code, uint64_t frequency,
                              bool completion = false) noexcept {
  const auto line = formatWriterFailure(snapshot, code, frequency,
                                       writerDiagnosticQpc(), completion);
  std::fputs(line.data(), stderr);
  std::fflush(stderr);
}
}  // namespace h3b
