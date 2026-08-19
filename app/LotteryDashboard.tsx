"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AI_FOCUS_OPTIONS,
  type AiAnalysisResponse,
  type AiBacktestStrategy,
  type AiConfidenceInterval,
  type AiDimensionId,
  type AiFocus,
  type AiObservationId,
  type AiPrimaryZodiacObservation,
  type AiScenario,
  type AiScenarioObservation,
} from "../lib/ai-types";
import type { OnlineLearningProfile } from "../lib/ai-online-learning";
import type {
  ResearchRuleEvidence,
  ResearchSnapshot,
} from "../lib/research-v2-types";
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
  type LiveDrawProgress,
  type Wave,
} from "../lib/lottery";
import { mergeDrawLists } from "../lib/draw-merge";

type ApiPayload = {
  game: GameId;
  draws: Draw[];
  live: boolean;
  degraded: boolean;
  message: string;
  fetchedAt: string;
  progress?: LiveDrawProgress | null;
};

type ScientificBacktestStrategy = AiBacktestStrategy;
type AiMode =
  | "idle"
  | "restoring"
  | "loading"
  | "ai"
  | "statistical"
  | "error";

type ScientificReport = AiAnalysisResponse & {
  decision?: {
    kind: "abstain" | "observe";
    scenarioId: AiScenario["id"] | null;
    label: string;
    reasons: string[];
  };
  ledger?: {
    state: "locked" | "existing" | "skipped" | "unavailable";
    forecastId: string | null;
    immutable: boolean;
    lockedAt: string | null;
    settledAt: string | null;
    reason:
      | "pre_draw_lock"
      | "already_locked"
      | "after_cutoff"
      | "target_unconfirmed"
      | "quality_gate_failed"
      | "generation_degraded"
      | "database_unavailable";
    summary: {
      totalForecasts: number;
      settledForecasts: number;
      trackedForecasts: number;
      observedForecasts: number;
      evaluatedObservedForecasts: number;
      totalMainOverlap: number;
      averageMainOverlap: number | null;
      specialExactHits: number;
      zodiacObservedForecasts: number;
      zodiacEvaluatedForecasts: number;
      zodiacCoverageHits: number;
      zodiacCoverageRate: number | null;
    } | null;
  } | null;
  learning?: OnlineLearningProfile;
  learningReview?: {
    currentLearning: OnlineLearningProfile;
    appliesTo: "next_report";
    settledTargetIssue: string;
    reviewedAt: string;
    notice: string;
  };
};

const LIVE_POLL_MS = 3_000;
const BACKGROUND_POLL_MS = 60_000;
const VISIBLE_GAME_IDS: readonly GameId[] = ["new_macau", "hk"];

export function LotteryDashboard({ initialNow }: { initialNow: string }) {
  const [draws, setDraws] = useState<Record<GameId, Draw[]>>(FALLBACK_DRAWS);
  const [status, setStatus] = useState<Record<GameId, ApiPayload | null>>({
    hk: null,
    macau: null,
    new_macau: null,
  });
  const [liveProgress, setLiveProgress] = useState<Record<GameId, LiveDrawProgress | null>>({
    hk: null,
    macau: null,
    new_macau: null,
  });
  const [selectedGame, setSelectedGame] = useState<GameId>("new_macau");
  const [windowSize, setWindowSize] = useState(30);
  const [historyVisible, setHistoryVisible] = useState(20);
  const [now, setNow] = useState(() => new Date(initialNow));
  const [demo, setDemo] = useState(false);
  const [demoSeconds, setDemoSeconds] = useState(3);
  const [revealed, setRevealed] = useState(0);
  const [realReveal, setRealReveal] = useState({ key: "", count: 0 });
  const [activeSection, setActiveSection] = useState("draws");
  const drawGridRef = useRef<HTMLElement | null>(null);
  const refreshInFlightRef = useRef(new Set<string>());
  const drawsRef = useRef(draws);

  useEffect(() => {
    drawsRef.current = draws;
  }, [draws]);

  const chooseGame = useCallback((game: GameId) => {
    setSelectedGame(game);
    setHistoryVisible(20);
  }, []);

  const chooseWindow = useCallback((size: number) => {
    setWindowSize(size);
  }, []);

  const refresh = useCallback(async (
    games: readonly GameId[] = VISIBLE_GAME_IDS,
    options: { limit?: number; fresh?: boolean } = {},
  ) => {
    const { limit = 100, fresh = false } = options;
    await Promise.allSettled(
      games.map(async (game) => {
        const requestKey = `${game}:${fresh ? "fresh" : "regular"}`;
        if (refreshInFlightRef.current.has(requestKey)) return;
        refreshInFlightRef.current.add(requestKey);
        try {
          const params = new URLSearchParams({ game, limit: String(limit) });
          if (fresh) params.set("live", "1");
          const response = await fetch(`/api/lottery?${params}`, { cache: "no-store" });
          if (!response.ok) throw new Error(`lottery ${response.status}`);
          const payload = (await response.json()) as ApiPayload;
          if (payload.draws?.length) {
            setDraws((current) => ({
              ...current,
              [game]: mergeDrawLists(current[game], payload.draws),
            }));
          }
          setLiveProgress((current) => ({
            ...current,
            [game]: mergeLiveProgress(
              current[game],
              payload.progress ?? null,
              [...(payload.draws ?? []), ...drawsRef.current[game]],
            ),
          }));
          setStatus((current) => ({ ...current, [game]: payload }));
        } finally {
          refreshInFlightRef.current.delete(requestKey);
        }
      }),
    );
  }, []);

  useEffect(() => {
    void refresh();
    const clock = window.setInterval(() => setNow(new Date()), 1_000);
    const backgroundPoll = window.setInterval(
      () => void refresh(VISIBLE_GAME_IDS, { limit: 10 }),
      BACKGROUND_POLL_MS,
    );
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") {
        void refresh(VISIBLE_GAME_IDS, { limit: 5, fresh: true });
      }
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(backgroundPoll);
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [refresh]);

  const liveWindow = useMemo(() => getLiveWindow(selectedGame, now), [selectedGame, now]);
  const liveGameKey = VISIBLE_GAME_IDS
    .filter((game) => getLiveWindow(game, now).visible)
    .join(",");

  useEffect(() => {
    if (!liveGameKey) return;
    const liveGames = liveGameKey.split(",") as GameId[];
    void refresh(liveGames, { limit: 5, fresh: true });
    const poll = window.setInterval(
      () => void refresh(liveGames, { limit: 5, fresh: true }),
      LIVE_POLL_MS,
    );
    return () => window.clearInterval(poll);
  }, [liveGameKey, refresh]);

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
        await wait(480);
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
  const realRevealKey = `${selectedGame}:${latest.issue}:${targetTime}`;

  useEffect(() => {
    if (!isCurrentResult) return;
    let count = 0;
    const interval = window.setInterval(() => {
      count += 1;
      setRealReveal({ key: realRevealKey, count });
      if (count >= 7) window.clearInterval(interval);
    }, 480);
    return () => window.clearInterval(interval);
  }, [isCurrentResult, realRevealKey]);

  useEffect(() => {
    drawGridRef.current?.scrollTo({ left: 0, behavior: "smooth" });
  }, [selectedGame]);

  useEffect(() => {
    const sections = ["draws", "analysis", "history"];
    let frame = 0;
    const syncActiveSection = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const marker = window.innerHeight * 0.28;
        let current = sections[0];
        for (const id of sections) {
          const section = document.getElementById(id);
          if (!section || section.getBoundingClientRect().top > marker) break;
          current = id;
        }
        setActiveSection(current);
      });
    };
    syncActiveSection();
    window.addEventListener("scroll", syncActiveSection, { passive: true });
    window.addEventListener("hashchange", syncActiveSection);
    window.addEventListener("resize", syncActiveSection);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", syncActiveSection);
      window.removeEventListener("hashchange", syncActiveSection);
      window.removeEventListener("resize", syncActiveSection);
    };
  }, []);

  const liveDraw = latest;
  const progressForGame = liveProgress[selectedGame];
  const selectedProgress =
    progressForGame &&
    Math.abs(new Date(progressForGame.drawAt).getTime() - targetTime) < 4 * 3_600_000
      ? progressForGame
      : null;
  const stageVisible = demo || liveWindow.visible;
  const stageReveal = demo ? revealed : realReveal.key === realRevealKey ? realReveal.count : 0;
  const orderedGames = [
    selectedGame,
    ...VISIBLE_GAME_IDS.filter((game) => game !== selectedGame),
  ];

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
          <a href="/research">高概率策略</a>
          <a href="/learning">逐期学习中心</a>
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
            <div className="eyebrow"><span className="signal-dot" /> LIVE DATA · EVENT RESEARCH</div>
            <h1>让每一期数据<br />都有可解释的结论</h1>
            <p>香港与新澳门双彩开奖数据实时校验，集中研究6+1生肖、尾数、指定位置单双与大小，并在每期开奖后自动复盘学习。</p>
            <div className="hero-actions">
              <a className="primary-action" href="/research">进入高概率策略 <span>→</span></a>
              <a className="ghost-action" href="/learning">逐期学习中心</a>
              <a className="ghost-action" href="/patterns">近30期条件规律</a>
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
              {VISIBLE_GAME_IDS.map((game) => (
                <button
                  type="button"
                  className={selectedGame === game ? "active" : ""}
                  onClick={() => chooseGame(game)}
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
            waiting={
              !demo &&
              liveWindow.delta <= 0 &&
              stageReveal === 0 &&
              !selectedProgress?.numbers.length
            }
            progress={selectedProgress}
            fetchedAt={status[selectedGame]?.fetchedAt}
            onClose={() => setDemo(false)}
          />
        )}

        <div className="draw-strip-head" aria-hidden="true">
          <strong>最新开奖</strong>
          <span>左右滑动查看其他彩种 →</span>
        </div>
        <section ref={drawGridRef} className="draw-grid" aria-label="最新开奖结果">
          {orderedGames.map((game) => (
            <DrawCard
              key={game}
              game={game}
              draw={draws[game][0]}
              selected={selectedGame === game}
              onSelect={() => chooseGame(game)}
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
            onGame={chooseGame}
            onWindow={chooseWindow}
          />
          <div className="analysis-grid">
            <NumberHeatmap
              analysis={analysis}
              drawAt={liveWindow.target.toISOString()}
            />
            <StructurePanel analysis={analysis} />
            <ZodiacPanel analysis={analysis} />
          </div>
        </section>

        <section className="history-section section-block" id="history">
          <SectionHeading
            eyebrow="DRAW ARCHIVE"
            title="历史开奖记录"
            description={`已载入 ${GAME_META[selectedGame].name} ${draws[selectedGame].length} 期，当前显示最近 ${Math.min(draws[selectedGame].length, historyVisible)} 期，北京时间口径。`}
          />
          <HistoryTable draws={draws[selectedGame].slice(0, historyVisible)} />
          {historyVisible < draws[selectedGame].length && (
            <button
              className="history-more"
              type="button"
              onClick={() => setHistoryVisible((current) => Math.min(current + 20, draws[selectedGame].length))}
            >
              再加载 {Math.min(20, draws[selectedGame].length - historyVisible)} 期
              <span>{historyVisible} / {draws[selectedGame].length}</span>
            </button>
          )}
        </section>
      </main>

      <footer>
        <div className="footer-brand">六合智研 <span>MARK SIX INTELLIGENCE</span></div>
        <p>第三方数据研究工具 · 非官方彩票服务 · 不销售彩票 · 不构成投注建议</p>
        <div className="footer-links"><a href="/research">高概率策略</a><a href="/learning">逐期学习中心</a><a href="/patterns">近30期条件规律</a><a href="#history">数据来源</a><a href="#top">返回顶部 ↑</a></div>
      </footer>
      <nav className="mobile-nav" aria-label="手机端快捷导航">
        <a onClick={() => setActiveSection("draws")} className={activeSection === "draws" ? "active" : ""} aria-current={activeSection === "draws" ? "page" : undefined} href="#draws"><span>01</span>开奖</a>
        <a onClick={() => setActiveSection("analysis")} className={activeSection === "analysis" ? "active" : ""} aria-current={activeSection === "analysis" ? "page" : undefined} href="#analysis"><span>02</span>统计</a>
        <a href="/research"><span>03</span>策略</a>
        <a onClick={() => setActiveSection("history")} className={activeSection === "history" ? "active" : ""} aria-current={activeSection === "history" ? "page" : undefined} href="#history"><span>04</span>历史</a>
      </nav>
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
  progress,
  fetchedAt,
  onClose,
}: {
  game: GameId;
  draw: Draw;
  countdown: number;
  revealed: number;
  demo: boolean;
  waiting: boolean;
  progress: LiveDrawProgress | null;
  fetchedAt?: string;
  onClose: () => void;
}) {
  const drawAt = progress?.drawAt ?? draw.drawAt;
  const stageIssue = progress?.issue ?? draw.issue;
  const slots: Array<number | null> = progress
    ? [
        ...progress.numbers.slice(0, 6),
        ...Array.from({ length: Math.max(6 - progress.numbers.length, 0) }, () => null),
        progress.special,
      ]
    : [...draw.numbers, draw.special];
  const specialReady = progress ? progress.special !== null : revealed >= slots.length;
  return (
    <section className="live-stage" aria-label="实时开奖台">
      <div className="live-stage-head">
        <div><span className="live-pill"><span /> {demo ? "动效预演" : "LIVE"}</span><strong>{GAME_META[game].name} · 开奖台</strong></div>
        {demo && <button type="button" onClick={onClose} aria-label="关闭开奖动效">关闭</button>}
      </div>
      <div className="stage-countdown">
        <small aria-live="polite">
          {countdown > 0
            ? "距离开奖 · 自动刷新已开启"
            : waiting
              ? "自动更新中 · 等待数据源发布本期完整结果"
              : specialReady
                ? "特码已开出，请慢慢刮开涂层"
                : "本期号码依次揭晓"}
        </small>
        <strong>{formatCountdown(countdown)}</strong>
        {!demo && (
          <span className="live-stage-sync">
            高频检测每 3 秒 · 最近响应 {fetchedAt ? formatSyncTime(fetchedAt) : "正在连接"}
          </span>
        )}
      </div>
      <div className="stage-balls" aria-label="开奖号码">
        {slots.map((number, index) => {
          const isSpecial = index === 6;
          const isRevealed = progress ? number !== null : revealed > index;
          return (
          <div className={`stage-ball-wrap ${isSpecial ? "special-stage-wrap" : ""}`} key={`${number ?? "pending"}-${index}`}>
            {index === 6 && <span className="plus">+</span>}
            {isSpecial && isRevealed && number !== null ? (
              <ScratchSpecialBall
                key={`${game}:${stageIssue}:${number}:${demo ? "demo" : "live"}`}
                number={number}
                drawAt={drawAt}
                resetKey={`${game}:${stageIssue}:${number}:${demo ? "demo" : "live"}`}
              />
            ) : (
              <>
                <span className={`ball stage-ball ${isRevealed && number !== null ? `wave-${getWave(number)} revealed` : "pending"}`}>
                  {isRevealed && number !== null ? formatBall(number) : String(index + 1).padStart(2, "0")}
                </span>
                <small>
                  {isRevealed && number !== null ? (
                <>
                  <strong className="stage-zodiac">{getZodiac(number, drawAt)}</strong>
                  <span>{WAVE_LABEL[getWave(number)]}</span>
                </>
                  ) : isSpecial ? "特码" : "待开"}
                </small>
              </>
            )}
          </div>
          );
        })}
      </div>
    </section>
  );
}

function ScratchSpecialBall({
  number,
  drawAt,
  resetKey,
}: {
  number: number;
  drawAt: string;
  resetKey: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scratchingRef = useRef(false);
  const completeRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const moveCountRef = useRef(0);
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const zodiac = getZodiac(number, drawAt);
  const wave = WAVE_LABEL[getWave(number)];

  const revealAll = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    canvas?.blur();
    setProgress(100);
    setComplete(true);
    completeRef.current = true;
    scratchingRef.current = false;
    activePointerIdRef.current = null;
    lastPointRef.current = null;
  }, []);

  const measureProgress = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context || canvas.width === 0 || canvas.height === 0) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = 0;
    let sampled = 0;
    for (let index = 3; index < pixels.length; index += 16) {
      sampled += 1;
      if (pixels[index] < 64) transparent += 1;
    }
    const next = Math.round((transparent / Math.max(sampled, 1)) * 100);
    setProgress(next);
    if (next >= 62) revealAll();
    return next;
  }, [revealAll]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    let initialized = false;
    const paintCoating = () => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(Math.round(bounds.width * ratio), 1);
      canvas.height = Math.max(Math.round(bounds.height * ratio), 1);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (completeRef.current && initialized) {
        context.clearRect(0, 0, bounds.width, bounds.height);
        setReady(true);
        return;
      }
      setReady(false);
      const gradient = context.createLinearGradient(0, 0, bounds.width, bounds.height);
      gradient.addColorStop(0, "#d9d3c7");
      gradient.addColorStop(0.42, "#8d9293");
      gradient.addColorStop(0.7, "#d6d0c3");
      gradient.addColorStop(1, "#777d7e");
      context.globalCompositeOperation = "source-over";
      context.fillStyle = gradient;
      context.fillRect(0, 0, bounds.width, bounds.height);
      context.fillStyle = "rgba(255,255,255,0.22)";
      for (let x = 7; x < bounds.width; x += 12) {
        for (let y = 8; y < bounds.height; y += 13) {
          context.beginPath();
          context.arc(x, y, 1.2, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.fillStyle = "#2d3434";
      context.font = `800 ${Math.max(Math.min(bounds.width * 0.1, 18), 11)}px sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("慢慢刮开", bounds.width / 2, bounds.height / 2);
      completeRef.current = false;
      setComplete(false);
      setProgress(0);
      scratchingRef.current = false;
      activePointerIdRef.current = null;
      lastPointRef.current = null;
      moveCountRef.current = 0;
      initialized = true;
      setReady(true);
    };
    const schedulePaint = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(paintCoating);
    };
    schedulePaint();
    const resizeObserver = new ResizeObserver(schedulePaint);
    resizeObserver.observe(canvas);
    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [number, resetKey]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
  };

  const eraseTo = (point: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    const previous = lastPointRef.current ?? point;
    const bounds = canvas.getBoundingClientRect();
    context.globalCompositeOperation = "destination-out";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(bounds.width * 0.24, 13);
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    context.beginPath();
    context.arc(point.x, point.y, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    lastPointRef.current = point;
  };

  const startScratch = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (complete || !ready || activePointerIdRef.current !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    scratchingRef.current = true;
    activePointerIdRef.current = event.pointerId;
    const point = pointFromEvent(event);
    lastPointRef.current = point;
    eraseTo(point);
  };

  const continueScratch = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (
      !scratchingRef.current ||
      activePointerIdRef.current !== event.pointerId ||
      complete
    ) {
      return;
    }
    event.preventDefault();
    eraseTo(pointFromEvent(event));
    moveCountRef.current += 1;
    if (moveCountRef.current % 5 === 0) measureProgress();
  };

  const stopScratch = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (
      !scratchingRef.current ||
      activePointerIdRef.current !== event.pointerId
    ) {
      return;
    }
    scratchingRef.current = false;
    activePointerIdRef.current = null;
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    measureProgress();
  };

  const cancelScratch = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (
      activePointerIdRef.current !== null &&
      activePointerIdRef.current !== event.pointerId
    ) {
      return;
    }
    scratchingRef.current = false;
    activePointerIdRef.current = null;
    lastPointRef.current = null;
  };

  return (
    <>
      <div className={`scratch-ticket ${ready ? "ready" : ""} ${complete ? "complete" : ""}`}>
        <div className={`scratch-reward ${ready ? "ready" : ""}`} aria-hidden={!complete}>
          <span className={`ball stage-ball wave-${getWave(number)} revealed`}>
            {formatBall(number)}
          </span>
          <small>
            <strong className="stage-zodiac">{zodiac}</strong>
            <span>{wave}</span>
          </small>
        </div>
        <canvas
          ref={canvasRef}
          className={`scratch-canvas ${ready ? "ready" : ""} ${complete ? "complete" : ""}`}
          role="button"
          tabIndex={complete ? -1 : 0}
          aria-label={
            complete
              ? `特码 ${formatBall(number)}，${zodiac}，${wave}`
              : "特码已开奖，使用手指或鼠标慢慢刮开；按回车键可直接揭晓"
          }
          onPointerDown={startScratch}
          onPointerMove={continueScratch}
          onPointerUp={stopScratch}
          onPointerCancel={cancelScratch}
          onLostPointerCapture={cancelScratch}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              revealAll();
            }
          }}
        />
      </div>
      <small className="scratch-status">
        {complete ? "特码已揭晓" : progress > 0 ? `已刮开 ${progress}%` : "慢慢刮开"}
      </small>
      <span className="scratch-announcement" role="status">
        {complete ? "特码已揭晓" : ready ? "特码已开出，可以开始刮开" : ""}
      </span>
    </>
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
      <BallRow numbers={draw.numbers} special={draw.special} drawAt={draw.drawAt} />
      <div className="draw-card-foot">
        <span className={draw.verified ? "verified" : "single-source"}><i /> {draw.verified ? "双源结果一致" : "第三方单源"}</span>
        <span>特码 {formatBall(draw.special)} · {getZodiac(draw.special, draw.drawAt)} · {WAVE_LABEL[getWave(draw.special)]}</span>
      </div>
      <p className="source-message">{message ?? GAME_META[game].sourceLabel}</p>
    </article>
  );
}

function BallRow({ numbers, special, compact = false, drawAt }: { numbers: number[]; special: number; compact?: boolean; drawAt: string }) {
  return (
    <div className={`ball-row ${compact ? "compact" : ""}`}>
      {numbers.map((number, index) => <Ball number={number} drawAt={drawAt} key={`${number}-${index}`} />)}
      <span className="ball-plus">+</span>
      <Ball number={special} special drawAt={drawAt} />
    </div>
  );
}

function Ball({ number, special = false, drawAt }: { number: number; special?: boolean; drawAt: string }) {
  const zodiac = getZodiac(number, drawAt);
  return (
    <span
      className={`ball-item ${special ? "special-item" : ""}`}
      aria-label={`${special ? "特码" : "号码"} ${formatBall(number)}，${zodiac}，${WAVE_LABEL[getWave(number)]}`}
    >
      <span className={`ball wave-${getWave(number)} ${special ? "special" : ""}`}>
        {formatBall(number)}
      </span>
      <span className="ball-zodiac">{zodiac}</span>
    </span>
  );
}

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="section-heading"><span>{eyebrow}</span><div><h2>{title}</h2><p>{description}</p></div></div>;
}

const RESEARCH_TARGET_TABS = [
  { id: "draw.6_plus_1.zodiac", label: "6+1 生肖" },
  { id: "special.zodiac", label: "特码生肖" },
  { id: "special.number", label: "特码号码" },
  { id: "main.position.3.zodiac", label: "第3正码" },
  { id: "special.wave", label: "特码波色" },
  { id: "special.tail", label: "特码尾数" },
] as const;

function ResearchV2Lab({
  snapshot,
  loading,
}: {
  snapshot: ResearchSnapshot | null;
  loading: boolean;
}) {
  const [targetId, setTargetId] = useState<string>("draw.6_plus_1.zodiac");
  const [layer, setLayer] = useState<"formal" | "experimental">("formal");
  if (!snapshot) {
    return (
      <section className="research-v2 research-v2-loading" aria-live="polite">
        <span className="panel-kicker">RESEARCH V2 · SHADOW RUN</span>
        <h3>{loading ? "正在恢复冻结研究快照…" : "研究快照暂不可用"}</h3>
        <p>开奖、历史与已保存 AI 报告不受影响；研究任务恢复后会自动显示同一期结果。</p>
      </section>
    );
  }
  const target =
    snapshot.targetForecasts.find((item) => item.targetId === targetId) ??
    snapshot.targetForecasts[0];
  const probabilities =
    layer === "formal"
      ? target?.formalProbabilities ?? []
      : target?.experimentalProbabilities ?? [];
  const ranked = [...probabilities].sort(
    (left, right) =>
      right.probability - left.probability ||
      left.value.localeCompare(right.value, "zh-CN", { numeric: true }),
  );
  const allRules = [
    ...snapshot.verifiedRules,
    ...snapshot.experimentalRules,
    ...snapshot.negativeRules,
  ];
  const activeRules = new Set(target?.activeRuleIds ?? []);
  const positiveRules = allRules.filter(
    (rule) =>
      rule.direction === "positive" &&
      (activeRules.has(rule.ruleId) || rule.targetId === target?.targetId),
  );
  const strongestPositive =
    positiveRules.find((rule) => activeRules.has(rule.ruleId)) ??
    positiveRules[0] ??
    null;
  const strongestNegative =
    snapshot.negativeRules.find((rule) => activeRules.has(rule.ruleId)) ??
    snapshot.negativeRules.find((rule) => rule.targetId === target?.targetId) ??
    null;
  return (
    <section className="research-v2" aria-label="v2 双轨概率研究">
      <div className="research-v2-head">
        <div>
          <span className="panel-kicker">RESEARCH V2 · IMMUTABLE SHADOW</span>
          <h3>冻结概率与规律挑战场</h3>
          <p>目标期 {snapshot.targetIssue} · 运行 {snapshot.runId.slice(0, 12)} · 数据版本 {snapshot.dataQuality.datasetVersion.slice(0, 12)}</p>
        </div>
        <span className={`research-tier ${snapshot.evidenceTier}`}>
          {snapshot.evidenceTier === "verified" ? "已验证" : "影子研究"}
        </span>
      </div>

      <div className="research-layer-switch" role="group" aria-label="选择正式层或实验层">
        <button type="button" className={layer === "formal" ? "active" : ""} onClick={() => setLayer("formal")}>
          正式预测
          <small>仅已验证证据</small>
        </button>
        <button type="button" className={layer === "experimental" ? "active" : ""} onClick={() => setLayer("experimental")}>
          研究实验室
          <small>候选规律，不进入正式概率</small>
        </button>
      </div>

      <div className="research-target-tabs" role="group" aria-label="选择研究目标">
        {RESEARCH_TARGET_TABS.map((item) => (
          <button
            type="button"
            className={target?.targetId === item.id ? "active" : ""}
            onClick={() => setTargetId(item.id)}
            key={item.id}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="research-probability-panel">
        <div className="research-target-summary">
          <span>{layer === "formal" ? "正式冻结分布" : "实验挑战分布"}</span>
          <h4>{target?.label}</h4>
          <p>{target?.conclusion}</p>
        </div>
        <div className="research-top3">
          {ranked.slice(0, 3).map((item, index) => (
            <article key={item.value}>
              <span>TOP {index + 1}</span>
              <strong>{item.label}</strong>
              <em>{formatResearchPercent(item.probability)}</em>
              <small>
                基线 {formatResearchPercent(item.baseline)}
                {item.deltaPrevious === 0
                  ? " · 持平"
                  : ` · 较上期 ${item.deltaPrevious > 0 ? "+" : ""}${formatResearchPercent(item.deltaPrevious)}`}
              </small>
            </article>
          ))}
        </div>
        <div className="research-distribution">
          {ranked.slice(0, target?.family === "number" ? 10 : ranked.length).map((item) => (
            <div key={item.value}>
              <span>{item.label}</span>
              <i><b style={{ width: `${Math.min(item.probability * 100, 100)}%` }} /></i>
              <strong>{formatResearchPercent(item.probability)}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="research-funnel">
        <div><span>生成候选</span><strong>{snapshot.generatedRuleCount.toLocaleString("zh-CN")}</strong></div>
        <div><span>完整回测</span><strong>{snapshot.fullBacktestRuleCount.toLocaleString("zh-CN")}</strong></div>
        <div><span>已淘汰资源</span><strong>{formatResearchPercent(snapshot.resourceReductionRate)}</strong></div>
        <div><span>正式样本</span><strong>{snapshot.dataQuality.formalSampleSize}</strong></div>
      </div>

      <div className="research-evidence-grid">
        <ResearchRuleCard title="最强正向候选" rule={strongestPositive} tone="positive" />
        <ResearchRuleCard title="最强负向 / 降权证据" rule={strongestNegative} tone="negative" />
      </div>

      <div className="research-model-grid">
        {snapshot.modelComparison.map((model) => (
          <article key={model.id}>
            <div><span>{model.role === "baseline" ? "基线" : model.role === "challenger" ? "挑战者" : "可解释轨"}</span><em>{model.status === "active" ? "运行中" : model.status === "shadow" ? "影子" : "样本不足"}</em></div>
            <strong>{model.label}</strong>
            <p>{model.note}</p>
            <small>{model.window ? `${model.window} 期窗口` : "全历史"} · 样本 {model.sampleSize}</small>
          </article>
        ))}
      </div>

      <div className="research-postmortem">
        <span className="panel-kicker">PREVIOUS DELTA · POSTMORTEM</span>
        <h4>{snapshot.previousForecastDelta.summary}</h4>
        <p>{snapshot.postmortem?.summary ?? "尚无可结算的上一期冻结研究预测；本期结果会在核验后自动评分。"}</p>
        <small>{snapshot.postmortem?.nextAction ?? snapshot.notice}</small>
      </div>
    </section>
  );
}

function ResearchRuleCard({
  title,
  rule,
  tone,
}: {
  title: string;
  rule: ResearchRuleEvidence | null;
  tone: "positive" | "negative";
}) {
  return (
    <article className={`research-rule-card ${tone}`}>
      <span>{title}</span>
      {rule ? (
        <>
          <h4>{rule.description}</h4>
          <div className="research-rule-signal">
            <span>
              {rule.currentTriggerMatched
                ? tone === "negative"
                  ? "本期降权对象"
                  : "本期策略结果"
                : "本期状态"}
            </span>
            <strong>
              {rule.currentPrediction
                ? rule.spec.target.family === "number"
                  ? formatBall(Number(rule.currentPrediction))
                  : rule.currentPrediction
                : "未触发"}
            </strong>
            <em>
              {rule.currentTriggerMatched
                ? tone === "negative"
                  ? "该方向只降低权重，不等同于排除必不开。"
                  : "前置条件已匹配，已计入实验层概率。"
                : "前置条件与最新一期不匹配，本期不参与计算。"}
            </em>
          </div>
          <div>
            <small>触发 <strong>{rule.support}</strong></small>
            <small>命中 <strong>{formatResearchPercent(rule.hitRate)}</strong></small>
            <small>基线 <strong>{formatResearchPercent(rule.baselineRate)}</strong></small>
            <small>q 值 <strong>{rule.qValue.toFixed(3)}</strong></small>
          </div>
          <p>{rule.direction === "negative" ? "只进入排除与降权池，不会反向包装成正向推荐。" : "仍须独立前瞻验证，当前只影响实验层。"}</p>
        </>
      ) : (
        <p>当前目标没有满足筛选且适用于本期的规则，因此没有策略结果，不会拿其他目标的规律充数。</p>
      )}
    </article>
  );
}

function formatResearchPercent(value: number) {
  const scaled = value * 100;
  return `${Math.abs(scaled) >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}%`;
}

function AnalysisToolbar({ game, windowSize, available, onGame, onWindow }: { game: GameId; windowSize: number; available: number; onGame: (game: GameId) => void; onWindow: (size: number) => void }) {
  return (
    <div className="analysis-toolbar">
      <div className="segmented" role="group" aria-label="彩种">
        {VISIBLE_GAME_IDS.map((item) => <button type="button" className={game === item ? "active" : ""} onClick={() => onGame(item)} key={item}>{GAME_META[item].shortName}</button>)}
      </div>
      <div className="window-controls"><span>统计窗口</span>{[10, 30, 50, 100].map((size) => <button type="button" disabled={available < size && size !== 10} className={windowSize === size ? "active" : ""} onClick={() => onWindow(size)} key={size}>近 {size} 期</button>)}</div>
      <span className="sample-count">有效样本 {Math.min(windowSize, available)} 期</span>
    </div>
  );
}

function NumberHeatmap({
  analysis,
  drawAt,
}: {
  analysis: Analysis;
  drawAt: string;
}) {
  const max = Math.max(...analysis.hot.map((item) => item.frequency), 1);
  const scoreMap = new Map([...analysis.hot, ...analysis.cold, ...analysis.overdue].map((item) => [item.number, item]));
  return (
    <article className="data-panel heatmap-panel">
      <div className="data-panel-head">
        <div><span>NUMBER FIELD</span><h3>号码热力与遗漏</h3></div>
        <div className="legend" aria-label="热力图图例">
          <span><i className="hot" />频率高</span>
          <span><i className="cold" />遗漏长</span>
          <span className="wave-legend">
            <b><i className="wave-red" />红波</b>
            <b><i className="wave-blue" />蓝波</b>
            <b><i className="wave-green" />绿波</b>
          </span>
        </div>
      </div>
      <div className="number-grid">
        {Array.from({ length: 49 }, (_, index) => {
          const number = index + 1;
          const info = scoreMap.get(number);
          const hot = analysis.hot.some((item) => item.number === number);
          const overdue = analysis.overdue.some((item) => item.number === number);
          const wave = getWave(number);
          const zodiac = getZodiac(number, drawAt);
          const detail = info ? `${info.frequency}次，遗漏${info.omission}期` : "暂无统计";
          return <div className={`number-cell number-wave-${wave} ${hot ? "hot" : ""} ${overdue ? "overdue" : ""}`} style={{ "--heat": `${Math.max((info?.frequency ?? 0) / max, 0.08)}` } as React.CSSProperties} title={`${formatBall(number)} · ${WAVE_LABEL[wave]} · ${zodiac}`} aria-label={`${formatBall(number)}，${WAVE_LABEL[wave]}，${zodiac}，${detail}`} key={number}><strong>{formatBall(number)}</strong><span>{zodiac}</span><small>{info ? <><span>{info.frequency}次</span><span>遗漏{info.omission}</span></> : "—"}</small></div>;
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
      <div className="data-panel-head"><div><span>ZODIAC MATRIX · 按期开奖年份</span><h3>生肖热度排行</h3></div></div>
      <div className="zodiac-list">
        {analysis.zodiacs.map((item, index) => <div className="zodiac-row" key={item.name}><span className={index < 3 ? "ranked" : ""}>{item.name}</span><div><i style={{ width: `${(item.count / max) * 100}%` }} /></div><strong>{item.count}</strong></div>)}
      </div>
      <p className="panel-note">生肖映射按开奖日期换算，并在农历新年边界自动切换对应生肖年。</p>
    </article>
  );
}

function AiContextBar({
  game,
  latest,
  target,
  windowSize,
  report,
}: {
  game: GameId;
  latest: Draw;
  target: Date;
  windowSize: number;
  report: AiAnalysisResponse | null;
}) {
  const displayedTarget = report
    ? new Date(report.target.expectedDrawAt)
    : target;
  return (
    <div className="ai-context-bar" aria-label="本次分析上下文">
      <div><span>分析彩种</span><strong>{GAME_META[game].shortName}</strong></div>
      <div><span>目标期号</span><strong>{report?.target.issue ?? `下一期`}</strong></div>
      <div><span>历史窗口</span><strong>{report?.dataQuality.requestedWindow ?? windowSize} 期</strong></div>
      <div><span>最新数据</span><strong>{latest.issue}</strong></div>
      <div><span>预计开奖</span><strong>{formatBeijingDate(displayedTarget)}</strong></div>
    </div>
  );
}

function AiReport({
  analysis,
  report,
  mode,
  focus,
  game,
  error,
}: {
  analysis: Analysis;
  report: AiAnalysisResponse | null;
  mode: AiMode;
  focus: AiFocus;
  game: GameId;
  error: string;
}) {
  const focusLabel = AI_FOCUS_OPTIONS.find((item) => item.id === focus)?.label ?? "综合";
  if (!report) {
    return (
      <article className={`ai-report ai-report-${mode}`}>
        <div className="ai-report-head">
          <div className="ai-orb">{mode === "loading" || mode === "restoring" ? "···" : "AI"}</div>
          <div>
            <span>
              {mode === "restoring"
                ? "SAVED REPORT"
                : mode === "loading"
                  ? "EVIDENCE SYNTHESIS"
                  : mode === "error"
                    ? "SERVICE NOTICE"
                    : "READY"}
            </span>
            <h3>
              {mode === "restoring"
                ? "正在读取已保存的本期报告"
                : mode === "loading"
                  ? "正在建立跨维度证据链"
                : mode === "error"
                  ? "本次报告未能生成"
                  : `${GAME_META[game].shortName} · ${focusLabel}预测工作台`}
            </h3>
          </div>
          <small>{analysis.sampleSize} 期样本</small>
        </div>
        {mode === "loading" || mode === "restoring" ? (
          <div className="ai-processing">
            <span /><span /><span />
            <p>
              {mode === "restoring"
                ? "优先从永久记录中恢复；只有本期尚无报告时才会重新生成。"
                : "统计计算、回测和大模型归纳都在服务端完成，通常需要数秒。"}
            </p>
          </div>
        ) : mode === "error" ? (
          <div className="ai-empty-state error">
            <strong>{error || "分析服务暂时不可用。"}</strong>
            <p>请稍后重试；现有统计图表与三路本地场景仍可正常使用。</p>
          </div>
        ) : (
          <div className="ai-empty-state">
            <strong>一键生成完整预测研究包</strong>
            <p>先给出一个可结算的 6+1 生肖方向，再展开尾数、波色、单双与大小观察；是否高于随机由独立留出回测另行标注。</p>
            <div className="empty-signal-grid">
              <span>6+1 生肖观察</span><span>多维观察</span><span>独立结算</span><span>强总结</span>
            </div>
          </div>
        )}
        <div className="report-meta"><span>SERVER-SIDE · 密钥不下发</span><span>NO GUARANTEE · 不承诺命中</span></div>
      </article>
    );
  }

  const scientificReport = report as ScientificReport;
  const displayedLearning =
    scientificReport.learningReview?.currentLearning ??
    scientificReport.learning;
  const observesByDecision =
    scientificReport.decision
      ? scientificReport.decision.kind === "observe"
      : report.backtest.decision === "recommend";
  const observedScenarioId =
    observesByDecision
      ? scientificReport.decision?.scenarioId ??
        report.backtest.selectedStrategyId ??
        report.synthesis.recommendedScenarioId
      : null;
  const recommended = observedScenarioId
    ? report.candidateSets.find((scenario) => scenario.id === observedScenarioId)
    : null;
  const selectedBacktest = report.backtest.selectedStrategyId
    ? report.backtest.strategies.find(
      (strategy) => strategy.id === report.backtest.selectedStrategyId,
    )
    : null;
  const observationScenarioId =
    report.zodiacObservation?.scenarioId ??
    report.backtest.selectedStrategyId ??
    report.synthesis.recommendedScenarioId ??
    report.candidateSets[0]?.id;
  const observationScenario = report.candidateSets.find(
    (scenario) => scenario.id === observationScenarioId,
  ) ?? report.candidateSets[0] ?? null;
  const scenarioZodiacObservation = observationScenario?.observations.find(
    (observation) => observation.id === "zodiac_coverage",
  );
  const zodiacDirection =
    report.zodiacObservation?.zodiac ?? scenarioZodiacObservation?.pick ?? null;
  const zodiacBacktest =
    report.zodiacObservation?.backtest ?? scenarioZodiacObservation?.backtest ?? null;
  const zodiacTarget =
    report.zodiacObservation?.target ??
    scenarioZodiacObservation?.target ??
    "当期 6+1 至少出现 1 个该生肖";
  const zodiacBaseline =
    report.zodiacObservation?.baselineRate ??
    scenarioZodiacObservation?.baselineRate ??
    null;
  const observesAdvantage =
    report.backtest.status === "observed_advantage" &&
    observesByDecision &&
    Boolean(recommended && selectedBacktest);
  const scientificConclusion = observesAdvantage ? "已观察到统计优势" : "结构观察 · 未证实优势";
  const verdictDetail = scientificReport.decision
    ? [
      scientificReport.decision.kind === "observe"
        ? scientificReport.decision.label
        : "未证实高于随机",
      ...scientificReport.decision.reasons,
    ]
      .filter(Boolean)
      .join("；")
    : report.backtest.conclusion;
  return (
    <article className="ai-report ai-report-complete">
      <div className="ai-report-head">
        <div className="ai-orb">AI</div>
        <div>
          <span>{mode === "ai" ? `${report.model.name} 证据归纳` : "本地证据引擎降级"}</span>
          <h3>{report.synthesis.headline}</h3>
        </div>
        <small>
          {scientificReport.ledger?.settledAt
            ? "已结算复盘"
            : report.cached
              ? "已恢复存档"
              : `${report.model.latencyMs / 1000}s`}
        </small>
      </div>
      {zodiacDirection && zodiacBacktest && zodiacBaseline !== null && (
        <PrimaryZodiacObservation
          zodiac={zodiacDirection}
          target={zodiacTarget}
          baselineRate={zodiacBaseline}
          backtest={zodiacBacktest}
          conclusion={report.zodiacObservation?.conclusion ?? report.backtest.conclusion}
          configuration={report.zodiacObservation?.configuration}
        />
      )}
      {observationScenario?.observations.length ? (
        <ObservationDeck
          scenarioName={observationScenario.name}
          observations={observationScenario.observations}
        />
      ) : null}
      <ObservationConsensus scenarios={report.candidateSets} />
      {displayedLearning && (
        <OnlineLearningPanel
          profile={displayedLearning}
          learningAtLock={scientificReport.learning}
          isPostDrawReview={Boolean(scientificReport.learningReview)}
          reviewNotice={scientificReport.learningReview?.notice}
        />
      )}
      <div className={`scientific-verdict ${observesAdvantage ? "observe" : "abstain"}`} role="status">
        <span>统计校准状态</span>
        <strong>{scientificConclusion}</strong>
        <p>{verdictDetail}</p>
      </div>
      <div className="evidence-strength">
        <div>
          <span>结构证据强度 · 非概率</span>
          <strong>{report.evidenceStrength.label} · {report.evidenceStrength.score}</strong>
        </div>
        <div className="evidence-meter"><i style={{ width: `${report.evidenceStrength.score}%` }} /></div>
        <small>不能替代独立留出结论</small>
      </div>
      {observesAdvantage && recommended ? (
        <div className="ai-recommendation">
          <span>独立留出后 · 观察优先场景</span>
          <div><strong>{recommended.name}</strong><em>校准分 {recommended.evidenceScore} · 非中奖概率</em></div>
          <div className="ai-recommendation-balls">
            <BallRow
              numbers={recommended.numbers}
              special={recommended.special}
              compact
              drawAt={report.target.expectedDrawAt}
            />
          </div>
          <p>{report.synthesis.recommendationReason}</p>
        </div>
      ) : (
        <div className="ai-abstain-panel">
          <strong>本期仍提供可结算观察方向</strong>
          <p>当前独立留出结果未证明高于随机；观察方向照常展示，且会在开奖后按预先定义的口径复核。</p>
        </div>
      )}
      <ScientificCalibration
        report={scientificReport}
        strategy={selectedBacktest ?? report.backtest.holdout.strategies[0] ?? null}
      />
      <p className="ai-overview">{report.synthesis.executiveSummary}</p>
      <div className="signal-columns">
        <div>
          <span>最强信号</span>
          <ul>{report.synthesis.strongestSignals.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
        <div>
          <span>冲突信号</span>
          <ul>{report.synthesis.conflictingSignals.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      </div>
      <div className="counterpoint">
        <span>不确定性</span>
        <p>{report.synthesis.uncertainty}</p>
      </div>
      <p className="ai-notice">{report.notice}</p>
      <div className="report-meta">
        <span>{report.model.name} · {report.model.reasoning.toUpperCase()}</span>
        <span>{formatGeneratedTime(report.generatedAt)} · 数据 {report.dataQuality.fingerprint}</span>
      </div>
    </article>
  );
}

function PrimaryZodiacObservation({
  zodiac,
  target,
  baselineRate,
  backtest,
  conclusion,
  configuration,
}: {
  zodiac: string;
  target: string;
  baselineRate: number;
  backtest: AiScenarioObservation["backtest"];
  conclusion: string;
  configuration?: AiPrimaryZodiacObservation["configuration"];
}) {
  return (
    <section className="primary-zodiac-observation" aria-label={`AI 6+1 生肖观察：${zodiac}`}>
      <div className="primary-zodiac-heading">
        <div>
          <span>PRIMARY VIEW · 6+1 ZODIAC</span>
          <strong>本期生肖观察</strong>
        </div>
        <em className={`observation-status ${backtest.status}`}>
          {observationStatusLabel(backtest.status)}
        </em>
      </div>
      <div className="primary-zodiac-core">
        <strong aria-label={`生肖 ${zodiac}`}>{zodiac}</strong>
        <div>
          <span>目标口径</span>
          <p>{target.replace("该生肖", zodiac)}</p>
        </div>
      </div>
      {configuration && (
        <div className="primary-zodiac-lock">
          <strong>固定综合 {configuration.trainWindow} 期 · 主方向口径固定</strong>
          <span>切换页面分析维度或统计窗口，不会改变本期主生肖方向。</span>
        </div>
      )}
      <div className="primary-zodiac-metrics">
        <span>
          独立留出
          <strong>{backtest.hitCount}/{backtest.sampleSize}</strong>
          <small>{formatStatistic(backtest.hitRate)}%</small>
        </span>
        <span>
          留出平均基准
          <strong>{formatStatistic(backtest.baselineRate)}%</strong>
          <small>各测试期精确基准</small>
        </span>
        <span>
          留出与基准差
          <strong>{backtest.lift > 0 ? "+" : ""}{formatStatistic(backtest.lift)}%</strong>
          <small>不是中奖概率</small>
        </span>
        <span>
          本期理论基准
          <strong>{formatStatistic(baselineRate)}%</strong>
          <small>按本期生肖号码数计算</small>
        </span>
      </div>
      <p>{conclusion}</p>
    </section>
  );
}

function ObservationDeck({
  scenarioName,
  observations,
}: {
  scenarioName: string;
  observations: AiScenarioObservation[];
}) {
  return (
    <section className="observation-deck" aria-label={`${scenarioName}多维 6+1 观察`}>
      <div className="observation-deck-head">
        <div>
          <span>MULTI-VIEW OBSERVATIONS</span>
          <strong>{scenarioName} · 多维观察</strong>
        </div>
        <small>左右滑动查看</small>
      </div>
      <div className="observation-scroll">
        {observations.map((observation) => (
          <article
            className={`observation-card ${observation.id === "zodiac_coverage" ? "primary" : ""}`}
            key={observation.id}
          >
            <span>{observation.label}</span>
            <strong>{observation.pick}</strong>
            <p>{observation.target}</p>
            <div>
              <span>留出 {observation.backtest.hitCount}/{observation.backtest.sampleSize}</span>
              <span>基准 {formatStatistic(observation.baselineRate)}%</span>
            </div>
            <em className={`observation-status ${observation.backtest.status}`}>
              {observationStatusLabel(observation.backtest.status)}
            </em>
          </article>
        ))}
      </div>
      <p className="observation-settlement-note">
        每项观察均按预先定义的口径独立结算；不可只挑命中项展示，也不能把多个方向合并成“总命中率”。
      </p>
    </section>
  );
}

function ObservationConsensus({ scenarios }: { scenarios: AiScenario[] }) {
  const consensus = observationConsensus(scenarios);
  if (!consensus.length) return null;
  return (
    <section className="observation-consensus" aria-label="三路策略观察共识">
      <div>
        <span>STRATEGY CONSENSUS</span>
        <strong>三路策略共识</strong>
      </div>
      <div className="consensus-scroll">
        {consensus.map((item) => (
          <span className={item.count >= 2 ? "aligned" : "split"} key={item.id}>
            <small>{item.label}</small>
            <strong>{item.count >= 2 ? item.pick : "方向分歧"}</strong>
            <em>{item.count >= 2 ? `${item.count}/3 同向` : "无多数"}</em>
          </span>
        ))}
      </div>
      <p>共识只表示三种权重得到相同方向，不代表概率叠加或独立证据。</p>
    </section>
  );
}

function OnlineLearningPanel({
  profile,
  learningAtLock,
  isPostDrawReview,
  reviewNotice,
}: {
  profile: OnlineLearningProfile;
  learningAtLock?: OnlineLearningProfile;
  isPostDrawReview: boolean;
  reviewNotice?: string;
}) {
  const scenarioLabels: Record<AiScenario["id"], string> = {
    balanced: "冷热平衡",
    momentum: "趋势延续",
    contrarian: "逆向遗漏",
  };
  const progress = Math.min(
    (profile.sampleSize / Math.max(profile.minimumSamples, 1)) * 100,
    100,
  );
  const review = profile.lastReview;
  const reviewHits =
    review?.observations.filter((observation) => observation.hit).length ?? 0;
  const sourceUnavailable = profile.sourceStatus === "unavailable";
  return (
    <section className="online-learning-panel" aria-label="开奖后机器学习复盘">
      <div className="online-learning-head">
        <div>
          <span>VERIFIED ONLINE LEARNING</span>
          <strong>
            {isPostDrawReview
              ? "本期开奖复盘 · 下期校准"
              : "本期采用 · 在线校准"}
          </strong>
        </div>
        <em className={sourceUnavailable ? "unavailable" : profile.active ? "active" : "collecting"}>
          {sourceUnavailable
            ? "学习库暂不可用"
            : profile.active
            ? profile.applied
              ? "已启用调权"
              : "已启用 · 保持中性"
            : `${profile.sampleSize}/${profile.minimumSamples} 积累中`}
        </em>
      </div>
      <p className="online-learning-audit">
        {isPostDrawReview
          ? (
            reviewNotice ??
            (
              learningAtLock
                ? `本期冻结报告生成时使用 ${learningAtLock.sampleSize} 个独立样本；下方为开奖后的新状态，只从下一份报告开始参与判断。`
                : "本期冻结报告生成于在线学习启用前；下方为开奖后的新状态，只从下一份报告开始参与判断。"
            )
          )
          : learningAtLock
            ? `本报告已冻结使用 ${learningAtLock.sampleSize} 个独立样本；后续开奖结果不会倒改本期方向。`
            : "这是上线前冻结的旧版报告，未使用在线学习；后续开奖结果不会倒改本期方向。"}
      </p>
      <p className="online-learning-summary">{profile.conclusion}</p>
      {sourceUnavailable ? (
        <div className="online-learning-unavailable" role="status">
          <strong>本期未使用在线调权</strong>
          <span>已自动保持中性权重；历史统计与冻结报告仍可正常查看，学习库恢复后再继续积累。</span>
        </div>
      ) : (
        <>
          <div
            className="online-learning-progress"
            aria-label={`已积累 ${profile.sampleSize} 个独立目标期，启用门槛 ${profile.minimumSamples} 期`}
          >
            <span><i style={{ width: `${progress}%` }} /></span>
            <small>
              已核验并去重 {profile.sampleSize} 期 · 启用门槛 {profile.minimumSamples} 期
            </small>
          </div>
          <div className="online-learning-weights" aria-label="三路策略在线权重">
            {(["balanced", "momentum", "contrarian"] as const).map((scenarioId) => {
              const weight = profile.scenarioWeights[scenarioId];
              return (
                <div
                  className={
                    profile.preferredScenarioId === scenarioId && profile.applied
                      ? "preferred"
                      : ""
                  }
                  key={scenarioId}
                >
                  <span>{scenarioLabels[scenarioId]}</span>
                  <strong>×{weight.weight.toFixed(3)}</strong>
                  <small>
                    {weight.sampleSize} 期 · {learningWeightLabel(weight.status)}
                  </small>
                </div>
              );
            })}
          </div>
          {review ? (
            <div className="online-learning-review">
              <div className="online-learning-review-head">
                <div>
                  <span>LATEST SETTLED REVIEW</span>
                  <strong>第 {review.issue} 期复盘</strong>
                </div>
                <em>{reviewHits}/{review.observations.length} 项命中</em>
              </div>
              {review.actual.length === 7 && (
                <BallRow
                  numbers={review.actual.slice(0, 6)}
                  special={review.actual[6]}
                  compact
                  drawAt={review.actualDrawAt}
                />
              )}
              <div className="online-learning-review-items">
                {review.observations.map((observation) => (
                  <span className={observation.hit ? "hit" : "miss"} key={observation.id}>
                    <small>{observation.label}</small>
                    <strong>{observation.pick}</strong>
                    <em>{observation.hit ? "命中" : "未中"}</em>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="online-learning-empty">
              尚无可复盘的已核验预测；分析页面取得已核验结果后会进入学习记录。
            </p>
          )}
        </>
      )}
      <p className="online-learning-boundary">
        只学习已有的开奖前冻结报告，并按期号去重；在线权重只做保守的小幅旁路调整，尚未纳入嵌套历史回测，不能继承或替代正式的独立留出优势结论。
      </p>
    </section>
  );
}

function learningWeightLabel(
  status: OnlineLearningProfile["scenarioWeights"][AiScenario["id"]]["status"],
) {
  if (status === "upweighted") return "小幅上调";
  if (status === "downweighted") return "小幅下调";
  if (status === "inactive_small_sample") return "暂不调权";
  return "保持中性";
}

function observationConsensus(scenarios: AiScenario[]) {
  const ids: AiObservationId[] = [
    "zodiac_coverage",
    "tail_coverage",
    "wave_threshold",
    "parity_majority",
    "size_majority",
  ];
  return ids.flatMap((id) => {
    const observations = scenarios
      .map((scenario) => scenario.observations.find((item) => item.id === id))
      .filter((item): item is AiScenarioObservation => Boolean(item));
    if (!observations.length) return [];
    const counts = new Map<string, number>();
    observations.forEach((observation) => {
      counts.set(observation.pick, (counts.get(observation.pick) ?? 0) + 1);
    });
    const [pick, count] = [...counts.entries()]
      .sort(([leftPick, leftCount], [rightPick, rightCount]) =>
        rightCount - leftCount || leftPick.localeCompare(rightPick, "zh-Hans-CN")
      )[0];
    return [{ id, label: observations[0].label, pick, count }];
  });
}

function observationStatusLabel(status: AiScenarioObservation["backtest"]["status"]) {
  if (status === "observed_above_random") return "留出观察高于随机";
  if (status === "insufficient") return "样本不足";
  return "未证实高于随机";
}

function ScientificCalibration({
  report,
  strategy,
}: {
  report: ScientificReport;
  strategy: ScientificBacktestStrategy | null;
}) {
  const generatedBeforeDraw =
    new Date(report.generatedAt).getTime() < new Date(report.target.expectedDrawAt).getTime();
  const ledgerStatus = ledgerStatusLabel(report.ledger, generatedBeforeDraw);
  const statusLabel =
    report.backtest.status === "observed_advantage"
      ? "独立留出观察到优势"
      : report.backtest.status === "insufficient"
        ? "样本不足 · 仅作结构观察"
        : "未区别于精确随机基准";
  const zodiacCalibration = strategy?.observations.find(
    (observation) => observation.id === "zodiac_coverage",
  );
  return (
    <section className="scientific-calibration" aria-label="候选科学校准">
      <div className="calibration-head">
        <div>
          <span>SCIENTIFIC CALIBRATION</span>
          <strong>嵌套走步 · 独立留出验证</strong>
        </div>
        <em className={`calibration-status ${report.backtest.status}`}>{statusLabel}</em>
      </div>
      <p className="calibration-method">
        主生肖方向固定采用综合 {report.zodiacObservation.configuration.trainWindow} 期，并对预声明的 {report.backtest.multipleComparisonCount} 组配置做保守校正；选择段用于挑选策略，独立留出段只做最终评估。扩展五维观察合计校正 {report.backtest.observationComparisonCount} 次比较（α≤{report.backtest.observationValidationAlpha}），每个测试期仅使用此前数据，避免挑选偶然最好看的结果。
      </p>
      <div className="calibration-samples">
        <span>选择段 <strong>{report.backtest.selectionCount} 期</strong><small>{formatIssueRange(report.backtest.selection.startIssue, report.backtest.selection.endIssue)}</small></span>
        <span>独立留出 <strong>{report.backtest.holdoutCount} 期</strong><small>{formatIssueRange(report.backtest.holdout.startIssue, report.backtest.holdout.endIssue)}</small></span>
        <span>有效样本 <strong>{report.dataQuality.sampleSize}/{report.dataQuality.requestedWindow} 期</strong><small>完整度 {report.dataQuality.completeness}%</small></span>
        <span>核验率 <strong>{report.dataQuality.verifiedRatio}%</strong><small>{report.dataQuality.sourceMode === "live" ? "实时历史源" : "同步快照"}</small></span>
        <span>前瞻台账 <strong>{ledgerStatus}</strong><small>{report.ledger?.lockedAt ? `锁定于 ${formatGeneratedTime(report.ledger.lockedAt)}` : formatGeneratedTime(report.generatedAt)}</small></span>
      </div>
      {report.ledger?.summary && (
        <div className="forward-ledger-summary">
          <span>全量前瞻复核</span>
          <strong>
            官方生肖已冻结 {report.ledger.summary.zodiacObservedForecasts} 期 · 已结算 {report.ledger.summary.zodiacEvaluatedForecasts} 期
          </strong>
          <small>
            {report.ledger.summary.zodiacEvaluatedForecasts > 0
              ? `6+1 生肖观察已结算 ${report.ledger.summary.zodiacEvaluatedForecasts} 份，命中 ${report.ledger.summary.zodiacCoverageHits} 份，命中率 ${formatStatistic(report.ledger.summary.zodiacCoverageRate ?? 0)}%；无论是否标注优势均全量计入。`
              : `已冻结 6+1 生肖观察 ${report.ledger.summary.zodiacObservedForecasts} 份，尚无可结算样本；系统不会只挑命中期展示。`}
          </small>
        </div>
      )}
      {strategy && (
        <>
          <div className="calibration-object">
            <span>校准对象</span>
            <strong>{strategy.name}</strong>
            <small>{(report.decision?.kind ?? (report.backtest.decision === "recommend" ? "observe" : "abstain")) === "abstain" ? "照常给出观察方向，但不标注统计优势" : "通过选择段后进入独立留出评估"}</small>
          </div>
          <div className="calibration-metrics">
            {zodiacCalibration && (
              <CalibrationMetric
                label="6+1 单生肖覆盖"
                value={`${zodiacCalibration.hitCount}/${zodiacCalibration.sampleSize} · ${formatStatistic(zodiacCalibration.hitRate)}%`}
                detail={`95% CI ${formatConfidenceInterval(zodiacCalibration.confidenceInterval, "%")} · 精确随机 ${formatStatistic(zodiacCalibration.baselineRate)}%`}
              />
            )}
            <CalibrationMetric
              label="平均正码覆盖"
              value={`${formatStatistic(strategy.averageMainOverlap)} 个/期`}
              detail={`累计 ${strategy.totalMainOverlap} 个 · 95% CI ${formatConfidenceInterval(strategy.averageMainOverlapCI)} · 随机 ${formatStatistic(report.backtest.baseline.averageMainOverlap)}`}
            />
            <CalibrationMetric
              label="至少覆盖 1 码"
              value={`${strategy.anyMainOverlapCount}/${strategy.sampleSize} · ${formatStatistic(strategy.anyMainOverlapRate)}%`}
              detail={`95% CI ${formatConfidenceInterval(strategy.anyMainOverlapCI, "%")} · 随机 ${formatStatistic(report.backtest.baseline.anyMainOverlapRate)}%`}
            />
            <CalibrationMetric
              label="特码精确命中"
              value={`${strategy.specialExactCount}/${strategy.sampleSize} · ${formatStatistic(strategy.specialExactRate)}%`}
              detail={`95% CI ${formatConfidenceInterval(strategy.specialExactCI, "%")} · 随机 ${formatStatistic(report.backtest.baseline.specialExactRate)}%`}
            />
          </div>
        </>
      )}
    </section>
  );
}

function CalibrationMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function formatConfidenceInterval(
  interval: AiConfidenceInterval,
  suffix = "",
): string {
  return `${formatStatistic(interval.low)}–${formatStatistic(interval.high)}${suffix}`;
}

function formatStatistic(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatIssueRange(start: string | null, end: string | null): string {
  if (!start || !end) return "样本不足，暂无期号区间";
  return start === end ? `第 ${start} 期` : `${start}–${end}`;
}

function ledgerStatusLabel(
  ledger: ScientificReport["ledger"],
  generatedBeforeDraw: boolean,
): string {
  if (!ledger) {
    return generatedBeforeDraw ? "未返回锁定状态" : "开奖后生成 · 仅作复盘";
  }
  if (ledger.settledAt) return "已锁定并结算";
  if ((ledger.state === "locked" || ledger.state === "existing") && ledger.immutable) {
    return ledger.state === "locked" ? "已锁定 · 不可篡改" : "已存在 · 不可覆盖";
  }
  if (ledger.reason === "after_cutoff") return "已过截止时间 · 未入账";
  if (ledger.reason === "target_unconfirmed") return "目标期未确认 · 未入账";
  if (ledger.reason === "quality_gate_failed") return "数据核验未通过 · 临时报告";
  if (ledger.reason === "generation_degraded") return "AI 未完成 · 可重新生成";
  return "台账暂不可用";
}

function backtestStatusLabel(status: AiAnalysisResponse["backtest"]["status"]): string {
  if (status === "observed_advantage") return "独立留出 · 观察到优势";
  if (status === "insufficient") return "独立留出 · 样本不足";
  return "独立留出 · 未证实高于随机";
}

function calculateScenarioDiversity(
  scenarios: Array<{ numbers: number[] }>,
): AiScenario["diversity"] {
  const uniqueMainNumbers = new Set(scenarios.flatMap((scenario) => scenario.numbers)).size;
  const overlaps: number[] = [];
  const jaccards: number[] = [];
  scenarios.forEach((left, leftIndex) => {
    scenarios.slice(leftIndex + 1).forEach((right) => {
      const leftSet = new Set(left.numbers);
      const rightSet = new Set(right.numbers);
      const intersection = [...leftSet].filter((number) => rightSet.has(number)).length;
      const union = new Set([...left.numbers, ...right.numbers]).size;
      overlaps.push(intersection);
      jaccards.push(intersection / Math.max(union, 1));
    });
  });
  const averageJaccard =
    jaccards.reduce((sum, value) => sum + value, 0) / Math.max(jaccards.length, 1);
  return {
    uniqueMainNumbers,
    maxMainOverlap: Math.max(...overlaps, 0),
    averageJaccard,
    score: Math.round((1 - averageJaccard) * 100),
  };
}

function formatPercentRatio(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function StrategySection({
  analysis,
  report,
  latest,
  targetDrawAt,
  activeScenario,
  onScenario,
}: {
  analysis: Analysis;
  report: AiAnalysisResponse | null;
  latest: Draw;
  targetDrawAt: string;
  activeScenario: AiScenario["id"];
  onScenario: (scenario: AiScenario["id"]) => void;
}) {
  const strategyGridRef = useRef<HTMLDivElement | null>(null);
  const localDiversity = calculateScenarioDiversity(analysis.candidates);
  const scenarios: AiScenario[] = report?.candidateSets ?? analysis.candidates.map((candidate) => {
    const all = [...candidate.numbers, candidate.special];
    const waves = all.reduce<Record<Wave, number>>(
      (current, number) => {
        current[getWave(number)] += 1;
        return current;
      },
      { red: 0, blue: 0, green: 0 },
    );
    return {
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      numbers: candidate.numbers,
      special: candidate.special,
      evidenceScore: Math.round(candidate.score),
      diversity: localDiversity,
      structure: {
        zodiacCount: new Set(
          all.map((number) => getZodiac(number, targetDrawAt)),
        ).size,
        waves,
        odd: all.filter((number) => number % 2 === 1).length,
        even: all.filter((number) => number % 2 === 0).length,
        big: all.filter((number) => number >= 25).length,
        small: all.filter((number) => number < 25).length,
        tails: [...new Set(all.map((number) => number % 10))].sort((a, b) => a - b),
      },
      supportingEvidence: ["等待 AI 生成后展示完整证据链。"],
      counterEvidence: ["结构排序不代表中奖概率。"],
      observations: [],
    };
  });
  const reportDecision = (report as ScientificReport | null)?.decision;
  const primaryObservationId = report?.zodiacObservation?.scenarioId ?? null;
  const recommendedId =
    report &&
    (reportDecision ? reportDecision.kind === "observe" : report.backtest.decision === "recommend")
      ? reportDecision?.scenarioId ??
        report.backtest.selectedStrategyId ??
        report.synthesis.recommendedScenarioId
      : null;
  const diversity = calculateScenarioDiversity(scenarios);
  const similarCandidates =
    diversity.maxMainOverlap >= 5 || diversity.averageJaccard >= 0.65;
  const reviewDraw = report?.target.issue === latest.issue ? latest : null;
  const selectScenario = (scenario: AiScenario["id"]) => {
    onScenario(scenario);
    window.requestAnimationFrame(() => {
      strategyGridRef.current
        ?.querySelector<HTMLElement>(`[data-scenario="${scenario}"]`)
        ?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
    });
  };
  return (
    <section className="strategy-section section-block">
      <SectionHeading
        eyebrow="WALK-FORWARD VIEW"
        title="三路候选策略"
        description="同一批历史数据用三种权重观察，并量化三路号码的联合覆盖与重合度；场景差异只用于结构研究，不代表三份独立的中奖证据。"
      />
      <div className={`diversity-strip ${similarCandidates ? "warning" : ""}`} aria-label="三路候选多样性">
        <div><span>三路联合覆盖</span><strong>{diversity.uniqueMainNumbers} 个正码</strong></div>
        <div><span>最大两两重合</span><strong>{diversity.maxMainOverlap}/6</strong></div>
        <div><span>平均 Jaccard</span><strong>{formatPercentRatio(diversity.averageJaccard)}</strong></div>
        <p>
          {similarCandidates
            ? "三路候选相似度较高，不能视为三份独立证据。"
            : "三路候选具备可辨识差异；多样性本身不提高理论中奖概率。"}
        </p>
      </div>
      <div className="scenario-switch" role="group" aria-label="切换候选场景">
        {scenarios.map((scenario) => (
          <button
            type="button"
            className={activeScenario === scenario.id ? "active" : ""}
            aria-pressed={activeScenario === scenario.id}
            aria-controls={`strategy-${scenario.id}`}
            onClick={() => selectScenario(scenario.id)}
            key={scenario.id}
          >
            {scenario.name}
            {recommendedId === scenario.id
              ? <span>留出优势</span>
              : primaryObservationId === scenario.id
                ? <span>主生肖方向</span>
                : null}
          </button>
        ))}
      </div>
      <div ref={strategyGridRef} className="strategy-grid" aria-label="三路候选策略卡片">
        {scenarios.map((scenario, index) => {
          const mainExact = reviewDraw
            ? scenario.numbers.filter((number) => reviewDraw.numbers.includes(number))
            : [];
          const specialExact = reviewDraw ? scenario.special === reviewDraw.special : false;
          const primaryZodiac = scenario.observations.find(
            (observation) => observation.id === "zodiac_coverage",
          );
          const zodiacDirections = [
            ...new Set(
              [...scenario.numbers, scenario.special].map((number) =>
                getZodiac(number, report?.target.expectedDrawAt ?? targetDrawAt),
              ),
            ),
          ];
          return (
            <article
              id={`strategy-${scenario.id}`}
              data-scenario={scenario.id}
              className={`strategy-card ${activeScenario === scenario.id ? "active" : ""} ${recommendedId === scenario.id ? "recommended" : ""} ${primaryObservationId === scenario.id ? "observation-primary" : ""}`}
              key={scenario.id}
            >
              <div className="strategy-topline">
                <span>0{index + 1}</span>
                <span>{report ? `校准分 ${scenario.evidenceScore} · 非概率` : "本地预研"}</span>
              </div>
              <h3>
                {scenario.name}
                {recommendedId === scenario.id
                  ? <small>留出优势</small>
                  : primaryObservationId === scenario.id
                    ? <small>主生肖方向</small>
                    : null}
              </h3>
              <p>{scenario.description}</p>
              <BallRow
                numbers={scenario.numbers}
                special={scenario.special}
                compact
                drawAt={report?.target.expectedDrawAt ?? targetDrawAt}
              />
              <div className="strategy-zodiac-track">
                <span>6+1 生肖观察</span>
                <strong>{primaryZodiac?.pick ?? "生成报告后显示"}</strong>
                <span>候选组合覆盖</span>
                <strong>{zodiacDirections.join(" · ")}</strong>
              </div>
              {reviewDraw && (
                <div className="strategy-review-result" aria-label={`${scenario.name}赛后复盘`}>
                  <div className="strategy-review-status">
                    <span>第 {reviewDraw.issue} 期复盘</span>
                    <strong className={reviewDraw.verified ? "verified" : "pending"}>
                      {reviewDraw.verified ? "结果已核验" : "结果已返回 · 待交叉核验"}
                    </strong>
                  </div>
                  <span>
                    正码号码
                    <strong>{mainExact.length}/6</strong>
                  </span>
                  <span className={specialExact ? "hit" : ""}>
                    特码号码
                    <strong>
                      {specialExact
                        ? `命中 ${formatBall(reviewDraw.special)}`
                        : `未中 ${formatBall(scenario.special)} → ${formatBall(reviewDraw.special)}`}
                    </strong>
                  </span>
                  <div className="strategy-observation-review">
                    {scenario.observations.map((observation) => {
                      const hit = observationHit(observation, reviewDraw);
                      return (
                        <span
                          className={`${hit ? "hit" : ""} ${observation.id === "zodiac_coverage" ? "primary" : ""}`}
                          key={observation.id}
                        >
                          {observation.label}
                          <strong>{observation.pick} · {hit ? "命中" : "未中"}</strong>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="strategy-tags">
                <span>{scenario.structure.odd} 奇</span>
                <span>{scenario.structure.big} 大</span>
                <span>生肖 {scenario.structure.zodiacCount} 类</span>
                <span>{scenario.structure.tails.length} 尾</span>
              </div>
              {report && (
                <div className="strategy-evidence">
                  <span>入选依据</span>
                  <ul>{scenario.supportingEvidence.map((item) => <li key={item}>{item}</li>)}</ul>
                  <details>
                    <summary>查看反方证据</summary>
                    <ul>{scenario.counterEvidence.map((item) => <li key={item}>{item}</li>)}</ul>
                  </details>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <div className="strategy-review-rule">
        <span>复盘口径</span>
        <p><strong>6+1 生肖命中</strong>＝预先选择的一个生肖，在当期六码加特码任一位置出现；<strong>正码命中</strong>＝候选六码与实际六码的交集；<strong>特码命中</strong>＝预测特码与实际特码完全相同。每项独立结算，报告目标期结果返回后自动显示，单源结果会标记为待交叉核验。</p>
      </div>
      <div className="responsible-note">
        <span>!</span>
        <p><strong>理性提示</strong>　校准分、观察优先和历史回测均不是中奖概率。彩票结果具有随机性；本站不是官方彩票网站，不提供投注、资金或收益建议。</p>
      </div>
    </section>
  );
}

function observationHit(observation: AiScenarioObservation, draw: Draw): boolean {
  const all = [...draw.numbers, draw.special];
  if (observation.id === "zodiac_coverage") {
    return all.some((number) => getZodiac(number, draw.drawAt) === observation.pick);
  }
  if (observation.id === "tail_coverage") {
    const tail = Number(observation.pick.match(/\d/)?.[0]);
    return Number.isInteger(tail) && all.some((number) => number % 10 === tail);
  }
  if (observation.id === "wave_threshold") {
    const wave =
      observation.pick.includes("红")
        ? "red"
        : observation.pick.includes("蓝")
          ? "blue"
          : "green";
    return all.filter((number) => getWave(number) === wave).length >= observation.threshold;
  }
  if (observation.id === "parity_majority") {
    const wantsOdd = observation.pick.includes("奇");
    return all.filter((number) => (number % 2 === 1) === wantsOdd).length >= observation.threshold;
  }
  const wantsBig = observation.pick.includes("大");
  return all.filter((number) => (number >= 25) === wantsBig).length >= observation.threshold;
}

function AiEvidenceSection({ report }: { report: AiAnalysisResponse }) {
  const [openDimension, setOpenDimension] = useState<AiDimensionId | null>(
    report.focus === "comprehensive" ? report.dimensions[0]?.id ?? null : report.focus,
  );
  const insightMap = new Map(
    report.synthesis.dimensionInsights.map((insight) => [insight.id, insight]),
  );
  const dimensions = [...report.dimensions].sort((a, b) => {
    if (a.id === report.focus) return -1;
    if (b.id === report.focus) return 1;
    return b.evidenceScore - a.evidenceScore;
  });
  const selected =
    report.backtest.selectedStrategyId
      ? report.backtest.strategies.find(
        (strategy) => strategy.id === report.backtest.selectedStrategyId,
      ) ?? null
      : null;
  const calibrationExample = selected ?? report.backtest.strategies[0] ?? null;
  const calibrationZodiac = calibrationExample?.observations.find(
    (observation) => observation.id === "zodiac_coverage",
  );
  const generatedBeforeDraw =
    new Date(report.generatedAt).getTime() < new Date(report.target.expectedDrawAt).getTime();
  return (
    <section className="ai-evidence-section section-block">
      <SectionHeading
        eyebrow="EVIDENCE & BACKTEST"
        title="证据链与滚动回测"
        description={`选择段用于选模，独立留出段只用于最终评估；每个测试期只使用目标期以前的数据，并与精确随机基准、95% 置信区间和 ${report.backtest.multipleComparisonCount} 组 Bonferroni 校正门槛对照。`}
      />
      <div className="data-quality-strip">
        <span>有效样本 <strong>{report.dataQuality.sampleSize}/{report.dataQuality.requestedWindow} 期</strong></span>
        <span>核验率 <strong>{report.dataQuality.verifiedRatio}%</strong></span>
        <span>选择段 <strong>{report.backtest.selectionCount} 期</strong></span>
        <span>独立留出 <strong>{report.backtest.holdoutCount} 期</strong></span>
        <span>训练窗口 <strong>{report.backtest.trainWindow} 期</strong></span>
        <span>数据模式 <strong>{report.dataQuality.sourceMode === "live" ? "实时历史源" : "同步快照"}</strong></span>
        <span>前瞻状态 <strong>{generatedBeforeDraw ? "开奖前生成" : "开奖后复盘"}</strong></span>
      </div>
      <div className="evidence-layout">
        <div className="dimension-accordion">
          {dimensions.map((dimension) => {
            const insight = insightMap.get(dimension.id);
            return (
              <details
                className="dimension-card"
                open={openDimension === dimension.id}
                key={dimension.id}
              >
                <summary
                  onClick={(event) => {
                    event.preventDefault();
                    setOpenDimension((current) => current === dimension.id ? null : dimension.id);
                  }}
                >
                  <span>{dimension.label}</span>
                  <strong>{dimension.direction}</strong>
                  <em>{signalLabel(dimension.signal)} · {dimension.evidenceScore}</em>
                </summary>
                <div className="dimension-body">
                  <p>{insight?.summary ?? dimension.explanation}</p>
                  <div className="dimension-metrics">
                    {dimension.metrics.map((metricItem) => (
                      <div key={metricItem.id}>
                        <span>{metricItem.label}</span>
                        <strong>{metricItem.value}</strong>
                        <small>基准：{metricItem.baseline}</small>
                      </div>
                    ))}
                  </div>
                  <div className="dimension-counter">
                    <span>反方校验</span>
                    <p>{insight?.counterpoint ?? dimension.counterEvidence[0]}</p>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
        <aside className="backtest-panel">
          <span className="control-label">NESTED WALK-FORWARD · INDEPENDENT HOLDOUT</span>
          <h3>{backtestStatusLabel(report.backtest.status)}</h3>
          <p>{report.backtest.conclusion}</p>
          {calibrationExample && (
            <div className="backtest-metrics">
              {calibrationZodiac && (
                <div><span>{calibrationExample.name} · 6+1 单生肖</span><strong>{calibrationZodiac.hitCount}/{calibrationZodiac.sampleSize}</strong><small>{formatStatistic(calibrationZodiac.hitRate)}% · 95% CI {formatConfidenceInterval(calibrationZodiac.confidenceInterval, "%")} · 精确随机 {formatStatistic(calibrationZodiac.baselineRate)}%</small></div>
              )}
              <div><span>{calibrationExample.name} · 平均正码</span><strong>{formatStatistic(calibrationExample.averageMainOverlap)} 个/期</strong><small>累计 {calibrationExample.totalMainOverlap} 个 · 95% CI {formatConfidenceInterval(calibrationExample.averageMainOverlapCI)} · 随机 {formatStatistic(report.backtest.baseline.averageMainOverlap)}</small></div>
              <div><span>至少覆盖 1 码</span><strong>{calibrationExample.anyMainOverlapCount}/{calibrationExample.sampleSize}</strong><small>{formatStatistic(calibrationExample.anyMainOverlapRate)}% · 95% CI {formatConfidenceInterval(calibrationExample.anyMainOverlapCI, "%")} · 随机 {formatStatistic(report.backtest.baseline.anyMainOverlapRate)}%</small></div>
              <div><span>特码精确命中</span><strong>{calibrationExample.specialExactCount}/{calibrationExample.sampleSize}</strong><small>{formatStatistic(calibrationExample.specialExactRate)}% · 95% CI {formatConfidenceInterval(calibrationExample.specialExactCI, "%")} · 随机 {formatStatistic(report.backtest.baseline.specialExactRate)}%</small></div>
            </div>
          )}
          <div className="backtest-strategy-list">
            <span className="control-label">三路独立留出明细</span>
            {report.backtest.strategies.map((strategy) => (
              <details open={selected?.id === strategy.id} key={strategy.id}>
                <summary>
                  <span>{strategy.name}</span>
                  <strong>生肖 6+1 {strategy.observations.find((item) => item.id === "zodiac_coverage")?.hitCount ?? 0}/{strategy.sampleSize}</strong>
                  <em>正码 {formatStatistic(strategy.averageMainOverlap)}/期</em>
                </summary>
                <div>
                  {strategy.observations.map((observation) => (
                    <p key={observation.id}>{observation.label}：{observation.hitCount}/{observation.sampleSize}（{formatStatistic(observation.hitRate)}%）；95% CI {formatConfidenceInterval(observation.confidenceInterval, "%")}；精确随机 {formatStatistic(observation.baselineRate)}%。</p>
                  ))}
                  <p>正码累计 {strategy.totalMainOverlap} 个；95% CI {formatConfidenceInterval(strategy.averageMainOverlapCI)}；随机 {formatStatistic(report.backtest.baseline.averageMainOverlap)}。</p>
                  <p>至少一正码 {strategy.anyMainOverlapCount}/{strategy.sampleSize}（{formatStatistic(strategy.anyMainOverlapRate)}%）；95% CI {formatConfidenceInterval(strategy.anyMainOverlapCI, "%")}；随机 {formatStatistic(report.backtest.baseline.anyMainOverlapRate)}%。</p>
                  <p>特码 {strategy.specialExactCount}/{strategy.sampleSize}（{formatStatistic(strategy.specialExactRate)}%）；95% CI {formatConfidenceInterval(strategy.specialExactCI, "%")}；随机 {formatStatistic(report.backtest.baseline.specialExactRate)}%。</p>
                </div>
              </details>
            ))}
          </div>
          <div className="model-boundary">
            <strong>模型边界</strong>
            <p>{report.risk.randomnessNotice}</p>
            <p>{report.risk.noGuarantee}</p>
          </div>
        </aside>
      </div>
      {report.dataQuality.warnings.length > 0 && (
        <div className="data-warnings">
          {report.dataQuality.warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      )}
    </section>
  );
}

function HistoryTable({ draws }: { draws: Draw[] }) {
  return (
    <>
      <div className="history-table-wrap">
        <table className="history-table">
          <thead><tr><th>彩种 / 期号</th><th>开奖时间（北京）</th><th>开奖号码与生肖</th><th>结构摘要</th><th>状态</th></tr></thead>
          <tbody>{draws.map((draw) => {
            const all = [...draw.numbers, draw.special];
            return <tr key={`${draw.game}-${draw.issue}`}><td><strong>{GAME_META[draw.game].shortName}</strong> {draw.issue}</td><td>{formatDrawDate(draw.drawAt)}</td><td><BallRow numbers={draw.numbers} special={draw.special} compact drawAt={draw.drawAt} /></td><td>{all.filter((number) => number % 2).length}奇 · 生肖{new Set(all.map((number) => getZodiac(number, draw.drawAt))).size}类 · 和值{all.reduce((a, b) => a + b, 0)}</td><td><span className={draw.verified ? "verified" : "single-source"}><i />{draw.verified ? "双源一致" : "第三方数据"}</span></td></tr>;
          })}</tbody>
        </table>
      </div>
      <div className="history-mobile-list">
        {draws.map((draw) => {
          const all = [...draw.numbers, draw.special];
          return (
            <article className="history-mobile-card" key={`mobile-${draw.game}-${draw.issue}`}>
              <div className="history-mobile-head">
                <div><strong>{GAME_META[draw.game].shortName}</strong><span>第 {draw.issue} 期</span></div>
                <time>{formatDrawDate(draw.drawAt)}</time>
              </div>
              <BallRow numbers={draw.numbers} special={draw.special} compact drawAt={draw.drawAt} />
              <div className="history-mobile-foot">
                <span>{all.filter((number) => number % 2).length}奇 · 生肖{new Set(all.map((number) => getZodiac(number, draw.drawAt))).size}类 · 和值{all.reduce((a, b) => a + b, 0)}</span>
                <span className={draw.verified ? "verified" : "single-source"}><i />{draw.verified ? "双源一致" : "第三方数据"}</span>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

function mergeLiveProgress(
  current: LiveDrawProgress | null,
  incoming: LiveDrawProgress | null,
  completedDraws: Draw[],
) {
  if (incoming) {
    const completed = completedDraws.find((draw) => draw.issue === incoming.issue);
    if (
      completed &&
      (incoming.numbers.length < completed.numbers.length || incoming.special === null)
    ) {
      return drawToLiveProgress(completed);
    }
    if (
      current &&
      incoming.issue === current.issue &&
      incoming.numbers.length + Number(incoming.special !== null) <
        current.numbers.length + Number(current.special !== null)
    ) {
      return current;
    }
    if (
      current &&
      incoming.issue.localeCompare(current.issue, "en", { numeric: true }) < 0
    ) {
      return current;
    }
    return incoming;
  }
  if (
    current &&
    completedDraws.some((draw) => draw.issue === current.issue)
  ) {
    const completed = completedDraws.find((draw) => draw.issue === current.issue);
    if (completed) return drawToLiveProgress(completed);
  }
  if (
    current &&
    completedDraws.some(
      (draw) =>
        draw.issue.localeCompare(current.issue, "en", { numeric: true }) > 0,
    )
  ) {
    return null;
  }
  return current;
}

function drawToLiveProgress(draw: Draw): LiveDrawProgress {
  return {
    game: draw.game,
    issue: draw.issue,
    drawAt: draw.drawAt,
    numbers: draw.numbers,
    special: draw.special,
    source: draw.source,
  };
}

function getLiveWindow(game: GameId, now: Date) {
  const reference = new Date(now.getTime() - 30 * 60_000);
  const target = nextScheduledDraw(game, reference);
  const delta = target.getTime() - now.getTime();
  return { target, delta, visible: delta <= 3 * 60_000 && delta >= -30 * 60_000 };
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

function formatSyncTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatGeneratedTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function signalLabel(signal: AiAnalysisResponse["dimensions"][number]["signal"]) {
  if (signal === "moderate") return "中等";
  if (signal === "weak") return "有限";
  return "中性";
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
