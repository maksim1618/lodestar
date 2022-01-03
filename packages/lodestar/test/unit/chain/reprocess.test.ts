import {expect} from "chai";
import {ReprocessController, ReprocessError} from "../../../src/chain/reprocess";

describe("ReprocessController", function () {
  let controller: ReprocessController;

  beforeEach(() => {
    controller = new ReprocessController(null);
  });

  it("should reject - block not come", async () => {
    const promise = controller.waitForBlock({slot: 100, root: "A"});
    controller.onSlot(101);
    try {
      await promise;
      expect.fail("promise should be rejected");
    } catch (e) {
      expect(e).to.be.equal(ReprocessError.EXPIRED);
    }
  });

  it("should reject - block comes too late", async () => {
    const promise = controller.waitForBlock({slot: 100, root: "A"});
    controller.onBlockImported({slot: 100, root: "A"}, 101);
    controller.onSlot(101);
    try {
      await promise;
      expect.fail("promise should be rejected");
    } catch (e) {
      expect(e).to.be.equal(ReprocessError.EXPIRED);
    }
  });

  it("should reject - too many promises", async () => {
    for (let i = 0; i < 16_384; i++) {
      void controller.waitForBlock({slot: 100, root: "A"});
    }
    try {
      await controller.waitForBlock({slot: 100, root: "A"});
      expect.fail("promise should be rejected");
    } catch (e) {
      expect(e).to.be.equal(ReprocessError.REACH_LIMITATION);
    }
  });

  it("should resolve - block comes on time", async () => {
    const promise = controller.waitForBlock({slot: 100, root: "A"});
    controller.onBlockImported({slot: 100, root: "A"}, 100);
    await promise;
  });
});
