#pragma once
#include <deque>
#include <mutex>

namespace h3b {
template <typename Work>
struct WriterBatch {
  Work* first = nullptr;
  Work* last = nullptr;
  void append(Work* work) noexcept {
    if (last) last->nextInBatch = work;
    else first = work;
    last = work;
  }
};

template <typename Work>
class WriterQueue {
  // Only enqueue/takePending cross threads. Outstanding and completion flags
  // belong to main; a batch callback runs after all its worker accesses end.
  std::mutex mutex;
  std::deque<Work*> pending;
  bool active = false;
  std::deque<Work*> outstanding;

 public:
  bool enqueue(Work* work) {
    outstanding.push_back(work);
    std::lock_guard lock(mutex);
    pending.push_back(work);
    if (active) return false;
    active = true;
    return true;
  }
  Work* takePending() {
    std::lock_guard lock(mutex);
    if (pending.empty()) {
      // A later enqueue starts a worker even before this batch's main callback.
      active = false;
      return nullptr;
    }
    auto work = pending.front();
    pending.pop_front();
    return work;
  }
  void complete(const WriterBatch<Work>& batch) noexcept {
    for (auto work = batch.first; work; work = work->nextInBatch)
      work->readyToSettle = true;
  }
  Work* takeReady() {
    if (outstanding.empty() || !outstanding.front()->readyToSettle) return nullptr;
    auto work = outstanding.front();
    outstanding.pop_front();
    return work;
  }
  bool empty() const noexcept { return outstanding.empty(); }
  size_t size() const noexcept { return outstanding.size(); }
  bool canFinalize(size_t liveBatches) const noexcept {
    return outstanding.empty() && liveBatches == 0;
  }
};
}  // namespace h3b
