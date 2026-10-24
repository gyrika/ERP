import type { Actor } from './auth.ts';
import {
  checkAnswer, makesLoop, MAX_OWN_LINES, questionKind, UNITS, type Answer, type RecipeEvent,
} from './costing.ts';
import { MAX_RESOURCE_LINES, RESOURCE_KINDS } from './resources.ts';

/**
 * Draft and published recipes (Visual Flow). A published recipe is the owner's answer as it
 * stands (recipe.answer_set): the costs, the stock a sale takes, everything reads it, and each
 * sale used the answers in force when it was made (stockUsage.ts), so publishing a new version
 * never rewrites what was made before. A draft (recipe.draft_set) is his change still being
 * worked on: it is synced and kept like his answers, so it survives a restart and shows on every
 * device, but nothing counts it until he publishes. Publishing one question writes its answer,
 * which also closes its draft; dropping a draft is a draft_set with `after: null`.
 */
type DraftEvent = Extract<RecipeEvent, { type: 'recipe.draft_set' }>;
type AnswerEvent = Extract<RecipeEvent, { type: 'recipe.answer_set' }>;

export interface Draft { question: string; answer: Answer; at: number; by: string }

/** The open drafts, by question: a later draft wins, a publish of the same question closes it. */
export const draftsFromEvents = (events: readonly { type: string }[]): Map<string, Draft> => {
  const drafts = new Map<string, Draft>();
  for (const e of events) {
    if (e.type === 'recipe.draft_set') {
      const d = e as DraftEvent;
      if (d.after) drafts.set(d.question, { question: d.question, answer: d.after, at: d.at, by: d.actor.name });
      else drafts.delete(d.question);
    } else if (e.type === 'recipe.answer_set') {
      // Published here, or changed on the Recipes screen meanwhile: either way the draft is done.
      drafts.delete((e as AnswerEvent).question);
    }
  }
  return drafts;
};

/**
 * The answers as they would be with the drafts published: what the canvas shows while he works.
 * A draft that would put an item inside itself is left out, as answersFromEvents leaves it out.
 */
export const withDrafts = (answers: ReadonlyMap<string, Answer>, drafts: ReadonlyMap<string, Draft>): Map<string, Answer> => {
  const out = new Map(answers);
  for (const [q, d] of drafts) {
    // A batch whose size he has not typed yet keeps the published one meanwhile (no divide by 0).
    const sized = (d.answer.kind !== 'batch' && d.answer.kind !== 'prep') || d.answer.makes.qty > 0;
    if (sized && !makesLoop(q, d.answer, out)) out.set(q, d.answer);
  }
  return out;
};

export interface Version { n: number; at: number; by: string; answer: Answer | null }

/** Every published version of one answer, oldest first (v1 is his first answer to it). */
export const versionsOf = (events: readonly { type: string }[], question: string): Version[] => {
  const out: Version[] = [];
  for (const e of events) {
    if (e.type !== 'recipe.answer_set') continue;
    const a = e as AnswerEvent;
    if (a.question === question) out.push({ n: out.length + 1, at: a.at, by: a.actor.name, answer: a.after });
  }
  return out;
};

export interface PublishStep { question: string; before: Answer | null; after: Answer; problem: string | null }

/** What publishing the drafts would write, each with what stops it (null: ready). */
export const publishPlan = (answers: ReadonlyMap<string, Answer>, drafts: ReadonlyMap<string, Draft>): PublishStep[] => {
  const trial = new Map(answers);
  const steps: PublishStep[] = [];
  for (const [question, d] of [...drafts].sort(([a], [b]) => a.localeCompare(b))) {
    const problem = checkAnswer(question, d.answer)
      ?? (makesLoop(question, d.answer, trial) ? 'It would go inside itself.' : null);
    if (!problem) trial.set(question, d.answer);
    steps.push({ question, before: answers.get(question) ?? null, after: d.answer, problem });
  }
  return steps;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KINDS = new Set(['yield', 'source', 'price', 'recipe', 'own', 'prep', 'batch', 'resources', 'rates']);

/**
 * Null when a draft is the right shape to keep (the server checks the same). Looser than
 * checkAnswer: a stage just added has no lines yet, an amount may still be 0; publishing
 * checks it in full.
 */
export const checkDraft = (question: string, a: unknown): string | null => {
  if (!isObj(a) || typeof a.kind !== 'string' || !KINDS.has(a.kind)) return 'That is not a recipe change.';
  if (typeof question !== 'string' || !question.includes(':') || question.length > 200) return 'That is not a recipe change.';
  if (!questionKind(question)) return 'That is not a recipe change.';
  if ('lines' in a) {
    if (!Array.isArray(a.lines)) return 'That is not a recipe change.';
    const max = a.kind === 'resources' ? MAX_RESOURCE_LINES : MAX_OWN_LINES;
    if (a.lines.length > max) return `At most ${max} lines.`;
    for (const l of a.lines) {
      if (!isObj(l)) return 'A line is not a line.';
      if (a.kind === 'resources') {
        if (!RESOURCE_KINDS.includes(l.kind as never)) return 'Choose what each cost is.';
        continue;
      }
      if (typeof l.name !== 'string' || l.name.length > 120 || typeof l.qty !== 'number' || !Number.isFinite(l.qty) || l.qty < 0
        || !(UNITS as readonly string[]).includes(String(l.unit))) return 'A line is not a line.';
    }
  }
  return null;
};

/** One draft change, as a recipe.draft_set (actor: the owner). */
export const draftEvent = (question: string, after: Answer | null, actor: Actor, at = Date.now()) =>
  ({ type: 'recipe.draft_set' as const, at, orderNumber: 0 as const, actor, question, after });
