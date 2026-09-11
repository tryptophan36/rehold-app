// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    HederaTokenService
} from "@hashgraph/hedera-smart-contracts/contracts/system-contracts/hedera-token-service/HederaTokenService.sol";
import {
    HederaResponseCodes
} from "@hashgraph/hedera-smart-contracts/contracts/system-contracts/HederaResponseCodes.sol";

import { ISecondaryMarket } from "./interfaces/ISecondaryMarket.sol";

/**
 * @title SecondaryMarket
 * @author Asset Tokenization Studio Team
 * @notice Simple order book for ATS-compliant bond tokens.
 *
 * @dev
 * The ATS bond token remains responsible for its own KYC and compliance
 * checks. This contract deliberately does not duplicate those checks; token
 * transfers are allowed to revert naturally if either party is ineligible.
 *
 * The contract also associates itself with the configured HTS cash token in
 * the constructor so that it can hold and transfer that token.
 *
 * The liquidation matcher uses active orders as price quotes and treats the
 * order owner as the cash-paying counterparty. A production implementation
 * should generally use a separate bid-order model for this purpose.
 */
contract SecondaryMarket is HederaTokenService, Ownable, ReentrancyGuard, ISecondaryMarket {
    /// @notice A stored bond order.
    struct Order {
        address seller;
        address bondToken;
        uint256 amount;
        uint256 pricePerUnit;
        bool active;
    }

    /// @notice All orders indexed by order ID.
    mapping(uint256 => Order) public orders;

    /// @notice ID assigned to the next newly listed order.
    uint256 public nextOrderId;

    /// @notice Cash token used to settle trades.
    IERC20 public cashToken;

    /// @notice Address authorised to execute liquidation sales.
    address public repoVault;

    /**
     * @notice Emitted when a new order is listed.
     * @param orderId ID assigned to the listed order.
     * @param seller Address that escrowed the bond tokens.
     * @param bondToken ATS bond token offered for sale.
     * @param amount Bond-token amount placed on the book.
     * @param pricePerUnit Cash-token price demanded per bond unit.
     */
    event OrderListed(
        uint256 indexed orderId,
        address indexed seller,
        address indexed bondToken,
        uint256 amount,
        uint256 pricePerUnit
    );

    /**
     * @notice Emitted when an order is cancelled.
     * @param orderId ID of the cancelled order.
     */
    event OrderCancelled(uint256 indexed orderId);

    /**
     * @notice Emitted when an order is filled.
     * @param orderId ID of the filled order.
     * @param buyer Address that paid cash and received bonds.
     * @param amount Bond-token amount transferred to the buyer.
     * @param cost Cash-token amount paid to the seller.
     */
    event OrderFilled(uint256 indexed orderId, address indexed buyer, uint256 amount, uint256 cost);

    /**
     * @notice Emitted when RepoVault sells bonds through the market.
     * @param bondToken ATS bond token sold in the liquidation.
     * @param amount Bond-token amount sold.
     * @param proceeds Cash-token proceeds sent to RepoVault.
     */
    event LiquidationSale(address indexed bondToken, uint256 amount, uint256 proceeds);

    /// @notice Thrown when the caller is not the original order seller.
    error NotSeller();

    /// @notice Thrown when an order is no longer active.
    error OrderInactive();

    /// @notice Thrown when the caller is not the configured RepoVault.
    error NotRepoVault();

    /// @notice Thrown when insufficient active orders are available.
    error InsufficientLiquidity();

    /**
     * @notice Creates the secondary market and associates it with the cash token.
     * @param _cashToken HTS token address exposed through the IERC20 interface.
     */
    constructor(address _cashToken) Ownable(msg.sender) {
        require(_cashToken != address(0), "Cash token is zero address");

        cashToken = IERC20(_cashToken);

        int response = associateToken(address(this), address(cashToken));

        require(response == HederaResponseCodes.SUCCESS, "Cash token association failed");
    }

    /**
     * @notice Sets the RepoVault address.
     * @dev This may only be called once by the contract owner.
     * @param _repoVault Address of the RepoVault contract.
     */
    function setRepoVault(address _repoVault) external onlyOwner {
        require(repoVault == address(0), "RepoVault already set");
        require(_repoVault != address(0), "RepoVault is zero address");

        repoVault = _repoVault;
    }

    /**
     * @notice Lists an ATS bond order for sale.
     * @dev
     * The bond token is transferred into escrow before the order is stored.
     * Any ATS KYC or compliance failure reverts naturally from transferFrom.
     *
     * @param bondToken Address of the ATS bond token.
     * @param amount Amount of bond tokens to list.
     * @param pricePerUnit Price per bond token in cash-token units.
     * @return orderId ID of the newly created order.
     */
    function listOrder(
        address bondToken,
        uint256 amount,
        uint256 pricePerUnit
    ) external nonReentrant returns (uint256 orderId) {
        require(amount > 0, "Amount is zero");

        require(IERC20(bondToken).transferFrom(msg.sender, address(this), amount), "Bond transfer failed");

        orderId = nextOrderId;
        nextOrderId = orderId + 1;

        orders[orderId] = Order({
            seller: msg.sender,
            bondToken: bondToken,
            amount: amount,
            pricePerUnit: pricePerUnit,
            active: true
        });

        emit OrderListed(orderId, msg.sender, bondToken, amount, pricePerUnit);
    }

    /**
     * @notice Cancels an active order and returns its remaining bond tokens.
     * @dev Only the original seller may cancel an order.
     * @param orderId ID of the order to cancel.
     */
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];

        if (order.seller != msg.sender) {
            revert NotSeller();
        }

        if (!order.active) {
            revert OrderInactive();
        }

        uint256 remainingAmount = order.amount;

        order.amount = 0;
        order.active = false;

        require(IERC20(order.bondToken).transfer(order.seller, remainingAmount), "Bond return failed");

        emit OrderCancelled(orderId);
    }

    /**
     * @notice Fills part or all of an active bond order.
     * @dev
     * The buyer pays the seller in cash tokens, after which the contract
     * transfers the bond tokens to the buyer. The ATS token itself enforces
     * the buyer's KYC and compliance eligibility.
     *
     * @param orderId ID of the order to fill.
     * @param amount Amount of bond tokens to purchase.
     */
    function fillOrder(uint256 orderId, uint256 amount) external nonReentrant {
        Order storage order = orders[orderId];

        if (!order.active) {
            revert OrderInactive();
        }

        require(amount > 0, "Amount is zero");
        require(amount <= order.amount, "Amount exceeds order");

        uint256 cost = amount * order.pricePerUnit;

        require(cashToken.transferFrom(msg.sender, order.seller, cost), "Cash transfer failed");

        // Any ATS KYC or compliance failure for the buyer reverts naturally.
        require(IERC20(order.bondToken).transfer(msg.sender, amount), "Bond transfer failed");

        order.amount -= amount;

        if (order.amount == 0) {
            order.active = false;
        }

        emit OrderFilled(orderId, msg.sender, amount, cost);
    }

    /// @inheritdoc ISecondaryMarket
    function sellOnBehalf(address bondToken, uint256 amount) external nonReentrant returns (uint256 proceeds) {
        if (msg.sender != repoVault) {
            revert NotRepoVault();
        }

        require(amount > 0, "Amount is zero");

        uint256 remaining = amount;

        while (remaining > 0) {
            uint256 bestOrderId = type(uint256).max;
            uint256 bestPrice;

            /*
             * Select the highest-priced active order. This maximises proceeds
             * for a liquidation sale.
             */
            for (uint256 i = 0; i < nextOrderId; i++) {
                Order storage candidate = orders[i];

                if (
                    candidate.active &&
                    candidate.bondToken == bondToken &&
                    candidate.amount > 0 &&
                    (bestOrderId == type(uint256).max || candidate.pricePerUnit > bestPrice)
                ) {
                    bestOrderId = i;
                    bestPrice = candidate.pricePerUnit;
                }
            }

            if (bestOrderId == type(uint256).max) {
                revert InsufficientLiquidity();
            }

            Order storage order = orders[bestOrderId];

            uint256 fillAmount = remaining < order.amount ? remaining : order.amount;

            uint256 cost = fillAmount * order.pricePerUnit;

            order.amount -= fillAmount;

            if (order.amount == 0) {
                order.active = false;
            }

            /*
             * The intermediate transfer into this contract uses the HTS
             * association established in the constructor. The proceeds are
             * then transferred to RepoVault.
             */
            require(cashToken.transferFrom(order.seller, address(this), cost), "Cash collection failed");

            require(cashToken.transfer(repoVault, cost), "Cash payout failed");

            // ATS compliance is enforced by the bond token transfer itself.
            require(IERC20(order.bondToken).transfer(order.seller, fillAmount), "Bond transfer failed");

            proceeds += cost;
            remaining -= fillAmount;
        }

        emit LiquidationSale(bondToken, amount, proceeds);
    }
}
