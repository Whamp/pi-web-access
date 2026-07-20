/** Workflow metadata for anonymous paired web-search answer judging. */
export const meta = {
  name: 'web_search_answer_tournament',
  description: 'Blindly compare paired web-search answers with independent batched judges and adjudication',
  phases: [{ title: 'Judge' }, { title: 'Adjudicate' }],
};

const RAW_PAIRS = Array.isArray(args?.pairs) ? args.pairs : [];
const INLINE_PAIRS = RAW_PAIRS
  .filter(pair => pair && typeof pair.id === 'string' && typeof pair.question === 'string'
    && typeof pair.answer0 === 'string' && typeof pair.answer1 === 'string')
  .slice(0, 20);
const PAIRS_PATH = typeof args?.pairsPath === 'string' ? args.pairsPath : null;
const PATH_IDS = Array.isArray(args?.pairIds)
  ? args.pairIds.filter(id => typeof id === 'string').slice(0, 20)
  : [];
const PAIR_IDS = INLINE_PAIRS.length > 0 ? INLINE_PAIRS.map(pair => pair.id) : PATH_IDS;
if (PAIR_IDS.length === 0 || (INLINE_PAIRS.length === 0 && PAIRS_PATH === null)) {
  throw new Error('Supply inline pairs or pairsPath with pairIds');
}
const PAIR_PAYLOAD = INLINE_PAIRS.length > 0
  ? JSON.stringify(INLINE_PAIRS)
  : `Read exactly ${PAIRS_PATH}. It contains the anonymous pairs for ids ${PAIR_IDS.join(', ')}. Do not inspect any adjacent file.`;

const SCORE_SHAPE = {
  type: 'object',
  properties: {
    correctness: { type: 'integer', minimum: 1, maximum: 5 },
    completeness: { type: 'integer', minimum: 1, maximum: 5 },
    sourceQuality: { type: 'integer', minimum: 1, maximum: 5 },
    directness: { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['correctness', 'completeness', 'sourceQuality', 'directness'],
};
const JUDGMENT_SHAPE = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    winner: { type: 'integer', enum: [-1, 0, 1] },
    answer0: SCORE_SHAPE,
    answer1: SCORE_SHAPE,
    fatalErrors0: { type: 'array', items: { type: 'string' } },
    fatalErrors1: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['id', 'winner', 'answer0', 'answer1', 'fatalErrors0', 'fatalErrors1', 'reason'],
};
const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    judgments: {
      type: 'array',
      minItems: PAIR_IDS.length,
      maxItems: PAIR_IDS.length,
      items: JUDGMENT_SHAPE,
    },
  },
  required: ['judgments'],
};

function judgePrompt(lens, pairPayload) {
  return `Judge each anonymous answer pair. Apart from reading an explicitly supplied anonymous-pairs path, do not call tools, inspect other files, or infer which system wrote either answer.

Lens: ${lens}

Score correctness, completeness, authoritative citation support, and directness from 1 to 5. Penalize invented APIs, unsupported dates, mismatched citations, and evasion. Winner -1 means a genuine tie. Return exactly one judgment for every supplied id.

Pairs:
${pairPayload}`;
}

phase('Judge');
const INITIAL_BATCHES = await parallel([
  () => agent(judgePrompt('Prioritize technical correctness and whether each citation supports the nearby claim.', PAIR_PAYLOAD), {
    label: 'judge:openai',
    model: 'openai-codex/gpt-5.6-luna:xhigh',
    schema: BATCH_SCHEMA,
  }),
  () => agent(judgePrompt('Be an independent skeptical reviewer; prioritize omissions, misleading wording, and citation quality.', PAIR_PAYLOAD), {
    label: 'judge:glm',
    model: 'zai/glm-5.2',
    schema: BATCH_SCHEMA,
  }),
]);
const OPENAI_BY_ID = Object.fromEntries((INITIAL_BATCHES[0]?.judgments ?? []).map(item => [item.id, item]));
const GLM_BY_ID = Object.fromEntries((INITIAL_BATCHES[1]?.judgments ?? []).map(item => [item.id, item]));
const INITIAL_RESULTS = PAIR_IDS.map(id => ({
  id,
  openai: OPENAI_BY_ID[id] ?? null,
  glm: GLM_BY_ID[id] ?? null,
}));
const DISPUTES = INITIAL_RESULTS.filter(item => item.openai !== null && item.glm !== null
  && item.openai.winner !== item.glm.winner);

phase('Adjudicate');
const ADJUDICATION_SCHEMA = {
  type: 'object',
  properties: {
    judgments: {
      type: 'array',
      minItems: DISPUTES.length,
      maxItems: DISPUTES.length,
      items: JUDGMENT_SHAPE,
    },
  },
  required: ['judgments'],
};
const ADJUDICATION_BATCH = DISPUTES.length === 0
  ? { judgments: [] }
  : await agent(judgePrompt('Resolve only these disagreements conservatively. Treat earlier judgments as advice, not authority.', `${PAIR_PAYLOAD}\n\nDisagreements to resolve:\n${JSON.stringify(DISPUTES)}`), {
      label: 'adjudicate:disputes',
      model: 'openai-codex/gpt-5.6-sol:high',
      schema: ADJUDICATION_SCHEMA,
    });
const ADJUDICATION_BY_ID = Object.fromEntries((ADJUDICATION_BATCH?.judgments ?? []).map(item => [item.id, item]));

const RESULTS = INITIAL_RESULTS.map(item => {
  const AVAILABLE = [item.openai, item.glm].filter(value => value !== null);
  const AGREEMENT = AVAILABLE.length === 2 && item.openai.winner === item.glm.winner;
  const ADJUDICATION = ADJUDICATION_BY_ID[item.id] ?? null;
  let finalWinner = null;
  let decision = 'missing';
  if (AVAILABLE.length === 1) {
    finalWinner = AVAILABLE[0].winner;
    decision = 'single-judge';
  } else if (AGREEMENT) {
    finalWinner = item.openai.winner;
    decision = 'agreement';
  } else if (AVAILABLE.length === 2) {
    finalWinner = ADJUDICATION?.winner ?? null;
    decision = ADJUDICATION === null ? 'adjudication-failed' : 'adjudicated';
  }
  return {
    id: item.id,
    openai: item.openai,
    glm: item.glm,
    agreement: AGREEMENT,
    adjudication: ADJUDICATION,
    finalWinner,
    decision,
  };
});

return {
  version: 1,
  results: RESULTS,
  coverage: {
    intendedPairs: PAIR_IDS.length,
    openaiJudgments: INITIAL_RESULTS.filter(item => item.openai !== null).length,
    glmJudgments: INITIAL_RESULTS.filter(item => item.glm !== null).length,
    disputes: DISPUTES.length,
    adjudications: Object.keys(ADJUDICATION_BY_ID).length,
    completeDecisions: RESULTS.filter(result => result.finalWinner !== null).length,
  },
  complete: RESULTS.every(result => result.finalWinner !== null),
};
