#pragma once
#include "wire.hpp"

namespace resource {
using namespace h3b;
inline Handle immutableArtifact(const std::wstring& path) {
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr,
                         OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(file.valid(), "launch-artifact-pin-failed");
  fileId(file.value);
  return file;
}
inline std::wstring quote(const std::wstring& arg) {
  require(arg.find(L'"') == std::wstring::npos && !arg.empty() && arg.back() != L'\\',
          "launch-argument-invalid");
  return L"\"" + arg + L"\"";
}
struct Stream {
  Handle read;
  bool eof = false;
  uint64_t total = 0;
  std::string pending;
  void poll() {
    if (eof) return;
    DWORD available = 0;
    if (!PeekNamedPipe(read.value, nullptr, 0, nullptr, &available, nullptr)) {
      require(GetLastError() == ERROR_BROKEN_PIPE, "stream-query-failed");
      eof = true;
      return;
    }
    std::array<char, 65536> buffer{};
    if (!available) return;
    DWORD bytes = 0;
    require(ReadFile(read.value, buffer.data(), std::min<DWORD>(available, DWORD(buffer.size())),
                     &bytes, nullptr) && bytes > 0, "stream-read-failed");
    total += bytes;
    require(total <= 64 * 1024 * 1024 && pending.size() + bytes <= 1024 * 1024,
            "stream-budget-exhausted");
    pending.append(buffer.data(), bytes);
  }
};
inline Handle pipe(Stream& read) {
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  Handle write;
  require(CreatePipe(&read.read.value, &write.value, &security, 65536) &&
              SetHandleInformation(read.read.value, HANDLE_FLAG_INHERIT, 0),
          "launch-stream-failed");
  return write;
}
struct Child {
  Handle process, thread;
  DWORD pid = 0;
  Stream out, err;
  bool resumed = false;
  ~Child() {
    if (process.valid() && !resumed && WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) {
      TerminateProcess(process.value, 79);
      WaitForSingleObject(process.value, 2000);
    }
  }
  void launch(const std::wstring& exe, std::wstring command, const std::wstring& directory,
              const std::vector<wchar_t>* environment = nullptr, HANDLE inherited = nullptr) {
    auto output = pipe(out), errors = pipe(err);
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                            &security, OPEN_EXISTING, 0, nullptr));
    require(input.valid(), "launch-stdin-failed");
    std::vector<HANDLE> allow{input.value, output.value, errors.value};
    Handle copy;
    if (inherited) {
      require(DuplicateHandle(GetCurrentProcess(), inherited, GetCurrentProcess(),
                  &copy.value, JOB_OBJECT_QUERY, TRUE, 0), "worker-job-copy-failed");
      allow.push_back(copy.value);
      command += L" " + std::to_wstring(reinterpret_cast<uintptr_t>(copy.value));
    }
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    require(bytes > 0, "launch-attribute-failed");
    std::vector<BYTE> buffer(bytes);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(buffer.data());
    require(InitializeProcThreadAttributeList(attributes, 1, 0, &bytes), "launch-attribute-failed");
    struct Cleanup { LPPROC_THREAD_ATTRIBUTE_LIST p; ~Cleanup() { DeleteProcThreadAttributeList(p); } } cleanup{attributes};
    require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                allow.data(), allow.size() * sizeof(HANDLE), nullptr, nullptr),
            "launch-handle-list-failed");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.value;
    startup.StartupInfo.hStdOutput = output.value;
    startup.StartupInfo.hStdError = errors.value;
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION info{};
    require(CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, TRUE,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
                EXTENDED_STARTUPINFO_PRESENT,
                environment ? const_cast<wchar_t*>(environment->data()) : nullptr,
                directory.c_str(), &startup.StartupInfo, &info), "launch-create-failed");
    process = Handle(info.hProcess);
    thread = Handle(info.hThread);
    pid = info.dwProcessId;
  }
  void resume() {
    require(ResumeThread(thread.value) == 1, "launch-resume-failed");
    resumed = true;
    thread.checkedClose();
  }
};
struct Output {
  Handle file;
  explicit Output(const std::wstring& path) {
    file = Handle(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                  CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(file.valid(), "output-create-failed");
    fileId(file.value);
  }
  void write(const std::string& bytes) {
    DWORD n = 0;
    require(bytes.size() <= MAXDWORD && WriteFile(file.value, bytes.data(),
                static_cast<DWORD>(bytes.size()), &n, nullptr) && n == bytes.size(),
            "output-write-failed");
  }
  void line(const Value& value) { write(canonical(value) + "\n"); }
};
inline Handle job() {
  Handle result(CreateJobObjectW(nullptr, nullptr));
  require(result.valid(), "job-create-failed");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  require(SetInformationJobObject(result.value, JobObjectExtendedLimitInformation,
              &limits, sizeof(limits)), "job-limits-failed");
  return result;
}
inline void assign(HANDLE job, HANDLE process) {
  BOOL member = FALSE;
  require(AssignProcessToJobObject(job, process) && IsProcessInJob(process, job, &member) && member,
          "job-assignment-failed");
}
struct LaunchContainment {
  Handle owner{job()};
  LaunchContainment() { assign(owner.value, GetCurrentProcess()); }
  void release() {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
    require(QueryInformationJobObject(owner.value, JobObjectBasicAccountingInformation,
                &state, sizeof(state), nullptr) && state.ActiveProcesses == 1,
            "launcher-descendants-remain");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    require(SetInformationJobObject(owner.value, JobObjectExtendedLimitInformation,
                &limits, sizeof(limits)), "launcher-job-release-failed");
    owner.checkedClose();
  }
  [[noreturn]] void abort() {
    TerminateJobObject(owner.value, 79);
    TerminateProcess(GetCurrentProcess(), 79);
    std::terminate();
  }
};
}  // namespace resource
