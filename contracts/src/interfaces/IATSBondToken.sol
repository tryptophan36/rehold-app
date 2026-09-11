// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IHoldByPartition } from "./IHoldByPartition.sol";

/**
 * @title IATSBondToken
 * @author Asset Tokenization Studio Team
 * @notice Combined surface of an ATS bond token as used by RepoVault.
 * @dev Aggregates three capabilities the vault relies on:
 *      1. ERC-20-style transfers (ATS-compliance-checked on every call).
 *      2. Hold-by-partition escrow (createHoldFromByPartition / execute / release).
 *      3. Maturity redemption entry points (fullRedeemAtMaturity,
 *         redeemAtMaturityByPartition).
 *      The diamond proxy address of the deployed bond token is cast to this
 *      interface at call sites; all selectors must be registered on the proxy.
 */
interface IATSBondToken is IHoldByPartition, IERC20 {
    /**
     * @notice Redeems the entire bond balance held by `tokenHolder` at face value.
     * @dev Intended for use after executeHoldByPartition has moved the tokens to
     *      this contract, so `tokenHolder` here is typically the vault itself.
     * @param tokenHolder Address whose bond balance is redeemed at maturity.
     */
    function fullRedeemAtMaturity(address tokenHolder) external;

    /**
     * @notice Redeems a partition-scoped balance of `tokenHolder` at face value.
     * @param tokenHolder Address whose bond balance is redeemed at maturity.
     * @param partition ERC-1410 partition from which tokens are redeemed.
     * @param amount Number of bond tokens to redeem.
     */
    function redeemAtMaturityByPartition(address tokenHolder, bytes32 partition, uint256 amount) external;
}
