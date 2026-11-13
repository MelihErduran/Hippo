# Hippo ranker build
#
#   make test   native unit tests (any C++17 compiler)
#   make wasm   WebAssembly build, needs wasi-sdk:
#               https://github.com/WebAssembly/wasi-sdk/releases
#               (macOS: download the arm64-macos tarball, then
#                make wasm WASI_SDK=/path/to/wasi-sdk-25.0-arm64-macos)

CXX      ?= c++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra
WASI_SDK ?= /opt/wasi-sdk-25.0-x86_64-linux

SRC     = src/ranker.cpp src/c_api.cpp
OUT_DIR = build
WASM    = $(OUT_DIR)/hippo_ranker.wasm
ASSET   = ../../packages/core/assets/hippo_ranker.wasm

.PHONY: test wasm clean

test: $(OUT_DIR)/test_ranker
	./$(OUT_DIR)/test_ranker

$(OUT_DIR)/test_ranker: $(SRC) tests/test_ranker.cpp include/hippo_ranker.h
	@mkdir -p $(OUT_DIR)
	$(CXX) $(CXXFLAGS) -Iinclude src/ranker.cpp tests/test_ranker.cpp -o $@

wasm: $(WASM)
	@mkdir -p $(dir $(ASSET))
	cp $(WASM) $(ASSET)
	@echo "copied to $(ASSET)"

$(WASM): $(SRC) include/hippo_ranker.h
	@mkdir -p $(OUT_DIR)
	$(WASI_SDK)/bin/clang++ --target=wasm32-wasip1 --sysroot=$(WASI_SDK)/share/wasi-sysroot \
	  -std=c++17 -O2 -fno-exceptions -mexec-model=reactor -Iinclude $(SRC) \
	  -Wl,--strip-all -o $@

clean:
	rm -rf $(OUT_DIR)
