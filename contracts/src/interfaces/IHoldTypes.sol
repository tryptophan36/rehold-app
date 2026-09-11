// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IHoldTypes
 * @author Asset Tokenization Studio Team
 * @notice Hold structs matching ATS HoldByPartition. Vendored so this repo
 *         compiles without the ATS monorepo.
 */
interface IHoldTypes {
    /**
     * @notice Composite identifier for a partition-scoped hold.
     * @param partition ERC-1410 partition of the hold.
     * @param tokenHolder Address whose tokens are held.
     * @param holdId Sequence id assigned by the bond token.
     */
    struct HoldIdentifier {
        bytes32 partition;
        address tokenHolder;
        uint256 holdId;
    }

    /**
     * @notice Hold definition used at creation time.
     * @param amount Token units placed under hold.
     * @param expirationTimestamp Zero means the hold never expires.
     * @param escrow Address allowed to execute the hold.
     * @param to Intended recipient on execute.
     * @param data Arbitrary metadata.
     */
    struct Hold {
        uint256 amount;
        uint256 expirationTimestamp;
        address escrow;
        address to;
        bytes data;
    }
}
