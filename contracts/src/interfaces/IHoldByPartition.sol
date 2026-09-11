// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IHoldTypes } from "./IHoldTypes.sol";

/**
 * @title IHoldByPartition
 * @author Asset Tokenization Studio Team
 * @notice Subset of ATS hold-by-partition writes used by RepoVault.
 * @dev Selectors must match the ATS diamond. This is an ABI shim, not a
 *      reimplementation of hold accounting.
 */
interface IHoldByPartition is IHoldTypes {
    /**
     * @notice Creates a hold on `_from`'s partition balance as an authorised operator.
     * @param _partition Partition of the tokens.
     * @param _from Token holder whose balance is held.
     * @param _hold Hold parameters.
     * @param _operatorData Operator metadata.
     * @return success_ True if the hold was created.
     * @return holdId_ Sequence id of the new hold.
     */
    function createHoldFromByPartition(
        bytes32 _partition,
        address _from,
        IHoldTypes.Hold calldata _hold,
        bytes calldata _operatorData
    ) external returns (bool success_, uint256 holdId_);

    /**
     * @notice Transfers held tokens to `_to`.
     * @param _holdIdentifier Hold to execute.
     * @param _to Recipient (vault, then market).
     * @param _amount Units to release from the hold.
     * @return success_ True if execution succeeded.
     * @return partition_ Partition that was drawn from.
     */
    function executeHoldByPartition(
        IHoldTypes.HoldIdentifier calldata _holdIdentifier,
        address _to,
        uint256 _amount
    ) external returns (bool success_, bytes32 partition_);

    /**
     * @notice Returns held tokens to the token holder.
     * @param _holdIdentifier Hold to release.
     * @param _amount Units to return.
     * @return success_ True if release succeeded.
     */
    function releaseHoldByPartition(
        IHoldTypes.HoldIdentifier calldata _holdIdentifier,
        uint256 _amount
    ) external returns (bool success_);
}
