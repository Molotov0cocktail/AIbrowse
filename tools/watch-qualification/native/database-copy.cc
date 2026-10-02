#include "database-copy.hpp"
#include <fcntl.h>
#include <io.h>
#include <iostream>

int wmain(int argc, wchar_t** argv) {
  using namespace h3b;
  try {
    require(argc == 7 && std::wstring(argv[1]) == L"--copy-closed" &&
                _setmode(_fileno(stdout), _O_BINARY) != -1, "copy-arguments-invalid");
    auto result = resource::databasecopy::copyDatabases(argv[2], argv[3],
        resource::readRootIds(argv[4]), utf8(argv[5]), utf8(argv[6]));
    std::cout << canonical(result) << '\n';
    return 0;
  } catch (const Failure& error) {
    std::cerr << "数据库副本未通过：" << error.what() << "；原库和失败副本保持原状。\n";
    return 79;
  } catch (...) {
    std::cerr << "数据库副本未通过；原库和失败副本保持原状。\n";
    return 79;
  }
}
