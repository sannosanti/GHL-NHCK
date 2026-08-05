'use strict';

/**
 * Statistics for a clustered, paired evaluation design.
 *
 * Two properties of this design drive everything here:
 *
 *  1. CLUSTERED. Each conversation is replayed N times. Those N runs are highly
 *     correlated — same prompt, same customer messages, same model. Pooling them
 *     as N independent observations inflates the sample by a factor of N and
 *     shrinks every confidence interval by ~√N. The unit of independence is the
 *     CONVERSATION, not the turn and not the repetition.
 *
 *  2. PAIRED. All three models answer exactly the same conversations. Comparing
 *     two independent intervals and checking for overlap throws that away — it is
 *     strictly less powerful than comparing the models case by case, and it can
 *     call a real difference "not demonstrated" purely because both intervals are
 *     wide.
 */

/** Deterministic RNG so a re-run of the report reproduces the same intervals. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Wilson score interval. Kept for the rare genuinely-independent proportion; NOT
 * used for the clustered metrics, where it would understate uncertainty.
 */
function wilson(passed, n, z = 1.96) {
  if (!n) return { point: null, lo: null, hi: null, n: 0 };
  const p = passed / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { point: p, lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d), n };
}

/**
 * Cluster bootstrap: resample whole clusters (conversations) with replacement.
 *
 * `statFn(sample)` receives an array of cluster objects and returns a number (or
 * null when undefined for that resample, e.g. a rate with an empty denominator).
 */
function clusterBootstrap(clusters, statFn, { B = 2000, seed = 42, alpha = 0.05 } = {}) {
  const point = statFn(clusters);
  if (!clusters.length) return { point, lo: null, hi: null, clusters: 0, B: 0 };

  const rnd = mulberry32(seed);
  const draws = [];
  for (let b = 0; b < B; b++) {
    const sample = new Array(clusters.length);
    for (let i = 0; i < clusters.length; i++) sample[i] = clusters[(rnd() * clusters.length) | 0];
    const v = statFn(sample);
    if (v !== null && Number.isFinite(v)) draws.push(v);
  }
  if (draws.length < B * 0.5) return { point, lo: null, hi: null, clusters: clusters.length, B: draws.length };

  draws.sort((a, b) => a - b);
  const q = p => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))];
  return { point, lo: q(alpha / 2), hi: q(1 - alpha / 2), clusters: clusters.length, B: draws.length };
}

/**
 * Paired cluster bootstrap for a difference (candidate − baseline).
 *
 * Both models are evaluated on the SAME resampled conversations every iteration,
 * so per-conversation difficulty cancels out. If the interval excludes 0 the
 * difference is real at that level.
 */
function pairedBootstrap(pairs, statFn, { B = 2000, seed = 42, alpha = 0.05 } = {}) {
  const diff = sample => {
    const a = statFn(sample.map(p => p.baseline));
    const b = statFn(sample.map(p => p.candidate));
    return a === null || b === null ? null : b - a;
  };
  const out = clusterBootstrap(pairs, diff, { B, seed, alpha });
  return { ...out, significant: out.lo !== null && (out.lo > 0 || out.hi < 0) };
}

/** log(n!) via Lanczos, so the exact binomial stays stable for large n. */
function logFactorial(n) {
  if (n < 2) return 0;
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * McNemar's exact test on paired binary outcomes.
 *
 * Only the DISCORDANT pairs carry information: `b` = baseline right / candidate
 * wrong, `c` = baseline wrong / candidate right. Cases where both agree tell you
 * nothing about which is better, which is exactly why the paired test is more
 * powerful than comparing two marginal rates.
 */
function mcnemar(pairs) {
  let b = 0, c = 0, both = 0, neither = 0;
  const discordant = { baselineOnly: [], candidateOnly: [] };
  for (const p of pairs) {
    if (p.baselineOk && !p.candidateOk) { b++; discordant.baselineOnly.push(p.id); }
    else if (!p.baselineOk && p.candidateOk) { c++; discordant.candidateOnly.push(p.id); }
    else if (p.baselineOk) both++;
    else neither++;
  }
  const n = b + c;
  let p = 1;
  if (n > 0) {
    const k = Math.min(b, c);
    let tail = 0;
    for (let i = 0; i <= k; i++) {
      tail += Math.exp(logFactorial(n) - logFactorial(i) - logFactorial(n - i) + n * Math.log(0.5));
    }
    p = Math.min(1, 2 * tail);
  }
  return { b, c, both, neither, n, p, significant: n > 0 && p < 0.05, discordant };
}

module.exports = { wilson, clusterBootstrap, pairedBootstrap, mcnemar, mulberry32 };
