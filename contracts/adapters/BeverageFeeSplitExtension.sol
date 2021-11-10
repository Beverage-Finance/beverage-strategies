/*
    Copyright 2021 Beverage Finance

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IIssuanceModule } from "../interfaces/IIssuanceModule.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IStreamingFeeModule } from "../interfaces/IStreamingFeeModule.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title BeverageFeeSplitExtension
 * @author Beverage Finance
 *
 * Smart contract extension that allows for splitting and setting streaming and mint/redeem fees.
 */
contract BeverageFeeSplitExtension is BaseExtension {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Events ============ */

    event FeesDistributed(
        ISetToken indexed _setToken,
        address indexed _operatorFeeRecipient,
        address indexed _methodologist,
        uint256 _operatorTake,
        uint256 _methodologistTake
    );

    /* ============ State Variables ============ */

    IStreamingFeeModule public streamingFeeModule;
    IIssuanceModule public issuanceModule;

    // Percent of fees in precise units (10^16 = 1%) sent to operator, rest to methodologist
    uint256 public operatorFeeSplit;

    // Address which receives operator's share of fees when they're distributed
    address public operatorFeeRecipient;

    /* ============ Constructor ============ */

    constructor(
        IBaseManager _manager,
        IStreamingFeeModule _streamingFeeModule,
        IIssuanceModule _issuanceModule,
        uint256 _operatorFeeSplit,
        address _operatorFeeRecipient
    )
        public
        BaseExtension(_manager)
    {
        streamingFeeModule = _streamingFeeModule;
        issuanceModule = _issuanceModule;
        operatorFeeSplit = _operatorFeeSplit;
        operatorFeeRecipient = _operatorFeeRecipient;
    }

    /* ============ External Functions ============ */

    /**
     * ANYONE CALLABLE: Accrues fees from streaming fee module. Gets resulting balance after fee accrual, calculates fees for
     * operator and methodologist, and sends to operator fee recipient and methodologist respectively. NOTE: mint/redeem fees
     * will automatically be sent to this address so reading the balance of the SetToken in the contract after accrual is
     * sufficient for accounting for all collected fees.
     */
    function accrueFeesAndDistribute(ISetToken _setToken) public {
        // Emits a FeeActualized event
        streamingFeeModule.accrueFee(_setToken);

        uint256 totalFees = _setToken.balanceOf(address(this));

        address methodologist = manager.methodologist();

        uint256 operatorTake = totalFees.preciseMul(operatorFeeSplit);
        uint256 methodologistTake = totalFees.sub(operatorTake);

        if (operatorTake > 0) {
            _setToken.transfer(operatorFeeRecipient, operatorTake);
        }

        if (methodologistTake > 0) {
            _setToken.transfer(methodologist, methodologistTake);
        }

        emit FeesDistributed(_setToken, operatorFeeRecipient, methodologist, operatorTake, methodologistTake);
    }

    /**
     * ONLY OPERATOR: Updates streaming fee on StreamingFeeModule
     *
     * NOTE: This will accrue streaming fees though not send to operator fee recipient and methodologist.
     *
     * @param _setToken     Address of SetToken
     * @param _newFee       Percent of Set accruing to fee extension annually (1% = 1e16, 100% = 1e18)
     */
    function updateStreamingFee(ISetToken _setToken, uint256 _newFee)
        external
        onlyOperator
    {
        bytes memory callData = abi.encodeWithSignature("updateStreamingFee(address,uint256)", _setToken, _newFee);
        invokeManager(address(streamingFeeModule), callData);
    }

    /**
     * ONLY OPERATOR: Updates issue fee on IssuanceModule
     *
     * @param _setToken         Address of SetToken
     * @param _newFee           New issue fee percentage in precise units (1% = 1e16, 100% = 1e18)
     */
    function updateIssueFee(ISetToken _setToken, uint256 _newFee)
        external
        onlyOperator
    {
        bytes memory callData = abi.encodeWithSignature("updateIssueFee(address,uint256)", _setToken, _newFee);
        invokeManager(address(issuanceModule), callData);
    }

    /**
     * ONLY OPERATOR: Updates redeem fee on IssuanceModule
     *
     * @param _setToken         Address of SetToken
     * @param _newFee           New redeem fee percentage in precise units (1% = 1e16, 100% = 1e18)
     */
    function updateRedeemFee(ISetToken _setToken, uint256 _newFee)
        external
        onlyOperator
    {
        bytes memory callData = abi.encodeWithSignature("updateRedeemFee(address,uint256)", _setToken, _newFee);
        invokeManager(address(issuanceModule), callData);
    }

    /**
     * ONLY OPERATOR: Updates fee recipient on both streaming fee and issuance modules.
     *
     * @param _setToken         Address of SetToken
     * @param _newFeeRecipient  Address of new fee recipient. This should be the address of the fee extension itself.
     */
    function updateFeeRecipient(ISetToken _setToken, address _newFeeRecipient)
        external
        onlyOperator
    {
        bytes memory callData = abi.encodeWithSignature("updateFeeRecipient(address,address)", _setToken, _newFeeRecipient);
        invokeManager(address(streamingFeeModule), callData);
        invokeManager(address(issuanceModule), callData);
    }

    /**
     * ONLY OPERATOR: Updates fee split between operator and methodologist. Split defined in precise units (1% = 10^16).
     *
     * @param _newFeeSplit      Percent of fees in precise units (10^16 = 1%) sent to operator, (rest go to the methodologist).
     */
    function updateFeeSplit(uint256 _newFeeSplit)
        external
        onlyOperator
    {
        require(_newFeeSplit <= PreciseUnitMath.preciseUnit(), "Fee must be less than 100%");

        // IMPORTANT: call accrueFeesAndDistribute for each SetToken to ensure that fees are collected prior to fee split change

        operatorFeeSplit = _newFeeSplit;
    }

    /**
     * OPERATOR ONLY: Updates the address that receives the operator's share of the fees
     *
     * @param _newOperatorFeeRecipient  Address to send operator's fees to.
     */
    function updateOperatorFeeRecipient(address _newOperatorFeeRecipient)
        external
        onlyOperator
    {
        require(_newOperatorFeeRecipient != address(0), "Zero address not valid");
        operatorFeeRecipient = _newOperatorFeeRecipient;
    }
}
