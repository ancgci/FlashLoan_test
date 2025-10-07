// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {Script, console} from "forge-std/Script.sol";
import {ArbitrageFlashLoan} from "../src/ArbitrageFlashLoan.sol";

/**
 * @title DeployFL
 * @notice Deployment script for ArbitrageFlashLoan contract
 * @dev Usage:
 *   Mainnet: forge script script/DeployFlashLoan.s.sol --rpc-url $ARBITRUM_RPC_URL --broadcast --verify
 *   Testnet (Sepolia): forge script script/DeployFlashLoan.s.sol --rpc-url $ARBITRUM_SEPOLIA_RPC_URL --broadcast --verify
 */
contract DeployFL is Script {
    // Arbitrum Mainnet addresses
    address constant MAINNET_AAVE_POOL_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address payable constant MAINNET_CAMELOT_ROUTER = payable(0xc873fEcbd354f5A56E00E710B90EF4201db2448d);
    address payable constant MAINNET_SUSHISWAP_ROUTER = payable(0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506);

    // Arbitrum Sepolia Testnet addresses
    address constant SEPOLIA_AAVE_POOL_PROVIDER = 0x0496275d34753A48320CA58103d5220d394FF77F;
    address payable constant SEPOLIA_CAMELOT_ROUTER = payable(address(0)); // TODO: Update with testnet address
    address payable constant SEPOLIA_SUSHISWAP_ROUTER = payable(0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2); // Uniswap V2 Router on Sepolia

    function run() public {
        uint256 chainId = block.chainid;
        console.log("Deploying on chain:", chainId);

        // Select addresses based on chain
        address aaveProvider;
        address payable camelotRouter;
        address payable sushiswapRouter;

        if (chainId == 42161) {
            // Arbitrum Mainnet
            console.log("Deploying to Arbitrum Mainnet");
            aaveProvider = MAINNET_AAVE_POOL_PROVIDER;
            camelotRouter = MAINNET_CAMELOT_ROUTER;
            sushiswapRouter = MAINNET_SUSHISWAP_ROUTER;
        } else if (chainId == 421614) {
            // Arbitrum Sepolia Testnet
            console.log("Deploying to Arbitrum Sepolia Testnet");
            aaveProvider = SEPOLIA_AAVE_POOL_PROVIDER;
            camelotRouter = SEPOLIA_CAMELOT_ROUTER;
            sushiswapRouter = SEPOLIA_SUSHISWAP_ROUTER;
            require(camelotRouter != address(0), "Camelot router not configured for testnet");
        } else {
            revert("Unsupported chain");
        }

        // Verify addresses are set
        require(aaveProvider != address(0), "AAVE provider not set");
        require(sushiswapRouter != address(0), "Sushiswap router not set");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        console.log("Deploying from:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        ArbitrageFlashLoan flashLoan = new ArbitrageFlashLoan(
            aaveProvider,
            sushiswapRouter,
            camelotRouter
        );

        vm.stopBroadcast();

        console.log("=================================");
        console.log("ArbitrageFlashLoan deployed to:", address(flashLoan));
        console.log("Owner:", flashLoan.owner());
        console.log("=================================");
        console.log("Next steps:");
        console.log("1. Set arbitrage details: flashLoan.setArbitrageDetails(tokenIn, tokenOut)");
        console.log("2. Test with small amount first");
        console.log("3. Monitor gas costs and profitability");
    }
}