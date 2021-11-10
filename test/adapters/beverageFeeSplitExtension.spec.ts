import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE_YEAR_IN_SECONDS } from "@utils/constants";
import { BeverageFeeSplitExtension, BeverageBaseManager } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getStreamingFee,
  getStreamingFeeInflationAmount,
  getTransactionTimestamp,
  getWaffleExpect,
  increaseTimeAsync,
  preciseMul,
  getRandomAccount
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("BeverageFeeSplitExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let operatorFeeRecipient: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManager: BeverageBaseManager;
  let feeExtension: BeverageFeeSplitExtension;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
      operatorFeeRecipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.debtIssuanceModule.address, setV2Setup.streamingFeeModule.address]
    );

    // Deploy BaseManager
    baseManager = await deployer.manager.deployBeverageBaseManager(
      operator.address,
      methodologist.address
    );

    const feeRecipient = baseManager.address;
    const maxStreamingFeePercentage = ether(.1);
    const streamingFeePercentage = ether(.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    await setV2Setup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);

    await setV2Setup.debtIssuanceModule.initialize(
      setToken.address,
      ether(.1),
      ether(.01),
      ether(.005),
      baseManager.address,
      ADDRESS_ZERO
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectStreamingFeeModule: Address;
    let subjectDebtIssuanceModule: Address;
    let subjectOperatorFeeSplit: BigNumber;
    let subjectOperatorFeeRecipient: Address;

    beforeEach(async () => {
      subjectManager = baseManager.address;
      subjectStreamingFeeModule = setV2Setup.streamingFeeModule.address;
      subjectDebtIssuanceModule = setV2Setup.debtIssuanceModule.address;
      subjectOperatorFeeSplit = ether(.7);
      subjectOperatorFeeRecipient = operatorFeeRecipient.address;
    });

    async function subject(): Promise<BeverageFeeSplitExtension> {
      return await deployer.extensions.deployBeverageFeeSplitExtension(
        subjectManager,
        subjectStreamingFeeModule,
        subjectDebtIssuanceModule,
        subjectOperatorFeeSplit,
        subjectOperatorFeeRecipient
      );
    }

    it("should set the correct manager address", async () => {
      const feeExtension = await subject();

      const actualManager = await feeExtension.manager();
      expect(actualManager).to.eq(baseManager.address);
    });

    it("should set the correct streaming fee module address", async () => {
      const feeExtension = await subject();

      const actualStreamingFeeModule = await feeExtension.streamingFeeModule();
      expect(actualStreamingFeeModule).to.eq(subjectStreamingFeeModule);
    });

    it("should set the correct debt issuance module address", async () => {
      const feeExtension = await subject();

      const actualDebtIssuanceModule = await feeExtension.issuanceModule();
      expect(actualDebtIssuanceModule).to.eq(subjectDebtIssuanceModule);
    });

    it("should set the correct operator fee split", async () => {
      const feeExtension = await subject();

      const actualOperatorFeeSplit = await feeExtension.operatorFeeSplit();
      expect(actualOperatorFeeSplit).to.eq(subjectOperatorFeeSplit);
    });

    it("should set the correct operator fee recipient", async () => {
      const feeExtension = await subject();

      const actualOperatorFeeRecipient = await feeExtension.operatorFeeRecipient();
      expect(actualOperatorFeeRecipient).to.eq(subjectOperatorFeeRecipient);
    });
  });

  context("when fee extension is deployed and system fully set up", async () => {
    const operatorSplit: BigNumber = ether(.7);

    beforeEach(async () => {
      feeExtension = await deployer.extensions.deployBeverageFeeSplitExtension(
        baseManager.address,
        setV2Setup.streamingFeeModule.address,
        setV2Setup.debtIssuanceModule.address,
        operatorSplit,
        operatorFeeRecipient.address
      );

      await baseManager.connect(operator.wallet).addAdapter(feeExtension.address);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManager.address);

      // Set extension as fee recipient
      await feeExtension.connect(operator.wallet).updateFeeRecipient(setToken.address, feeExtension.address);
    });

    describe("#accrueFeesAndDistribute", async () => {
      let mintedTokens: BigNumber;
      let subjectSetToken: Address;

      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      beforeEach(async () => {
        mintedTokens = ether(2);
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        subjectSetToken = setToken.address;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.accrueFeesAndDistribute(subjectSetToken);
      }

      it("should send correct amount of fees to operator fee recipient and methodologist", async () => {
        const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        const totalSupply = await setToken.totalSupply();

        const txnTimestamp = await getTransactionTimestamp(subject());

        const expectedFeeInflation = await getStreamingFee(
          setV2Setup.streamingFeeModule,
          setToken.address,
          feeState.lastStreamingFeeTimestamp,
          txnTimestamp
        );

        const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

        const expectedMintRedeemFees = preciseMul(mintedTokens, ether(.01));
        const expectedOperatorTake = preciseMul(feeInflation.add(expectedMintRedeemFees), operatorSplit);
        const expectedMethodologistTake = feeInflation.add(expectedMintRedeemFees).sub(expectedOperatorTake);

        const operatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);
        const methodologistBalance = await setToken.balanceOf(methodologist.address);

        expect(operatorFeeRecipientBalance).to.eq(expectedOperatorTake);
        expect(methodologistBalance).to.eq(expectedMethodologistTake);
      });

      it("should emit a FeesDistributed event", async () => {
        await expect(subject()).to.emit(feeExtension, "FeesDistributed");
      });

      describe("when methodologist fees are 0", async () => {
        beforeEach(async () => {
          await feeExtension.connect(operator.wallet).updateFeeSplit(ether(1));
        });

        it("should not send fees to methodologist", async () => {
          const preMethodologistBalance = await setToken.balanceOf(methodologist.address);

          await subject();

          const postMethodologistBalance = await setToken.balanceOf(methodologist.address);
          expect(postMethodologistBalance.sub(preMethodologistBalance)).to.eq(ZERO);
        });
      });

      describe("when operator fees are 0", async () => {
        beforeEach(async () => {
          await feeExtension.connect(operator.wallet).updateFeeSplit(ZERO);
        });

        it("should not send fees to operator fee recipient", async () => {
          const preOperatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);

          await subject();

          const postOperatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);
          expect(postOperatorFeeRecipientBalance.sub(preOperatorFeeRecipientBalance)).to.eq(ZERO);
        });
      });

      describe("when extension has fees accrued, is removed and no longer the feeRecipient", () => {
        let txnTimestamp: BigNumber;
        let feeState: any;
        let expectedFeeInflation: BigNumber;
        let totalSupply: BigNumber;

        beforeEach(async () => {
          feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
          totalSupply = await setToken.totalSupply();

          // Accrue fees to extension by StreamingFeeModule by direct call
          txnTimestamp = await getTransactionTimestamp(
            setV2Setup.streamingFeeModule.accrueFee(setToken.address)
          );

          expectedFeeInflation = await getStreamingFee(
            setV2Setup.streamingFeeModule,
            setToken.address,
            feeState.lastStreamingFeeTimestamp,
            txnTimestamp
          );

          // Change fee recipient to baseManager;
          await feeExtension.connect(operator.wallet).updateFeeRecipient(setToken.address, baseManager.address);

          // Remove extension
          await baseManager.connect(operator.wallet).removeAdapter(feeExtension.address);
        });

        it("should send residual fees to operator fee recipient and methodologist", async () => {
          await subject();

          const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

          const expectedMintRedeemFees = preciseMul(mintedTokens, ether(.01));
          const expectedOperatorTake = preciseMul(feeInflation.add(expectedMintRedeemFees), operatorSplit);
          const expectedMethodologistTake = feeInflation.add(expectedMintRedeemFees).sub(expectedOperatorTake);

          const operatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);
          const methodologistBalance = await setToken.balanceOf(methodologist.address);

          expect(operatorFeeRecipientBalance).to.eq(expectedOperatorTake);
          expect(methodologistBalance).to.eq(expectedMethodologistTake);
        });
      });
    });

    describe("#updateStreamingFee", async () => {
      let mintedTokens: BigNumber;
      let subjectSetToken: Address;
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      let subjectNewFee: BigNumber;
      let subjectOperatorCaller: Account;

      beforeEach(async () => {
        mintedTokens = ether(2);
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        subjectNewFee = ether(.01);
        subjectOperatorCaller = operator;
        subjectSetToken = setToken.address;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.connect(subjectOperatorCaller.wallet).updateStreamingFee(subjectSetToken, subjectNewFee);
      }

      it("should update the streaming fee", async () => {
        await subject();

        const feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        expect(feeState.streamingFeePercentage).to.eq(subjectNewFee);
      });

      it("should send correct amount of fees to the fee extension", async () => {
        const preExtensionBalance = await setToken.balanceOf(feeExtension.address);
        const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        const totalSupply = await setToken.totalSupply();

        const txnTimestamp = await getTransactionTimestamp(subject());

        const expectedFeeInflation = await getStreamingFee(
          setV2Setup.streamingFeeModule,
          setToken.address,
          feeState.lastStreamingFeeTimestamp,
          txnTimestamp,
          ether(.02)
        );

        const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

        const postExtensionBalance = await setToken.balanceOf(feeExtension.address);

        expect(postExtensionBalance.sub(preExtensionBalance)).to.eq(feeInflation);
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    describe("#updateIssueFee", async () => {
      let subjectNewFee: BigNumber;
      let subjectSetToken: Address;
      let subjectOperatorCaller: Account;

      beforeEach(async () => {
        subjectNewFee = ether(.02);
        subjectOperatorCaller = operator;
        subjectSetToken = setToken.address;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.connect(subjectOperatorCaller.wallet).updateIssueFee(subjectSetToken, subjectNewFee);
      }

      it("should update the issue fee", async () => {
        await subject();

        const issueState: any = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

        expect(issueState.managerIssueFee).to.eq(subjectNewFee);
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    describe("#updateRedeemFee", async () => {
      let subjectNewFee: BigNumber;
      let subjectOperatorCaller: Account;
      let subjectSetToken: Address;

      beforeEach(async () => {
        subjectNewFee = ether(.02);
        subjectOperatorCaller = operator;
        subjectSetToken = setToken.address;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.connect(subjectOperatorCaller.wallet).updateRedeemFee(subjectSetToken, subjectNewFee);
      }

      it("should update the redeem fee", async () => {
        await subject();

        const issuanceState: any = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

        expect(issuanceState.managerRedeemFee).to.eq(subjectNewFee);
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    describe("#updateFeeRecipient", async () => {
      let subjectNewFeeRecipient: Address;
      let subjectOperatorCaller: Account;
      let subjectSetToken: Address;

      beforeEach(async () => {
        subjectNewFeeRecipient = owner.address;
        subjectOperatorCaller = operator;
        subjectSetToken = setToken.address;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.connect(subjectOperatorCaller.wallet).updateFeeRecipient(subjectSetToken, subjectNewFeeRecipient);
      }

      it("sets the new fee recipients", async () => {
        await subject();

        const streamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        const issuanceFeeState = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

        expect(streamingFeeState.feeRecipient).to.eq(subjectNewFeeRecipient);
        expect(issuanceFeeState.feeRecipient).to.eq(subjectNewFeeRecipient);
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    describe("#updateFeeSplit", async () => {
      let subjectNewFeeSplit: BigNumber;
      let subjectOperatorCaller: Account;

      const mintedTokens: BigNumber = ether(2);
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      beforeEach(async () => {
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        subjectNewFeeSplit = ether(.5);
        subjectOperatorCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.connect(subjectOperatorCaller.wallet).updateFeeSplit(subjectNewFeeSplit);
      }

      it("sets the new fee split", async () => {
        await subject();

        const actualFeeSplit = await feeExtension.operatorFeeSplit();

        expect(actualFeeSplit).to.eq(subjectNewFeeSplit);
      });

      describe("when fee splits is >100%", async () => {
        beforeEach(async () => {
          subjectNewFeeSplit = ether(1.1);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Fee must be less than 100%");
        });
      });

      describe("when the caller is not the operator or methodologist", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    describe("#updateOperatorFeeRecipient", async () => {
      let subjectCaller: Account;
      let subjectOperatorFeeRecipient: Address;

      beforeEach(async () => {
        subjectCaller = operator;
        subjectOperatorFeeRecipient = (await getRandomAccount()).address;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension
          .connect(subjectCaller.wallet)
          .updateOperatorFeeRecipient(subjectOperatorFeeRecipient);
      }

      it("sets the new operator fee recipient", async () => {
        await subject();

        const newOperatorFeeRecipient = await feeExtension.operatorFeeRecipient();
        expect(newOperatorFeeRecipient).to.eq(subjectOperatorFeeRecipient);
      });

      describe("when the new operator fee recipient is address zero", async () => {
        beforeEach(async () => {
          subjectOperatorFeeRecipient = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Zero address not valid");
        });
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = methodologist;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });
  });
});