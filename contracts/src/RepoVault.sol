// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Hedera's published Solidity support libraries for the HTS system precompile.
// Pulled from the hashgraph/hedera-smart-contracts repo — do not hand-write these.
import {
    HederaTokenService
} from "@hashgraph/hedera-smart-contracts/contracts/system-contracts/hedera-token-service/HederaTokenService.sol";
import {
    HederaResponseCodes
} from "@hashgraph/hedera-smart-contracts/contracts/system-contracts/HederaResponseCodes.sol";

import { IPriceOracle } from "./interfaces/IPriceOracle.sol";
import { ISecondaryMarket } from "./interfaces/ISecondaryMarket.sol";
import { IIdentityRegistry } from "./interfaces/IIdentityRegistry.sol";
import { IATSBondToken } from "./interfaces/IATSBondToken.sol";
import { IHoldTypes } from "./interfaces/IHoldTypes.sol";

/**
 * @title RepoVault
 * @author Asset Tokenization Studio Team
 * @notice Shared repo clearing house: one vault can custody and lend against
 *         ATS bonds from many issuers. Each onboarded bond is priced by its
 *         own IPriceOracle, registered via `setOracleForBond`. The pooled
 *         liquidity source ("lender pool") funds the cash leg of every repo.
 * @dev This is a demo/testnet contract. Lender pool accounting uses simple
 *      proportional bookkeeping (deposits and withdrawals tracked as plain
 *      uint256 balances) rather than ERC-4626-style share tokens. That is
 *      adequate for a single lender or a small, cooperative set of lenders,
 *      but a production version should mint shares so that deposits, yield,
 *      and loss are always consistent under concurrent activity.
 *
 *      Hold expiry is set to zero (never-expires) on every position. The repo
 *      term is enforced by `termEnd` + `settleAtMaturity`, not by hold expiry,
 *      to prevent borrowers from reclaiming collateral via `reclaimHoldByPartition`
 *      before the term ends.
 */
contract RepoVault is Ownable, ReentrancyGuard, HederaTokenService {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /**
     * @notice State record for a single collateralised repo position.
     * @param borrower Address that opened this position.
     * @param bondToken ATS diamond proxy address of the pledged bond token.
     * @param partition ERC-1410 partition under which the hold is registered.
     * @param holdId Sequence id assigned by the bond token for this position's hold.
     * @param collateralAmount Bond units currently pledged and under hold.
     * @param principal Outstanding cash (USDC) owed by the borrower.
     * @param haircutBps Haircut applied at origination, in basis points.
     * @param maintenanceThresholdBps Collateral ratio below which a margin call fires.
     * @param targetRatioBps Collateral ratio targeted after a partial liquidation.
     * @param termEnd Unix timestamp at which the repo matures.
     * @param lastMarginCallAt Unix timestamp of the most recent margin call, or 0.
     * @param active False once the position is repaid, settled, or fully liquidated.
     */
    struct RepoPosition {
        address borrower;
        address bondToken;
        bytes32 partition;
        uint256 holdId;
        uint256 collateralAmount;
        uint256 principal;
        uint256 haircutBps;
        uint256 maintenanceThresholdBps;
        uint256 targetRatioBps;
        uint256 termEnd;
        uint256 lastMarginCallAt;
        bool active;
    }

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    /// @notice All active and historical repo positions, keyed by position ID.
    mapping(uint256 => RepoPosition) public positions;

    /// @notice ID that will be assigned to the next opened position.
    uint256 public nextPositionId;

    /// @notice Per-bond NAV oracle (BondPriceOracle or any IPriceOracle-compatible feed).
    /// @dev One shared vault can serve many issuers; each bondToken has its own
    ///      independent market price and therefore its own oracle instance.
    mapping(address => address) public bondOracles;

    /// @notice Address of the MarginEngine contract authorised to trigger liquidations.
    address public marginEngine;

    /// @notice Address of the SecondaryMarket used for liquidation sales.
    address public secondaryMarket;

    /// @notice Optional ATS Identity Registry for defense-in-depth origination checks.
    /// @dev Skipped when address(0). ATS bond token enforces KYC internally.
    IIdentityRegistry public identityRegistry;

    /// @notice The HTS cash token (USDC on Hedera testnet: 0.0.429274).
    IERC20 public cashToken;

    /// @notice Fee charged on repayment, in bps of principal. Defaults to 0.5%.
    uint256 public repoFeeBps = 50;

    /// @notice Total cash deposited by lenders (including amounts currently lent out).
    uint256 public totalDeposited;

    /// @notice Total cash currently lent across all active positions.
    uint256 public totalLent;

    /// @notice Per-lender deposit balance.
    mapping(address => uint256) public lenderDeposits;

    /// @notice Per-lender accrued yield available to claim.
    mapping(address => uint256) public lenderClaimableYield;

    /// @dev Tracks every address that has ever deposited, so `_distributeFee` and
    ///      `_socializeLoss` can iterate lenders for pro-rata accounting.
    ///      Fine at demo scale (small, bounded lender count). An unbounded lender
    ///      set would need a pull-based checkpoint scheme instead.
    address[] private _lenderList;

    /// @dev Membership set for O(1) deduplication when adding to `_lenderList`.
    mapping(address => bool) private _isKnownLender;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /**
     * @notice Emitted when a lender deposits cash into the lender pool.
     * @param lender Address that made the deposit.
     * @param amount Cash amount deposited.
     */
    event LiquidityDeposited(address indexed lender, uint256 amount);

    /**
     * @notice Emitted when a lender withdraws idle cash from the lender pool.
     * @param lender Address that made the withdrawal.
     * @param amount Cash amount withdrawn.
     */
    event LiquidityWithdrawn(address indexed lender, uint256 amount);

    /**
     * @notice Emitted when a lender claims accrued yield.
     * @param lender Address that claimed yield.
     * @param amount Cash amount paid out.
     */
    event YieldClaimed(address indexed lender, uint256 amount);

    /**
     * @notice Emitted when a new repo position is opened.
     * @param positionId ID of the newly created position.
     * @param borrower Address of the borrower.
     * @param collateralAmount Bond units pledged as collateral.
     * @param principal Cash amount lent to the borrower.
     */
    event RepoOriginated(
        uint256 indexed positionId,
        address indexed borrower,
        uint256 collateralAmount,
        uint256 principal
    );

    /**
     * @notice Emitted when a repo position is closed (repaid or settled at maturity).
     * @param positionId ID of the closed position.
     * @param atMaturity True when settled by the Hedera Scheduled Transaction at maturity.
     */
    event RepoSettled(uint256 indexed positionId, bool atMaturity);
    
    /**
     * @notice Emitted after a partial liquidation of a position's collateral.
     * @param positionId ID of the liquidated position.
     * @param sellAmount Bond units sold on the secondary market.
     * @param proceeds Cash proceeds returned from the market and applied to principal.
     */
    event PartialLiquidation(uint256 indexed positionId, uint256 sellAmount, uint256 proceeds);

    /**
     * @notice Emitted when a position's proceeds fall short of its outstanding principal.
     * @param positionId ID of the position that generated bad debt.
     * @param shortfall Cash amount that could not be recovered, socialised across lenders.
     */
    event BadDebtRealized(uint256 indexed positionId, uint256 shortfall);

    /**
     * @notice Emitted when the MarginEngine issues a margin call on a position.
     * @param positionId ID of the under-collateralised position.
     * @param ratioBps Current collateral ratio, in basis points.
     */
    event MarginCallIssued(uint256 indexed positionId, uint256 ratioBps);

    /**
     * @notice Emitted when an admin registers or rotates the NAV oracle for a bond.
     * @param bondToken ATS diamond proxy whose prices this oracle reports.
     * @param oracle IPriceOracle instance for that bond.
     */
    event OracleSetForBond(address indexed bondToken, address indexed oracle);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice Thrown when the bond oracle price is older than 10 minutes.
    error StalePrice();
    /// @notice Thrown when `originateRepo` is called for a bond with no registered oracle.
    error NoOracleForBond();
    /// @notice Thrown when the lender pool does not hold enough idle cash to fund a repo.
    error InsufficientPoolLiquidity();
    /// @notice Thrown when a lender tries to withdraw more than their idle share.
    error InsufficientIdleLiquidity();
    /// @notice Thrown when a caller other than `marginEngine` invokes a restricted function.
    error NotMarginEngine();
    /// @notice Thrown when a caller other than the position's `borrower` attempts repayment.
    error NotBorrower();
    /// @notice Thrown when an operation targets a position that is no longer active.
    error PositionNotActive();
    /// @notice Thrown when the borrower is not verified in the optional identity registry.
    error NotVerified();
    /// @notice Thrown when a zero amount is supplied to a function that requires a positive value.
    error ZeroAmount();
    /// @notice Thrown when a required address argument is the zero address.
    error ZeroAddress();
    /// @notice Thrown when a cash (USDC) transfer fails.
    error CashTransferFailed();
    /// @notice Thrown when HTS association of the USDC token fails in the constructor.
    error UsdcAssociationFailed();
    /// @notice Thrown when a one-time-set admin address has already been configured.
    error AlreadySet();
    /// @notice Thrown when `settleAtMaturity` is called before `termEnd`.
    error MaturityNotReached();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    /// @notice Restricts a function to the configured `marginEngine` address.
    modifier onlyMarginEngine() {
        if (msg.sender != marginEngine) revert NotMarginEngine();
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @notice Deploys the vault and associates it with the HTS cash token.
     * @dev Oracles are not wired here. After deploy, call `setOracleForBond`
     *      once per onboarded ATS bond so originateRepo can price that instrument.
     * @param _cashToken The Solidity address of Hedera testnet's native USDC
     *        (HTS token 0.0.429274, resolved to its EVM address). NOT a plain
     *        mock ERC-20 — the HTS association below is required before the vault
     *        can hold or transfer USDC.
     */
    constructor(address _cashToken) Ownable(msg.sender) {
        cashToken = IERC20(_cashToken);

        // HTS tokens require explicit association before this contract can hold
        // or move them — there is no default-allow behaviour like a plain ERC-20.
        int256 response = HederaTokenService.associateToken(address(this), _cashToken);
        if (response != HederaResponseCodes.SUCCESS) revert UsdcAssociationFailed();
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /**
     * @notice One-time wiring of the MarginEngine contract address.
     * @param engine Address of the deployed MarginEngine.
     */
    function setMarginEngine(address engine) external onlyOwner {
        if (marginEngine != address(0)) revert AlreadySet();
        marginEngine = engine;
    }

    /**
     * @notice One-time wiring of the SecondaryMarket contract address.
     * @param market Address of the deployed SecondaryMarket.
     */
    function setSecondaryMarket(address market) external onlyOwner {
        if (secondaryMarket != address(0)) revert AlreadySet();
        secondaryMarket = market;
    }

    /**
     * @notice Optional wiring of an ATS Identity Registry for defense-in-depth
     *         verification checks at repo origination time.
     * @param registry Address of the ATS Identity Registry, or address(0) to disable.
     */
    function setIdentityRegistry(address registry) external onlyOwner {
        identityRegistry = IIdentityRegistry(registry);
    }

    /**
     * @notice Registers (or rotates) the NAV oracle used to price `bondToken`.
     * @dev Each ATS bond is an independent instrument and must have its own
     *      BondPriceOracle instance. Without a mapping entry, `originateRepo`
     *      for that bond reverts `NoOracleForBond`.
     * @param bondToken ATS diamond proxy address of the bond.
     * @param oracleAddress IPriceOracle (typically a BondPriceOracle) for this bond.
     */
    function setOracleForBond(address bondToken, address oracleAddress) external onlyOwner {
        if (bondToken == address(0) || oracleAddress == address(0)) revert ZeroAddress();
        bondOracles[bondToken] = oracleAddress;
        emit OracleSetForBond(bondToken, oracleAddress);
    }

    /**
     * @notice Updates the fee charged on repayment, in bps of principal.
     * @param newFeeBps New fee rate in basis points (e.g. 50 = 0.5%).
     */
    function setRepoFeeBps(uint256 newFeeBps) external onlyOwner {
        repoFeeBps = newFeeBps;
    }

    // ---------------------------------------------------------------------
    // Lender pool
    // ---------------------------------------------------------------------

    /**
     * @notice Deposits `amount` of cashToken into the lender pool.
     * @param amount Cash amount to deposit. Must be greater than zero.
     */
    function depositLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        bool ok = cashToken.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert CashTransferFailed();

        if (!_isKnownLender[msg.sender]) {
            _isKnownLender[msg.sender] = true;
            _lenderList.push(msg.sender);
        }

        lenderDeposits[msg.sender] += amount;
        totalDeposited += amount;

        emit LiquidityDeposited(msg.sender, amount);
    }

    /**
     * @notice Withdraws up to the caller's currently idle share of the pool
     *         (their deposit minus their proportional share of what is out on loan).
     * @param amount Cash amount to withdraw. Must not exceed the caller's idle share.
     */
    function withdrawLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 deposit = lenderDeposits[msg.sender];
        uint256 lentShare = totalDeposited == 0 ? 0 : (deposit * totalLent) / totalDeposited;
        uint256 idleShare = deposit > lentShare ? deposit - lentShare : 0;

        if (amount > idleShare) revert InsufficientIdleLiquidity();

        lenderDeposits[msg.sender] = deposit - amount;
        totalDeposited -= amount;

        bool ok = cashToken.transfer(msg.sender, amount);
        if (!ok) revert CashTransferFailed();

        emit LiquidityWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Pays out the caller's accrued yield (from repayment fees).
     */
    function claimYield() external nonReentrant {
        uint256 amount = lenderClaimableYield[msg.sender];
        if (amount == 0) revert ZeroAmount();

        lenderClaimableYield[msg.sender] = 0;

        bool ok = cashToken.transfer(msg.sender, amount);
        if (!ok) revert CashTransferFailed();

        emit YieldClaimed(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Repo lifecycle
    // ---------------------------------------------------------------------

    /**
     * @notice Originates a new repo: pledges `collateralAmount` of `bondToken`
     *         via a Hold and lends the borrower cash against it.
     * @dev Collateral is priced via `bondOracles[bondToken]` at 8 decimals
     *      (Chainlink convention). The oracle price and bond token unit
     *      convention must share the same scale — adjust the 1e8 divisor if needed.
     *
     *      The hold is created with `expirationTimestamp == type(uint256).max`
     *      (ATS never-expires). A zero timestamp reverts `WrongExpirationTimestamp`.
     *      Term enforcement is handled by `termEnd` + `settleAtMaturity`, not
     *      hold expiry, to prevent borrowers reclaiming collateral early via
     *      `reclaimHoldByPartition`.
     *
     *      The caller must have previously called `authorizeOperator(address(this))`
     *      on the ATS bond token to permit the vault to create holds on their behalf.
     *
     * @param bondToken ATS diamond proxy address of the bond to pledge.
     * @param partition ERC-1410 partition under which the collateral is held.
     * @param collateralAmount Number of bond units to pledge. Must be greater than zero.
     * @param termSeconds Duration of the repo in seconds from the current block.
     * @param haircutBps Haircut rate in bps applied to collateral value to compute principal.
     * @param maintenanceThresholdBps Collateral ratio (bps) below which margin call fires.
     * @param targetRatioBps Collateral ratio (bps) targeted after a partial liquidation.
     * @return positionId ID assigned to the new position.
     */
    function originateRepo(
        address bondToken,
        bytes32 partition,
        uint256 collateralAmount,
        uint256 termSeconds,
        uint256 haircutBps,
        uint256 maintenanceThresholdBps,
        uint256 targetRatioBps
    ) external nonReentrant returns (uint256 positionId) {
        if (collateralAmount == 0) revert ZeroAmount();

        (int256 oraclePrice, uint256 updatedAt) = _latestPriceForBond(bondToken);
        if (block.timestamp - updatedAt > 10 minutes) revert StalePrice();

        uint256 collateralValue = (uint256(oraclePrice) * collateralAmount) / 1e8;
        uint256 principal = (collateralValue * (10000 - haircutBps)) / 10000;

        if (this.getAvailableLiquidity() < principal) revert InsufficientPoolLiquidity();

        // Optional defense-in-depth: skip gracefully when no registry is configured,
        // since the ATS bond token's own hold and transfer paths enforce KYC internally.
        if (address(identityRegistry) != address(0)) {
            if (!identityRegistry.isVerified(msg.sender)) revert NotVerified();
        }

        IHoldTypes.Hold memory hold = IHoldTypes.Hold({
            amount: collateralAmount,
            expirationTimestamp: type(uint256).max, // ATS never-expires — 0 reverts WrongExpirationTimestamp
            escrow: address(this),
            to: address(this), // fixed forever — vault executes into itself then transfers onward
            data: ""
        });

        (, uint256 holdId) = IATSBondToken(bondToken).createHoldFromByPartition(partition, msg.sender, hold, "");

        totalLent += principal;

        positionId = nextPositionId++;
        positions[positionId] = RepoPosition({
            borrower: msg.sender,
            bondToken: bondToken,
            partition: partition,
            holdId: holdId,
            collateralAmount: collateralAmount,
            principal: principal,
            haircutBps: haircutBps,
            maintenanceThresholdBps: maintenanceThresholdBps,
            targetRatioBps: targetRatioBps,
            termEnd: block.timestamp + termSeconds,
            lastMarginCallAt: 0,
            active: true
        });

        bool ok = cashToken.transfer(msg.sender, principal);
        if (!ok) revert CashTransferFailed();

        emit RepoOriginated(positionId, msg.sender, collateralAmount, principal);
    }

    /**
     * @notice Repays a position in full: principal + fee, releases the pledged
     *         collateral back to the borrower, and credits fee income to lenders.
     * @param positionId ID of the position to repay.
     */
    function repay(uint256 positionId) external nonReentrant {
        RepoPosition storage pos = positions[positionId];
        if (!pos.active) revert PositionNotActive();
        if (msg.sender != pos.borrower) revert NotBorrower();

        uint256 principal = pos.principal;
        uint256 fee = (principal * repoFeeBps) / 10000;
        uint256 totalOwed = principal + fee;

        bool ok = cashToken.transferFrom(msg.sender, address(this), totalOwed);
        if (!ok) revert CashTransferFailed();

        IHoldTypes.HoldIdentifier memory id = IHoldTypes.HoldIdentifier({
            partition: pos.partition,
            tokenHolder: pos.borrower,
            holdId: pos.holdId
        });
        IATSBondToken(pos.bondToken).releaseHoldByPartition(id, pos.collateralAmount);

        totalLent -= principal;
        _distributeFee(fee);

        pos.principal = 0;
        pos.active = false;

        emit RepoSettled(positionId, false);
    }

    /**
     * @notice Sells `sellAmount` of a position's pledged collateral to pay down
     *         its principal. Callable only by the MarginEngine.
     * @param positionId ID of the position to partially liquidate.
     * @param sellAmount Bond units to execute from the hold and sell on the market.
     */
    function liquidatePartial(uint256 positionId, uint256 sellAmount) external nonReentrant onlyMarginEngine {
        RepoPosition storage pos = positions[positionId];
        if (!pos.active) revert PositionNotActive();

        IHoldTypes.HoldIdentifier memory id = IHoldTypes.HoldIdentifier({
            partition: pos.partition,
            tokenHolder: pos.borrower,
            holdId: pos.holdId
        });
        IATSBondToken(pos.bondToken).executeHoldByPartition(id, address(this), sellAmount);

        bool ok = IATSBondToken(pos.bondToken).transfer(secondaryMarket, sellAmount);
        if (!ok) revert CashTransferFailed();

        uint256 proceeds = ISecondaryMarket(secondaryMarket).sellOnBehalf(pos.bondToken, sellAmount);

        _applyProceedsToPosition(positionId, proceeds);
        pos.collateralAmount -= sellAmount;

        emit PartialLiquidation(positionId, sellAmount, proceeds);
    }

    /**
     * @notice Issues a margin call notice for a position. Callable only by the
     *         MarginEngine; purely informational (drives UI grace-period timers).
     * @param positionId ID of the under-collateralised position.
     * @param ratioBps Current collateral ratio, in basis points.
     */
    function issueMarginCall(uint256 positionId, uint256 ratioBps) external onlyMarginEngine {
        positions[positionId].lastMarginCallAt = block.timestamp;
        emit MarginCallIssued(positionId, ratioBps);
    }

    /**
     * @notice Settles a position at maturity by redeeming the remaining collateral
     *         at face value from the issuer and applying proceeds to the debt.
     * @dev Intended to be triggered by a Hedera Scheduled Transaction at `termEnd`,
     *      but callable by anyone — it is a no-op (early return) if already settled.
     * @param positionId ID of the position to settle.
     */
    function settleAtMaturity(uint256 positionId) external nonReentrant {
        RepoPosition storage pos = positions[positionId];
        if (!pos.active) return; // already repaid or settled

        if (block.timestamp < pos.termEnd) revert MaturityNotReached();

        IHoldTypes.HoldIdentifier memory id = IHoldTypes.HoldIdentifier({
            partition: pos.partition,
            tokenHolder: pos.borrower,
            holdId: pos.holdId
        });
        IATSBondToken(pos.bondToken).executeHoldByPartition(id, address(this), pos.collateralAmount);

        uint256 balanceBefore = cashToken.balanceOf(address(this));
        IATSBondToken(pos.bondToken).fullRedeemAtMaturity(address(this));
        uint256 proceeds = cashToken.balanceOf(address(this)) - balanceBefore;

        _applyProceedsToPosition(positionId, proceeds);
        pos.collateralAmount = 0;
        pos.active = false;

        emit RepoSettled(positionId, true);
    }

    /**
     * @notice Read helper for MarginEngine's health evaluation.
     * @param positionId ID of the position to query.
     * @return borrower Address of the position's borrower.
     * @return bondToken ATS diamond proxy pledged as collateral.
     * @return collateralAmount Bond units currently pledged and under hold.
     * @return principal Outstanding cash owed by the borrower.
     * @return active False when the position has been closed.
     */
    function getPositionSummary(
        uint256 positionId
    )
        external
        view
        returns (address borrower, address bondToken, uint256 collateralAmount, uint256 principal, bool active)
    {
        RepoPosition storage pos = positions[positionId];
        return (pos.borrower, pos.bondToken, pos.collateralAmount, pos.principal, pos.active);
    }

    /**
     * @notice Cash currently sitting idle in the pool and available to lend.
     * @return The idle cash balance (totalDeposited minus totalLent).
     */
    function getAvailableLiquidity() external view returns (uint256) {
        return totalDeposited - totalLent;
    }

    // ---------------------------------------------------------------------
    // Internal accounting helpers
    // ---------------------------------------------------------------------

    /**
     * @notice Looks up the registered oracle for `bondToken` and returns its latest price.
     * @dev Reverts `NoOracleForBond` when the bond has not been onboarded.
     */
    function _latestPriceForBond(address bondToken) internal view returns (int256 oraclePrice, uint256 updatedAt) {
        address oracle = bondOracles[bondToken];
        if (oracle == address(0)) revert NoOracleForBond();
        return IPriceOracle(oracle).latestPrice();
    }

    /**
     * @notice Applies liquidation or redemption `proceeds` against a position's
     *         outstanding principal. Shared by `liquidatePartial` and `settleAtMaturity`.
     * @dev If proceeds fall short of the remaining principal the shortfall is realised
     *      as bad debt and socialised across the lender pool.
     * @param positionId ID of the position to update.
     * @param proceeds Cash proceeds to apply against the position's principal.
     */
    function _applyProceedsToPosition(uint256 positionId, uint256 proceeds) internal {
        RepoPosition storage pos = positions[positionId];
        uint256 owed = pos.principal;
        uint256 applied = proceeds < owed ? proceeds : owed;

        totalLent -= applied;
        pos.principal = owed - applied;

        if (proceeds < owed) {
            uint256 shortfall = owed - proceeds;
            _socializeLoss(shortfall);
            emit BadDebtRealized(positionId, shortfall);
        }
    }

    /**
     * @notice Credits `fee` to lenders' claimable yield, pro-rata by each lender's
     *         current share of `totalDeposited`.
     * @dev Demo-grade: iterates the bounded `_lenderList`. Rounding dust from
     *      integer division is left unallocated (negligible at this scale — the
     *      backing cash stays in the contract and is never lost).
     * @param fee Total fee amount to distribute across the lender pool.
     */
    function _distributeFee(uint256 fee) internal {
        if (fee == 0 || totalDeposited == 0) return;

        uint256 len = _lenderList.length;
        for (uint256 i = 0; i < len; ++i) {
            address lender = _lenderList[i];
            uint256 deposit = lenderDeposits[lender];
            if (deposit == 0) continue;
            lenderClaimableYield[lender] += (fee * deposit) / totalDeposited;
        }
    }

    /**
     * @notice Writes down `totalDeposited` (and each known lender's deposit,
     *         pro-rata) to reflect realised bad debt.
     * @dev Demo-grade simplification: a production system would let ERC-4626-style
     *      share price fall naturally rather than mutating individual balances directly.
     * @param shortfall Cash amount that could not be recovered from a position.
     */
    function _socializeLoss(uint256 shortfall) internal {
        if (shortfall == 0 || totalDeposited == 0) return;

        uint256 cappedShortfall = shortfall > totalDeposited ? totalDeposited : shortfall;
        uint256 len = _lenderList.length;

        for (uint256 i = 0; i < len; ++i) {
            address lender = _lenderList[i];
            uint256 deposit = lenderDeposits[lender];
            if (deposit == 0) continue;
            uint256 lenderLoss = (cappedShortfall * deposit) / totalDeposited;
            if (lenderLoss > deposit) lenderLoss = deposit;
            lenderDeposits[lender] = deposit - lenderLoss;
        }

        totalDeposited -= cappedShortfall;
    }
}
