#include "hippo_ranker.h"

#include <algorithm>
#include <cmath>
#include <unordered_set>

namespace hippo {
namespace {

// Keep in sync with STOPWORDS in packages/core/src/rank/tokenize.ts.
const std::unordered_set<std::string>& stopwords() {
  static const std::unordered_set<std::string> kStop = {
      "the",  "and",   "for",  "with", "that",  "this", "from", "have",
      "are",  "was",   "but",  "not",  "you",   "your", "about", "into",
      "just", "then",  "than", "its",  "our",   "out",  "all",  "can",
      "will", "what",  "when", "where", "who",  "how",  "to",   "of",
      "in",   "on",    "at",   "is",   "it",    "be",   "or",   "as",
      "by",   "me",    "my",   "do",   "so",    "up",   "if",   "we",
      "he",   "she",   "they", "them", "his",   "her",  "there", "been",
      "also", "an"};
  return kStop;
}

}  // namespace

std::vector<std::string> tokenize(const std::string& text) {
  std::vector<std::string> out;
  std::string cur;
  auto flush = [&]() {
    if (!cur.empty()) {
      // A one-byte token is always a single ASCII character.
      if (cur.size() > 1 && stopwords().count(cur) == 0) out.push_back(cur);
      cur.clear();
    }
  };
  for (unsigned char c : text) {
    if (c >= 0x80) {
      cur.push_back(static_cast<char>(c));
    } else if (c >= 'A' && c <= 'Z') {
      cur.push_back(static_cast<char>(c + 32));
    } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      cur.push_back(static_cast<char>(c));
    } else {
      flush();
    }
  }
  flush();
  return out;
}

void Ranker::reset() {
  docs_.clear();
  df_.clear();
  totalLen_ = 0;
}

void Ranker::add(double id, const std::string& text, double updatedMs,
                 double dueMs, const std::string& project) {
  Doc d;
  d.id = id;
  d.updated = updatedMs;
  d.due = dueMs;
  d.project = project;
  auto tokens = tokenize(text);
  d.len = static_cast<int>(tokens.size());
  for (const auto& t : tokens) d.tf[t] += 1;
  for (const auto& kv : d.tf) df_[kv.first] += 1;
  totalLen_ += d.len;
  docs_.push_back(std::move(d));
}

std::vector<Hit> Ranker::query(const std::string& q, double nowMs,
                               const std::string& project, int k,
                               bool requireText, const Weights& w) const {
  std::vector<Hit> hits;
  const size_t n = docs_.size();
  if (n == 0) return hits;

  // Unique query terms, in order of first appearance (keeps float sums
  // in the same order as the TypeScript implementation).
  std::vector<std::string> terms;
  {
    std::unordered_set<std::string> seen;
    for (auto& t : tokenize(q)) {
      if (seen.insert(t).second) terms.push_back(t);
    }
  }

  const double nd = static_cast<double>(n);
  const double avgdl = static_cast<double>(totalLen_) / nd;
  std::vector<double> bm(n, 0.0);
  double maxBm = 0.0;
  for (size_t i = 0; i < n; ++i) {
    const Doc& d = docs_[i];
    double s = 0.0;
    for (const auto& term : terms) {
      auto it = d.tf.find(term);
      if (it == d.tf.end()) continue;
      auto dit = df_.find(term);
      const double dfv = dit == df_.end() ? 0.0 : static_cast<double>(dit->second);
      const double idf = std::log(1.0 + (nd - dfv + 0.5) / (dfv + 0.5));
      const double tf = static_cast<double>(it->second);
      const double norm = avgdl > 0.0 ? static_cast<double>(d.len) / avgdl : 0.0;
      s += idf * (tf * (kK1 + 1.0)) / (tf + kK1 * (1.0 - kB + kB * norm));
    }
    bm[i] = s;
    if (s > maxBm) maxBm = s;
  }

  for (size_t i = 0; i < n; ++i) {
    const Doc& d = docs_[i];
    if (requireText && !terms.empty() && bm[i] <= 0.0) continue;
    const double text = maxBm > 0.0 ? bm[i] / maxBm : 0.0;
    const double ageDays = std::max(0.0, nowMs - d.updated) / kMsPerDay;
    const double recency = std::pow(0.5, ageDays / kRecencyHalfLifeDays);
    double urgency = 0.0;
    if (d.due > 0.0) {
      const double hoursLeft = (d.due - nowMs) / kMsPerHour;
      urgency = hoursLeft <= 0.0 ? 1.0 : std::pow(0.5, hoursLeft / kUrgencyHalfLifeHours);
    }
    const double proj = (!project.empty() && d.project == project) ? 1.0 : 0.0;
    const double score = w.text * text + w.recency * recency +
                         w.urgency * urgency + w.project * proj;
    hits.push_back(Hit{d.id, score, bm[i]});
  }

  std::sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) {
    if (a.score != b.score) return a.score > b.score;
    return a.id < b.id;
  });
  if (k > 0 && hits.size() > static_cast<size_t>(k)) hits.resize(k);
  return hits;
}

}  // namespace hippo
