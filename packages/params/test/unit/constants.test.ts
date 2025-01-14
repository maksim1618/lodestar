import * as constants from "../../src";
import {ssz} from "@chainsafe/lodestar-types";
import {expect} from "chai";

/* eslint-disable @typescript-eslint/naming-convention */

describe("Lightclient pre-computed constants", () => {
  const FINALIZED_ROOT_GINDEX = Number(ssz.altair.BeaconState.getPathGindex(["finalizedCheckpoint", "root"]));
  const FINALIZED_ROOT_DEPTH = floorlog2(FINALIZED_ROOT_GINDEX);
  const FINALIZED_ROOT_INDEX = FINALIZED_ROOT_GINDEX % 2 ** FINALIZED_ROOT_DEPTH;

  const NEXT_SYNC_COMMITTEE_GINDEX = Number(ssz.altair.BeaconState.getPathGindex(["nextSyncCommittee"]));
  const NEXT_SYNC_COMMITTEE_DEPTH = floorlog2(NEXT_SYNC_COMMITTEE_GINDEX);
  const NEXT_SYNC_COMMITTEE_INDEX = NEXT_SYNC_COMMITTEE_GINDEX % 2 ** NEXT_SYNC_COMMITTEE_DEPTH;

  const correctConstants = {
    FINALIZED_ROOT_GINDEX,
    FINALIZED_ROOT_DEPTH,
    FINALIZED_ROOT_INDEX,
    NEXT_SYNC_COMMITTEE_GINDEX,
    NEXT_SYNC_COMMITTEE_DEPTH,
    NEXT_SYNC_COMMITTEE_INDEX,
  };

  for (const [key, expectedValue] of Object.entries(correctConstants)) {
    it(key, () => {
      expect(((constants as unknown) as Record<string, number>)[key]).to.equal(expectedValue);
    });
  }
});

function floorlog2(num: number): number {
  return Math.floor(Math.log2(num));
}
