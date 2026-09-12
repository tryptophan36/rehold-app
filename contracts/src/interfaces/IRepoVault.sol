// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IRepoVault
 * @author Asset Tokenization Studio Team
 * @notice Minimal vault surface used by MarginEngine for risk evaluation.
 * @dev MarginEngine must import this interface only, not the vault
 *      implementation, so the risk rules stay auditable in isolation from
 *      custody, hold, and lender-pool accounting. The live `RepoVault`
 *      contract already exposes these selectors.
 */
interface IRepoVault {
    /**
     * @notice Sells `sellAmount` of pledged collateral and pays down principal.
     * @dev Restricted on the vault to the wired MarginEngine address.
     *      Executes the ATS hold, routes tokens through the secondary market,
     *      and applies proceeds to the position.
     * @param positionId ID of the position to partially liquidate.
     * @param sellAmount Bond units to seize from the hold and sell.
     */
    function liquidatePartial(uint256 positionId, uint256 sellAmount) external;

    /**
     * @notice Records a margin-call notice for an under-collateralised position.
     * @dev Restricted on the vault to the wired MarginEngine address.
     *      Informational only: emits `MarginCallIssued` and stamps
     *      `lastMarginCallAt` for UI grace-period timers. Does not move tokens.
     * @param positionId ID of the under-collateralised position.
     * @param ratioBps Current collateral ratio, in basis points.
     */
    function issueMarginCall(uint256 positionId, uint256 ratioBps) external;

    /**
     * @notice Returns the fields MarginEngine needs to value a position.
     * @dev `borrower` is unused by the engine; it is kept because callers
     *      already decode this tuple. `bondToken` selects the per-bond oracle.
     * @param positionId ID of the repo position to query.
     * @return borrower Address that opened the position.
     * @return bondToken ATS diamond proxy pledged as collateral.
     * @return collateralAmount Bond units currently pledged and under hold.
     * @return principal Outstanding cash owed by the borrower.
     * @return active False once the position has been repaid or settled.
     */
    function getPositionSummary(
        uint256 positionId
    )
        external
        view
        returns (address borrower, address bondToken, uint256 collateralAmount, uint256 principal, bool active);

    /**
     * @notice NAV oracle registered for `bondToken`, or address(0) if none.
     * @param bondToken ATS diamond proxy whose price feed is requested.
     * @return oracle IPriceOracle address for that bond.
     */
    function bondOracles(address bondToken) external view returns (address oracle);
}
