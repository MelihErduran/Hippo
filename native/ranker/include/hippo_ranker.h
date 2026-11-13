// Hippo ranker: BM25 text match fused with recency, urgency and project signals.
//
// The exact same formula lives in packages/core/src/rank/ranker.ts. A parity
// test runs both implementations on randomized corpora, so if you change the
// math here, change it there too.
#pragma once

#include <string>
#include <unordered_map>
#include <vector>

namespace hippo {

struct Weights {
  double text = 0.55;
  double recency = 0.20;
  double urgency = 0.15;
  double project = 0.10;
};

struct Hit {
  double id;
  double score;
  double bm25;  // raw BM25, before normalization
};

// Lowercases ASCII, keeps UTF-8 bytes intact (so Turkish letters survive),
// splits on everything else, and drops single ASCII characters and stopwords.
std::vector<std::string> tokenize(const std::string& text);

class Ranker {
 public:
  static constexpr double kK1 = 1.2;
  static constexpr double kB = 0.75;
  static constexpr double kMsPerDay = 86400000.0;
  static constexpr double kMsPerHour = 3600000.0;
  static constexpr double kRecencyHalfLifeDays = 14.0;
  static constexpr double kUrgencyHalfLifeHours = 48.0;

  void reset();
  // dueMs <= 0 means "no due date". project may be empty.
  void add(double id, const std::string& text, double updatedMs, double dueMs,
           const std::string& project);
  // k <= 0 returns every hit. requireText drops docs with no query term
  // (only when the query has at least one token).
  std::vector<Hit> query(const std::string& q, double nowMs,
                         const std::string& project, int k, bool requireText,
                         const Weights& w) const;
  size_t size() const { return docs_.size(); }

 private:
  struct Doc {
    double id;
    std::unordered_map<std::string, int> tf;
    int len;
    double updated;
    double due;
    std::string project;
  };
  std::vector<Doc> docs_;
  std::unordered_map<std::string, int> df_;
  long long totalLen_ = 0;
};

}  // namespace hippo
