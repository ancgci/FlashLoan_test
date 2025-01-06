// test/ArbitrageFlashLoan.t.sol
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ArbitrageFlashLoan.sol";
import {IERC20} from "../node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "../lib/aave-v3-core/contracts/interfaces/IPool.sol";
import "forge-std/console.sol";

// Test on a fork from Arbitrum network
// initialise avec la fonction setArbitrage , le token recu du pret, le token a swap et le Pool sur lequel on le swap en dernier.
// des des USDC pour le test

contract ArbitrageFlashLoanTest is Test {
    ArbitrageFlashLoan public flashLoan;

    address constant AAVE_POOL_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address payable constant CAMELOT_ROUTER = payable(0xc873fEcbd354f5A56E00E710B90EF4201db2448d); //audited
    address payable constant SUSHISWAP_ROUTER = payable(0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506);

    address constant USDC = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8; //Via AAVE
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    address owner = address(this);

    function setUp() public {
        vm.createSelectFork(vm.envString("ARBITRUM_RPC_URL"));
        flashLoan = new ArbitrageFlashLoan(
            AAVE_POOL_PROVIDER,
            SUSHISWAP_ROUTER,
            CAMELOT_ROUTER
        );

        flashLoan.setArbitrageDetails(USDC, WETH);
        assertTrue(address(AAVE_POOL_PROVIDER).code.length > 0);
        assertTrue(address(CAMELOT_ROUTER).code.length > 0);
        assertTrue(address(SUSHISWAP_ROUTER).code.length > 0);

        // Deal des tokens pour les tests 10 USDC
        deal(USDC, address(flashLoan), 10_000_000);
    }

    function testInitialSetup() public {
        assertTrue(address(flashLoan) != address(0));
        assertEq(flashLoan.getBalance(USDC), 10_000_000);
    }

    // Reauest a flash loan avec 10_000 USDC
    function testRequestFlashLoan() public {
        flashLoan.requestFlashLoan(USDC, 1000e6);
        uint256 finalBalance = IERC20(USDC).balanceOf(address(flashLoan));
        console.log("finalBalance", finalBalance);
        assertGe(finalBalance, 1000e6, "Balance should not decrease");

    }

    // Withdraw the initial 10 USDC.
    function testWithdraw() public {
        flashLoan.withdraw(USDC);
    }

    // Test des modifiers et des fonctions de sécurité
    function testOnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert("Only the contract owner can call this function");
        flashLoan.withdraw(USDC);
    }

}