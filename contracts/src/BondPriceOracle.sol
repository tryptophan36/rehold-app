// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title BondPriceOracle
 * @author Asset Tokenization Studio Team
 * @notice A minimal, purpose-built price/NAV feed for a tokenised treasury bond.
 * @dev DEMO / TESTNET ORACLE. No real oracle network (Chainlink, Pyth, etc.)
 *      prices a bespoke custom instrument like this bond, so instead an
 *      authorised off-chain service pushes price updates directly on-chain,
 *      which the rest of the TreasuryRepo system (RepoVault, MarginEngine)
 *      reads to value pledged collateral. The external interface is shaped
 *      loosely like Chainlink's AggregatorV3Interface (`latestPrice` /
 *      `decimals`) so this contract could be swapped for a real feed later
 *      without changing callers much.
 */
contract BondPriceOracle {
    // ---------------------------------------------------------------------
    // Constants (must precede state variables — solhint ordering rule)
    // ---------------------------------------------------------------------

    /// @notice Fixed decimal precision, mimicking Chainlink's convention.
    uint8 public constant DECIMALS_VALUE = 8;

    /// @dev Maximum allowed move between consecutive pushes, in bps of the
    ///      current price (30%), as a circuit breaker against bad data.
    uint256 private constant _MAX_MOVE_BPS = 3000;

    /// @dev Denominator for basis-point arithmetic.
    uint256 private constant _BPS_DENOMINATOR = 10000;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    /// @notice The only address allowed to push new prices.
    address public updater;

    /// @notice The current price, at `DECIMALS_VALUE` precision.
    int256 public price;

    /// @notice Unix timestamp of the last successful price push.
    uint256 public updatedAt;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /**
     * @notice Emitted when a new price is successfully pushed on-chain.
     * @param price The new price accepted, at `DECIMALS_VALUE` precision.
     * @param timestamp Unix timestamp of the block in which the push landed.
     */
    event PriceUpdated(int256 price, uint256 timestamp);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice Thrown when a caller other than `updater` calls `pushPrice` or `setUpdater`.
    error NotAuthorizedUpdater();

    /// @notice Thrown when `pushPrice` receives a non-positive price.
    error InvalidPrice();

    /**
     * @notice Thrown when a push would move the price by more than 30 % in one step.
     * @param attempted The price that was rejected.
     * @param current The price currently stored on-chain.
     */
    error PriceMoveTooLarge(int256 attempted, int256 current);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    /// @notice Restricts a function to the currently configured `updater` address.
    modifier onlyUpdater() {
        if (msg.sender != updater) revert NotAuthorizedUpdater();
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @notice Deploys the oracle and sets the initial authorised updater.
     * @param _updater The initial address authorised to push prices.
     */
    constructor(address _updater) {
        updater = _updater;
    }

    // ---------------------------------------------------------------------
    // External functions
    // ---------------------------------------------------------------------

    /**
     * @notice Pushes a new price for this demo/testnet NAV oracle.
     * @dev Only callable by `updater`. Reverts if `newPrice <= 0`. After the
     *      first push, also reverts if the move is more than 30 % away from
     *      the current price in either direction — a circuit breaker against
     *      a bad or fat-fingered off-chain push. The very first push is
     *      exempt from this check since there is no prior price to compare
     *      against.
     * @param newPrice The new price, at `DECIMALS_VALUE` precision.
     */
    function pushPrice(int256 newPrice) external onlyUpdater {
        if (newPrice <= 0) revert InvalidPrice();

        if (updatedAt != 0) {
            int256 current = price;
            int256 diff = newPrice > current ? newPrice - current : current - newPrice;
            // `current` is guaranteed > 0 here since every prior successful
            // push required newPrice > 0.
            uint256 moveBps = (uint256(diff) * _BPS_DENOMINATOR) / uint256(current);
            if (moveBps > _MAX_MOVE_BPS) revert PriceMoveTooLarge(newPrice, current);
        }

        price = newPrice;
        updatedAt = block.timestamp;

        emit PriceUpdated(newPrice, block.timestamp);
    }

    /**
     * @notice Rotates the address authorised to push prices.
     * @dev Only callable by the current updater. Key rotation is intentionally
     *      simple (no timelock or multi-step handoff) for this demo/testnet context.
     * @param newUpdater The new address to authorise.
     */
    function setUpdater(address newUpdater) external onlyUpdater {
        updater = newUpdater;
    }

    /**
     * @notice Returns the latest pushed price and when it was pushed.
     * @dev Callers should apply their own staleness check against `lastUpdatedAt`
     *      (as RepoVault and MarginEngine do, using a 10-minute window).
     * @return currentPrice The latest price, at `DECIMALS_VALUE` precision.
     * @return lastUpdatedAt Unix timestamp of the last price push.
     */
    function latestPrice() external view returns (int256 currentPrice, uint256 lastUpdatedAt) {
        return (price, updatedAt);
    }

    /**
     * @notice Number of decimals the price is denominated in.
     * @dev Fixed at 8 to mimic Chainlink's convention for this demo/testnet NAV oracle.
     * @return The constant `DECIMALS_VALUE` (8).
     */
    function decimals() external pure returns (uint8) {
        return DECIMALS_VALUE;
    }
}
