// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IAggregatorV3
 * @author Asset Tokenization Studio Team
 * @notice Minimal Chainlink AggregatorV3Interface, defined inline so this
 *         contract has no external dependency on Chainlink's own npm package.
 * @dev Only the two methods ChainlinkAdapter exposes are declared here.
 */
interface IAggregatorV3 {
    /**
     * @notice Returns data from the latest completed round.
     * @return roundId The round ID of the completed round.
     * @return answer The price answer reported in that round.
     * @return startedAt Unix timestamp when the round started.
     * @return updatedAt Unix timestamp when the round was last updated.
     * @return answeredInRound The round ID in which the answer was computed.
     */
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    /**
     * @notice Number of decimals in the feed's reported price.
     * @return The decimal precision used by this aggregator.
     */
    function decimals() external view returns (uint8);
}

/**
 * @title ChainlinkAdapter
 * @author Asset Tokenization Studio Team
 * @notice A thin, read-only wrapper around a real, live Chainlink price feed
 *         deployed on Hedera testnet (e.g. HBAR/USD).
 * @dev Used for the cash-leg/FX side of the TreasuryRepo system, to
 *      demonstrate genuine external oracle integration alongside the
 *      separate, custom BondPriceOracle used for the bond itself (which has
 *      no real market price feed and so cannot use a live Chainlink feed).
 *      The underlying `FEED` address is supplied at deployment time — point
 *      it at Chainlink's official Hedera testnet aggregator for the chosen
 *      pair (e.g. HBAR/USD). See Chainlink's Hedera documentation for the
 *      current, correct aggregator address before deploying.
 */
contract ChainlinkAdapter {
    /// @notice The underlying live Chainlink aggregator this contract wraps.
    IAggregatorV3 public immutable FEED;

    /**
     * @notice Deploys the adapter pointed at a specific Chainlink aggregator.
     * @param feedAddress Address of the deployed Chainlink aggregator on
     *        Hedera testnet for the desired pair.
     */
    constructor(address feedAddress) {
        FEED = IAggregatorV3(feedAddress);
    }

    /**
     * @notice Returns the latest answer and its update timestamp from the
     *         wrapped Chainlink feed.
     * @dev Thin passthrough to `FEED.latestRoundData()`, surfacing only the
     *      two fields the rest of the system needs. The caller is responsible
     *      for staleness checks on `updatedAt`.
     * @return answer The latest reported price, at `decimals()` precision.
     * @return updatedAt Unix timestamp of when that round was updated.
     */
    function latestAnswer() external view returns (int256 answer, uint256 updatedAt) {
        (, int256 roundAnswer, , uint256 roundUpdatedAt, ) = FEED.latestRoundData();
        return (roundAnswer, roundUpdatedAt);
    }

    /**
     * @notice Number of decimals the wrapped feed's price is denominated in.
     * @dev Proxies directly through to `FEED.decimals()` rather than
     *      hardcoding a value, since this is a real external feed whose
     *      precision this contract does not control.
     * @return The decimal precision reported by the underlying aggregator.
     */
    function decimals() external view returns (uint8) {
        return FEED.decimals();
    }
}
