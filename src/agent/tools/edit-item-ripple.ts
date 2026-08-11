import { makeDraft } from '../../editor/store';
import type { MediaAsset, MediaAssetKind, TimelineItem, TimelineState } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';

type OpResult = Record<string, unknown>;

export interface RippleBatchConflict {
  planIndex: number;
  error: string;
}

function assetKindForPlan(plan: OpResult): MediaAssetKind | null {
  if (plan.plan === 'addMg') return 'motion-graphic';
  if (plan.plan === 'addAudio') return 'audio';
  if (plan.plan !== 'addMedia') return null;
  const kind = String(plan.kind ?? '');
  return ['video', 'image', 'audio', 'motion-graphic', 'gif', 'svg'].includes(kind)
    ? kind as MediaAssetKind
    : null;
}

function overlaps(a: TimelineItem, b: TimelineItem): boolean {
  return a.track === b.track
    && a.startFrame < b.startFrame + b.durationInFrames
    && b.startFrame < a.startFrame + a.durationInFrames;
}

/**
 * Dry-run ordered ripple adds through the real EditorCommands selectors and
 * reducer. This keeps implicit main-media/MG lane creation and earlier ripple
 * shifts identical to the eventual commit without touching the live project.
 */
export function rippleBatchInsertionConflict(
  state: TimelineState,
  plans: readonly OpResult[],
  ripple: boolean,
): RippleBatchConflict | null {
  if (!ripple) return null;
  const draft = makeDraft(docFromTimeline(state));
  const plannedItemOwners = new Map<string, number>();

  for (const [planIndex, plan] of plans.entries()) {
    const kind = assetKindForPlan(plan);
    if (!kind) continue;
    const durationInFrames = typeof plan.durationInFrames === 'number'
      ? Math.max(1, Math.round(plan.durationInFrames))
      : 1;
    const asset: MediaAsset = {
      id: `__ripple_plan_${planIndex}`,
      name: `Planned add ${planIndex}`,
      kind,
      src: '',
      durationInFrames,
    };

    let itemId: string;
    try {
      itemId = draft.commands.addMediaItem(asset, {
        track: typeof plan.track === 'string' ? plan.track : undefined,
        startFrame: typeof plan.startFrame === 'number' ? plan.startFrame : undefined,
        ripple: true,
      });
    } catch (error) {
      return {
        planIndex,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const after = draft.getState();
    const added = after.items.find((item) => item.id === itemId);
    if (!added) {
      return { planIndex, error: `ripple add did not create an item for plan ${planIndex}` };
    }
    const covering = after.items.find((item) => item.id !== itemId && overlaps(added, item));
    if (covering) {
      const blocker = plannedItemOwners.has(covering.id)
        ? `planned-add-${plannedItemOwners.get(covering.id)}`
        : covering.id;
      return {
        planIndex,
        error: `ripple insertion frame ${added.startFrame} is inside item ${blocker} on track ${added.track}; choose an existing clip boundary or split the clip first`,
      };
    }
    plannedItemOwners.set(itemId, planIndex);
  }
  return null;
}
