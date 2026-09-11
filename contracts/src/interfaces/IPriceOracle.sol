// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IPriceOracle
 * @author Asset Tokenization Studio Team
 * @notice Minimal interface for a bond NAV / price feed.
 * @dev Shaped loosely like Chainlink's AggregatorV3Interface so callers can be
 *      swapped to a real on-chain feed without changing their call sites.
 *      The demo implementation is BondPriceOracle.sol — an admin-pushed
 *      feed with a 30 % single-push circuit-breaker.
 */
interface IPriceOracle {
    /**
     * @notice Returns the latest price and when it was last updated.
     * @return price The latest price at 8 decimal places (Chainlink convention).
     * @return updatedAt Unix timestamp of the last successful price push.
     */
    function latestPrice() external view returns (int256 price, uint256 updatedAt);
}
