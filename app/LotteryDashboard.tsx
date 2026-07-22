"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FALLBACK_DRAWS,
  GAME_META,
  WAVE_LABEL,
  buildAnalysis,
  formatBall,
  getWave,
  getZodiac,
  nextScheduledDraw,
  type Analysis,
  type Draw,
  type GameId,
  type Wave,
} from "../lib/lottery";

type ApiPayload = {
  game: GameId;
  draws: Draw[];
  live: boolean;
  degraded: boolean;
  message: string;
  fetchedAt: string;
};

type AiNarrative = {
  headline: string;
  overview: string;
  observations: string[];
  counterpoint: string;
};

const FOCUS_OPTIONS = ["综合", "号码", "生肖", "波色", "遗漏", "形态"] as const;

export function LotteryDashboard() {
  const [draws, setDraws] = useState<Record<GameId, Draw[]>>(FALLBACK_DRAWS);
  const [status, setStatus] = useState<Record<GameId, ApiPayload | null>>({ hk: null, macau: null });
  const [selectedGame, setSelectedGame] = useState<GameId>("hk");
  const [windowSize, setWindowSize] = useState(30);
  const [focus, setFocus] = useState<(typeof FOCUS_OPTIONS)[number]>("综合");
  const [now, setNow] = useState(() => new Date());
  const [demo, setDemo] = useState(false);
  const [demoSeconds, setDemoSeconds] = useState(3);
  const [revealed, setRevealed] = useState(0);
  const [realRevealed, setRealRevealed] = useState(0);
  const [aiNarrative, setAiNarrative] = useState<AiNarrative | null>(null);
  const [aiMode, setAiMode] = useState<"idle" | "loading" | "ai" | "statistical">("idle");

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled(
      (["hk", "macau"] as GameId[]).map(async (game) => {
        const response = await fetch(`/api/lottery?game=${game}&limit=100`, { cache: "no-store" });
        if (!response.ok) throw new Error(`lottery ${response.status}`);
        return (await response.json()) as ApiPayload;
      }),
    );
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const game: GameId = index === 0 ? "hk" : "macau";
      if (result.value.draws?.length) {
        setDraws((current) => ({ ...current, [game]: result.value.draws }));
      }
      setStatus((current) => ({ ...current, [game]: result.value }));
    });
  }, []);

  useEffect(() => {
    refresh();
    const clock = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(clock);
  }, [refresh]);

  const liveWindow = useMemo(() => getLiveWindow(selectedGame, now), [selectedGame, now]);

  useEffect(() => {
    if (!liveWindow.visible) return;
    const poll = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(poll);
  }, [liveWindow.visible, refresh]);

  useEffect(() => {
    if (!demo) return;
    let cancelled = false;
    const waits: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const id = window.setTimeout(resolve, ms);
        waits.push(id);
      });
    async function play() {
      setRevealed(0);
      for (let second = 3; second >= 1; second -= 1) {
        if (cancelled) return;
        setDemoSeconds(second);
        await wait(720);
      }
      setDemoSeconds(0);
      for (let index = 1; index <= 7; index += 1) {
        if (cancelled) return;
        setRevealed(index);
        await wait(620);
      }
    }
    play();
    return () => {
      cancelled = true;
      waits.forEach(window.clearTimeout);
    };
  }, [demo]);

  const scopedDraws = useMemo(
    () => draws[selectedGame].slice(0, Math.min(windowSize, draws[selectedGame].length)),
    [draws, selectedGame, windowSize],
  );
  const analysis = useMemo(() => buildAnalysis(scopedDraws), [scopedDraws]);
  const latest = draws[selectedGame][0];
  const targetTime = liveWindow.target.getTime();
  const isCurrentResult =
    liveWindow.visible &&
    liveWindow.delta <= 0 &&
    Math.abs(new Date(latest.drawAt).getTime() - targetTime) < 4 * 3_600_000;

  useEffect(() => {
    if (!isCurrentResult) {
      if (liveWindow.delta > 0) setRealRevealed(0);
      return;
    }
    setRealRevealed(0);
    let count = 0;
    const interval = window.setInterval(() => {
      count += 1;
      setRealRevealed(count);
      if (count >= 7) window.clearInterval(interval);
    }, 620);
    return () => window.clearInterval(interval);
  }, [isCurrentResult, latest.issue, liveWindow.delta > 0, targetTime]);

  useEffect(() => {
    setAiNarrative(null);
    setAiMode("idle");
  }, [selectedGame, windowSize, focus]);

  const requestAi = useCallback(async () => {
    setAiMode("loading");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ game: selectedGame, draws: scopedDraws, focus }),
      });
      const payload = (await response.json()) as {
        mode?: "ai" | "statistical";
        narrative?: AiNarrative;
      };
      if (payload.narrative) setAiNarrative(payload.narrative);
      setAiMode(payload.mode === "ai" ? "ai" : "statistical");
    } catch {
      setAiMode("statistical");
    }
  }, [focus, scopedDraws, selectedGame]);

  const liveDraw = latest;
  const stageVisible = demo || liveWindow.visible;
  const stageReveal = demo ? revealed : realRevealed;

  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="六合智研首页">
          <span className="brand-mark">六</span>
          <span>
            <strong>六合智研</strong>
            <small>MARK SIX INTELLIGENCE</small>
          </span>
        </a>
        <nav className="topnav" aria-label="主导航">
          <a href="#draws">今日开奖</a>
          <a href="#analysis">多维分析</a>
          <a href="#lab">AI 实验室</a>
          <a href="#history">历史记录</a>
        </nav>
        <div className="time-block" aria-live="polite">
          <span>北京时间</span>
          <strong>{formatBeijingTime(now)}</strong>
        </div>
      </header>

      <main id="top">
        <section className="hero" id="draws">
          <div className="hero-copy">
            <div className="eyebrow"><span className="signal-dot" /> LIVE DATA · AI RESEARCH</div>
            <h1>让每一期数据<br />都有可解释的结论</h1>
            <p>港澳开奖实时校验，结合号码、生肖、波色、遗漏、形态与滚动回测，形成清晰而克制的 AI 研究报告。</p>
            <div className="hero-actions">
              <a className="primary-action" href="#lab">进入 AI 实验室 <span>→</span></a>
              <button className="ghost-action" type="button" onClick={() => { setDemo(false); window.setTimeout(() => setDemo(true), 0); }}>
                预览开奖动效
              </button>
            </div>
          </div>
          <div className="next-draw-panel">
            <div className="panel-kicker">NEXT DRAW</div>
            <div className="next-row">
              <span>{GAME_META[selectedGame].name}</span>
              <span className="verified-label">{status[selectedGame]?.live ? "数据源在线" : "样本模式"}</span>
            </div>
            <strong className="next-time">{formatCountdown(Math.max(liveWindow.delta, 0))}</strong>
            <div className="next-meta">
              <span>{formatBeijingDate(liveWindow.target)}</span>
              <span>开奖前 3 分钟自动开启开奖台</span>
            </div>
            <div className="schedule-switch" role="group" aria-label="选择彩种">
              {(["hk", "macau"] as GameId[]).map((game) => (
                <button
                  type="button"
                  className={selectedGame === game ? "active" : ""}
                  onClick={() => setSelectedGame(game)}
                  key={game}
                >
                  {GAME_META[game].shortName}
                </button>
              ))}
            </div>
          </div>
        </section>

        {stageVisible && (
          <LiveStage
            game={selectedGame}
            draw={liveDraw}
            countdown={demo ? demoSeconds * 1_000 : Math.max(liveWindow.delta, 0)}
            revealed={stageReveal}
            demo={demo}
            waiting={!demo && liveWindow.delta <= 0 && stageReveal === 0}
            onClose={() => setDemo(false)}
          />
        )}

        <section className="draw-grid" aria-label="最新开奖结果">
          {(["hk", "macau"] as GameId[]).map((game) => (
            <DrawCard
              key={game}
              game={game}
              draw={draws[game][0]}
              selected={selectedGame === game}
              onSelect={() => setSelectedGame(game)}
              message={status[game]?.message}
            />
          ))}
        </section>

        <section className="section-block" id="analysis">
          <SectionHeading
            eyebrow="SYSTEM STATISTICS"
            title="多维统计，不止冷热"
            description="所有指标都由当前选择的历史窗口即时计算；切换彩种或窗口，图表与 AI 上下文同步更新。"
          />
          <AnalysisToolbar
            game={selectedGame}
            windowSize={windowSize}
            available={draws[selectedGame].length}
            onGame={setSelectedGame}
            onWindow={setWindowSize}
          />
          <div className="analysis-grid">
            <NumberHeatmap analysis={analysis} />
            <StructurePanel analysis={analysis} />
            <ZodiacPanel analysis={analysis} />
          </div>
        </section>

        <section className="ai-lab section-block" id="lab">
          <div className="ai-intro">
            <SectionHeading
              eyebrow="AI MODEL LENS"
              title="六维研判实验室"
              description="先由统计引擎计算，再交给 AI 解释；候选组合始终附带样本、结构和反方观点。"
            />
            <div className="focus-tabs" role="tablist" aria-label="AI 分析维度">
              {FOCUS_OPTIONS.map((item) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={focus === item}
                  className={focus === item ? "active" : ""}
                  onClick={() => setFocus(item)}
                  key={item}
                >
                  {item}
                </button>
              ))}
            </div>
            <button className="primary-action ai-button" type="button" onClick={requestAi} disabled={aiMode === "loading"}>
              {aiMode === "loading" ? "正在形成研判…" : "生成本窗口 AI 深度报告"}
            </button>
            <p className="microcopy">AI 只解释已计算的数据，不会把随机波动包装成确定规律。</p>
          </div>
          <AiReport analysis={analysis} narrative={aiNarrative} mode={aiMode} focus={focus} game={selectedGame} />
        </section>

        <section className="strategy-section section-block">
          <SectionHeading
            eyebrow="WALK-FORWARD VIEW"
            title="三路候选策略"
            description="同一批数据用三种权重观察，避免单一算法只放大某一类历史特征。"
          />
          <div className="strategy-grid">
            {analysis.candidates.map((candidate, index) => (
              <article className="strategy-card" key={candidate.id}>
                <div className="strategy-topline">
                  <span>0{index + 1}</span>
                  <span>结构分 {candidate.score}</span>
                </div>
                <h3>{candidate.name}</h3>
                <p>{candidate.description}</p>
                <BallRow numbers={candidate.numbers} special={candidate.special} compact />
                <div className="strategy-tags">
                  <span>{candidate.numbers.filter((number) => number % 2).length} 奇</span>
                  <span>{candidate.numbers.filter((number) => number >= 25).length} 大</span>
                  <span>{new Set(candidate.numbers.map(getZodiac)).size} 肖</span>
                </div>
              </article>
            ))}
          </div>
          <div className="responsible-note">
            <span>!</span>
            <p><strong>理性提示</strong>　候选组合来自历史统计演示。彩票结果具有随机性，过去数据无法保证未来结果，本网站不提供投注或收益承诺。</p>
          </div>
        </section>

        <section className="history-section section-block" id="history">
          <SectionHeading
            eyebrow="DRAW ARCHIVE"
            title="历史开奖记录"
            description={`当前展示 ${GAME_META[selectedGame].name} 最近 ${Math.min(draws[selectedGame].length, 10)} 期，北京时间口径。`}
          />
          <HistoryTable draws={draws[selectedGame].slice(0, 10)} />
        </section>
      </main>

      <footer>
        <div className="footer-brand">六合智研 <span>MARK SIX INTELLIGENCE</span></div>
        <p>数据研究与娱乐参考工具 · 不销售彩票 · 不构成投注建议</p>
        <div className="footer-links"><a href="#analysis">方法说明</a><a href="#history">数据来源</a><a href="#top">返回顶部 ↑</a></div>
      </footer>
    </div>
  );
}

function LiveStage({
  game,
  draw,
  countdown,
  revealed,
  demo,
  waiting,
  onClose,
}: {
  game: GameId;
  draw: Draw;
  countdown: number;
  revealed: number;
  demo: boolean;
  waiting: boolean;
  onClose: () => void;
}) {
  const all = [...draw.numbers, draw.special];
  return (
    <section className="live-stage" aria-live="polite">
      <div className="live-stage-head">
        <div><span className="live-pill"><span /> {demo ? "动效预演" : "LIVE"}</span><strong>{GAME_META[game].name} · 开奖台</strong></div>
        {demo && <button type="button" onClick={onClose} aria-label="关闭开奖动效">关闭</button>}
      </div>
      <div className="stage-countdown">
        <small>{countdown > 0 ? "距离开奖" : waiting ? "正在等待数据源确认" : "本期号码依次揭晓"}</small>
        <strong>{formatCountdown(countdown)}</strong>
      </div>
      <div className="stage-balls" aria-label="开奖号码">
        {all.map((number, index) => (
          <div className="stage-ball-wrap" key={`${number}-${index}`}>
            {index === 6 && <span className="plus">+</span>}
            <span className={`ball stage-ball ${revealed > index ? `wave-${getWave(number)} revealed` : "pending"}`}>
              {revealed > index ? formatBall(number) : String(index + 1).padStart(2, "0")}
            </span>
            <small>{revealed > index ? `${getZodiac(number)} · ${WAVE_LABEL[getWave(number)]}` : index === 6 ? "特码" : "待开"}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function DrawCard({ game, draw, selected, onSelect, message }: { game: GameId; draw: Draw; selected: boolean; onSelect: () => void; message?: string }) {
  return (
    <article className={`draw-card ${selected ? "selected" : ""}`}>
      <div className="draw-card-head">
        <div><span>{GAME_META[game].shortName.toUpperCase()}</span><h2>{GAME_META[game].name}</h2></div>
        <button type="button" onClick={onSelect}>{selected ? "分析中" : "切换分析"}</button>
      </div>
      <div className="issue-line">第 <strong>{draw.issue}</strong> 期 <span>{formatDrawDate(draw.drawAt)}</span></div>
      <BallRow numbers={draw.numbers} special={draw.special} />
      <div className="draw-card-foot">
        <span className={draw.verified ? "verified" : "single-source"}><i /> {draw.verified ? "双源已核验" : "单源待复核"}</span>
        <span>特码 {formatBall(draw.special)} · {getZodiac(draw.special)} · {WAVE_LABEL[getWave(draw.special)]}</span>
      </div>
      <p className="source-message">{message ?? GAME_META[game].sourceLabel}</p>
    </article>
  );
}

function BallRow({ numbers, special, compact = false }: { numbers: number[]; special: number; compact?: boolean }) {
  return (
    <div className={`ball-row ${compact ? "compact" : ""}`}>
      {numbers.map((number, index) => <Ball number={number} key={`${number}-${index}`} />)}
      <span className="ball-plus">+</span>
      <Ball number={special} special />
    </div>
  );
}

function Ball({ number, special = false }: { number: number; special?: boolean }) {
  return <span className={`ball wave-${getWave(number)} ${special ? "special" : ""}`} title={`${formatBall(number)} ${getZodiac(number)} ${WAVE_LABEL[getWave(number)]}`}>{formatBall(number)}</span>;
}

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="section-heading"><span>{eyebrow}</span><div><h2>{title}</h2><p>{description}</p></div></div>;
}

function AnalysisToolbar({ game, windowSize, available, onGame, onWindow }: { game: GameId; windowSize: number; available: number; onGame: (game: GameId) => void; onWindow: (size: number) => void }) {
  return (
    <div className="analysis-toolbar">
      <div className="segmented" role="group" aria-label="彩种">
        {(["hk", "macau"] as GameId[]).map((item) => <button type="button" className={game === item ? "active" : ""} onClick={() => onGame(item)} key={item}>{GAME_META[item].shortName}</button>)}
      </div>
      <div className="window-controls"><span>统计窗口</span>{[10, 30, 50, 100].map((size) => <button type="button" disabled={available < size && size !== 10} className={windowSize === size ? "active" : ""} onClick={() => onWindow(size)} key={size}>近 {size} 期</button>)}</div>
      <span className="sample-count">有效样本 {Math.min(windowSize, available)} 期</span>
    </div>
  );
}

function NumberHeatmap({ analysis }: { analysis: Analysis }) {
  const max = Math.max(...analysis.hot.map((item) => item.frequency), 1);
  const scoreMap = new Map([...analysis.hot, ...analysis.cold, ...analysis.overdue].map((item) => [item.number, item]));
  return (
    <article className="data-panel heatmap-panel">
      <div className="data-panel-head"><div><span>NUMBER FIELD</span><h3>号码热力与遗漏</h3></div><div className="legend"><i className="hot" />频率高 <i className="cold" />遗漏长</div></div>
      <div className="number-grid">
        {Array.from({ length: 49 }, (_, index) => {
          const number = index + 1;
          const info = scoreMap.get(number);
          const hot = analysis.hot.some((item) => item.number === number);
          const overdue = analysis.overdue.some((item) => item.number === number);
          return <div className={`number-cell ${hot ? "hot" : ""} ${overdue ? "overdue" : ""}`} style={{ "--heat": `${Math.max((info?.frequency ?? 0) / max, 0.08)}` } as React.CSSProperties} key={number}><strong>{formatBall(number)}</strong><small>{info ? `${info.frequency}次 · 遗${info.omission}` : "—"}</small></div>;
        })}
      </div>
    </article>
  );
}

function StructurePanel({ analysis }: { analysis: Analysis }) {
  const waveTotal = analysis.waves.red + analysis.waves.blue + analysis.waves.green;
  return (
    <article className="data-panel structure-panel">
      <div className="data-panel-head"><div><span>STRUCTURE</span><h3>波色与形态结构</h3></div></div>
      <div className="wave-bars">
        {(Object.keys(analysis.waves) as Wave[]).map((wave) => <div className="wave-bar" key={wave}><div><span><i className={`wave-${wave}`} />{WAVE_LABEL[wave]}</span><strong>{percent(analysis.waves[wave], waveTotal)}</strong></div><div className="bar-track"><span className={`wave-${wave}`} style={{ width: percent(analysis.waves[wave], waveTotal) }} /></div></div>)}
      </div>
      <div className="metric-grid">
        <Metric label="奇偶比" value={`${analysis.odd}:${analysis.even}`} hint="全号码" />
        <Metric label="大小比" value={`${analysis.big}:${analysis.small}`} hint="25–49 为大" />
        <Metric label="重号率" value={`${analysis.repeatRate}%`} hint="相邻两期" />
        <Metric label="连号率" value={`${analysis.consecutiveRate}%`} hint="每期正码" />
        <Metric label="平均和值" value={String(analysis.averageSum)} hint="含特码" />
        <Metric label="三区分布" value={analysis.zones.join("·")} hint="低 / 中 / 高" />
      </div>
    </article>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

function ZodiacPanel({ analysis }: { analysis: Analysis }) {
  const max = Math.max(...analysis.zodiacs.map((item) => item.count), 1);
  return (
    <article className="data-panel zodiac-panel">
      <div className="data-panel-head"><div><span>ZODIAC MATRIX · 2026 马年</span><h3>生肖热度排行</h3></div></div>
      <div className="zodiac-list">
        {analysis.zodiacs.map((item, index) => <div className="zodiac-row" key={item.name}><span className={index < 3 ? "ranked" : ""}>{item.name}</span><div><i style={{ width: `${(item.count / max) * 100}%` }} /></div><strong>{item.count}</strong></div>)}
      </div>
      <p className="panel-note">生肖映射按 2026 丙午马年口径；跨年数据会在正式历史层按开奖年份换算。</p>
    </article>
  );
}

function AiReport({ analysis, narrative, mode, focus, game }: { analysis: Analysis; narrative: AiNarrative | null; mode: "idle" | "loading" | "ai" | "statistical"; focus: string; game: GameId }) {
  const report = narrative ?? {
    headline: `${GAME_META[game].shortName} · ${focus}预研摘要`,
    overview: analysis.summary[0],
    observations: analysis.summary,
    counterpoint: "点击生成报告后，系统会基于当前窗口给出完整证据链和反方观点。",
  };
  return (
    <article className="ai-report">
      <div className="ai-report-head"><div className="ai-orb">AI</div><div><span>{mode === "ai" ? "大模型增强" : "统计引擎在线"}</span><h3>{report.headline}</h3></div><small>{analysis.sampleSize} 期样本</small></div>
      <p className="ai-overview">{report.overview}</p>
      <ol>{report.observations.map((item, index) => <li key={`${item}-${index}`}><span>0{index + 1}</span><p>{item}</p></li>)}</ol>
      <div className="counterpoint"><span>反方校验</span><p>{report.counterpoint}</p></div>
      <div className="report-meta"><span>GROUNDING · 结构化数据</span><span>NO GUARANTEE · 不承诺命中</span></div>
    </article>
  );
}

function HistoryTable({ draws }: { draws: Draw[] }) {
  return (
    <div className="history-table-wrap">
      <table className="history-table">
        <thead><tr><th>彩种 / 期号</th><th>开奖时间（北京）</th><th>开奖号码</th><th>结构摘要</th><th>状态</th></tr></thead>
        <tbody>{draws.map((draw) => {
          const all = [...draw.numbers, draw.special];
          return <tr key={`${draw.game}-${draw.issue}`}><td><strong>{GAME_META[draw.game].shortName}</strong> {draw.issue}</td><td>{formatDrawDate(draw.drawAt)}</td><td><BallRow numbers={draw.numbers} special={draw.special} compact /></td><td>{all.filter((number) => number % 2).length}奇 · {new Set(all.map(getZodiac)).size}肖 · 和值{all.reduce((a, b) => a + b, 0)}</td><td><span className={draw.verified ? "verified" : "single-source"}><i />{draw.verified ? "已核验" : "待复核"}</span></td></tr>;
        })}</tbody>
      </table>
    </div>
  );
}

function getLiveWindow(game: GameId, now: Date) {
  const reference = new Date(now.getTime() - 10 * 60_000);
  const target = nextScheduledDraw(game, reference);
  const delta = target.getTime() - now.getTime();
  return { target, delta, visible: delta <= 3 * 60_000 && delta >= -10 * 60_000 };
}

function formatBeijingTime(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function formatBeijingDate(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatDrawDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatCountdown(ms: number) {
  const total = Math.max(Math.ceil(ms / 1_000), 0);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function percent(value: number, total: number) {
  return `${Math.round((value / Math.max(total, 1)) * 1000) / 10}%`;
}
