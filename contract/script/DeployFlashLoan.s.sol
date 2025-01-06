// script/DeployArbitrage.s.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {Script, console} from "forge-std/Script.sol";
import {ArbitrageFlashLoan} from "../src/ArbitrageFlashLoan.sol";

contract DeployFL is Script {
    //address constant AAVE_POOL_PROVIDER = 0xB25a5D144626a0D488e52AE717A051a2E9997076;
    address constant AAVE_POOL_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address payable constant CAMELOT_ROUTER = payable(0xc873fEcbd354f5A56E00E710B90EF4201db2448d); //audited
    address payable constant SUSHISWAP_ROUTER = payable(0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506);


    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        ArbitrageFlashLoan flashLoan = new ArbitrageFlashLoan(
            AAVE_POOL_PROVIDER,
            SUSHISWAP_ROUTER,
            CAMELOT_ROUTER
        );
        vm.stopBroadcast();
        console.log("ArbitrageFlashLoan deployed to:", address(flashLoan));
    }
}