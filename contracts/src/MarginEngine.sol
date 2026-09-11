// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IPriceOracle } from "./interfaces/IPriceOracle.sol";
import { IRepoVault } from "./interfaces/IRepoVault.sol";

/**
 * @title MarginEngine
 * @author Asset Tokenization Studio Team
 * @notice Isolated risk-evaluation contract for TreasuryRepo positions.
 * @dev Kept separate from RepoVault's custody and hold logic so the
 *      liquidation and margin-call thresholds are auditable on their own.
 *      Anyone may call `evaluate` — it is intended for a keeper or a demo-UI
 *      admin button, not for an access-restricted role.
 *
 *      Collateral is valued with the same 8-decimal oracle convention as
 *      RepoVault: `collateralValue = uint256(price) * collateralAmount / 1e8`.
 *      The engine does not read per-position haircut or threshold fields;
 *      the 102 % / 110 % constants below are the system-wide risk policy.
 */
contract MarginEngine {
    // ---------------------------------------------------------------------
    // Constants (must precede state variables — solhint ordering rule)
    // ---------------------------------------------------------------------

    /// @notice Collateral ratio below which a position is force-liquidated (102 %).
    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 10200;

    /// @notice Collateral ratio targeted after a partial liquidation (110 %).
    uint256 public constant TARGET_RATIO_BPS = 11000;

    /// @dev Denominator for basis-point arithmetic (100 % = 10_000).
    uint256 private constant _BPS_DENOMINATOR = 10000;

    /// @dev Oracle decimal scale. Matches BondPriceOracle / Chainlink convention.
    uint256 private constant _PRICE_SCALE = 1e8;

    /// @dev Maximum age of `bondOracle.latestPrice()` accepted by `evaluate`.
    uint256 private constant _STALE_PRICE_WINDOW = 10 minutes;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    /// @notice Vault whose positions this engine evaluates and liquidates.
    IRepoVault public vault;

    /// @notice Bond NAV feed used to value pledged collateral.
    IPriceOracle public bondOracle;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /**
     * @notice Emitted when `evaluate` finds a position at or above the target
     *         ratio, so the UI can show a healthy state without a vault call.
     * @param positionId ID of the healthy position.
     * @param ratioBps Current collateral ratio, in basis points.
     */
    event PositionHealthy(uint256 indexed positionId, uint256 ratioBps);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice Thrown when the bond oracle price is older than 10 minutes.
    error StalePrice();

    /// @notice Thrown when `evaluate` is called on a closed or unknown position.
    error PositionInactive();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @notice Wires the engine to a vault and a bond NAV oracle.
     * @param _vault Address of the deployed RepoVault.
     * @param _bondOracle Address of the deployed BondPriceOracle.
     */
    constructor(address _vault, address _bondOracle) {
        vault = IRepoVault(_vault);
        bondOracle = IPriceOracle(_bondOracle);
    }

    // ---------------------------------------------------------------------
    // External functions
    // ---------------------------------------------------------------------

    /**
     * @notice Revalues one position and issues a margin call or liquidation.
     * @dev Permissionless. Reads `vault.getPositionSummary` and
     *      `bondOracle.latestPrice`, then either:
     *      - calls `vault.liquidatePartial` when `ratioBps` is below 102 %,
     *      - calls `vault.issueMarginCall` when it is in [102 %, 110 %),
     *      - or emits `PositionHealthy` when it is at or above 110 %.
     *      Reverts `PositionInactive` when the position is closed, and
     *      `StalePrice` when the oracle update is older than 10 minutes.
     *      A zero principal is treated as healthy (nothing left to secure).
     *      A computed `sellAmount` of zero is not forwarded to the vault,
     *      because `SecondaryMarket.sellOnBehalf` rejects a zero sale.
     * @param positionId ID of the repo position to evaluate.
     */
    function evaluate(uint256 positionId) external {
        (, uint256 collateralAmount, uint256 principal, bool active) = vault.getPositionSummary(positionId);
        if (!active) revert PositionInactive();

        (int256 price, uint256 updatedAt) = bondOracle.latestPrice();
        if (block.timestamp - updatedAt > _STALE_PRICE_WINDOW) revert StalePrice();

        if (principal == 0) {
            emit PositionHealthy(positionId, TARGET_RATIO_BPS);
            return;
        }

        uint256 collateralValue = (uint256(price) * collateralAmount) / _PRICE_SCALE;
        uint256 ratioBps = (collateralValue * _BPS_DENOMINATOR) / principal;

        if (ratioBps < LIQUIDATION_THRESHOLD_BPS) {
            uint256 sellAmount = _sellAmountToRestore(
                collateralAmount,
                collateralValue,
                principal,
                uint256(price)
            );
            if (sellAmount > 0) {
                vault.liquidatePartial(positionId, sellAmount);
            }
        } else if (ratioBps < TARGET_RATIO_BPS) {
            vault.issueMarginCall(positionId, ratioBps);
        } else {
            emit PositionHealthy(positionId, ratioBps);
        }
    }

    // ---------------------------------------------------------------------
    // Internal functions
    // ---------------------------------------------------------------------

    /**
     * @notice Bond units to sell so remaining collateral / remaining principal
     *         equals `TARGET_RATIO_BPS`.
     * @dev Algebra (P is the decimal-adjusted unit price `price / 1e8`):
     *
     *      Let C = collateralAmount, P = price / 1e8, V = C * P = collateralValue,
     *      L = principal, target = TARGET_RATIO_BPS / 10_000.
     *
     *      After selling x units at price P, proceeds `xP` pay down the loan:
     *          remaining collateral value = V - xP
     *          remaining principal        = L - xP
     *      Target: (V - xP) / (L - xP) = target
     *
     *          V - xP = target * (L - xP)
     *          V - xP = target*L - target*x*P
     *          V - target*L = xP - target*x*P
     *          V - target*L = xP * (1 - target)
     *          x = (V - target*L) / (P * (1 - target))
     *
     *      `target > 1`, so `(1 - target)` is negative. Flipping both signs
     *      for unsigned integer math:
     *          x = (target*L - V) / (P * (target - 1))
     *
     *      Substituting `target = T / BPS`, `P = price / 1e8`, `BPS = 10_000`,
     *      `T = TARGET_RATIO_BPS`:
     *          x = (T*L - BPS*V) * 1e8 / (price * (T - BPS))
     *
     *      The division is rounded up so truncation cannot leave the position
     *      below target. The result is clamped to `[0, C]` when the position
     *      is too far underwater for any sale to restore 110 %.
     * @param collateralAmount Bond units currently pledged (`C`).
     * @param collateralValue Oracle-valued collateral (`V` = C * P).
     * @param principal Outstanding cash owed (`L`).
     * @param price Oracle price at 8 decimals (so P = price / 1e8).
     * @return sellAmount Bond units to sell, clamped to the pledged amount.
     */
    function _sellAmountToRestore(
        uint256 collateralAmount,
        uint256 collateralValue,
        uint256 principal,
        uint256 price
    ) internal pure returns (uint256 sellAmount) {
        if (collateralAmount == 0 || price == 0) {
            return 0;
        }

        // target*L compared with V, in BPS: T*L vs 10_000*V.
        uint256 targetPrincipalValue = TARGET_RATIO_BPS * principal;
        uint256 scaledCollateralValue = _BPS_DENOMINATOR * collateralValue;
        if (targetPrincipalValue <= scaledCollateralValue) {
            return 0;
        }

        // x = (T*L - BPS*V) * 1e8 / (price * (T - BPS)), rounded up.
        uint256 numerator = (targetPrincipalValue - scaledCollateralValue) * _PRICE_SCALE;
        uint256 denominator = price * (TARGET_RATIO_BPS - _BPS_DENOMINATOR);
        sellAmount = (numerator + denominator - 1) / denominator;

        if (sellAmount > collateralAmount) {
            sellAmount = collateralAmount;
        }
    }
}
