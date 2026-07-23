import {
  GAME_META,
  WAVE_LABEL,
  buildAnalysis,
  formatBall,
  getWave,
  getZodiac,
  type Analysis,
  type CandidateSet,
  type Draw,
  type GameId,
  type Wave,
} from "./lottery";
import {
  AI_FOCUS_OPTIONS,
  type AiAnalysisResponse,
  type AiBacktest,
  type AiBacktestStrategy,
  type AiDimensionEvidence,
  type AiDimensionId,
  type AiFocus,
  type AiScenario,
  type AiScenarioId,
  type AiSignalLevel,
  type AiSynthesis,
} from "./ai-types";

export type ForecastPack = {
  game: GameId;
  focus: AiFocus;
  draws: Draw[];
  analysis: Analysis;
  dimensions: AiDimensionEvidence[];
  candidateSets: AiScenario[];
  backtest: AiBacktest;
  evidenceStrength: AiAnalysisResponse["evidenceStrength"];
  localSynthesis: AiSynthesis;
};

export function buildForecastPack(
  game: GameId,
  draws: Draw[],
  focus: AiFocus,
  expectedDrawAt: string,
): ForecastPack {
  const analysis = buildAnalysis(draws);
  const dimensions = buildDimensions(draws, analysis);
  const backtest = buildWalkForwardBacktest(draws, focus);
  const focusedCandidates = buildFocusedCandidates(
    draws,
    analysis,
    focus,
    expectedDrawAt,
  );
  const candidateSets = buildScenarios(
    focusedCandidates,
    backtest,
    expectedDrawAt,
    dimensions,
  );
  const evidenceStrength = buildEvidenceStrength(dimensions, backtest, draws.length);
  const draft = {
    game,
    focus,
    draws,
    analysis,
    dimensions,
    candidateSets,
    backtest,
    evidenceStrength,
  };
  return {
    ...draft,
    localSynthesis: buildLocalSynthesis(draft),
  };
}

export function nextIssue(issue: string): string {
  if (!/^\d+$/.test(issue)) return `${issue}-NEXT`;
  const next = String(Number(issue) + 1);
  return next.padStart(issue.length, "0");
}

function buildDimensions(draws: Draw[], analysis: Analysis): AiDimensionEvidence[] {
  const total = Math.max(draws.length * 7, 1);
  const averageFrequency = total / 49;
  const topHot = analysis.hot.slice(0, 5);
  const topOverdue = analysis.overdue.slice(0, 5);
  const topZodiac = analysis.zodiacs.slice(0, 3);
  const waveEntries = (Object.entries(analysis.waves) as Array<[Wave, number]>)
    .sort((a, b) => b[1] - a[1]);
  const tailCounts = Array.from({ length: 10 }, (_, tail) => ({
    tail,
    count: draws.reduce(
      (sum, draw) =>
        sum + [...draw.numbers, draw.special].filter((number) => number % 10 === tail).length,
      0,
    ),
  })).sort((a, b) => b.count - a.count || a.tail - b.tail);

  const hotDeviation = ((topHot[0]?.frequency ?? averageFrequency) - averageFrequency) /
    Math.max(draws.length, 1);
  const zodiacShare = (topZodiac[0]?.count ?? 0) / total;
  const waveShare = waveEntries[0][1] / total;
  const oddShare = analysis.odd / total;
  const bigShare = analysis.big / total;
  const topTailShare = tailCounts[0].count / total;
  const maxOmission = topOverdue[0]?.omission ?? 0;
  const zoneTotal = analysis.zones.reduce((sum, value) => sum + value, 0);
  const zoneSpread =
    (Math.max(...analysis.zones) - Math.min(...analysis.zones)) / Math.max(zoneTotal, 1);

  return [
    dimension(
      "numbers",
      "号码",
      scoreFromDeviation(hotDeviation, 0.06),
      `热码带集中在 ${topHot.slice(0, 3).map((item) => formatBall(item.number)).join("、")}`,
      topHot.map((item) => formatBall(item.number)),
      [
        metric(
          "numbers.hot_band",
          "热码带",
          topHot.slice(0, 5).map((item) => `${formatBall(item.number)}(${item.frequency})`).join(" · "),
          `49 码均值 ${round(averageFrequency)} 次`,
          hotDeviation > 0.08 ? "up" : "flat",
          draws.length,
        ),
        metric(
          "numbers.special_hot",
          "特码频次",
          topHot.slice(0, 5).map((item) => `${formatBall(item.number)}(${item.specialFrequency})`).join(" · "),
          "仅描述样本内次数",
          "flat",
          draws.length,
        ),
      ],
      `近 ${draws.length} 期的高频号码形成相对集中带，但频率差异仍处于有限样本范围。`,
      ["单个号码理论机会相同，热码可能在下一期回归均值。"],
    ),
    dimension(
      "zodiac",
      "生肖",
      scoreFromDeviation(zodiacShare - 1 / 12, 0.035),
      `${topZodiac[0]?.name ?? "—"}为样本第一，前列为 ${topZodiac.map((item) => item.name).join("、")}`,
      topZodiac.map((item) => item.name),
      [
        metric(
          "zodiac.top_share",
          "第一生肖占比",
          percent(topZodiac[0]?.count ?? 0, total),
          "均匀基准 8.3%",
          zodiacShare > 0.11 ? "up" : "flat",
          draws.length,
        ),
        metric(
          "zodiac.top_three",
          "前三生肖",
          topZodiac.map((item) => `${item.name}${item.count}`).join(" · "),
          "按期开奖日期映射",
          "flat",
          draws.length,
        ),
      ],
      `生肖维度以开奖日期映射，当前样本由${topZodiac[0]?.name ?? "—"}领先。`,
      ["生肖只是号码分组方式，同一生肖内仍包含多个等机会号码。"],
    ),
    dimension(
      "wave",
      "波色",
      scoreFromDeviation(waveShare - 1 / 3, 0.045),
      `${WAVE_LABEL[waveEntries[0][0]]}占比最高，为 ${percent(waveEntries[0][1], total)}`,
      waveEntries.map(([wave]) => WAVE_LABEL[wave]),
      waveEntries.map(([wave, count], index) =>
        metric(
          `wave.${wave}`,
          WAVE_LABEL[wave],
          percent(count, total),
          "参考基准约 33.3%",
          index === 0 && waveShare > 0.37 ? "up" : "flat",
          draws.length,
        ),
      ),
      `${WAVE_LABEL[waveEntries[0][0]]}在当前窗口略占优势，适合作为结构约束而非单独选号依据。`,
      ["三种波色的号码数量并非完全相同，短窗口占比容易摆动。"],
    ),
    dimension(
      "parity",
      "奇偶",
      scoreFromDeviation(Math.abs(oddShare - 0.5), 0.045),
      `奇偶比 ${analysis.odd}:${analysis.even}，${oddShare >= 0.5 ? "奇数" : "偶数"}略多`,
      [oddShare >= 0.5 ? "奇数" : "偶数"],
      [
        metric(
          "parity.odd_share",
          "奇数占比",
          percent(analysis.odd, total),
          "均匀基准约 50%",
          oddShare > 0.54 ? "up" : oddShare < 0.46 ? "down" : "flat",
          draws.length,
        ),
        metric(
          "parity.ratio",
          "奇偶累计",
          `${analysis.odd}:${analysis.even}`,
          "观察结构，不是概率",
          "flat",
          draws.length,
        ),
      ],
      `奇偶结构接近${oddShare >= 0.5 ? "奇数" : "偶数"}侧，但偏离程度决定其证据强弱。`,
      ["单期可能出现高度偏斜，长期均衡不要求下一期立即修复。"],
    ),
    dimension(
      "size",
      "大小",
      scoreFromDeviation(Math.abs(bigShare - 25 / 49), 0.045),
      `大小比 ${analysis.big}:${analysis.small}，${bigShare >= 25 / 49 ? "大数" : "小数"}略多`,
      [bigShare >= 25 / 49 ? "25–49" : "01–24"],
      [
        metric(
          "size.big_share",
          "大数占比",
          percent(analysis.big, total),
          "号码池基准 51.0%",
          bigShare > 0.56 ? "up" : bigShare < 0.46 ? "down" : "flat",
          draws.length,
        ),
        metric(
          "size.average_sum",
          "每期平均和值",
          String(analysis.averageSum),
          "7 个号码和值",
          "flat",
          draws.length,
        ),
      ],
      `大小维度当前向${bigShare >= 25 / 49 ? "大数" : "小数"}侧倾斜，可用于控制候选组合的区间分布。`,
      ["号码池中大数本就比小数多一个，轻微偏大不构成异常。"],
    ),
    dimension(
      "tail",
      "尾数",
      scoreFromDeviation(topTailShare - 0.1, 0.035),
      `${tailCounts[0].tail} 尾最活跃，前三为 ${tailCounts.slice(0, 3).map((item) => `${item.tail}尾`).join("、")}`,
      tailCounts.slice(0, 4).map((item) => `${item.tail}尾`),
      [
        metric(
          "tail.top_share",
          "第一尾数占比",
          percent(tailCounts[0].count, total),
          "参考基准约 10%",
          topTailShare > 0.14 ? "up" : "flat",
          draws.length,
        ),
        metric(
          "tail.top_three",
          "前三尾数",
          tailCounts.slice(0, 3).map((item) => `${item.tail}尾(${item.count})`).join(" · "),
          "0–9 尾",
          "flat",
          draws.length,
        ),
      ],
      `尾数分布显示 ${tailCounts[0].tail} 尾相对活跃，组合中可观察尾数分散度。`,
      ["各尾数包含的号码个数不同，0 尾只有 4 个号码。"],
    ),
    dimension(
      "hot_cold",
      "冷热",
      scoreFromDeviation(hotDeviation, 0.05),
      `热端 ${topHot.slice(0, 3).map((item) => formatBall(item.number)).join("、")}；冷端 ${analysis.cold.slice(0, 3).map((item) => formatBall(item.number)).join("、")}`,
      [...topHot.slice(0, 3), ...analysis.cold.slice(0, 3)].map((item) => formatBall(item.number)),
      [
        metric(
          "hot_cold.hot",
          "高频端",
          topHot.slice(0, 4).map((item) => `${formatBall(item.number)}(${item.frequency})`).join(" · "),
          `均值 ${round(averageFrequency)} 次`,
          "up",
          draws.length,
        ),
        metric(
          "hot_cold.cold",
          "低频端",
          analysis.cold.slice(0, 4).map((item) => `${formatBall(item.number)}(${item.frequency})`).join(" · "),
          "不代表应当回补",
          "down",
          draws.length,
        ),
      ],
      "冷热同时展示，避免只追逐近期高频或只押注低频回补。",
      ["热度和冷度都是后验描述，不改变下一期单号的理论机会。"],
    ),
    dimension(
      "omission",
      "遗漏",
      scoreFromDeviation(maxOmission / Math.max(draws.length, 1), 0.18),
      `${formatBall(topOverdue[0]?.number ?? 0)} 当前遗漏 ${maxOmission} 期`,
      topOverdue.map((item) => formatBall(item.number)),
      [
        metric(
          "omission.max",
          "最大当前遗漏",
          `${formatBall(topOverdue[0]?.number ?? 0)} · ${maxOmission} 期`,
          `样本窗口 ${draws.length} 期`,
          maxOmission > draws.length * 0.35 ? "up" : "flat",
          draws.length,
        ),
        metric(
          "omission.top_band",
          "长遗漏带",
          topOverdue.slice(0, 5).map((item) => `${formatBall(item.number)}(${item.omission})`).join(" · "),
          "按最近出现位置计算",
          "flat",
          draws.length,
        ),
      ],
      "遗漏维度用于识别样本中的空档长度，并与频率信号交叉检查。",
      ["随机序列没有必须回补的期限，长遗漏可继续延长。"],
    ),
    dimension(
      "shape",
      "形态",
      scoreFromDeviation(Math.max(zoneSpread, Math.abs(analysis.repeatRate - 50) / 100), 0.1),
      `重号率 ${analysis.repeatRate}%，连号率 ${analysis.consecutiveRate}%，三区 ${analysis.zones.join(":")}`,
      ["三区分布", "重号", "连号"],
      [
        metric(
          "shape.repeat",
          "相邻期重号率",
          `${analysis.repeatRate}%`,
          "至少出现一个重号",
          analysis.repeatRate > 55 ? "up" : analysis.repeatRate < 35 ? "down" : "flat",
          draws.length,
        ),
        metric(
          "shape.consecutive",
          "正码连号率",
          `${analysis.consecutiveRate}%`,
          "每期是否含连号",
          analysis.consecutiveRate > 45 ? "up" : "flat",
          draws.length,
        ),
        metric(
          "shape.zones",
          "三区分布",
          analysis.zones.join(" · "),
          "01–16 / 17–33 / 34–49",
          zoneSpread > 0.08 ? "up" : "flat",
          draws.length,
        ),
      ],
      "形态层把重号、连号和三区分布合并观察，用于检查候选组合是否过度集中。",
      ["形态约束能改善组合多样性，但不会提高理论中奖概率。"],
    ),
  ];
}

function buildFocusedCandidates(
  draws: Draw[],
  analysis: Analysis,
  focus: AiFocus,
  targetDrawAt: string,
): CandidateSet[] {
  const frequency = Array(50).fill(0) as number[];
  const recent = Array(50).fill(0) as number[];
  const specialFrequency = Array(50).fill(0) as number[];
  const omission = Array(50).fill(draws.length) as number[];
  const seen = new Set<number>();
  draws.forEach((draw, drawIndex) => {
    const weight = Math.exp(-drawIndex / Math.max(draws.length / 3, 4));
    [...draw.numbers, draw.special].forEach((number) => {
      frequency[number] += 1;
      recent[number] += weight;
      if (!seen.has(number)) {
        omission[number] = drawIndex;
        seen.add(number);
      }
    });
    specialFrequency[draw.special] += 1;
  });

  const maxFrequency = Math.max(...frequency, 1);
  const maxRecent = Math.max(...recent, 1);
  const maxSpecial = Math.max(...specialFrequency, 1);
  const maxOmission = Math.max(...omission.slice(1), 1);
  const zodiacRanks = new Map(
    analysis.zodiacs.slice(0, 4).map((item, index) => [item.name, index]),
  );
  const waveRanks = new Map(
    (Object.entries(analysis.waves) as Array<[Wave, number]>)
      .sort((a, b) => b[1] - a[1])
      .map(([wave], index) => [wave, index]),
  );
  const dominantParity = analysis.odd >= analysis.even ? 1 : 0;
  const dominantSize = analysis.big >= analysis.small ? "big" : "small";
  const tailCounts = Array.from({ length: 10 }, (_, tail) => ({
    tail,
    count: draws.reduce(
      (sum, draw) =>
        sum + [...draw.numbers, draw.special].filter((number) => number % 10 === tail).length,
      0,
    ),
  })).sort((a, b) => b.count - a.count || a.tail - b.tail);
  const tailRanks = new Map(tailCounts.map((item, index) => [item.tail, index]));
  const focusLabel = AI_FOCUS_OPTIONS.find((item) => item.id === focus)?.label ?? "综合";

  const profiles = Array.from({ length: 49 }, (_, index) => {
    const number = index + 1;
    const hot = frequency[number] / maxFrequency;
    const momentum = recent[number] / maxRecent;
    const special = specialFrequency[number] / maxSpecial;
    const overdue = omission[number] / maxOmission;
    const cold = 1 - hot;
    const focusBonus = focusedBonus({
      number,
      focus,
      hot,
      cold,
      overdue,
      zodiacRanks,
      waveRanks,
      dominantParity,
      dominantSize,
      tailRanks,
      targetDrawAt,
    });
    return {
      number,
      balanced: hot * 0.34 + momentum * 0.2 + overdue * 0.24 + special * 0.12 + focusBonus * 0.1,
      momentum: momentum * 0.44 + hot * 0.28 + special * 0.16 + focusBonus * 0.12,
      contrarian: overdue * 0.48 + cold * 0.25 + momentum * 0.1 + special * 0.07 + focusBonus * 0.1,
      specialScore: special * 0.48 + momentum * 0.2 + overdue * 0.17 + focusBonus * 0.15,
    };
  });

  return (["balanced", "momentum", "contrarian"] as AiScenarioId[]).map((id) => {
    const ranked = [...profiles].sort(
      (a, b) => b[id] - a[id] || b.specialScore - a.specialScore || a.number - b.number,
    );
    const main = pickStructuredNumbers(ranked, focus, targetDrawAt);
    const special =
      [...profiles]
        .filter((item) => !main.includes(item.number))
        .sort(
          (a, b) =>
            (b.specialScore + b[id] * 0.35) - (a.specialScore + a[id] * 0.35) ||
            a.number - b.number,
        )[0]?.number ?? ranked.find((item) => !main.includes(item.number))?.number ?? 1;
    const selected = [...main, special];
    return {
      id,
      name: scenarioName(id),
      description: `${scenarioDescription(id)} · ${focusLabel}主研`,
      numbers: [...main].sort((a, b) => a - b),
      special,
      score: round(
        average(
          selected.map((number) => {
            const profile = profiles[number - 1];
            return (profile[id] + profile.specialScore * 0.2) * 100;
          }),
        ),
      ),
    };
  });
}

function focusedBonus({
  number,
  focus,
  hot,
  cold,
  overdue,
  zodiacRanks,
  waveRanks,
  dominantParity,
  dominantSize,
  tailRanks,
  targetDrawAt,
}: {
  number: number;
  focus: AiFocus;
  hot: number;
  cold: number;
  overdue: number;
  zodiacRanks: Map<string, number>;
  waveRanks: Map<Wave, number>;
  dominantParity: number;
  dominantSize: "big" | "small";
  tailRanks: Map<number, number>;
  targetDrawAt: string;
}) {
  if (focus === "zodiac") {
    const rank = zodiacRanks.get(getZodiac(number, targetDrawAt)) ?? 11;
    return clamp(1 - rank / 5, 0, 1);
  }
  if (focus === "wave") {
    const rank = waveRanks.get(getWave(number)) ?? 2;
    return clamp(1 - rank / 3, 0, 1);
  }
  if (focus === "parity") return number % 2 === dominantParity ? 1 : 0.15;
  if (focus === "size") {
    const size = number >= 25 ? "big" : "small";
    return size === dominantSize ? 1 : 0.15;
  }
  if (focus === "tail") {
    const rank = tailRanks.get(number % 10) ?? 9;
    return clamp(1 - rank / 6, 0, 1);
  }
  if (focus === "hot_cold") return hot * 0.55 + cold * 0.45;
  if (focus === "omission") return overdue;
  if (focus === "shape") {
    const zone = number <= 16 ? 0 : number <= 33 ? 1 : 2;
    return zone === 1 ? 1 : 0.75;
  }
  if (focus === "numbers") return hot * 0.6 + overdue * 0.4;
  return hot * 0.35 + overdue * 0.35 + 0.3;
}

function pickStructuredNumbers(
  ranked: Array<{
    number: number;
    balanced: number;
    momentum: number;
    contrarian: number;
  }>,
  focus: AiFocus,
  targetDrawAt: string,
) {
  const picked: number[] = [];
  for (const item of ranked) {
    const number = item.number;
    const zone = number <= 16 ? 0 : number <= 33 ? 1 : 2;
    const zoneCount = picked.filter((value) =>
      zone === 0 ? value <= 16 : zone === 1 ? value >= 17 && value <= 33 : value >= 34,
    ).length;
    const parityCount = picked.filter((value) => value % 2 === number % 2).length;
    const waveCount = picked.filter((value) => getWave(value) === getWave(number)).length;
    const zodiacCount = picked.filter(
      (value) => getZodiac(value, targetDrawAt) === getZodiac(number, targetDrawAt),
    ).length;
    const tailCount = picked.filter((value) => value % 10 === number % 10).length;
    const parityCap = focus === "parity" ? 5 : 4;
    const waveCap = focus === "wave" ? 5 : 4;
    const zodiacCap = focus === "zodiac" ? 3 : 2;
    if (
      zoneCount >= 3 ||
      parityCount >= parityCap ||
      waveCount >= waveCap ||
      zodiacCount >= zodiacCap ||
      tailCount >= 2
    ) {
      continue;
    }
    picked.push(number);
    if (picked.length === 6) break;
  }
  for (const item of ranked) {
    if (picked.length >= 6) break;
    if (!picked.includes(item.number)) picked.push(item.number);
  }
  return picked;
}

function buildWalkForwardBacktest(draws: Draw[], focus: AiFocus): AiBacktest {
  const chronological = [...draws].reverse();
  if (chronological.length < 10) {
    return {
      method: "walk_forward",
      trainWindow: 0,
      testCount: 0,
      noLookahead: true,
      strategies: ["balanced", "momentum", "contrarian"].map((id) => ({
        id: id as AiScenarioId,
        name: scenarioName(id as AiScenarioId),
        averageMainOverlap: 0,
        anyMainOverlapRate: 0,
        specialExactRate: 0,
        stabilityScore: 0,
      })),
      baseline: randomBaseline(),
      conclusion: "有效样本不足，暂不能运行时间顺序回测。",
    };
  }

  const trainWindow = Math.min(30, Math.max(8, Math.floor(chronological.length * 0.65)));
  const testStart = Math.max(trainWindow, chronological.length - 24);
  const buckets = new Map<AiScenarioId, {
    overlaps: number[];
    any: number;
    special: number;
    stability: number[];
    previous: number[] | null;
  }>();
  (["balanced", "momentum", "contrarian"] as AiScenarioId[]).forEach((id) =>
    buckets.set(id, { overlaps: [], any: 0, special: 0, stability: [], previous: null }),
  );

  for (let index = testStart; index < chronological.length; index += 1) {
    const training = chronological
      .slice(Math.max(0, index - trainWindow), index)
      .reverse();
    const actual = chronological[index];
    const actualMain = new Set(actual.numbers);
    const forecast = buildAnalysis(training);
    const focused = buildFocusedCandidates(training, forecast, focus, actual.drawAt);
    focused.forEach((candidate) => {
      const bucket = buckets.get(candidate.id);
      if (!bucket) return;
      const overlap = candidate.numbers.filter((number) => actualMain.has(number)).length;
      bucket.overlaps.push(overlap);
      if (overlap > 0) bucket.any += 1;
      if (candidate.special === actual.special) bucket.special += 1;
      if (bucket.previous) bucket.stability.push(jaccard(bucket.previous, candidate.numbers));
      bucket.previous = candidate.numbers;
    });
  }

  const testCount = Math.max(chronological.length - testStart, 0);
  const strategies = (["balanced", "momentum", "contrarian"] as AiScenarioId[]).map((id) => {
    const bucket = buckets.get(id)!;
    return {
      id,
      name: scenarioName(id),
      averageMainOverlap: round(average(bucket.overlaps)),
      anyMainOverlapRate: round((bucket.any / Math.max(testCount, 1)) * 100),
      specialExactRate: round((bucket.special / Math.max(testCount, 1)) * 100),
      stabilityScore: round(average(bucket.stability) * 100),
    } satisfies AiBacktestStrategy;
  });
  const baseline = randomBaseline();
  const best = [...strategies].sort(
    (a, b) =>
      b.averageMainOverlap - a.averageMainOverlap ||
      b.anyMainOverlapRate - a.anyMainOverlapRate,
  )[0];
  const delta = best.averageMainOverlap - baseline.averageMainOverlap;
  const conclusion =
    testCount < 6
      ? `仅完成 ${testCount} 期回测，样本不足，结果只作流程校验。`
      : delta > 0.2
        ? `${best.name}在 ${testCount} 期滚动回测中的平均正码覆盖暂高于随机期望 ${round(delta)} 个，但样本仍不足以证明未来优势。`
        : delta < -0.2
          ? `三路策略在 ${testCount} 期回测中未超过随机基准，不应把当前信号解释为预测优势。`
          : `三路策略在 ${testCount} 期回测中整体接近随机基准，当前更适合用于结构研究。`;

  return {
    method: "walk_forward",
    trainWindow,
    testCount,
    noLookahead: true,
    strategies,
    baseline,
    conclusion,
  };
}

function buildScenarios(
  candidates: CandidateSet[],
  backtest: AiBacktest,
  expectedDrawAt: string,
  dimensions: AiDimensionEvidence[],
): AiScenario[] {
  const dimensionLeaders = [...dimensions]
    .sort((a, b) => b.evidenceScore - a.evidenceScore)
    .slice(0, 3);
  return candidates.map((candidate) => {
    const all = [...candidate.numbers, candidate.special];
    const waves = all.reduce<Record<Wave, number>>(
      (result, number) => {
        result[getWave(number)] += 1;
        return result;
      },
      { red: 0, blue: 0, green: 0 },
    );
    const backtestResult = backtest.strategies.find((item) => item.id === candidate.id);
    const baselineDelta =
      (backtestResult?.averageMainOverlap ?? 0) - backtest.baseline.averageMainOverlap;
    const evidenceScore = clamp(
      Math.round(
        42 +
        candidate.score * 0.7 +
        baselineDelta * 12 +
        Math.min((backtestResult?.stabilityScore ?? 0) / 8, 10),
      ),
      28,
      76,
    );
    return {
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      numbers: candidate.numbers,
      special: candidate.special,
      evidenceScore,
      structure: {
        zodiacCount: new Set(all.map((number) => getZodiac(number, expectedDrawAt))).size,
        waves,
        odd: all.filter((number) => number % 2 === 1).length,
        even: all.filter((number) => number % 2 === 0).length,
        big: all.filter((number) => number >= 25).length,
        small: all.filter((number) => number < 25).length,
        tails: [...new Set(all.map((number) => number % 10))].sort((a, b) => a - b),
      },
      supportingEvidence: [
        ...dimensionLeaders.slice(0, 2).map((item) => `${item.label}：${item.direction}`),
        backtestResult
          ? `滚动回测平均覆盖 ${backtestResult.averageMainOverlap} 个正码`
          : "等待回测数据",
      ],
      counterEvidence: [
        candidate.id === "momentum"
          ? "近期热度可能回归均值。"
          : candidate.id === "contrarian"
            ? "遗漏不构成号码必须回补的义务。"
            : "结构均衡不改变每个组合的理论机会。",
        backtest.conclusion,
      ],
    };
  });
}

function buildEvidenceStrength(
  dimensions: AiDimensionEvidence[],
  backtest: AiBacktest,
  sampleSize: number,
): AiAnalysisResponse["evidenceStrength"] {
  const leaders = [...dimensions].sort((a, b) => b.evidenceScore - a.evidenceScore).slice(0, 4);
  const dimensionAverage = average(leaders.map((item) => item.evidenceScore));
  const sampleFactor = Math.min(sampleSize / 100, 1) * 15;
  const bestBacktest = Math.max(...backtest.strategies.map((item) => item.averageMainOverlap), 0);
  const backtestDelta = bestBacktest - backtest.baseline.averageMainOverlap;
  const score = clamp(Math.round(dimensionAverage * 0.65 + sampleFactor + backtestDelta * 12), 18, 72);
  return {
    kind: "evidence_strength_not_win_probability",
    score,
    label: score >= 62 ? "中等" : score >= 42 ? "有限" : "低",
    drivers: leaders.slice(0, 3).map((item) => `${item.label}证据指数 ${item.evidenceScore}`),
    penalties: [
      backtest.testCount < 10 ? "滚动回测期数偏少" : "历史回测不能外推为未来命中率",
      "开奖结果为独立随机事件",
    ],
  };
}

function buildLocalSynthesis(pack: Omit<ForecastPack, "localSynthesis">): AiSynthesis {
  const focusLabel =
    AI_FOCUS_OPTIONS.find((item) => item.id === pack.focus)?.label ?? "综合";
  const rankedDimensions = [...pack.dimensions].sort(
    (a, b) => b.evidenceScore - a.evidenceScore,
  );
  const preferredDimension =
    pack.focus === "comprehensive"
      ? rankedDimensions[0]
      : pack.dimensions.find((item) => item.id === pack.focus) ?? rankedDimensions[0];
  const recommended =
    [...pack.candidateSets].sort((a, b) => b.evidenceScore - a.evidenceScore)[0] ??
    pack.candidateSets[0];
  return {
    headline: `${GAME_META[pack.game].shortName} · ${focusLabel}多策略研判`,
    executiveSummary: `当前最值得观察的是${preferredDimension.label}维度：${preferredDimension.direction}。三路场景中，${recommended.name}的样本内证据相对更完整，但这只是历史结构排序。`,
    recommendedScenarioId: recommended.id,
    recommendationReason: `${recommended.name}同时覆盖 ${recommended.supportingEvidence.slice(0, 2).join("；")}，证据指数 ${recommended.evidenceScore}。`,
    uncertainty: "所有候选都处在高不确定性环境。证据指数反映样本内一致性，不是中奖概率，也不意味着下一期更容易出现。",
    strongestSignals: rankedDimensions
      .slice(0, 3)
      .map((item) => `${item.label}：${item.direction}（证据指数 ${item.evidenceScore}）`),
    conflictingSignals: rankedDimensions
      .slice(-2)
      .reverse()
      .map((item) => `${item.label}信号偏弱：${item.counterEvidence[0]}`),
    dimensionInsights: pack.dimensions.map((item) => ({
      id: item.id,
      summary: item.explanation,
      counterpoint: item.counterEvidence[0],
      evidenceIds: item.metrics.map((metricItem) => metricItem.id),
    })),
  };
}

function dimension(
  id: AiDimensionId,
  label: string,
  evidenceScore: number,
  direction: string,
  candidates: string[],
  metrics: AiDimensionEvidence["metrics"],
  explanation: string,
  counterEvidence: string[],
): AiDimensionEvidence {
  return {
    id,
    label,
    signal: level(evidenceScore),
    evidenceScore,
    direction,
    candidates,
    metrics,
    explanation,
    counterEvidence,
  };
}

function metric(
  id: string,
  label: string,
  value: string,
  baseline: string,
  trend: "up" | "down" | "flat",
  window: number,
) {
  return { id, label, value, baseline, trend, window };
}

function scoreFromDeviation(value: number, reference: number): number {
  return clamp(Math.round(30 + (Math.abs(value) / Math.max(reference, 0.001)) * 22), 28, 78);
}

function level(score: number): AiSignalLevel {
  if (score >= 62) return "moderate";
  if (score >= 42) return "weak";
  return "neutral";
}

function randomBaseline() {
  const noOverlap = combinationRatio(43, 6, 49, 6);
  return {
    averageMainOverlap: round((6 * 6) / 49),
    anyMainOverlapRate: round((1 - noOverlap) * 100),
    specialExactRate: round((1 / 49) * 100),
  };
}

function combinationRatio(aN: number, aK: number, bN: number, bK: number) {
  return combination(aN, aK) / combination(bN, bK);
}

function combination(n: number, k: number) {
  let value = 1;
  for (let index = 1; index <= k; index += 1) {
    value = (value * (n - k + index)) / index;
  }
  return value;
}

function jaccard(a: number[], b: number[]) {
  const left = new Set(a);
  const right = new Set(b);
  const intersection = [...left].filter((value) => right.has(value)).length;
  return intersection / Math.max(new Set([...left, ...right]).size, 1);
}

function scenarioName(id: AiScenarioId) {
  if (id === "momentum") return "趋势延续";
  if (id === "contrarian") return "逆向遗漏";
  return "冷热平衡";
}

function scenarioDescription(id: AiScenarioId) {
  if (id === "momentum") return "提高近期活跃度与特码频次权重";
  if (id === "contrarian") return "优先观察长遗漏与低频反向情景";
  return "综合频率、近期动量、遗漏与结构约束";
}

function percent(value: number, total: number) {
  return `${round((value / Math.max(total, 1)) * 100)}%`;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
