#include "wire.hpp"
#include "stream.hpp"
#include "write-io.hpp"
#include "writer-diagnostics.hpp"
#include "writer-queue.hpp"
#include <delayimp.h>
#include <node_api.h>

#include <atomic>
#include <cmath>
#include <deque>


extern "C" FARPROC WINAPI delayHook(unsigned event, PDelayLoadInfo info) {
  if (event == dliNotePreLoadLibrary && strcmp(info->szDll, "node.exe") == 0)
    return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
  return nullptr;
}
extern "C" const PfnDliHook __pfnDliNotifyHook2 = delayHook;

namespace {
using namespace h3b;
void napiCheck(napi_status status) {
  require(status == napi_ok, "qualification-frame-invalid");
}
napi_value toJs(napi_env env, const Value& v) {
  napi_value out = nullptr;
  if (v.isNull())
    napiCheck(napi_get_null(env, &out));
  else if (auto boolean = std::get_if<bool>(&v.data))
    napiCheck(napi_get_boolean(env, *boolean, &out));
  else if (auto number = std::get_if<uint64_t>(&v.data))
    napiCheck(napi_create_double(env, static_cast<double>(*number), &out));
  else if (auto string = std::get_if<std::wstring>(&v.data))
    napiCheck(napi_create_string_utf16(
        env, reinterpret_cast<const char16_t*>(string->data()), string->size(),
        &out));
  else if (auto array = std::get_if<Value::Array>(&v.data)) {
    napiCheck(napi_create_array_with_length(env, array->size(), &out));
    for (size_t i = 0; i < array->size(); ++i)
      napiCheck(napi_set_element(env, out, static_cast<uint32_t>(i),
                                 toJs(env, (*array)[i])));
  } else {
    napiCheck(napi_create_object(env, &out));
    for (const auto& [k, x] : v.object())
      napiCheck(
          napi_set_named_property(env, out, utf8(k).c_str(), toJs(env, x)));
  }
  return out;
}
Value fromJs(napi_env env, napi_value v, size_t& budget, unsigned depth = 0) {
  require(budget > 0, "qualification-frame-invalid");
  --budget;
  require(depth <= 12, "qualification-frame-invalid");
  napi_valuetype type;
  napiCheck(napi_typeof(env, v, &type));
  if (type == napi_null) return nullptr;
  if (type == napi_boolean) {
    bool x;
    napiCheck(napi_get_value_bool(env, v, &x));
    return Value(x);
  }
  if (type == napi_number) {
    double x;
    napiCheck(napi_get_value_double(env, v, &x));
    require(std::isfinite(x) && x >= 0 && x <= 9007199254740991.0 &&
                std::floor(x) == x && !(x == 0 && std::signbit(x)),
            "qualification-frame-invalid");
    return Value(static_cast<uint64_t>(x));
  }
  if (type == napi_string) {
    size_t n = 0;
    napiCheck(napi_get_value_string_utf16(env, v, nullptr, 0, &n));
    require(n <= 262143, "qualification-frame-invalid");
    std::wstring s(n + 1, 0);
    size_t actual = 0;
    napiCheck(napi_get_value_string_utf16(
        env, v, reinterpret_cast<char16_t*>(s.data()), n + 1, &actual));
    require(actual == n, "qualification-frame-invalid");
    s.resize(n);
    nfc(s);
    return Value(s);
  }
  require(type == napi_object, "qualification-frame-invalid");
  bool array = false;
  napiCheck(napi_is_array(env, v, &array));
  if (array) {
    uint32_t n;
    napiCheck(napi_get_array_length(env, v, &n));
    require(n <= 8192, "qualification-frame-invalid");
    Value::Array out;
    for (uint32_t i = 0; i < n; ++i) {
      bool own;
      napiCheck(napi_has_element(env, v, i, &own));
      require(own, "qualification-frame-invalid");
      napi_value item;
      napiCheck(napi_get_element(env, v, i, &item));
      out.push_back(fromJs(env, item, budget, depth + 1));
    }
    return Value(out);
  }
  napi_value names;
  napiCheck(napi_get_all_property_names(env, v, napi_key_own_only,
                                        napi_key_all_properties,
                                        napi_key_numbers_to_strings, &names));
  uint32_t n;
  napiCheck(napi_get_array_length(env, names, &n));
  require(n <= 64, "qualification-frame-invalid");
  Value::Object out;
  for (uint32_t i = 0; i < n; ++i) {
    napi_value key, item;
    napiCheck(napi_get_element(env, names, i, &key));
    auto k = fromJs(env, key, budget, depth + 1);
    auto keyString = std::get<std::wstring>(k.data);
    napiCheck(napi_get_property(env, v, key, &item));
    require(out.emplace(keyString, fromJs(env, item, budget, depth + 1)).second,
            "qualification-frame-invalid");
  }
  return Value(out);
}
struct State;
struct Work {
  State* state;
  WorkKind kind;
  napi_deferred deferred = nullptr;
  std::string bytes;
  std::string error;
  uint64_t sequence = 0;
  uint64_t enqueued = 0;
  uint64_t completed = 0;
  uint64_t scheduled = 0, executeBegin = 0, executeEnd = 0, mainCompletion = 0;
  WriterFailureStage failureStage = WriterFailureStage::Execute;
  WriterFailureCode failureCode = WriterFailureCode::Unknown;
  bool firstFailure = false;
  Work* nextInBatch = nullptr;
  bool readyToSettle = false;
  bool event = false;
  Value result;
};
struct Batch {
  State* state;
  napi_async_work work = nullptr;
  WriterBatch<Work> completed;
  bool started = false;
};
struct State {
  napi_env env;
  Roots roots;
  Handle pipe, peer;
  napi_ref ticket = nullptr, capability = nullptr;
  bool prepared = false, authenticated = false, closing = false, closed = false,
       serializing = false;
  std::atomic<bool> failed{false};
  FirstWriterFailure firstFailure;
  TelemetryStream stream;
  std::wstring mainEntry;
  uint64_t sequence = 0;
  uint64_t freq = frequency();
  uint64_t lastQpc = 0;
  Value ready;
  WriterQueue<Work> queue;
  // Main-only: includes batches whose worker is done but callback is pending.
  size_t liveBatches = 0;
  size_t eventCount = 0, eventBytes = 0, controlCount = 0, controlBytes = 0;
  explicit State(napi_env e) : env(e) {}
};
WriterFailureSnapshot writerSnapshot(const Work& work) noexcept {
  return {work.kind, work.failureStage, work.sequence, work.enqueued,
          work.scheduled, work.executeBegin, work.executeEnd, work.completed,
          work.mainCompletion};
}
bool reportFirstWriterFailure(State* state, const WriterFailureSnapshot& snapshot,
                              WriterFailureCode code) noexcept {
  if (!state->firstFailure.claim()) return false;
  emitWriterFailure(snapshot, code, state->freq);
  return true;
}
void reportWorkFailure(Work* work, WriterFailureCode code) noexcept {
  work->failureCode = code;
  work->firstFailure = reportFirstWriterFailure(work->state, writerSnapshot(*work), code);
}
State* getState(napi_env env) {
  State* state = nullptr;
  napiCheck(napi_get_instance_data(env, reinterpret_cast<void**>(&state)));
  require(state != nullptr, "qualification-native-unavailable");
  return state;
}
bool sameObject(napi_env env, napi_ref ref, napi_value candidate) {
  if (!ref) return false;
  napi_value value;
  napiCheck(napi_get_reference_value(env, ref, &value));
  bool equal = false;
  napiCheck(napi_strict_equals(env, value, candidate, &equal));
  return equal;
}
napi_value opaque(napi_env env, napi_ref& ref) {
  napi_value out;
  napiCheck(napi_create_object(env, &out));
  napiCheck(napi_object_freeze(env, out));
  napiCheck(napi_create_reference(env, out, 1, &ref));
  return out;
}
void cleanup(State* state) {
  state->pipe.checkedClose();
  state->peer.checkedClose();
  for (auto& pin : state->roots.pins) pin.checkedClose();
  state->roots.pins.clear();
  state->closed = true;
}
void authenticate(State* s, Work* work) {
  DWORD self = GetCurrentProcessId();
  DWORD parent = directParent(self);
  require(parent && parent != self, "qualification-peer-invalid");
  s->peer = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                               FALSE, parent));
  require(s->peer.valid(), "qualification-peer-invalid");
  nonInherited(s->peer.value);
  auto selfCreation = creation(GetCurrentProcess());
  auto parentCreation = creation(s->peer.value);
  require(parentCreation < selfCreation &&
              WaitForSingleObject(s->peer.value, 0) == WAIT_TIMEOUT,
          "qualification-peer-invalid");
  uint64_t start = qpc();
  for (;;) {
    s->pipe = Handle(
        CreateFileW(pipeName(self).c_str(),
                    FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, 0,
                    nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
    if (s->pipe.valid()) break;
    DWORD error = GetLastError();
    require(error == ERROR_PIPE_BUSY || error == ERROR_FILE_NOT_FOUND,
            "qualification-peer-invalid");
    require(qpc() - start < s->freq * 5, "qualification-io-timeout");
    Sleep(10);
  }
  nonInherited(s->pipe.value);
  ULONG server = 0;
  require(GetNamedPipeServerProcessId(s->pipe.value, &server) &&
              server == parent && directParent(self) == parent &&
              creation(s->peer.value) == parentCreation &&
              WaitForSingleObject(s->peer.value, 0) == WAIT_TIMEOUT,
          "qualification-peer-invalid");
  auto repo = cwd();
  auto exe = exePath();
  require(exe == repo + L"\\node_modules\\electron\\dist\\electron.exe",
          "qualification-launch-invalid");
  const auto entry = repo + L"\\" + s->mainEntry;
  auto appHandle = openAttributes(entry.substr(0, entry.find_last_of(L"\\")));
  auto exeHandle = openAttributes(exe);
  Value::Object ids;
  for (const auto& [k, id] : s->roots.ids) ids.emplace(wide(k), Value(id));
  s->ready = object(
      {{L"appPathFileId", Value(fileId(appHandle.value, true))},
       {L"electronExeFileId", Value(fileId(exeHandle.value))},
       {L"mainCreationFileTime", Value(hex(selfCreation))},
       {L"mainEntrySha256", Value(sha256(entry))},
       {L"mainPid", Value(static_cast<uint64_t>(self))},
       {L"processExecPathSha256", Value(sha256(exe))},
       {L"processType", Value("browser")},
       {L"qpcFrequency", Value(s->freq)},
       {L"rootFileIds", Value(ids)},
       {L"serverCreationFileTime", Value(hex(parentCreation))},
       {L"serverPid", Value(static_cast<uint64_t>(parent))}});
  FILETIME utc{};
  GetSystemTimePreciseAsFileTime(&utc);
  auto anchor = qpc();
  require(fileTime(utc) >= 116444736000000000ULL, "qualification-qpc-invalid");
  work->result =
      object({{L"identity", s->ready},
              {L"qpcAnchorTicks", Value(hex(anchor))},
              {L"utcAnchorMs",
               Value((fileTime(utc) - 116444736000000000ULL) / 10000)}});
}
void writeFrame(State* s, Work* work) {
  work->failureStage = WriterFailureStage::Peer;
  require(
      s->pipe.valid() && WaitForSingleObject(s->peer.value, 0) == WAIT_TIMEOUT,
      "qualification-peer-invalid");
  size_t offset = 0;
  while (offset < work->bytes.size()) {
    work->failureStage = WriterFailureStage::EnqueueDeadline;
    require(qpc() - work->enqueued < s->freq * 2, "qualification-io-timeout");
    work->failureStage = WriterFailureStage::Submit;
    PendingWrite operation(s->pipe.value);
    operation.submit(work->bytes.data() + offset,
                     static_cast<DWORD>(work->bytes.size() - offset));
    work->failureStage = WriterFailureStage::AwaitCompletion;
    const auto completion = finishWriteWith(operation, work->enqueued, s->freq);
    work->failureStage = WriterFailureStage::WriteResult;
    const auto bytes = completion.bytes;
    require(bytes > 0 && bytes <= work->bytes.size() - offset,
            "qualification-io-failed");
    offset += bytes;
    work->completed = completion.observed;
  }
  work->result =
      object({{L"sequence", Value(work->sequence)},
              {L"writeCompletedQpcTicks", Value(hex(work->completed))}});
}
void executeWork(Work* work) {
  auto state = work->state;
  work->executeBegin = writerDiagnosticQpc();
  try {
    if (state->failed && work->kind != WorkKind::Close)
      throw Failure("qualification-closed");
    if (work->kind == WorkKind::Connect) {
      work->failureStage = WriterFailureStage::Connect;
      authenticate(state, work);
    } else if (work->kind == WorkKind::Write)
      writeFrame(state, work);
    else {
      work->failureStage = WriterFailureStage::Cleanup;
      cleanup(state);
    }
    work->executeEnd = writerDiagnosticQpc();
  } catch (const Failure& error) {
    work->executeEnd = writerDiagnosticQpc();
    reportWorkFailure(work, writerFailureCode(error.what()));
    work->error = error.what();
    state->failed = true;
    if (work->kind == WorkKind::Connect) {
      try {
        cleanup(state);
      } catch (...) {
      }
    }
  } catch (...) {
    work->executeEnd = writerDiagnosticQpc();
    reportWorkFailure(work, WriterFailureCode::Unknown);
    work->error = "qualification-io-failed";
    state->failed = true;
    if (work->kind == WorkKind::Connect) {
      try {
        cleanup(state);
      } catch (...) {
      }
    }
  }
}
void execute(napi_env, void* data) {
  auto batch = static_cast<Batch*>(data);
  batch->started = true;
  try {
    while (auto work = batch->state->queue.takePending()) {
      batch->completed.append(work);
      // For a drain batch this is dispatch from the pending queue, not the
      // libuv submission time of the containing batch.
      work->scheduled = writerDiagnosticQpc();
      executeWork(work);
    }
  } catch (...) {
    // Keep ownership intact if the queue itself cannot complete its protocol.
    TerminateProcess(GetCurrentProcess(), 77);
    std::terminate();
  }
}
void settleWork(napi_env env, Work* work) {
  auto state = work->state;
  work->mainCompletion = writerDiagnosticQpc();
  if (work->firstFailure)
    emitWriterFailure(writerSnapshot(*work), work->failureCode, state->freq, true);
  auto failureSnapshot = writerSnapshot(*work);
  try {
    if (!work->error.empty()) {
      state->failed = true;
      napi_value message, error;
      napiCheck(napi_create_string_utf8(env, work->error.c_str(),
                                        NAPI_AUTO_LENGTH, &message));
      napiCheck(napi_create_error(env, nullptr, message, &error));
      napiCheck(napi_reject_deferred(env, work->deferred, error));
    } else {
      auto result = toJs(env, work->result);
      if (work->kind == WorkKind::Connect) {
        state->authenticated = true;
        napiCheck(napi_set_named_property(env, result, "capability",
                                          opaque(env, state->capability)));
      }
      napiCheck(napi_resolve_deferred(env, work->deferred, result));
    }
    if (work->kind == WorkKind::Write) {
      if (work->event) {
        --state->eventCount;
        state->eventBytes -= work->bytes.size();
      } else {
        --state->controlCount;
        state->controlBytes -= work->bytes.size();
      }
    }
    delete work;
  } catch (...) {
    failureSnapshot.stage = WriterFailureStage::MainCompletionFatal;
    reportFirstWriterFailure(state, failureSnapshot, currentWriterFailureCode());
    napi_fatal_error("qualification", NAPI_AUTO_LENGTH, "资格原生完成路径失败",
                     NAPI_AUTO_LENGTH);
  }
}
void completed(napi_env env, napi_status status, void* data) {
  auto batch = static_cast<Batch*>(data);
  auto state = batch->state;
  try {
    if (status != napi_ok) {
      // A cancelled batch that never started still exclusively owns pending
      // work. Retire it as failure instead of stranding an active consumer.
      if (!batch->started) {
        while (auto work = state->queue.takePending()) {
          batch->completed.append(work);
          // No worker or pending OS write belongs to an unstarted batch.
          if (work->kind == WorkKind::Close) cleanup(state);
        }
      }
      for (auto work = batch->completed.first; work; work = work->nextInBatch) {
        if (!work->error.empty()) continue;
        work->failureStage = WriterFailureStage::MainCompletion;
        reportWorkFailure(work, WriterFailureCode::IoFailed);
        work->error = "qualification-io-failed";
      }
      state->failed = true;
    }
    napiCheck(napi_delete_async_work(env, batch->work));
    state->queue.complete(batch->completed);
    delete batch;
    --state->liveBatches;
    while (auto work = state->queue.takeReady()) settleWork(env, work);
  } catch (...) {
    napi_fatal_error("qualification", NAPI_AUTO_LENGTH, "资格原生批完成路径失败",
                     NAPI_AUTO_LENGTH);
  }
}
[[noreturn]] void failScheduling(State* state, Work* first, WriterFailureCode code) {
  first->failureStage = WriterFailureStage::Schedule;
  reportWorkFailure(first, code);
  state->failed = true;
  napi_fatal_error("qualification", NAPI_AUTO_LENGTH, "资格原生批调度失败",
                   NAPI_AUTO_LENGTH);
}
void schedule(State* state, Work* first) {
  try {
    // The callback owns this allocation after success. On failure retain it
    // until fatal teardown, including any N-API object that refers to it.
    auto batch = new Batch{state};
    napi_value name;
    napiCheck(napi_create_string_utf8(state->env, "AIbrowseQualification",
                                      NAPI_AUTO_LENGTH, &name));
    napiCheck(napi_create_async_work(state->env, nullptr, name, execute,
                                     completed, batch, &batch->work));
    napiCheck(napi_queue_async_work(state->env, batch->work));
    ++state->liveBatches;
  } catch (...) {
    // A failed N-API submission cannot leave an active queue without a worker.
    // Preserve ownership until process teardown instead of accepting more work.
    failScheduling(state, first, currentWriterFailureCode());
  }
}
napi_value enqueue(State* state, Work* work) {
  napi_value promise;
  try {
    napiCheck(napi_create_promise(state->env, &work->deferred, &promise));
    if (state->queue.enqueue(work)) schedule(state, work);
  } catch (...) {
    failScheduling(state, work, currentWriterFailureCode());
  }
  return promise;
}
template <typename F>
napi_value guarded(napi_env env, F action) {
  try {
    return action();
  } catch (const Failure& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  } catch (...) {
    napi_throw_error(env, nullptr, "qualification-native-unavailable");
    return nullptr;
  }
}
napi_value prepare(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    size_t argc = 1;
    napi_value arg;
    napiCheck(napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr));
    require(argc == 0, "qualification-launch-invalid");
    auto state = getState(env);
    require(!state->prepared && !state->failed && !state->closed,
            "qualification-launch-invalid");
    state->prepared = true;
    try {
      int count = 0;
      LPWSTR* rawArgs = CommandLineToArgvW(GetCommandLineW(), &count);
      std::unique_ptr<void, decltype(&LocalFree)> argsOwner(rawArgs, &LocalFree);
      require(rawArgs != nullptr && count == 4, "qualification-launch-invalid");
      const std::vector<std::wstring> arguments(rawArgs, rawArgs + count);
      auto temp = environment(L"TEMP");
      strictLocalPath(temp);
      auto root = parentPath(temp);
      require(temp == root + L"\\process-temp" && environment(L"TMP") == temp &&
                  environment(L"APPDATA") == root + L"\\appdata" &&
                  environment(L"LOCALAPPDATA") == root + L"\\localappdata",
              "qualification-isolation-invalid");
      state->roots.pin(root, false);
      require(qualificationLaunchArguments(
                  arguments, exePath(), state->roots.paths.at("userDataRoot")),
              "qualification-launch-invalid");
      state->mainEntry = arguments[1];
      std::replace(state->mainEntry.begin(), state->mainEntry.end(), L'/', L'\\');
      Value::Object paths, ids;
      for (const auto& [k, v] : state->roots.paths)
        paths.emplace(wide(k), Value(v));
      for (const auto& [k, v] : state->roots.ids)
        ids.emplace(wide(k), Value(v));
      auto result = toJs(
          env, object({{L"paths", Value(paths)},
                       {L"rootFileIds", Value(ids)},
                       {L"qualificationRunId", Value(state->roots.runId)}}));
      napiCheck(napi_set_named_property(env, result, "ticket",
                                        opaque(env, state->ticket)));
      return result;
    } catch (...) {
      reportFirstWriterFailure(state,
          {WorkKind::Connect, WriterFailureStage::Prepare}, currentWriterFailureCode());
      state->failed = true;
      cleanup(state);
      throw;
    }
  });
}
napi_value connect(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    size_t argc = 2;
    napi_value args[2];
    napiCheck(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    auto s = getState(env);
    require(argc == 1 && sameObject(env, s->ticket, args[0]) && s->prepared &&
                !s->failed && !s->closing && !s->authenticated &&
                s->queue.empty(),
            "qualification-capability-invalid");
    return enqueue(s, new Work{s, WorkKind::Connect});
  });
}
napi_value read(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    size_t argc = 1;
    napi_value arg;
    napiCheck(napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr));
    require(argc == 0, "qualification-qpc-invalid");
    auto state = getState(env);
    auto now = qpc();
    require(now >= state->lastQpc && frequency() == state->freq,
            "qualification-qpc-invalid");
    state->lastQpc = now;
    return toJs(env, object({{L"ticks", Value(hex(now))},
                             {L"frequency", Value(state->freq)}}));
  });
}
napi_value write(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    size_t argc = 3;
    napi_value args[3];
    napiCheck(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    auto s = getState(env);
    require(argc == 2 && sameObject(env, s->capability, args[0]) &&
                s->authenticated && !s->failed && !s->closing && !s->stream.complete &&
                !s->serializing,
            "qualification-capability-invalid");
    s->serializing = true;
    Value frame;
    size_t budget = 32768;
    try {
      frame = fromJs(env, args[1], budget);
      validateFrame(frame);
    } catch (...) {
      reportFirstWriterFailure(s,
          {WorkKind::Write, WriterFailureStage::Serialize, s->sequence + 1},
          currentWriterFailureCode());
      s->serializing = false;
      s->failed = true;
      throw;
    }
    s->serializing = false;
    auto kind = frame.at("kind").string();
    auto sequence = frame.at("sequence").number();
    require(frame.at("qualificationRunId").string() == s->roots.runId &&
                sequence == s->sequence + 1,
            "qualification-sequence-invalid");
    require((sequence == 1) == (kind == "ready"),
            "qualification-sequence-invalid");
    if (kind == "ready")
      require(canonical(frame.at("payload")) == canonical(s->ready),
              "qualification-peer-invalid");
    s->stream.accept(frame);
    auto bytes = canonical(frame) + '\n';
    require(bytes.size() <= 262144, "qualification-frame-invalid");
    bool event = kind == "register" || kind == "unregister";
    if ((event && (s->eventCount + 1 >= 4096 ||
                   s->eventBytes + bytes.size() >= 8388608)) ||
        (!event && (s->controlCount + 1 >= 64 ||
                    s->controlBytes + bytes.size() >= 1048576))) {
      reportFirstWriterFailure(s,
          {WorkKind::Write, WriterFailureStage::QueueLimit, sequence},
          WriterFailureCode::QueueLimit);
      s->failed = true;
      throw Failure("qualification-queue-limit");
    }
    auto work = new Work{s, WorkKind::Write};
    work->sequence = sequence;
    work->bytes = std::move(bytes);
    work->event = event;
    work->enqueued = qpc();
    if (event) {
      ++s->eventCount;
      s->eventBytes += work->bytes.size();
    } else {
      ++s->controlCount;
      s->controlBytes += work->bytes.size();
    }
    s->sequence = sequence;
    return enqueue(s, work);
  });
}
napi_value close(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    size_t argc = 2;
    napi_value args[2];
    napiCheck(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    auto s = getState(env);
    require(argc == 1 && (sameObject(env, s->ticket, args[0]) ||
                          sameObject(env, s->capability, args[0])),
            "qualification-capability-invalid");
    s->closing = true;
    return enqueue(s, new Work{s, WorkKind::Close});
  });
}
void finalize(napi_env, void* data, void*) {
  auto s = static_cast<State*>(data);
  if (!s->queue.canFinalize(s->liveBatches)) {
    TerminateProcess(GetCurrentProcess(), 77);
    return;
  }
  delete s;
}
napi_value initialize(napi_env env, napi_value exports) {
  return guarded(env, [&] {
    napi_value global, process, type, arch, versions, electron;
    napiCheck(napi_get_global(env, &global));
    napiCheck(napi_get_named_property(env, global, "process", &process));
    napiCheck(napi_get_named_property(env, process, "type", &type));
    napiCheck(napi_get_named_property(env, process, "arch", &arch));
    napiCheck(napi_get_named_property(env, process, "versions", &versions));
    napiCheck(napi_get_named_property(env, versions, "electron", &electron));
    size_t budget = 64;
    require(fromJs(env, type, budget).string() == "browser" &&
                fromJs(env, arch, budget).string() == "x64" &&
                fromJs(env, electron, budget).string() == "43.4.0",
            "qualification-native-unavailable");
    auto s = new State(env);
    napiCheck(napi_set_instance_data(env, s, finalize, nullptr));
    const std::array<std::pair<const char*, napi_callback>, 5> methods{
        {{"prepareLaunchIsolation", prepare},
         {"authenticateLaunchAndConnectTelemetry", connect},
         {"readQpc", read},
         {"writeTelemetryFrame", write},
         {"closeTelemetry", close}}};
    for (const auto& [name, callback] : methods) {
      napi_value function;
      napiCheck(napi_create_function(env, name, NAPI_AUTO_LENGTH, callback,
                                     nullptr, &function));
      napiCheck(napi_set_named_property(env, exports, name, function));
    }
    return exports;
  });
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
