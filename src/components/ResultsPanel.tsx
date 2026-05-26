import { ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Grid, Recommendation } from "../lib/types";
import { getCandidateEvidence } from "../lib/wordle";

interface ResultsPanelProps {
  candidates: string[];
  grid: Grid;
  recommendations: Recommendation[];
  completedRows: number;
}

export function ResultsPanel({ candidates, completedRows, grid, recommendations }: ResultsPanelProps) {
  const [query, setQuery] = useState("");
  const [recommendationsOpen, setRecommendationsOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(120);
  const sortedCandidates = useMemo(
    () => [...candidates].sort((a, b) => a.localeCompare(b)),
    [candidates],
  );
  const filteredCandidates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return sortedCandidates;
    }
    return sortedCandidates.filter((word) => word.includes(normalized));
  }, [query, sortedCandidates]);
  const visibleCandidates = filteredCandidates.slice(0, visibleCount);

  useEffect(() => {
    setVisibleCount(120);
  }, [query, candidates]);

  const handleCandidateScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const isNearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 80;
    if (isNearBottom) {
      setVisibleCount((count) => Math.min(count + 120, filteredCandidates.length));
    }
  };

  return (
    <section className="results-panel">
      <div className="result-header">
        <div>
          <h2>후보</h2>
          <p>{completedRows > 0 ? `${candidates.length.toLocaleString()}개 후보` : "전체 목록 기준"}</p>
        </div>
      </div>

      <div className="candidate-tools">
        <label className="search-box">
          <Search size={17} />
          <input
            aria-label="후보 검색"
            placeholder="후보 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <div className="candidate-list" aria-label="가능 후보" onScroll={handleCandidateScroll}>
        {visibleCandidates.map((word) => (
          <MiniWord key={word} word={word} states={getCandidateEvidence(word, grid)} />
        ))}
      </div>
      <p className="list-note">
        {visibleCandidates.length.toLocaleString()} / {filteredCandidates.length.toLocaleString()} 표시
      </p>

      <section className="recommendation-section">
        <button
          aria-expanded={recommendationsOpen}
          className="recommendation-toggle"
          type="button"
          onClick={() => setRecommendationsOpen((open) => !open)}
        >
          <span>추천 단어</span>
          <small>{recommendations.length.toLocaleString()}개</small>
          <ChevronDown className={recommendationsOpen ? "is-open" : ""} size={18} />
        </button>
        {recommendationsOpen && (
          <div className="recommendation-list">
            {recommendations.slice(0, 12).map((item, index) => (
              <article className="word-card" key={item.word}>
                <div className="word-card-meta">
                  <span>{index + 1}</span>
                  <small>{item.score.toFixed(2)}</small>
                </div>
                <MiniWord word={item.word} states={getCandidateEvidence(item.word, grid)} />
              </article>
            ))}
            {recommendations.length === 0 && <p className="empty-message">일치하는 단어가 없습니다.</p>}
          </div>
        )}
      </section>
    </section>
  );
}

function MiniWord({
  word,
  states,
}: {
  word: string;
  states: ReturnType<typeof getCandidateEvidence>;
}) {
  return (
    <div className="mini-word" aria-label={word.toUpperCase()}>
      {[...word.toUpperCase()].map((letter, index) => (
        <span className={`mini-tile tile-${states[index]}`} key={`${letter}-${index}`}>
          {letter}
        </span>
      ))}
    </div>
  );
}
