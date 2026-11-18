// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Invoice} from "../src/Invoice.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract InvoiceTest is Test {
    MockUSD8 token;
    Invoice invoice;
    address merchant = makeAddr("merchant");
    address buyer;
    uint256 buyerKey;
    address stranger = makeAddr("stranger");
    address relayer = makeAddr("relayer");

    bytes32 constant INV = keccak256("inv-1");
    uint256 constant AMOUNT = 5e6; // 5 tUSD8

    function setUp() public {
        (buyer, buyerKey) = makeAddrAndKey("buyer");
        token = new MockUSD8();
        invoice = new Invoice(IERC20(address(token)), merchant);
        token.mint(buyer, 100e6);
        token.mint(stranger, 100e6);
        vm.prank(merchant);
        invoice.createInvoice(INV, buyer, AMOUNT, 0, "Website redesign - milestone 1");
    }

    // ---------- createInvoice ----------

    function test_createInvoice_storesFields() public view {
        Invoice.InvoiceData memory inv = invoice.invoiceOf(INV);
        assertEq(inv.payer, buyer);
        assertEq(inv.amount, AMOUNT);
        assertEq(inv.dueAt, 0);
        assertEq(inv.memo, "Website redesign - milestone 1");
        assertFalse(inv.paid);
        assertFalse(inv.cancelled);
        assertTrue(invoice.isOpen(INV));
    }

    function test_createInvoice_onlyMerchant() public {
        vm.prank(stranger);
        vm.expectRevert(Invoice.OnlyMerchant.selector);
        invoice.createInvoice(keccak256("inv-2"), buyer, AMOUNT, 0, "");
    }

    function test_createInvoice_revertsOnDuplicate() public {
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(Invoice.InvoiceExists.selector, INV));
        invoice.createInvoice(INV, buyer, AMOUNT, 0, "");
    }

    function test_createInvoice_revertsOnZeroAmount() public {
        vm.prank(merchant);
        vm.expectRevert(Invoice.ZeroAmount.selector);
        invoice.createInvoice(keccak256("inv-2"), buyer, 0, 0, "");
    }

    function test_createInvoice_revertsOnPastDueDate() public {
        vm.prank(merchant);
        vm.expectRevert(Invoice.InvalidDueDate.selector);
        invoice.createInvoice(keccak256("inv-2"), buyer, AMOUNT, uint64(block.timestamp), "");
    }

    function test_createInvoice_openToAnyone() public {
        bytes32 id = keccak256("inv-open");
        vm.prank(merchant);
        invoice.createInvoice(id, address(0), AMOUNT, 0, "open invoice");
        assertEq(invoice.invoiceOf(id).payer, address(0));
    }

    // ---------- pay (approve + call, exact invoiced amount) ----------

    function test_pay_movesExactAmountAndRecords() public {
        vm.startPrank(buyer);
        token.approve(address(invoice), AMOUNT);
        vm.expectEmit(true, true, false, true, address(invoice));
        emit Invoice.InvoicePaid(INV, buyer, AMOUNT);
        invoice.pay(INV);
        vm.stopPrank();

        assertEq(token.balanceOf(merchant), AMOUNT);
        assertEq(token.balanceOf(address(invoice)), 0);
        assertTrue(invoice.isPaid(INV));
        Invoice.InvoiceData memory inv = invoice.invoiceOf(INV);
        assertEq(inv.paidBy, buyer);
        assertEq(inv.amount, AMOUNT);
        assertEq(inv.paidAt, block.timestamp);
    }

    function test_pay_revertsOnSecondPayment() public {
        vm.startPrank(buyer);
        token.approve(address(invoice), 2 * AMOUNT);
        invoice.pay(INV);
        vm.expectRevert(abi.encodeWithSelector(Invoice.AlreadyPaid.selector, INV));
        invoice.pay(INV);
        vm.stopPrank();
    }

    function test_pay_revertsForWrongPayer() public {
        vm.startPrank(stranger);
        token.approve(address(invoice), AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Invoice.WrongPayer.selector, stranger));
        invoice.pay(INV);
        vm.stopPrank();
        assertFalse(invoice.isPaid(INV));
    }

    function test_pay_revertsWithoutApproval() public {
        vm.prank(buyer);
        vm.expectRevert();
        invoice.pay(INV);
        assertFalse(invoice.isPaid(INV));
    }

    function test_pay_revertsOnUnknownInvoice() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Invoice.InvoiceNotFound.selector, keccak256("nope")));
        invoice.pay(keccak256("nope"));
    }

    function test_pay_revertsWhenExpired() public {
        bytes32 id = keccak256("inv-exp");
        vm.prank(merchant);
        invoice.createInvoice(id, buyer, AMOUNT, uint64(block.timestamp + 1 hours), "");
        vm.warp(block.timestamp + 2 hours);
        assertTrue(invoice.isExpired(id));
        assertFalse(invoice.isOpen(id));

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Invoice.InvoiceExpired.selector, id));
        invoice.pay(id);
    }

    function test_pay_revertsWhenCancelled() public {
        vm.prank(merchant);
        invoice.cancelInvoice(INV);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Invoice.AlreadyCancelled.selector, INV));
        invoice.pay(INV);
    }

    // ---------- cancelInvoice ----------

    function test_cancelInvoice_merchantOnly() public {
        vm.prank(stranger);
        vm.expectRevert(Invoice.OnlyMerchant.selector);
        invoice.cancelInvoice(INV);
    }

    function test_cancelInvoice_marksCancelled() public {
        vm.prank(merchant);
        vm.expectEmit(true, false, false, true, address(invoice));
        emit Invoice.InvoiceCancelled(INV);
        invoice.cancelInvoice(INV);
        assertTrue(invoice.isCancelled(INV));
        assertFalse(invoice.isOpen(INV));
    }

    function test_cancelInvoice_revertsWhenPaid() public {
        vm.startPrank(buyer);
        token.approve(address(invoice), AMOUNT);
        invoice.pay(INV);
        vm.stopPrank();

        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(Invoice.AlreadyPaid.selector, INV));
        invoice.cancelInvoice(INV);
    }

    // ---------- recoverERC20 ----------

    function test_recoverERC20_returnsStrayTokens() public {
        token.mint(address(invoice), 7e6); // sent straight to the contract by mistake
        vm.prank(merchant);
        invoice.recoverERC20(address(token), merchant);
        assertEq(token.balanceOf(merchant), 7e6);
        assertEq(token.balanceOf(address(invoice)), 0);
    }

    function test_recoverERC20_merchantOnly() public {
        vm.prank(stranger);
        vm.expectRevert(Invoice.OnlyMerchant.selector);
        invoice.recoverERC20(address(token), stranger);
    }

    // ---------- payWithAuthorization (EIP-3009, gasless for the buyer) ----------

    function _sign(bytes32 invoiceId, uint256 value, uint256 validBefore)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(invoice),
            value: value,
            validAfter: 0,
            validBefore: validBefore,
            nonce: invoice.authorizationNonce(invoiceId)
        });
        return Signing.signReceive(vm, buyerKey, token.DOMAIN_SEPARATOR(), a);
    }

    function test_payWithAuthorization_relayerSubmits() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, AMOUNT, deadline);

        vm.prank(relayer); // the buyer never sends a transaction
        invoice.payWithAuthorization(INV, buyer, 0, deadline, v, r, s);

        assertEq(token.balanceOf(merchant), AMOUNT);
        assertEq(token.balanceOf(buyer), 95e6);
        assertEq(invoice.invoiceOf(INV).paidBy, buyer);
    }

    function test_payWithAuthorization_signatureIsBoundToInvoice() public {
        bytes32 other = keccak256("inv-2");
        vm.prank(merchant);
        invoice.createInvoice(other, buyer, AMOUNT, 0, "second invoice");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, AMOUNT, deadline);

        // Same signature, different invoice id: the nonce no longer matches, so it fails.
        vm.prank(relayer);
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        invoice.payWithAuthorization(other, buyer, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_rejectsWrongPayer() public {
        // Signature is from the buyer, but the relayer claims a different payer.
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, AMOUNT, deadline);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(Invoice.WrongPayer.selector, stranger));
        invoice.payWithAuthorization(INV, stranger, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_expired() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, AMOUNT, deadline);
        vm.warp(deadline);

        vm.expectRevert(MockUSD8.AuthorizationExpired.selector);
        invoice.payWithAuthorization(INV, buyer, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_noReplay() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, AMOUNT, deadline);
        invoice.payWithAuthorization(INV, buyer, 0, deadline, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(Invoice.AlreadyPaid.selector, INV));
        invoice.payWithAuthorization(INV, buyer, 0, deadline, v, r, s);
    }

    function test_constructor_rejectsZeroAddress() public {
        vm.expectRevert(Invoice.ZeroAddress.selector);
        new Invoice(IERC20(address(0)), merchant);
        vm.expectRevert(Invoice.ZeroAddress.selector);
        new Invoice(IERC20(address(token)), address(0));
    }

    function testFuzz_createAndPay(uint256 amount) public {
        amount = bound(amount, 1, 100e6);
        bytes32 id = keccak256(abi.encode(amount, block.timestamp));
        vm.prank(merchant);
        invoice.createInvoice(id, buyer, amount, 0, "fuzz");
        vm.startPrank(buyer);
        token.approve(address(invoice), amount);
        invoice.pay(id);
        vm.stopPrank();
        assertEq(token.balanceOf(merchant), amount);
        assertEq(invoice.invoiceOf(id).amount, amount);
    }
}
