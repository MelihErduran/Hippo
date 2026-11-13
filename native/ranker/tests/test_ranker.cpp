// Native unit tests: g++ -std=c++17 -Iinclude src/ranker.cpp tests/test_ranker.cpp
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "hippo_ranker.h"

static int g_failures = 0;
#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) {                                                     \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);      \
      ++g_failures;                                                    \
    }                                                                  \
  } while (0)

using hippo::Hit;
using hippo::Ranker;
using hippo::Weights;

static const double kDay = 86400000.0;
static const double kNow = 1793836560000.0;  // fixed clock

static void test_tokenize() {
  auto t = hippo::tokenize("Finish CS161 HW4, then email Navid!");
  std::vector<std::string> want = {"finish", "cs161", "hw4", "email", "navid"};
  CHECK(t == want);  // "then" is a stopword

  auto u = hippo::tokenize("Ödev: türkçe çeviri");
  CHECK(u.size() == 3);
  CHECK(u[0] == "\xC3\x96" "dev");  // non-ASCII bytes kept as-is, not lowercased
  CHECK(hippo::tokenize("a b c I").empty());
  CHECK(hippo::tokenize("").empty());
}

static void test_bm25_prefers_matches() {
  Ranker r;
  r.add(1, "buy groceries milk eggs", kNow, 0, "");
  r.add(2, "cs161 homework four problem set", kNow, 0, "cs161");
  r.add(3, "cs161 lecture notes on graphs", kNow, 0, "cs161");
  auto hits = r.query("cs161 homework", kNow, "", 0, true, Weights{});
  CHECK(hits.size() == 2);
  CHECK(hits[0].id == 2);
  CHECK(hits[1].id == 3);
  CHECK(hits[0].bm25 > hits[1].bm25);
}

static void test_require_text_and_empty_query() {
  Ranker r;
  r.add(1, "alpha beta", kNow, 0, "");
  r.add(2, "gamma delta", kNow - 30 * kDay, 0, "");
  auto none = r.query("zeta", kNow, "", 0, true, Weights{});
  CHECK(none.empty());
  // Empty query: no filtering, recency decides.
  auto all = r.query("", kNow, "", 0, true, Weights{});
  CHECK(all.size() == 2);
  CHECK(all[0].id == 1);
}

static void test_urgency_and_project() {
  Weights w;
  Ranker r;
  r.add(1, "write report", kNow, kNow + 10 * kDay, "");
  r.add(2, "write report", kNow, kNow + 2 * 3600000.0, "");
  r.add(3, "write report", kNow, kNow - kDay, "");  // overdue
  auto hits = r.query("report", kNow, "", 0, true, w);
  CHECK(hits[0].id == 3);
  CHECK(hits[1].id == 2);
  CHECK(hits[2].id == 1);

  Ranker p;
  p.add(1, "fix bug", kNow, 0, "smart-bin");
  p.add(2, "fix bug", kNow, 0, "signalos");
  auto ph = p.query("bug", kNow, "signalos", 0, true, w);
  CHECK(ph[0].id == 2);
  CHECK(std::fabs(ph[0].score - ph[1].score - w.project) < 1e-12);
}

static void test_exact_score() {
  // One doc, query matches: text = 1, recency = 1 (age 0), no due, no project.
  Ranker r;
  r.add(7, "hello world", kNow, 0, "");
  auto h = r.query("hello", kNow, "", 0, true, Weights{});
  CHECK(h.size() == 1);
  CHECK(std::fabs(h[0].score - (0.55 + 0.20)) < 1e-12);
  // 14 days old: recency halves.
  Ranker o;
  o.add(7, "hello world", kNow - 14 * kDay, 0, "");
  auto oh = o.query("hello", kNow, "", 0, true, Weights{});
  CHECK(std::fabs(oh[0].score - (0.55 + 0.10)) < 1e-12);
}

static void test_k_and_ties() {
  Ranker r;
  for (int i = 5; i >= 1; --i) r.add(i, "same text", kNow, 0, "");
  auto h = r.query("text", kNow, "", 3, true, Weights{});
  CHECK(h.size() == 3);
  CHECK(h[0].id == 1 && h[1].id == 2 && h[2].id == 3);  // ties break by id
}

int main() {
  test_tokenize();
  test_bm25_prefers_matches();
  test_require_text_and_empty_query();
  test_urgency_and_project();
  test_exact_score();
  test_k_and_ties();
  if (g_failures == 0) std::printf("ranker: all tests passed\n");
  return g_failures == 0 ? 0 : 1;
}
