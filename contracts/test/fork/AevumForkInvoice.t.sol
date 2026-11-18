// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Invoice} from "../../src/Invoice.sol";
import {Signing} from "../Signing.sol";

interface ITUSD8 is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

/// @notice Runs Invoice against the REAL tUSD8 on a local fork of Aevum testnet. No funds needed:
///         `deal` writes a balance into the fork only.
///         Run with: make test-fork   (or: forge test --match-path 'test/fork/*' --fork-url aevum --evm-version shanghai)
contract AevumForkInvoiceTest is Test {
    ITUSD8 constant TUSD8 = ITUSD8(0x456569838f1d43009A91ebA4263147Afd7233483);

    function test_realTusd8_createAndPay() public {
        assertEq(block.chainid, 44005, "run with --fork-url aevum");
        address merchant = makeAddr("merchant");
        address buyer = makeAddr("buyer");
        Invoice invoice = new Invoice(TUSD8, merchant);
        deal(address(TUSD8), buyer, 10e6);

        bytes32 id = keccak256("fork-inv-1");
        vm.prank(merchant);
        invoice.createInvoice(id, buyer, 3e6, 0, "Fork test invoice");

        vm.startPrank(buyer);
        TUSD8.approve(address(invoice), 3e6);
        invoice.pay(id);
        vm.stopPrank();

        assertEq(TUSD8.balanceOf(merchant), 3e6);
        assertTrue(invoice.isPaid(id));
    }

    function test_realTusd8_payWithAuthorization() public {
        address merchant = makeAddr("merchant");
        (address buyer, uint256 key) = makeAddrAndKey("buyer");
        Invoice invoice = new Invoice(TUSD8, merchant);
        deal(address(TUSD8), buyer, 10e6);

        bytes32 id = keccak256("fork-inv-2");
        vm.prank(merchant);
        invoice.createInvoice(id, buyer, 5e6, 0, "Fork gasless invoice");

        uint256 deadline = block.timestamp + 1 hours;
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(invoice),
            value: 5e6,
            validAfter: 0,
            validBefore: deadline,
            nonce: invoice.authorizationNonce(id)
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, key, TUSD8.DOMAIN_SEPARATOR(), a);

        vm.prank(makeAddr("relayer"));
        invoice.payWithAuthorization(id, buyer, 0, deadline, v, r, s);

        assertEq(TUSD8.balanceOf(merchant), 5e6);
        assertEq(TUSD8.balanceOf(buyer), 5e6);
        assertTrue(TUSD8.authorizationState(buyer, invoice.authorizationNonce(id)));
    }

    function test_realTusd8_wrongPayerReverts() public {
        address merchant = makeAddr("merchant");
        address buyer = makeAddr("buyer");
        address stranger = makeAddr("stranger");
        Invoice invoice = new Invoice(TUSD8, merchant);
        deal(address(TUSD8), stranger, 10e6);

        bytes32 id = keccak256("fork-inv-3");
        vm.prank(merchant);
        invoice.createInvoice(id, buyer, 3e6, 0, "Designated payer only");

        vm.startPrank(stranger);
        TUSD8.approve(address(invoice), 3e6);
        vm.expectRevert(abi.encodeWithSelector(Invoice.WrongPayer.selector, stranger));
        invoice.pay(id);
        vm.stopPrank();
    }
}
