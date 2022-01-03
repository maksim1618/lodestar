import {toHexString} from "@chainsafe/ssz";
import PeerId from "peer-id";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {phase0, ssz, ValidatorIndex} from "@chainsafe/lodestar-types";
import {ILogger, prettyBytes} from "@chainsafe/lodestar-utils";
import {IMetrics} from "../../../metrics";
import {OpSource} from "../../../metrics/validatorMonitor";
import {IBeaconChain} from "../../../chain";
import {
  AttestationError,
  AttestationErrorCode,
  BlockError,
  BlockErrorCode,
  BlockGossipError,
  GossipAction,
  SyncCommitteeError,
} from "../../../chain/errors";
import {GossipHandlers, GossipType} from "../interface";
import {
  validateGossipAggregateAndProof,
  validateGossipAttestation,
  validateGossipAttesterSlashing,
  validateGossipBlock,
  validateGossipProposerSlashing,
  validateGossipSyncCommittee,
  validateSyncCommitteeGossipContributionAndProof,
  validateGossipVoluntaryExit,
} from "../../../chain/validation";
import {INetwork} from "../../interface";
import {NetworkEvent} from "../../events";
import {PeerAction} from "../../peers";

type ValidatorFnsModules = {
  chain: IBeaconChain;
  config: IBeaconConfig;
  logger: ILogger;
  network: INetwork;
  metrics: IMetrics | null;
};

/**
 * Gossip handlers perform validation + handling in a single function.
 * - This gossip handlers MUST only be registered as validator functions. No handler is registered for any topic.
 * - All `chain/validation/*` functions MUST throw typed GossipActionError instances so they gossip action is captured
 *   by `getGossipValidatorFn()` try catch block.
 * - This gossip handlers should not let any handling errors propagate to the caller. Only validation errors must be thrown.
 *
 * Note: `libp2p/js-libp2p-interfaces` would normally indicate to register separate validator functions and handler functions.
 * This approach is not suitable for us because:
 * - We do expensive processing on the object in the validator function that we need to re-use in the handler function.
 * - The validator function produces extra data that is needed for the handler function. Making this data available in
 *   the handler function scope is hard to achieve without very hacky strategies
 * - Eth2.0 gossipsub protocol strictly defined a single topic for message
 */
export function getGossipHandlers(modules: ValidatorFnsModules): GossipHandlers {
  const {chain, config, metrics, network, logger} = modules;

  return {
    [GossipType.beacon_block]: async (signedBlock, topic, peerIdStr, seenTimestampSec) => {
      const slot = signedBlock.message.slot;
      const blockHex = prettyBytes(config.getForkTypes(slot).BeaconBlock.hashTreeRoot(signedBlock.message));
      logger.verbose("Received gossip block", {
        slot: slot,
        root: blockHex,
        curentSlot: chain.clock.currentSlot,
        peerId: peerIdStr,
      });

      try {
        await validateGossipBlock(config, chain, signedBlock, topic.fork);
      } catch (e) {
        if (e instanceof BlockGossipError) {
          if (e instanceof BlockGossipError && e.type.code === BlockErrorCode.PARENT_UNKNOWN) {
            logger.debug("Gossip block has error", {slot, root: blockHex, code: e.type.code});
            network.events.emit(NetworkEvent.unknownBlockParent, signedBlock, peerIdStr);
          }
        }

        if (e instanceof BlockGossipError && e.action === GossipAction.REJECT) {
          const archivedPath = chain.persistInvalidSszObject(
            "signedBlock",
            config.getForkTypes(slot).SignedBeaconBlock.serialize(signedBlock),
            `gossip_slot_${slot}`
          );
          logger.debug("The invalid gossip block was written to", archivedPath);
        }

        throw e;
      }

      // Handler - MUST NOT `await`, to allow validation result to be propagated

      metrics?.registerBeaconBlock(OpSource.gossip, seenTimestampSec, signedBlock.message);

      // `validProposerSignature = true`, in gossip validation the proposer signature is checked
      chain
        .processBlock(signedBlock, {validProposerSignature: true})
        .then(() => {
          // Returns the delay between the start of `block.slot` and `current time`
          const delaySec = Date.now() / 1000 - (chain.genesisTime + slot * config.SECONDS_PER_SLOT);
          metrics?.gossipBlock.elappsedTimeTillProcessed.observe(delaySec);
        })
        .catch((e) => {
          if (e instanceof BlockError) {
            switch (e.type.code) {
              case BlockErrorCode.ALREADY_KNOWN:
              case BlockErrorCode.PARENT_UNKNOWN:
              case BlockErrorCode.PRESTATE_MISSING:
                break;
              default:
                network.peerRpcScores.applyAction(
                  PeerId.createFromB58String(peerIdStr),
                  PeerAction.LowToleranceError,
                  "BadGossipBlock"
                );
            }
          }
          logger.error("Error receiving block", {slot, peer: peerIdStr}, e as Error);
        });
    },

    [GossipType.beacon_aggregate_and_proof]: async (signedAggregateAndProof, _topic, _peer, seenTimestampSec) => {
      let indexedAttestation: phase0.IndexedAttestation | undefined = undefined;
      let committeeIndices: ValidatorIndex[] | undefined = undefined;

      try {
        const validationResult = await validateGossipAggregateAndProof(chain, signedAggregateAndProof);
        indexedAttestation = validationResult.indexedAttestation;
        committeeIndices = validationResult.committeeIndices;
      } catch (e) {
        if (!(e instanceof AttestationError)) throw e;

        let retry = false;
        try {
          if (e.type.code === AttestationErrorCode.UNKNOWN_BEACON_BLOCK_ROOT) {
            const {slot, beaconBlockRoot} = signedAggregateAndProof.message.aggregate.data;
            await chain.reprocessController.waitForBlock({slot, root: toHexString(beaconBlockRoot)});
            // block comes, retry. Otherwises it jumps to the catch (e2) clause below.
            retry = true;
            const validationResult = await validateGossipAggregateAndProof(chain, signedAggregateAndProof);
            indexedAttestation = validationResult.indexedAttestation;
            committeeIndices = validationResult.committeeIndices;
          } else {
            throw e;
          }
        } catch (e2) {
          // if "waitForBlock" gets rejected, ignore its error (e2)
          const error = retry ? e2 : e;

          if (error instanceof AttestationError && error.action === GossipAction.REJECT) {
            const archivedPath = chain.persistInvalidSszObject(
              "signedAggregatedAndProof",
              ssz.phase0.SignedAggregateAndProof.serialize(signedAggregateAndProof),
              toHexString(ssz.phase0.SignedAggregateAndProof.hashTreeRoot(signedAggregateAndProof))
            );
            logger.debug("The invalid gossip aggregate and proof was written to", archivedPath, e);
          }

          if (indexedAttestation === undefined || committeeIndices === undefined) throw error;
        }
      }

      // Handler
      metrics?.registerAggregatedAttestation(
        OpSource.gossip,
        seenTimestampSec,
        signedAggregateAndProof,
        indexedAttestation
      );
      const aggregatedAttestation = signedAggregateAndProof.message.aggregate;

      chain.aggregatedAttestationPool.add(
        aggregatedAttestation,
        indexedAttestation.attestingIndices as ValidatorIndex[],
        committeeIndices
      );
    },

    [GossipType.beacon_attestation]: async (attestation, {subnet}, _peer, seenTimestampSec) => {
      let indexedAttestation: phase0.IndexedAttestation | undefined = undefined;
      try {
        indexedAttestation = (await validateGossipAttestation(chain, attestation, subnet)).indexedAttestation;
      } catch (e) {
        if (!(e instanceof AttestationError)) throw e;

        let retry = false;
        try {
          if (e.type.code === AttestationErrorCode.UNKNOWN_BEACON_BLOCK_ROOT) {
            const {slot, beaconBlockRoot} = attestation.data;
            await chain.reprocessController.waitForBlock({slot, root: toHexString(beaconBlockRoot)});
            // block comes, retry. Otherwises it jumps to the catch (e2) clause below.
            retry = true;
            indexedAttestation = (await validateGossipAttestation(chain, attestation, subnet)).indexedAttestation;
          } else {
            throw e;
          }
        } catch (e2) {
          // if "waitForBlock" gets rejected, ignore its error (e2)
          const error = retry ? e2 : e;

          if (error instanceof AttestationError && error.action === GossipAction.REJECT) {
            const archivedPath = chain.persistInvalidSszObject(
              "attestation",
              ssz.phase0.Attestation.serialize(attestation),
              toHexString(ssz.phase0.Attestation.hashTreeRoot(attestation))
            );
            logger.debug("The invalid gossip attestation was written to", archivedPath);
          }

          if (indexedAttestation === undefined) throw error;
        }
      }

      metrics?.registerUnaggregatedAttestation(OpSource.gossip, seenTimestampSec, indexedAttestation);

      // Handler

      // Node may be subscribe to extra subnets (long-lived random subnets). For those, validate the messages
      // but don't import them, to save CPU and RAM
      if (!network.attnetsService.shouldProcess(subnet, attestation.data.slot)) {
        return;
      }

      try {
        chain.attestationPool.add(attestation);
      } catch (e) {
        logger.error("Error adding attestation to pool", {subnet}, e as Error);
      }
    },

    [GossipType.attester_slashing]: async (attesterSlashing) => {
      await validateGossipAttesterSlashing(chain, attesterSlashing);

      // Handler

      try {
        chain.opPool.insertAttesterSlashing(attesterSlashing);
      } catch (e) {
        logger.error("Error adding attesterSlashing to pool", {}, e as Error);
      }
    },

    [GossipType.proposer_slashing]: async (proposerSlashing) => {
      await validateGossipProposerSlashing(chain, proposerSlashing);

      // Handler

      try {
        chain.opPool.insertProposerSlashing(proposerSlashing);
      } catch (e) {
        logger.error("Error adding attesterSlashing to pool", {}, e as Error);
      }
    },

    [GossipType.voluntary_exit]: async (voluntaryExit) => {
      await validateGossipVoluntaryExit(chain, voluntaryExit);

      // Handler

      try {
        chain.opPool.insertVoluntaryExit(voluntaryExit);
      } catch (e) {
        logger.error("Error adding attesterSlashing to pool", {}, e as Error);
      }
    },

    [GossipType.sync_committee_contribution_and_proof]: async (contributionAndProof) => {
      try {
        await validateSyncCommitteeGossipContributionAndProof(chain, contributionAndProof);
      } catch (e) {
        if (e instanceof SyncCommitteeError && e.action === GossipAction.REJECT) {
          const archivedPath = chain.persistInvalidSszObject(
            "contributionAndProof",
            ssz.altair.SignedContributionAndProof.serialize(contributionAndProof),
            toHexString(ssz.altair.SignedContributionAndProof.hashTreeRoot(contributionAndProof))
          );
          logger.debug("The invalid gossip contribution and proof was written to", archivedPath);
        }
        throw e;
      }

      // Handler

      try {
        chain.syncContributionAndProofPool.add(contributionAndProof.message);
      } catch (e) {
        logger.error("Error adding to contributionAndProof pool", {}, e as Error);
      }
    },

    [GossipType.sync_committee]: async (syncCommittee, {subnet}) => {
      let indexInSubCommittee = 0;
      try {
        indexInSubCommittee = (await validateGossipSyncCommittee(chain, syncCommittee, subnet)).indexInSubCommittee;
      } catch (e) {
        if (e instanceof SyncCommitteeError && e.action === GossipAction.REJECT) {
          const archivedPath = chain.persistInvalidSszObject(
            "syncCommittee",
            ssz.altair.SyncCommitteeMessage.serialize(syncCommittee),
            toHexString(ssz.altair.SyncCommitteeMessage.hashTreeRoot(syncCommittee))
          );
          logger.debug("The invalid gossip sync committee was written to", archivedPath);
        }
        throw e;
      }

      // Handler

      try {
        chain.syncCommitteeMessagePool.add(subnet, syncCommittee, indexInSubCommittee);
      } catch (e) {
        logger.error("Error adding to syncCommittee pool", {subnet}, e as Error);
      }
    },
  };
}
