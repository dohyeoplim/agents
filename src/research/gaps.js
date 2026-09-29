export const normalizeGap = (gap) => gap.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

export function reconcileGaps(assessment, knownGaps = []) {
    const registry = knownGaps.map((gap) => ({ ...gap }));
    const byId = new Map(registry.map((gap) => [gap.id, gap]));
    const byText = new Map(registry.map((gap) => [normalizeGap(gap.text), gap]));
    let sequence = registry.reduce((max, gap) => Math.max(max, Number(gap.id.slice(1))), 0);
    const newGaps = [];
    for (const [index, text] of assessment.gaps.entries()) {
        const normalized = normalizeGap(text);
        if (!normalized) continue;
        const existing = byId.get(assessment.gapIds?.[index]) || byText.get(normalized);
        if (existing) continue;
        const gap = { id: `g${++sequence}`, text };
        registry.push(gap);
        byText.set(normalized, gap);
        newGaps.push(text);
    }
    return { knownGaps: registry, newGaps };
}
