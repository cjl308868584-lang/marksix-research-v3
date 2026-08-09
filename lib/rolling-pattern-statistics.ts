export function poissonBinomialUpperTail(
  probabilities: readonly number[],
  hits: number,
) {
  if (hits <= 0) return 1;
  if (hits > probabilities.length) return 0;
  const probabilityMass = Array<number>(probabilities.length + 1).fill(0);
  probabilityMass[0] = 1;
  probabilities.forEach((rawProbability, index) => {
    const probability = Math.max(0, Math.min(1, rawProbability));
    for (let count = index + 1; count >= 0; count -= 1) {
      probabilityMass[count] = probabilityMass[count] * (1 - probability) +
        (count > 0 ? probabilityMass[count - 1] * probability : 0);
    }
  });
  return probabilityMass
    .slice(hits)
    .reduce((sum, probability) => sum + probability, 0);
}

export function benjaminiHochberg<T>(
  rows: readonly T[],
  getPValue: (row: T) => number,
): Array<T & { qValue: number }> {
  if (!rows.length) return [];
  const ranked = rows.map((row, index) => ({
    row,
    index,
    pValue: Math.max(0, Math.min(1, getPValue(row))),
    qValue: 1,
  })).sort((left, right) =>
    left.pValue - right.pValue || left.index - right.index
  );
  let nextQValue = 1;
  for (let index = ranked.length - 1; index >= 0; index -= 1) {
    const adjusted = ranked[index].pValue * ranked.length / (index + 1);
    nextQValue = Math.min(nextQValue, adjusted, 1);
    ranked[index].qValue = nextQValue;
  }
  return ranked
    .sort((left, right) => left.index - right.index)
    .map(({ row, qValue }) => ({ ...row, qValue }));
}
