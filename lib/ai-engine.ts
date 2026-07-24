import {
  GAME_META,
  WAVE_LABEL,
  buildAnalysis,
  formatBall,
  getWave,
  getZodiac,
  isValidDraw,
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
  type AiBacktestSegment,
  type AiBacktestStrategy,
  type AiConfidenceInterval,
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
  evaluationHistory: Draw[] = draws,
): ForecastPack {
  const normalizedDraws = normalizeHistory(draws);
  const cutoff = normalizedDraws[0] ? drawTimeValue(normalizedDraws[0]) : Infinity;
  const normalizedEvaluationHistory = normalizeHistory(evaluationHistory).filter(
    (draw) => drawTimeValue(draw) <= cutoff,
  );
  const analysis = buildAnalysis(normalizedDraws);
  const dimensions = buildDimensions(normalizedDraws, analysis);
  const backtest = buildWalkForwardBacktest(
    normalizedEvaluationHistory,
    focus,
    normalizedDraws.length,
  );
  const focusedCandidates = buildFocusedCandidates(
    normalizedDraws,
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
  const evidenceStrength = buildEvidenceStrength(
    dimensions,
    backtest,
    normalizedDraws.length,
  );
  const draft = {
    game,
    focus,
    draws: normalizedDraws,
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
  const topZodiacName = topZodiac[0]?.name ?? "";
  const zodiacBaseline = topZodiacName
    ? average(
      draws.map(
        (draw) =>
          countNumbers((number) => getZodiac(number, draw.drawAt) === topZodiacName) / 49,
      ),
    )
    : 1 / 12;
  const leadingWave = waveEntries[0][0];
  const waveBaseline = countNumbers((number) => getWave(number) === leadingWave) / 49;
  const leadingTail = tailCounts[0].tail;
  const tailBaseline = countNumbers((number) => number % 10 === leadingTail) / 49;
  const topZone = analysis.zones.indexOf(Math.max(...analysis.zones));
  const zoneBaseline = [16 / 49, 17 / 49, 16 / 49][topZone] ?? 1 / 3;
  const repeatCount = countRepeatEvents(draws);
  const consecutiveCount = countConsecutiveEvents(draws);
  const numberEvidenceScore = confidenceScoreFromBinomial(
    topHot[0]?.frequency ?? 0,
    draws.length,
    7 / 49,
    { multiplicity: 49 },
  );
  const zodiacEvidenceScore = confidenceScoreFromBinomial(
    topZodiac[0]?.count ?? 0,
    total,
    zodiacBaseline,
    { multiplicity: 12 },
  );
  const waveEvidenceScore = confidenceScoreFromBinomial(
    waveEntries[0][1],
    total,
    waveBaseline,
    { multiplicity: 3 },
  );
  const parityEvidenceScore = confidenceScoreFromBinomial(
    analysis.odd,
    total,
    25 / 49,
    { twoSided: true },
  );
  const sizeEvidenceScore = confidenceScoreFromBinomial(
    analysis.big,
    total,
    25 / 49,
    { twoSided: true },
  );
  const tailEvidenceScore = confidenceScoreFromBinomial(
    tailCounts[0].count,
    total,
    tailBaseline,
    { multiplicity: 10 },
  );
  const omissionEvidenceScore = confidenceScoreFromPValue(
    Math.min(1, 49 * Math.pow(42 / 49, maxOmission)),
  );
  const repeatPValue = exactBinomialTwoSidedPValue(
    repeatCount,
    Math.max(draws.length - 1, 0),
    randomRepeatRate(),
  );
  const consecutivePValue = exactBinomialTwoSidedPValue(
    consecutiveCount,
    draws.length,
    randomConsecutiveRate(),
  );
  const zonePValue = adjustedPValue(
    exactBinomialUpperTailPValue(
      analysis.zones[topZone] ?? 0,
      total,
      zoneBaseline,
    ),
    3,
  );
  const shapeEvidenceScore = confidenceScoreFromPValue(
    adjustedPValue(Math.min(repeatPValue, consecutivePValue, zonePValue), 3),
  );

  return [
    dimension(
      "numbers",
      "号码",
      numberEvidenceScore,
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
      zodiacEvidenceScore,
      `${topZodiac[0]?.name ?? "—"}为样本第一，前列为 ${topZodiac.map((item) => item.name).join("、")}`,
      topZodiac.map((item) => item.name),
      [
        metric(
          "zodiac.top_share",
          "第一生肖占比",
          percent(topZodiac[0]?.count ?? 0, total),
          `号码池基准 ${percent(zodiacBaseline, 1)}`,
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
      waveEvidenceScore,
      `${WAVE_LABEL[waveEntries[0][0]]}占比最高，为 ${percent(waveEntries[0][1], total)}`,
      waveEntries.map(([wave]) => WAVE_LABEL[wave]),
      waveEntries.map(([wave, count], index) =>
        metric(
          `wave.${wave}`,
          WAVE_LABEL[wave],
          percent(count, total),
          `号码池基准 ${percent(countNumbers((number) => getWave(number) === wave) / 49, 1)}`,
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
      parityEvidenceScore,
      `奇偶比 ${analysis.odd}:${analysis.even}，${oddShare >= 0.5 ? "奇数" : "偶数"}略多`,
      [oddShare >= 0.5 ? "奇数" : "偶数"],
      [
        metric(
          "parity.odd_share",
          "奇数占比",
          percent(analysis.odd, total),
          "号码池基准 51.0%",
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
      sizeEvidenceScore,
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
      tailEvidenceScore,
      `${tailCounts[0].tail} 尾最活跃，前三为 ${tailCounts.slice(0, 3).map((item) => `${item.tail}尾`).join("、")}`,
      tailCounts.slice(0, 4).map((item) => `${item.tail}尾`),
      [
        metric(
          "tail.top_share",
          "第一尾数占比",
          percent(tailCounts[0].count, total),
          `号码池基准 ${percent(tailBaseline, 1)}`,
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
      numberEvidenceScore,
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
      omissionEvidenceScore,
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
      shapeEvidenceScore,
      `重号率 ${analysis.repeatRate}%，连号率 ${analysis.consecutiveRate}%，三区 ${analysis.zones.join(":")}`,
      ["三区分布", "重号", "连号"],
      [
        metric(
          "shape.repeat",
          "相邻期重号率",
          `${analysis.repeatRate}%`,
          `随机基准 ${percent(randomRepeatRate(), 1)}`,
          analysis.repeatRate > randomRepeatRate() * 100 ? "up" : "down",
          draws.length,
        ),
        metric(
          "shape.consecutive",
          "正码连号率",
          `${analysis.consecutiveRate}%`,
          `随机基准 ${percent(randomConsecutiveRate(), 1)}`,
          analysis.consecutiveRate > randomConsecutiveRate() * 100 ? "up" : "down",
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

  const results: CandidateSet[] = [];
  const priorMainSets: number[][] = [];
  for (const id of ["balanced", "momentum", "contrarian"] as AiScenarioId[]) {
    const ranked = [...profiles].sort((a, b) => {
      const aReuse = priorMainSets.reduce(
        (count, values) => count + Number(values.includes(a.number)),
        0,
      );
      const bReuse = priorMainSets.reduce(
        (count, values) => count + Number(values.includes(b.number)),
        0,
      );
      const diversityPenalty = id === "balanced" ? 0 : id === "momentum" ? 0.2 : 0.16;
      const aScore = a[id] - aReuse * diversityPenalty;
      const bScore = b[id] - bReuse * diversityPenalty;
      return bScore - aScore || b.specialScore - a.specialScore || a.number - b.number;
    });
    const main = pickStructuredNumbers(
      ranked,
      focus,
      targetDrawAt,
      priorMainSets,
    );
    const special =
      [...profiles]
        .filter((item) => !main.includes(item.number))
        .sort(
          (a, b) =>
            (b.specialScore + b[id] * 0.35) - (a.specialScore + a[id] * 0.35) ||
            a.number - b.number,
        )[0]?.number ?? ranked.find((item) => !main.includes(item.number))?.number ?? 1;
    const selected = [...main, special];
    results.push({
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
    });
    priorMainSets.push(main);
  }
  return results;
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
  avoidSets: number[][] = [],
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
    const exceedsDiversityCap = avoidSets.some(
      (values) =>
        picked.filter((value) => values.includes(value)).length +
          Number(values.includes(number)) >
        2,
    );
    const parityCap = focus === "parity" ? 5 : 4;
    const waveCap = focus === "wave" ? 5 : 4;
    const zodiacCap = focus === "zodiac" ? 3 : 2;
    if (
      zoneCount >= 3 ||
      parityCount >= parityCap ||
      waveCount >= waveCap ||
      zodiacCount >= zodiacCap ||
      tailCount >= 2 ||
      exceedsDiversityCap
    ) {
      continue;
    }
    picked.push(number);
    if (picked.length === 6) break;
  }
  for (const item of ranked) {
    if (picked.length >= 6) break;
    const exceedsDiversityCap = avoidSets.some(
      (values) =>
        picked.filter((value) => values.includes(value)).length +
          Number(values.includes(item.number)) >
        2,
    );
    if (!picked.includes(item.number) && !exceedsDiversityCap) {
      picked.push(item.number);
    }
  }
  for (const item of ranked) {
    if (picked.length >= 6) break;
    if (!picked.includes(item.number)) picked.push(item.number);
  }
  return picked;
}

type BacktestBucket = {
  overlaps: number[];
  any: number;
  special: number;
  specialZodiac: number;
  specialZodiacBaselines: number[];
  stability: number[];
  previous: number[] | null;
};

const MIN_BACKTEST_SEGMENT = 20;
const SUPPORTED_WINDOW_COUNT = 4;
const MULTIPLE_COMPARISON_COUNT =
  AI_FOCUS_OPTIONS.length * SUPPORTED_WINDOW_COUNT;
const FAMILY_WISE_ALPHA = 0.05;
const VALIDATION_ALPHA =
  FAMILY_WISE_ALPHA / MULTIPLE_COMPARISON_COUNT;

function buildWalkForwardBacktest(
  draws: Draw[],
  focus: AiFocus,
  trainWindow: number,
): AiBacktest {
  const chronological = [...draws].reverse();
  const availableTargets = Math.max(chronological.length - trainWindow, 0);
  const selectionCount = Math.floor(availableTargets / 2);
  const selection = evaluateBacktestSegment({
    chronological,
    focus,
    trainWindow,
    start: trainWindow,
    end: trainWindow + selectionCount,
    role: "selection",
  });
  const holdout = evaluateBacktestSegment({
    chronological,
    focus,
    trainWindow,
    start: trainWindow + selectionCount,
    end: chronological.length,
    role: "holdout",
  });
  const baseline = randomBaseline();
  const sufficient =
    trainWindow >= 8 &&
    selection.testCount >= MIN_BACKTEST_SEGMENT &&
    holdout.testCount >= MIN_BACKTEST_SEGMENT;
  const selectedFromSelection = sufficient
    ? [...selection.strategies].sort(compareSelectionStrategies)[0] ?? null
    : null;
  const selectedStrategyId = selectedFromSelection?.id ?? null;
  const selectedHoldout = selectedStrategyId
    ? holdout.strategies.find((strategy) => strategy.id === selectedStrategyId) ?? null
    : null;
  const observedAdvantage = Boolean(
    sufficient &&
      selectedHoldout &&
      selectedHoldout.averageMainOverlapCI.low > baseline.averageMainOverlap &&
      selectedHoldout.randomPValue < VALIDATION_ALPHA,
  );
  const status: AiBacktest["status"] = !sufficient
    ? "insufficient"
    : observedAdvantage
      ? "observed_advantage"
      : "no_advantage";
  const decision: AiBacktest["decision"] =
    status === "observed_advantage" ? "recommend" : "abstain";
  const conclusion =
    status === "insufficient"
      ? `评估历史需至少包含 ${trainWindow + MIN_BACKTEST_SEGMENT * 2} 期，当前独立选择段 ${selection.testCount} 期、留出段 ${holdout.testCount} 期，不生成优势推荐。`
      : status === "observed_advantage" && selectedHoldout
        ? `${selectedHoldout.name}由选择段预先确定，并在 ${holdout.testCount} 期独立留出段通过多配置校正门槛；该结果仍需前瞻样本复核。`
        : `${selectedFromSelection?.name ?? "预选策略"}在 ${holdout.testCount} 期独立留出段未通过多窗口与维度尝试校正，本期保持弃权。`;

  return {
    method: "nested_holdout_walk_forward",
    trainWindow,
    evaluationHistorySize: chronological.length,
    selectionCount: selection.testCount,
    holdoutCount: holdout.testCount,
    testCount: holdout.testCount,
    noLookahead: true,
    multipleComparisonCount: MULTIPLE_COMPARISON_COUNT,
    validationAlpha: round6(VALIDATION_ALPHA),
    correction: "bonferroni",
    status,
    decision,
    selectedStrategyId,
    selection,
    holdout,
    strategies: holdout.strategies,
    baseline,
    conclusion,
  };
}

function evaluateBacktestSegment({
  chronological,
  focus,
  trainWindow,
  start,
  end,
  role,
}: {
  chronological: Draw[];
  focus: AiFocus;
  trainWindow: number;
  start: number;
  end: number;
  role: AiBacktestSegment["role"];
}): AiBacktestSegment {
  const buckets = new Map<AiScenarioId, BacktestBucket>();
  (["balanced", "momentum", "contrarian"] as AiScenarioId[]).forEach((id) =>
    buckets.set(id, {
      overlaps: [],
      any: 0,
      special: 0,
      specialZodiac: 0,
      specialZodiacBaselines: [],
      stability: [],
      previous: null,
    }),
  );
  const safeStart = Math.max(start, trainWindow);
  const safeEnd = Math.min(Math.max(end, safeStart), chronological.length);

  for (let index = safeStart; index < safeEnd; index += 1) {
    const training = chronological
      .slice(index - trainWindow, index)
      .reverse();
    if (training.length !== trainWindow) continue;
    const actual = chronological[index];
    const actualMain = new Set(actual.numbers);
    const forecast = buildAnalysis(training);
    const focused = buildFocusedCandidates(training, forecast, focus, actual.drawAt);
    focused.forEach((candidate) => {
      const bucket = buckets.get(candidate.id);
      if (!bucket) return;
      const overlap = candidate.numbers.filter((number) => actualMain.has(number)).length;
      const predictedZodiac = getZodiac(candidate.special, actual.drawAt);
      bucket.overlaps.push(overlap);
      if (overlap > 0) bucket.any += 1;
      if (candidate.special === actual.special) bucket.special += 1;
      if (predictedZodiac === getZodiac(actual.special, actual.drawAt)) {
        bucket.specialZodiac += 1;
      }
      bucket.specialZodiacBaselines.push(
        countNumbers((number) => getZodiac(number, actual.drawAt) === predictedZodiac) /
          49,
      );
      if (bucket.previous) {
        bucket.stability.push(jaccard(bucket.previous, candidate.numbers));
      }
      bucket.previous = candidate.numbers;
    });
  }

  const targetDraws = chronological.slice(safeStart, safeEnd);
  return {
    role,
    startIssue: targetDraws[0]?.issue ?? null,
    endIssue: targetDraws.at(-1)?.issue ?? null,
    testCount: targetDraws.length,
    strategies: (["balanced", "momentum", "contrarian"] as AiScenarioId[]).map(
      (id) => buildBacktestStrategy(id, buckets.get(id)!),
    ),
  };
}

function buildBacktestStrategy(
  id: AiScenarioId,
  bucket: BacktestBucket,
): AiBacktestStrategy {
  const sampleSize = bucket.overlaps.length;
  const totalMainOverlap = bucket.overlaps.reduce((sum, value) => sum + value, 0);
  const averageMainOverlap = average(bucket.overlaps);
  const baseline = randomBaseline();
  const randomPValue = exactMainOverlapUpperTailPValue(
    sampleSize,
    totalMainOverlap,
  );
  return {
    id,
    name: scenarioName(id),
    sampleSize,
    totalMainOverlap,
    averageMainOverlap: round4(averageMainOverlap),
    averageMainOverlapCI: bootstrapMeanInterval(
      bucket.overlaps,
      `${id}:${bucket.overlaps.join(",")}`,
    ),
    averageMainLift: round4(averageMainOverlap - baseline.averageMainOverlap),
    anyMainOverlapCount: bucket.any,
    anyMainOverlapRate: rate(bucket.any, sampleSize),
    anyMainOverlapCI: wilsonInterval(bucket.any, sampleSize),
    specialExactCount: bucket.special,
    specialExactRate: rate(bucket.special, sampleSize),
    specialExactCI: wilsonInterval(bucket.special, sampleSize),
    specialZodiacCount: bucket.specialZodiac,
    specialZodiacRate: rate(bucket.specialZodiac, sampleSize),
    specialZodiacCI: wilsonInterval(bucket.specialZodiac, sampleSize),
    specialZodiacBaseline: round4(average(bucket.specialZodiacBaselines) * 100),
    stabilityScore: round4(average(bucket.stability) * 100),
    randomPValue: round6(randomPValue),
    evidenceScore: sampleSize ? Math.round((1 - randomPValue) * 100) : 0,
  };
}

function compareSelectionStrategies(
  left: AiBacktestStrategy,
  right: AiBacktestStrategy,
) {
  return (
    right.totalMainOverlap - left.totalMainOverlap ||
    right.anyMainOverlapCount - left.anyMainOverlapCount ||
    right.specialExactCount - left.specialExactCount ||
    left.id.localeCompare(right.id)
  );
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
    const otherCandidates = candidates.filter((item) => item.id !== candidate.id);
    const pairwiseOverlaps = otherCandidates.map(
      (item) =>
        candidate.numbers.filter((number) => item.numbers.includes(number)).length,
    );
    const pairwiseJaccards = otherCandidates.map((item) =>
      jaccard(candidate.numbers, item.numbers),
    );
    const uniqueMainNumbers = candidate.numbers.filter((number) =>
      otherCandidates.every((item) => !item.numbers.includes(number)),
    ).length;
    const confirmedScenario =
      backtest.decision === "recommend" &&
      backtest.selectedStrategyId === candidate.id;
    const evidenceScore =
      backtest.status === "insufficient"
        ? 0
        : confirmedScenario
          ? backtestResult?.evidenceScore ?? 0
          : Math.min(backtestResult?.evidenceScore ?? 0, 49);
    return {
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      numbers: candidate.numbers,
      special: candidate.special,
      evidenceScore,
      diversity: {
        uniqueMainNumbers,
        maxMainOverlap: Math.max(...pairwiseOverlaps, 0),
        averageJaccard: round4(average(pairwiseJaccards)),
        score: Math.round((1 - average(pairwiseJaccards)) * 100),
      },
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
          ? `独立留出段平均覆盖 ${backtestResult.averageMainOverlap} 个正码`
          : "等待回测数据",
        `与其余场景最大重合 ${Math.max(...pairwiseOverlaps, 0)} 个主号`,
      ],
      counterEvidence: [
        candidate.id === "momentum"
          ? "近期热度可能回归均值。"
          : candidate.id === "contrarian"
            ? "遗漏不构成号码必须回补的义务。"
            : "结构均衡不改变每个组合的理论机会。",
        backtest.decision === "abstain"
          ? "独立留出回测未达到优势推荐门槛。"
          : "留出优势仍需持续前瞻验证。",
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
  const leaders = [...dimensions]
    .sort((a, b) => b.evidenceScore - a.evidenceScore)
    .slice(0, 3);
  const selected = backtest.selectedStrategyId
    ? backtest.holdout.strategies.find(
      (item) => item.id === backtest.selectedStrategyId,
    ) ?? null
    : null;
  const score =
    backtest.status === "observed_advantage" && selected
      ? selected.evidenceScore
      : backtest.status === "no_advantage" && selected
        ? Math.min(selected.evidenceScore, 49)
        : 0;
  return {
    kind: "evidence_strength_not_win_probability",
    score,
    label:
      backtest.status === "observed_advantage"
        ? "中等"
        : backtest.status === "no_advantage"
          ? "有限"
          : "低",
    drivers: selected
      ? [
        `选择段预选 ${selected.name}`,
        `独立留出 ${backtest.holdoutCount} 期`,
        ...leaders.map((item) => `${item.label}校准证据 ${item.evidenceScore}`),
      ].slice(0, 3)
      : leaders.map((item) => `${item.label}校准证据 ${item.evidenceScore}`),
    penalties: [
      backtest.status === "insufficient"
        ? `训练 ${sampleSize} 期之外缺少独立选择段与留出段`
        : backtest.status === "no_advantage"
          ? "独立留出段未观察到高于随机的可靠优势"
          : "历史留出优势仍不能替代前瞻验证",
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
    pack.backtest.decision === "recommend" && pack.backtest.selectedStrategyId
      ? pack.candidateSets.find(
        (item) => item.id === pack.backtest.selectedStrategyId,
      ) ?? null
      : null;
  return {
    headline: `${GAME_META[pack.game].shortName} · ${focusLabel}多策略研判`,
    executiveSummary: recommended
      ? `当前最值得观察的是${preferredDimension.label}维度：${preferredDimension.direction}。${recommended.name}由选择段预先确定，并通过独立留出门槛；仍需前瞻样本复核。`
      : `当前最值得观察的是${preferredDimension.label}维度：${preferredDimension.direction}。独立留出回测尚未证明三路场景优于随机基准，本期不作优势推荐。`,
    recommendedScenarioId: recommended?.id ?? null,
    recommendationReason: recommended
      ? `${recommended.name}通过独立留出门槛，校准证据 ${recommended.evidenceScore}。`
      : "选择段与留出段相互独立；当前留出结果不足以支持优势推荐，系统保持弃权。",
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

function level(score: number): AiSignalLevel {
  if (score >= 95) return "moderate";
  if (score >= 80) return "weak";
  return "neutral";
}

export function randomBaseline() {
  const noOverlap = combinationRatio(43, 6, 49, 6);
  return {
    averageMainOverlap: round6((6 * 6) / 49),
    anyMainOverlapRate: round6((1 - noOverlap) * 100),
    specialExactRate: round6((1 / 49) * 100),
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

function normalizeHistory(draws: Draw[]) {
  const sorted = draws
    .filter(isValidDraw)
    .map((draw) => ({ ...draw, numbers: [...draw.numbers] }))
    .sort(
      (a, b) =>
        drawTimeValue(b) - drawTimeValue(a) ||
        b.issue.localeCompare(a.issue, "en", { numeric: true }) ||
        [...a.numbers, a.special].join(",").localeCompare(
          [...b.numbers, b.special].join(","),
        ),
    );
  const seen = new Set<string>();
  return sorted.filter((draw) => {
    const key = `${draw.game}:${draw.issue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function drawTimeValue(draw: Draw) {
  const value = Date.parse(draw.drawAt);
  return Number.isFinite(value) ? value : 0;
}

function countNumbers(predicate: (number: number) => boolean) {
  let count = 0;
  for (let number = 1; number <= 49; number += 1) {
    if (predicate(number)) count += 1;
  }
  return count;
}

function countRepeatEvents(draws: Draw[]) {
  let count = 0;
  for (let index = 0; index < draws.length - 1; index += 1) {
    const current = new Set([...draws[index].numbers, draws[index].special]);
    const previous = [...draws[index + 1].numbers, draws[index + 1].special];
    if (previous.some((number) => current.has(number))) count += 1;
  }
  return count;
}

function countConsecutiveEvents(draws: Draw[]) {
  return draws.filter((draw) => {
    const sorted = [...draw.numbers].sort((a, b) => a - b);
    return sorted.some(
      (number, index) => index > 0 && number - sorted[index - 1] === 1,
    );
  }).length;
}

function randomRepeatRate() {
  return 1 - combination(42, 7) / combination(49, 7);
}

function randomConsecutiveRate() {
  return 1 - combination(44, 6) / combination(49, 6);
}

function confidenceScoreFromBinomial(
  observed: number,
  trials: number,
  probability: number,
  {
    twoSided = false,
    multiplicity = 1,
  }: { twoSided?: boolean; multiplicity?: number } = {},
) {
  const rawPValue = twoSided
    ? exactBinomialTwoSidedPValue(observed, trials, probability)
    : exactBinomialUpperTailPValue(observed, trials, probability);
  return confidenceScoreFromPValue(adjustedPValue(rawPValue, multiplicity));
}

function confidenceScoreFromPValue(pValue: number) {
  return clamp(Math.round((1 - clamp(pValue, 0, 1)) * 100), 0, 99);
}

function adjustedPValue(pValue: number, multiplicity: number) {
  return Math.min(1, Math.max(0, pValue) * Math.max(multiplicity, 1));
}

function exactBinomialTwoSidedPValue(
  observed: number,
  trials: number,
  probability: number,
) {
  if (trials <= 0) return 1;
  const upper = exactBinomialUpperTailPValue(observed, trials, probability);
  const lower = exactBinomialLowerTailPValue(observed, trials, probability);
  return Math.min(1, 2 * Math.min(upper, lower));
}

function exactBinomialUpperTailPValue(
  observed: number,
  trials: number,
  probability: number,
) {
  if (trials <= 0) return 1;
  if (observed <= 0) return 1;
  if (observed > trials) return 0;
  let total = 0;
  for (let value = observed; value <= trials; value += 1) {
    total += binomialProbability(trials, value, probability);
  }
  return clamp(total, 0, 1);
}

function exactBinomialLowerTailPValue(
  observed: number,
  trials: number,
  probability: number,
) {
  if (trials <= 0) return 1;
  if (observed < 0) return 0;
  if (observed >= trials) return 1;
  let total = 0;
  for (let value = 0; value <= observed; value += 1) {
    total += binomialProbability(trials, value, probability);
  }
  return clamp(total, 0, 1);
}

function binomialProbability(trials: number, successes: number, probability: number) {
  if (probability <= 0) return successes === 0 ? 1 : 0;
  if (probability >= 1) return successes === trials ? 1 : 0;
  let logCombination = 0;
  const k = Math.min(successes, trials - successes);
  for (let index = 1; index <= k; index += 1) {
    logCombination +=
      Math.log(trials - k + index) -
      Math.log(index);
  }
  return Math.exp(
    logCombination +
      successes * Math.log(probability) +
      (trials - successes) * Math.log1p(-probability),
  );
}

const mainOverlapDistributionCache = new Map<number, number[]>();

function exactMainOverlapUpperTailPValue(
  sampleSize: number,
  observedTotal: number,
) {
  if (sampleSize <= 0) return 1;
  const distribution = mainOverlapDistribution(sampleSize);
  return clamp(
    distribution
      .slice(Math.max(observedTotal, 0))
      .reduce((sum, probability) => sum + probability, 0),
    0,
    1,
  );
}

function mainOverlapDistribution(sampleSize: number) {
  const cached = mainOverlapDistributionCache.get(sampleSize);
  if (cached) return cached;
  const single = Array.from(
    { length: 7 },
    (_, overlap) =>
      (combination(6, overlap) * combination(43, 6 - overlap)) /
      combination(49, 6),
  );
  let distribution = [1];
  for (let drawIndex = 0; drawIndex < sampleSize; drawIndex += 1) {
    const next = Array(distribution.length + 6).fill(0) as number[];
    distribution.forEach((currentProbability, total) => {
      single.forEach((probability, overlap) => {
        next[total + overlap] += currentProbability * probability;
      });
    });
    distribution = next;
  }
  mainOverlapDistributionCache.set(sampleSize, distribution);
  return distribution;
}

export function wilsonInterval(
  successes: number,
  trials: number,
): AiConfidenceInterval {
  if (trials <= 0) {
    return { low: 0, high: 0, level: 95, method: "wilson" };
  }
  const z = 1.959963984540054;
  const proportion = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (proportion + (z * z) / (2 * trials)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt(
      (proportion * (1 - proportion)) / trials +
        (z * z) / (4 * trials * trials),
    );
  return {
    low: round4(Math.max(0, center - margin) * 100),
    high: round4(Math.min(1, center + margin) * 100),
    level: 95,
    method: "wilson",
  };
}

function bootstrapMeanInterval(
  values: number[],
  seed: string,
): AiConfidenceInterval {
  if (!values.length) {
    return { low: 0, high: 0, level: 95, method: "bootstrap_percentile" };
  }
  if (values.length === 1) {
    return {
      low: values[0],
      high: values[0],
      level: 95,
      method: "bootstrap_percentile",
    };
  }
  const random = seededRandom(seed);
  const samples = Array.from({ length: 2_000 }, () => {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)];
    }
    return total / values.length;
  }).sort((a, b) => a - b);
  return {
    low: round4(percentile(samples, 0.025)),
    high: round4(percentile(samples, 0.975)),
    level: 95,
    method: "bootstrap_percentile",
  };
}

function percentile(sortedValues: number[], quantile: number) {
  const position = (sortedValues.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const fraction = position - lowerIndex;
  return (
    sortedValues[lowerIndex] * (1 - fraction) +
    sortedValues[upperIndex] * fraction
  );
}

function seededRandom(seed: string) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function rate(count: number, total: number) {
  return round4((count / Math.max(total, 1)) * 100);
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

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function round6(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
