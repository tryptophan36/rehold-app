// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title ISecondaryMarket
 * @author Asset Tokenization Studio Team
 * @notice Minimal market surface used by RepoVault during liquidation.
 * @dev RepoVault must import this interface only, not the order-book
 *      implementation, so the vault does not compile against the full market.
 */
interface ISecondaryMarket {
    /**
     * @notice Sells seized bond tokens on behalf of the configured RepoVault.
     * @param bondToken Address of the ATS bond token being liquidated.
     * @param amount Amount of bond tokens to sell.
     * @return proceeds Total cash-token proceeds sent to RepoVault.
     */
    function sellOnBehalf(address bondToken, uint256 amount) external returns (uint256 proceeds);
}
