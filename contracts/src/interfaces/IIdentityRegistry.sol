// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IIdentityRegistry
 * @author Asset Tokenization Studio Team
 * @notice Defense-in-depth KYC check surface exposed by an ATS Identity Registry.
 * @dev Optional. RepoVault skips the check when no registry is configured,
 *      because the ATS bond token's own transfer and hold paths already enforce
 *      identity and compliance internally. Wire this in for an additional
 *      on-entry gate at origination time.
 */
interface IIdentityRegistry {
    /**
     * @notice Returns whether `account` holds a valid KYC identity claim.
     * @param account Address to verify.
     * @return verified True if the account is KYC-verified in the registry.
     */
    function isVerified(address account) external view returns (bool verified);
}
