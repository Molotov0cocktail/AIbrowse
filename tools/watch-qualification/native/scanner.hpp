#pragma once
#include "wire.hpp"
namespace collector {
using namespace h3b;
// Independent scanner: rejects duplicates and noncanonical spellings while
// consuming bytes.
class Scanner {
  const std::string& text;
  size_t cursor = 0;
  unsigned depth = 0;
  char take() {
    require(cursor < text.size(), "collector-incomplete-frame");
    return text[cursor++];
  }
  std::wstring string() {
    require(take() == '"', "collector-string-invalid");
    std::string bytes;
    for (;;) {
      char c = take();
      if (c == '"') break;
      if (c == '\\') {
        c = take();
        require(c == '"' || c == '\\', "collector-noncanonical-escape");
      }
      require(static_cast<unsigned char>(c) >= 32, "collector-string-control");
      bytes += c;
    }
    auto result = wide(bytes);
    nfc(result);
    return result;
  }
  Value value() {
    require(++depth <= 12 && cursor < text.size(), "collector-shape-invalid");
    Value result;
    char c = text[cursor];
    if (c == '"')
      result = Value(string());
    else if (c == '{') {
      ++cursor;
      Value::Object members;
      std::wstring previous;
      bool first = true;
      if (cursor < text.size() && text[cursor] != '}')
        for (;;) {
          auto key = string();
          require(first || key > previous, "collector-duplicate-or-key-order");
          previous = key;
          first = false;
          require(take() == ':', "collector-object-invalid");
          require(members.emplace(key, value()).second,
                  "collector-duplicate-key");
          c = take();
          if (c == '}') break;
          require(c == ',', "collector-object-invalid");
        }
      else
        require(take() == '}', "collector-object-invalid");
      result = Value(members);
    } else if (c == '[') {
      ++cursor;
      Value::Array items;
      if (cursor < text.size() && text[cursor] != ']')
        for (;;) {
          require(items.size() < 8192, "collector-array-limit");
          items.push_back(value());
          c = take();
          if (c == ']') break;
          require(c == ',', "collector-array-invalid");
        }
      else
        require(take() == ']', "collector-array-invalid");
      result = Value(items);
    } else if (c >= '0' && c <= '9') {
      size_t start = cursor;
      uint64_t number = 0;
      do {
        c = text[cursor++];
        require(number <= (9007199254740991ULL - (c - '0')) / 10,
                "collector-number-overflow");
        number = number * 10 + c - '0';
      } while (cursor < text.size() && text[cursor] >= '0' &&
               text[cursor] <= '9');
      require(cursor == start + 1 || text[start] != '0',
              "collector-number-spelling");
      result = Value(number);
    } else if (text.substr(cursor, 4) == "null") {
      cursor += 4;
      result = Value(nullptr);
    } else if (text.substr(cursor, 4) == "true") {
      cursor += 4;
      result = Value(true);
    } else if (text.substr(cursor, 5) == "false") {
      cursor += 5;
      result = Value(false);
    } else
      throw Failure("collector-value-invalid");
    --depth;
    return result;
  }

 public:
  explicit Scanner(const std::string& t) : text(t) {}
  Value parse() {
    require(!text.empty() && text.size() <= 262144 && text.back() == '\n',
            "collector-line-invalid");
    auto result = value();
    require(cursor + 1 == text.size() && take() == '\n',
            "collector-noncanonical-trailing");
    return result;
  }
};

} // namespace collector
