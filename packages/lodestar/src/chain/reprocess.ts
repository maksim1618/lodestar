import {Slot, RootHex} from "@chainsafe/lodestar-types";
import {IMetrics} from "../metrics";
import {MapDef} from "../util/map";

/**
 * To prevent our node from having to reprocess while struggling to sync,
 * we only want to reprocess attestations if block reaches our node before this time.
 */
export const REPROCESS_MIN_TIME_TO_NEXT_SLOT_SEC = 2;

type AwaitingAttestationPromise = {
  resolve: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reject: (reason?: any) => void;
};

// How many attestations (aggregate + unaggregate) we keep before new ones get dropped.
const MAXIMUM_QUEUED_ATTESTATIONS = 16_384;

type SlotRoot = {slot: Slot; root: RootHex};

enum ReprocessError {
  /**
   * There are too many attestations that have unknown block root.
   */
  REACH_LIMITATION = "ERR_REPROCESS_REACH_LIMITATION",
  /**
   * The awaiting attestation is pruned per clock slot.
   */
  EXPIRED = "ERR_REPROCESS_EXPIRED",
}

/**
 * Some attestations may reach our node before the voted block, so we manage a cache to reprocess them
 * when the block come.
 * (n)                                               (n + 1)
 *  |----------------|----------------|----------|------|
 *                   |                |          |
 *                  att           agg att        |
 *                                              block
 * Since the gossip handler has to return validation result to js-libp2p-gossipsub, this class should not
 * reprocess attestations, it should control when the attestations are ready to reprocess instead.
 */
export class ReprocessController {
  private readonly awaitingPromisesByRootBySlot: MapDef<Slot, MapDef<RootHex, AwaitingAttestationPromise[]>>;
  private awaitingPromisesCount = 0;

  constructor(private readonly metrics: IMetrics | null) {
    this.awaitingPromisesByRootBySlot = new MapDef(
      () => new MapDef<RootHex, AwaitingAttestationPromise[]>(() => [])
    );
  }

  /**
   * Handle unknown block root for both unaggregated and aggregated attestations
   */
  waitForBlock({slot, root}: SlotRoot): Promise<void> {
    this.metrics?.reprocessAttestations.total.inc();
    const promise = new Promise<void>((resolve, reject) => {
      if (this.awaitingPromisesCount >= MAXIMUM_QUEUED_ATTESTATIONS) {
        reject(ReprocessError.REACH_LIMITATION);
        this.metrics?.reprocessAttestations.reject.inc({reason: ReprocessError.REACH_LIMITATION});
      } else {
        const awaitingPromisesByRoot = this.awaitingPromisesByRootBySlot.getOrDefault(slot);
        const awaitingPromises = awaitingPromisesByRoot.getOrDefault(root);
        awaitingPromises.push({resolve, reject});
        this.awaitingPromisesCount++;
      }
    });
    return promise;
  }

  /**
   * It's important to make sure our node is synced before we reprocess,
   * it means the processed slot is same to clock slot
   * Note that we want to use clock advanced by REPROCESS_MIN_TIME_TO_NEXT_SLOT instead of
   * clockSlot because we want to make sure our node is healthy while reprocessing attestations.
   * If a block reach our node 1s before the next slot, for example, then probably node
   * is struggling and we don't want to reprocess anything at that time.
   */
  onBlockImported({slot, root}: SlotRoot, advancedSlot: Slot): void {
    // we are probably resyncing, don't want to reprocess attestations here
    if (slot < advancedSlot) return;

    // resolve all related promises
    const awaitingPromisesBySlot = this.awaitingPromisesByRootBySlot.getOrDefault(slot);
    const awaitingPromises = awaitingPromisesBySlot.getOrDefault(root);
    for (const awaitingPromise of awaitingPromises) {
      awaitingPromise.resolve();
      this.awaitingPromisesCount--;
      this.metrics?.reprocessAttestations.resolve.inc();
    }

    // prune
    awaitingPromisesBySlot.delete(root);
  }

  /**
   * It's important to make sure our node is synced before reprocessing attestations,
   * it means clockSlot is the same to last processed block's slot, and we don't reprocess
   * attestations of old slots.
   * So we reject and prune all old awaiting promises per clock slot.
   * @param clockSlot
   */
  onSlot(clockSlot: Slot): void {
    for (const key of this.awaitingPromisesByRootBySlot.keys()) {
      if (key < clockSlot) {
        // reject all related promises
        const awaitingPromises = Array.from(this.awaitingPromisesByRootBySlot.getOrDefault(key).values()).flat();
        for (const awaitingPromise of awaitingPromises) {
          awaitingPromise.reject(ReprocessError.EXPIRED);
          this.metrics?.reprocessAttestations.reject.inc({reason: ReprocessError.EXPIRED});
        }

        // prune
        this.awaitingPromisesByRootBySlot.delete(key);
      } else {
        break;
      }
    }

    // in theory there are maybe some awaiting promises waiting for a slot > clockSlot
    // in reality this never happens so reseting awaitingPromisesCount to 0 to make it simple
    this.awaitingPromisesCount = 0;
  }
}
