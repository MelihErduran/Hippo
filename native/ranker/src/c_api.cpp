// Plain C API so the ranker can be called from WebAssembly with no generated
// glue code. Strings cross the boundary as NUL-terminated UTF-8 in linear
// memory: the host allocates with hr_alloc, writes bytes, calls, then frees.
#include <cstdio>
#include <cstdlib>
#include <string>

#include "hippo_ranker.h"

#ifdef __wasm__
#define HR_EXPORT(name) __attribute__((export_name(name)))
#else
#define HR_EXPORT(name)
#endif

namespace {
hippo::Ranker g_ranker;
std::string g_out;
}  // namespace

extern "C" {

HR_EXPORT("hr_alloc") void* hr_alloc(int n) { return std::malloc(static_cast<size_t>(n)); }

HR_EXPORT("hr_free") void hr_free(void* p) { std::free(p); }

HR_EXPORT("hr_reset") void hr_reset() { g_ranker.reset(); }

HR_EXPORT("hr_size") int hr_size() { return static_cast<int>(g_ranker.size()); }

HR_EXPORT("hr_add")
void hr_add(double id, const char* text, double updated_ms, double due_ms, const char* project) {
  g_ranker.add(id, text ? text : "", updated_ms, due_ms, project ? project : "");
}

// Returns JSON: [[id, score, bm25], ...]. The pointer stays valid until the
// next hr_query call.
HR_EXPORT("hr_query")
const char* hr_query(const char* query, double now_ms, const char* project, int k,
                     int require_text, double w_text, double w_recency, double w_urgency,
                     double w_project) {
  hippo::Weights w;
  w.text = w_text;
  w.recency = w_recency;
  w.urgency = w_urgency;
  w.project = w_project;
  auto hits = g_ranker.query(query ? query : "", now_ms, project ? project : "", k,
                             require_text != 0, w);
  g_out.clear();
  g_out.push_back('[');
  char buf[96];
  for (size_t i = 0; i < hits.size(); ++i) {
    std::snprintf(buf, sizeof(buf), "%s[%.17g,%.17g,%.17g]", i ? "," : "", hits[i].id,
                  hits[i].score, hits[i].bm25);
    g_out += buf;
  }
  g_out.push_back(']');
  return g_out.c_str();
}

}  // extern "C"
