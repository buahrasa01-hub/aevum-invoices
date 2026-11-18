// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice EIP-3009 (USDC-style) signed transfers. tUSD8 on Aevum implements this.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title Invoice
/// @notice A stablecoin invoicing contract on Aevum testnet. The merchant creates an invoice
///         for a designated payer (or anyone, when payer is address(0)); the buyer pays the
///         EXACT invoiced amount, either with an approval (two transactions, buyer pays gas)
///         or with one EIP-3009 signature that anyone can relay (gasless for the buyer).
///         Money goes straight to the merchant; the `InvoicePaid` event is the receipt.
///
/// @dev Forked from the Aevum Starter Kit's Checkout.sol (MIT, PQA Labs) and changed in
///      four ways that matter:
///        1. The amount comes from the invoice, never from the caller. Checkout let anyone
///           mark an order paid with 0.000001 tUSD8 and front-run the real buyer; here the
///           contract itself enforces the exact invoiced amount.
///        2. The payer can be designated at creation. A payment from anyone else reverts,
///           so an invoice can't be claimed by a stranger.
///        3. Invoices expire (`dueAt`, 0 = never) and the merchant can cancel an unpaid one.
///        4. Tokens sent straight to the contract by mistake are recoverable by the merchant
///           (`recoverERC20`). Invoice payments never sit in the contract, so this can only
///           ever return accidental transfers, never customer funds.
contract Invoice {
    using SafeERC20 for IERC20;

    struct InvoiceData {
        address payer; // address(0) = anyone may pay
        address paidBy;
        uint64 createdAt;
        uint64 dueAt; // 0 = no expiry
        uint64 paidAt;
        uint256 amount;
        string memo;
        bool paid;
        bool cancelled;
    }

    IERC20 public immutable token;
    address public immutable merchant;

    mapping(bytes32 invoiceId => InvoiceData) private _invoices;

    event InvoiceCreated(
        bytes32 indexed invoiceId, address indexed payer, uint256 amount, uint64 dueAt, string memo
    );
    event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, uint256 amount);
    event InvoiceCancelled(bytes32 indexed invoiceId);

    error OnlyMerchant();
    error InvoiceExists(bytes32 invoiceId);
    error InvoiceNotFound(bytes32 invoiceId);
    error AlreadyPaid(bytes32 invoiceId);
    error AlreadyCancelled(bytes32 invoiceId);
    error InvoiceExpired(bytes32 invoiceId);
    error WrongPayer(address payer);
    error ZeroAmount();
    error ZeroAddress();
    error InvalidDueDate();

    constructor(IERC20 token_, address merchant_) {
        if (address(token_) == address(0) || merchant_ == address(0)) revert ZeroAddress();
        token = token_;
        merchant = merchant_;
    }

    /// @notice Create an invoice. Only the merchant. `dueAt` is a unix timestamp, 0 = no expiry.
    function createInvoice(
        bytes32 invoiceId,
        address payer,
        uint256 amount,
        uint64 dueAt,
        string calldata memo
    ) external {
        if (msg.sender != merchant) revert OnlyMerchant();
        if (amount == 0) revert ZeroAmount();
        if (_invoices[invoiceId].amount != 0) revert InvoiceExists(invoiceId);
        if (dueAt != 0 && dueAt <= block.timestamp) revert InvalidDueDate();

        _invoices[invoiceId] = InvoiceData({
            payer: payer,
            paidBy: address(0),
            createdAt: uint64(block.timestamp),
            dueAt: dueAt,
            paidAt: 0,
            amount: amount,
            memo: memo,
            paid: false,
            cancelled: false
        });
        emit InvoiceCreated(invoiceId, payer, amount, dueAt, memo);
    }

    /// @notice Pay `invoiceId` for its exact invoiced amount. The buyer must have approved
    ///         this contract first. The payer must match the designated payer, if any.
    function pay(bytes32 invoiceId) external {
        InvoiceData storage inv = _payable(invoiceId, msg.sender);
        _record(inv, invoiceId, msg.sender);
        token.safeTransferFrom(msg.sender, merchant, inv.amount);
    }

    /// @notice Pay `invoiceId` with an EIP-3009 `ReceiveWithAuthorization` signed by `from`.
    /// @dev The signed nonce must be `authorizationNonce(invoiceId)`. That ties the signature
    ///      to this invoice, so a relayer can't reuse it to mark a different invoice as paid.
    ///      `to` in the signed message must be this contract.
    function payWithAuthorization(
        bytes32 invoiceId,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        InvoiceData storage inv = _payable(invoiceId, from);
        _record(inv, invoiceId, from);
        IERC3009(address(token)).receiveWithAuthorization(
            from,
            address(this),
            inv.amount,
            validAfter,
            validBefore,
            authorizationNonce(invoiceId),
            v,
            r,
            s
        );
        token.safeTransfer(merchant, inv.amount);
    }

    /// @notice Cancel an unpaid invoice. Only the merchant.
    function cancelInvoice(bytes32 invoiceId) external {
        if (msg.sender != merchant) revert OnlyMerchant();
        InvoiceData storage inv = _invoices[invoiceId];
        if (inv.amount == 0) revert InvoiceNotFound(invoiceId);
        if (inv.paid) revert AlreadyPaid(invoiceId);
        if (inv.cancelled) revert AlreadyCancelled(invoiceId);
        inv.cancelled = true;
        emit InvoiceCancelled(invoiceId);
    }

    /// @notice Recover tokens sent straight to this contract by mistake. Only the merchant.
    /// @dev Invoice payments go directly to the merchant and never sit here, so this can
    ///      only return accidental transfers.
    function recoverERC20(address token_, address to) external {
        if (msg.sender != merchant) revert OnlyMerchant();
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token_).balanceOf(address(this));
        if (balance > 0) IERC20(token_).safeTransfer(to, balance);
    }

    /// @notice The EIP-3009 nonce a buyer must sign to pay `invoiceId` through this contract.
    function authorizationNonce(bytes32 invoiceId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), invoiceId));
    }

    function invoiceOf(bytes32 invoiceId) external view returns (InvoiceData memory) {
        return _invoices[invoiceId];
    }

    function isPaid(bytes32 invoiceId) external view returns (bool) {
        return _invoices[invoiceId].paid;
    }

    function isCancelled(bytes32 invoiceId) external view returns (bool) {
        return _invoices[invoiceId].cancelled;
    }

    function isExpired(bytes32 invoiceId) external view returns (bool) {
        InvoiceData storage inv = _invoices[invoiceId];
        return inv.amount != 0 && !inv.paid && inv.dueAt != 0 && block.timestamp > inv.dueAt;
    }

    function isOpen(bytes32 invoiceId) external view returns (bool) {
        InvoiceData storage inv = _invoices[invoiceId];
        return inv.amount != 0 && !inv.paid && !inv.cancelled
            && (inv.dueAt == 0 || block.timestamp <= inv.dueAt);
    }

    function _payable(bytes32 invoiceId, address payer) private view returns (InvoiceData storage) {
        InvoiceData storage inv = _invoices[invoiceId];
        if (inv.amount == 0) revert InvoiceNotFound(invoiceId);
        if (inv.paid) revert AlreadyPaid(invoiceId);
        if (inv.cancelled) revert AlreadyCancelled(invoiceId);
        if (inv.dueAt != 0 && block.timestamp > inv.dueAt) revert InvoiceExpired(invoiceId);
        if (inv.payer != address(0) && inv.payer != payer) revert WrongPayer(payer);
        return inv;
    }

    function _record(InvoiceData storage inv, bytes32 invoiceId, address payer) private {
        inv.paid = true;
        inv.paidBy = payer;
        inv.paidAt = uint64(block.timestamp);
        emit InvoicePaid(invoiceId, payer, inv.amount);
    }
}
